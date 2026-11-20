import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.mjs';
import { connect, initializeDatabase } from './lib/db.mjs';
import { graphConfigured, syncNumbers, listTemplates, clearTemplateCache, downloadMedia } from './lib/graph.mjs';
import { processWebhook, conversationList, getConversation, sendText, sendTemplate, startConversation } from './lib/inbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.join(here, '.env'));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(here, 'public');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || '';
const APP_SECRET = process.env.META_APP_SECRET || '';
const MAX_BODY_BYTES = 1024 * 1024;
const COOKIE_NAME = 'relaydesk_session';
const PRODUCTION = process.env.NODE_ENV === 'production';
// Hostinger serves Node apps behind a reverse proxy, so the socket address is the
// proxy's. Only trust X-Forwarded-For when the operator says a proxy is in front.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

if (PRODUCTION && (!ADMIN_EMAIL || ADMIN_PASSWORD.length < 16)) {
  throw new Error('Production requires ADMIN_EMAIL and a unique ADMIN_PASSWORD of at least 16 characters.');
}

const { client, db } = await connect();
await initializeDatabase(db);
const sessions = db.collection('sessions');
const adminPasswordHash = ADMIN_PASSWORD.length >= 12 ? await scrypt(ADMIN_PASSWORD, 'relaydesk-admin-v1') : null;
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

function scrypt(password, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key)));
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  ...(PRODUCTION ? { 'strict-transport-security': 'max-age=31536000' } : {})
};

function respond(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...BASE_HEADERS, ...headers });
  res.end(type.startsWith('text/plain') ? String(body) : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('payload_too_large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw.toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('invalid_json'), { statusCode: 400 }); }
}

function cookieValue(req, name) {
  const part = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  if (!part) return '';
  try { return decodeURIComponent(part.slice(name.length + 1)); } catch { return ''; }
}

function setSessionCookie(res, token, maxAge) {
  const secure = PRODUCTION || process.env.COOKIE_SECURE === 'true';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

function requestHost(req) {
  return (TRUST_PROXY && String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()) || req.headers.host;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return !PRODUCTION;
  try { return new URL(origin).host === requestHost(req); } catch { return false; }
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    if (forwarded.length) return forwarded[forwarded.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

async function requireSession(req) {
  const token = cookieValue(req, COOKIE_NAME);
  if (!token || token.length > 200) return false;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = await sessions.findOne({ _id: hash });
  if (!row || Number(row.expires_at) < Date.now()) {
    if (row) await sessions.deleteOne({ _id: hash });
    return false;
  }
  return true;
}

function signatureValid(raw, header) {
  if (!APP_SECRET || typeof header !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const supplied = Buffer.from(header.slice(7), 'hex');
  const expected = crypto.createHmac('sha256', APP_SECRET).update(raw).digest();
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function serveStatic(url, res) {
  let requested;
  try { requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)); }
  catch { return respond(res, 400, { error: 'invalid_path' }); }
  const safe = path.resolve(PUBLIC_DIR, requested);
  if (!safe.startsWith(PUBLIC_DIR + path.sep)) return respond(res, 400, { error: 'invalid_path' });
  try {
    const data = await fs.readFile(safe);
    res.writeHead(200, {
      'content-type': STATIC_TYPES[path.extname(safe)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      ...BASE_HEADERS,
      'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    });
    res.end(data);
  } catch (error) {
    respond(res, error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 500, { error: 'not_found' });
  }
}

const INLINE_MEDIA = /^(image\/(jpeg|png|webp|gif)|audio\/[\w.+-]+|video\/(mp4|3gpp))$/;

async function serveMedia(res, messageId) {
  const message = await db.collection('messages').findOne({ _id: messageId }, { projection: { media_id: 1, media_mime: 1, media_filename: 1 } });
  if (!message?.media_id) return respond(res, 404, { error: 'media_not_found' });
  const { response, mime } = await downloadMedia(message.media_id);
  const type = String(message.media_mime || mime).split(';')[0].trim().toLowerCase();
  const safeType = /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream';
  const filename = String(message.media_filename || `whatsapp-${messageId}`).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  res.writeHead(200, {
    'content-type': safeType,
    'cache-control': 'private, max-age=3600',
    'content-disposition': `${INLINE_MEDIA.test(safeType) ? 'inline' : 'attachment'}; filename="${filename}"`,
    'content-security-policy': "default-src 'none'; sandbox",
    ...BASE_HEADERS,
    ...(response.headers.get('content-length') ? { 'content-length': response.headers.get('content-length') } : {})
  });
  await new Promise((resolve, reject) => Readable.fromWeb(response.body).on('error', reject).pipe(res).on('finish', resolve).on('error', reject));
}

async function overview() {
  const conversations = db.collection('conversations');
  const [total, unread, open, numbers] = await Promise.all([
    conversations.estimatedDocumentCount(), conversations.countDocuments({ unread_count: { $gt: 0 } }),
    conversations.countDocuments({ state: 'open' }), db.collection('phone_numbers').estimatedDocumentCount()
  ]);
  return {
    conversations: total, unread, open, numbers,
    whatsapp_configured: graphConfigured(), webhook_configured: Boolean(VERIFY_TOKEN && APP_SECRET)
  };
}

async function handleLogin(req, res) {
  if (!sameOrigin(req)) return respond(res, 403, { error: 'origin_rejected' });
  if (!ADMIN_EMAIL || !adminPasswordHash) return respond(res, 503, { error: 'Set ADMIN_EMAIL and ADMIN_PASSWORD in the private server environment before signing in.' });
  const ip = clientIp(req);
  const now = Date.now();
  if (loginAttempts.size > 5000) for (const [key, value] of loginAttempts) if (value.until <= now) loginAttempts.delete(key);
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.until > now && attempt.count >= LOGIN_MAX_FAILURES) return respond(res, 429, { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
  const body = await readJsonBody(req);
  const provided = await scrypt(String(body.password || ''), 'relaydesk-admin-v1');
  const valid = String(body.email || '').trim().toLowerCase() === ADMIN_EMAIL && safeEqual(provided, adminPasswordHash);
  if (!valid) {
    const next = attempt && attempt.until > now ? attempt : { count: 0, until: now + LOGIN_WINDOW_MS };
    next.count += 1;
    loginAttempts.set(ip, next);
    return respond(res, 401, { error: 'Email or password is incorrect.' });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await sessions.insertOne({ _id: hash, expires_at: now + SESSION_TTL_MS, expire_at: new Date(now + SESSION_TTL_MS), created_at: now });
  setSessionCookie(res, token, Math.floor(SESSION_TTL_MS / 1000));
  return respond(res, 200, { authenticated: true, email: ADMIN_EMAIL });
}

function errorResponse(res, error, fallbackStatus = 502) {
  const status = error.statusCode || fallbackStatus;
  return respond(res, status, { error: error.message || 'request_failed', ...(error.code ? { code: String(error.code) } : {}) });
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/overview') return respond(res, 200, await overview());

  if (url.pathname === '/api/conversations') {
    if (req.method === 'GET') {
      return respond(res, 200, { conversations: await conversationList(db, {
        search: (url.searchParams.get('q') || '').slice(0, 100),
        state: url.searchParams.get('state') || 'open',
        phone: (url.searchParams.get('phone') || '').slice(0, 64)
      }) });
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      try { return respond(res, 201, await startConversation(db, body)); }
      catch (error) { return errorResponse(res, error); }
    }
  }

  const conversationMatch = url.pathname.match(/^\/api\/conversations\/(\d{1,15})(?:\/(messages|state|template))?$/);
  if (conversationMatch) {
    const id = Number(conversationMatch[1]);
    const action = conversationMatch[2];
    const conversations = db.collection('conversations');
    if (req.method === 'GET' && !action) {
      const row = await getConversation(db, id);
      return row ? respond(res, 200, { conversation: row }) : respond(res, 404, { error: 'conversation_not_found' });
    }
    if (req.method === 'GET' && action === 'messages') {
      const found = await conversations.updateOne({ _id: id }, { $set: { unread_count: 0 } });
      if (!found.matchedCount) return respond(res, 404, { error: 'conversation_not_found' });
      const messages = await db.collection('messages').find({ conversation_id: id }).sort({ sent_at: -1, _id: -1 }).limit(200).toArray();
      return respond(res, 200, { messages: messages.reverse().map(m => ({
        id: m._id, wa_message_id: m.wa_message_id, direction: m.direction, message_type: m.message_type, body: m.body,
        media_mime: m.media_mime ?? null, media_filename: m.media_filename ?? null, has_media: Boolean(m.media_id),
        status: m.status, error_code: m.error_code ?? null, error_title: m.error_title ?? null, sent_at: m.sent_at
      })) });
    }
    if (req.method === 'POST' && action === 'messages') {
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      if (!text || text.length > 4096) return respond(res, 400, { error: 'Message must be 1–4096 characters.' });
      try { return respond(res, 201, await sendText(db, id, text)); }
      catch (error) { return errorResponse(res, error); }
    }
    if (req.method === 'POST' && action === 'template') {
      const body = await readJsonBody(req);
      try { return respond(res, 201, await sendTemplate(db, id, body)); }
      catch (error) { return errorResponse(res, error); }
    }
    if (req.method === 'POST' && action === 'state') {
      const body = await readJsonBody(req);
      if (!['open', 'closed'].includes(body.state)) return respond(res, 400, { error: 'Invalid conversation state.' });
      const updated = await conversations.updateOne({ _id: id }, { $set: { state: body.state, updated_at: new Date().toISOString() } });
      if (!updated.matchedCount) return respond(res, 404, { error: 'conversation_not_found' });
      return respond(res, 200, { id, state: body.state });
    }
  }

  const mediaMatch = url.pathname.match(/^\/api\/messages\/(\d{1,15})\/media$/);
  if (mediaMatch && req.method === 'GET') {
    try { return await serveMedia(res, Number(mediaMatch[1])); }
    catch (error) { return res.headersSent ? res.destroy(error) : errorResponse(res, error); }
  }

  if (req.method === 'GET' && url.pathname === '/api/templates') {
    try { return respond(res, 200, { templates: await listTemplates({ fresh: url.searchParams.get('refresh') === '1' }) }); }
    catch (error) { return errorResponse(res, error, 400); }
  }
  if (req.method === 'GET' && url.pathname === '/api/numbers') {
    const [numbers, openCounts] = await Promise.all([
      db.collection('phone_numbers').find().toArray(),
      db.collection('conversations').aggregate([{ $match: { state: 'open' } }, { $group: { _id: '$phone_number_id', n: { $sum: 1 } } }]).toArray()
    ]);
    const open = new Map(openCounts.map(row => [row._id, row.n]));
    const rows = numbers.map(({ _id, ...n }) => ({ phone_number_id: _id, ...n, open_conversations: open.get(_id) || 0 }))
      .sort((a, b) => String(a.display_phone_number || a.phone_number_id).localeCompare(String(b.display_phone_number || b.phone_number_id)));
    return respond(res, 200, { numbers: rows, configured: graphConfigured() });
  }
  if (req.method === 'POST' && url.pathname === '/api/numbers/sync') {
    try { const result = await syncNumbers(db); clearTemplateCache(); return respond(res, 200, result); }
    catch (error) { return errorResponse(res, error, 400); }
  }
  return respond(res, 404, { error: 'not_found' });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url || '/', 'http://relaydesk.local'); }
  catch { return respond(res, 400, { error: 'invalid_url' }); }
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      await db.command({ ping: 1 });
      return respond(res, 200, { status: 'ok', database: 'ok', whatsapp_configured: graphConfigured(), webhook_configured: Boolean(VERIFY_TOKEN && APP_SECRET) });
    }

    if (url.pathname === '/webhooks/whatsapp' && req.method === 'GET') {
      if (!VERIFY_TOKEN) return respond(res, 503, { error: 'webhook_not_configured' });
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token') || '';
      const challenge = url.searchParams.get('hub.challenge') || '';
      if (mode === 'subscribe' && challenge && safeEqual(token, VERIFY_TOKEN)) return respond(res, 200, challenge, 'text/plain; charset=utf-8');
      return respond(res, 403, { error: 'webhook_verification_failed' });
    }
    if (url.pathname === '/webhooks/whatsapp' && req.method === 'POST') {
      if (!APP_SECRET) return respond(res, 503, { error: 'webhook_not_configured' });
      const raw = await readBody(req);
      if (!signatureValid(raw, req.headers['x-hub-signature-256'])) return respond(res, 401, { error: 'invalid_signature' });
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { return respond(res, 400, { error: 'invalid_json' }); }
      if (payload?.object !== 'whatsapp_business_account') return respond(res, 200, { ignored: true });
      // Commit before acknowledging; a 5xx makes Meta retry, and inserts are idempotent.
      return respond(res, 200, { received: true, ...(await processWebhook(db, payload)) });
    }

    if (url.pathname === '/api/auth/status' && req.method === 'GET') {
      return respond(res, 200, { configured: Boolean(ADMIN_EMAIL && adminPasswordHash), authenticated: await requireSession(req), email: ADMIN_EMAIL || null });
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') return handleLogin(req, res);
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) return respond(res, 403, { error: 'origin_rejected' });
      const token = cookieValue(req, COOKIE_NAME);
      if (token) await sessions.deleteOne({ _id: crypto.createHash('sha256').update(token).digest('hex') });
      setSessionCookie(res, '', 0);
      return respond(res, 200, { authenticated: false });
    }

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return respond(res, 405, { error: 'method_not_allowed' });
      return serveStatic(url, res);
    }
    if (!(await requireSession(req))) return respond(res, 401, { error: 'sign_in_required' });
    if (req.method !== 'GET' && !sameOrigin(req)) return respond(res, 403, { error: 'origin_rejected' });
    return await handleApi(req, res, url);
  } catch (error) {
    const status = error.statusCode || (error instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(`${req.method} ${url.pathname} failed:`, error.message);
    if (res.headersSent) return res.destroy();
    return respond(res, status, { error: status === 500 ? 'server_error' : (error.message || 'invalid_request') });
  }
});

server.headersTimeout = 15000;
server.requestTimeout = 90000;
server.keepAliveTimeout = 5000;
server.listen(PORT, HOST, () => console.log(`Relaydesk listening on ${HOST}:${PORT}; MongoDB ready.`));

async function shutdown(signal) {
  console.log(`Received ${signal}; closing server.`);
  server.close(async error => {
    try { await client.close(); } finally { process.exit(error ? 1 : 0); }
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
