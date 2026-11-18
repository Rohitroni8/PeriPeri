import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

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
const GRAPH_VERSION = (process.env.WA_GRAPH_API_VERSION || '').replace(/^\/+|\/+$/g, '');
const COOKIE_NAME = 'relaydesk_session';
const PRODUCTION = process.env.NODE_ENV === 'production';

const requiredDb = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missingDb = requiredDb.filter(key => !process.env[key]);
if (missingDb.length) throw new Error(`Missing required MySQL settings: ${missingDb.join(', ')}`);
if (PRODUCTION && (!ADMIN_EMAIL || ADMIN_PASSWORD.length < 16)) {
  throw new Error('Production requires ADMIN_EMAIL and a unique ADMIN_PASSWORD of at least 16 characters.');
}

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 50,
  charset: 'utf8mb4',
  enableKeepAlive: true,
  connectTimeout: 10000,
  supportBigNumbers: true,
  dateStrings: true
});

await initializeDatabase();
const adminPasswordHash = ADMIN_PASSWORD.length >= 12 ? await scrypt(ADMIN_PASSWORD, 'relaydesk-admin-v1') : null;
const loginAttempts = new Map();

async function initializeDatabase() {
  const schema = `
    CREATE TABLE IF NOT EXISTS phone_numbers (
      phone_number_id VARCHAR(64) NOT NULL PRIMARY KEY,
      display_phone_number VARCHAR(32) NULL,
      verified_name VARCHAR(255) NULL,
      quality_rating VARCHAR(32) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'connected',
      updated_at VARCHAR(32) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS contacts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      wa_id VARCHAR(64) NOT NULL UNIQUE,
      profile_name VARCHAR(255) NULL,
      updated_at VARCHAR(32) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS conversations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      phone_number_id VARCHAR(64) NOT NULL,
      contact_id BIGINT UNSIGNED NOT NULL,
      last_message_at VARCHAR(32) NULL,
      last_message_preview VARCHAR(500) NOT NULL DEFAULT '',
      unread_count INT UNSIGNED NOT NULL DEFAULT 0,
      state VARCHAR(10) NOT NULL DEFAULT 'open',
      created_at VARCHAR(32) NOT NULL,
      updated_at VARCHAR(32) NOT NULL,
      UNIQUE KEY conversation_phone_contact (phone_number_id, contact_id),
      KEY conversations_recent (state, last_message_at),
      CONSTRAINT conversations_phone_fk FOREIGN KEY (phone_number_id) REFERENCES phone_numbers(phone_number_id),
      CONSTRAINT conversations_contact_fk FOREIGN KEY (contact_id) REFERENCES contacts(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS messages (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      conversation_id BIGINT UNSIGNED NOT NULL,
      wa_message_id VARCHAR(255) NULL UNIQUE,
      direction ENUM('inbound','outbound') NOT NULL,
      message_type VARCHAR(32) NOT NULL,
      body TEXT NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'received',
      error_code VARCHAR(64) NULL,
      sent_at VARCHAR(32) NOT NULL,
      created_at VARCHAR(32) NOT NULL,
      KEY messages_conversation (conversation_id, sent_at),
      CONSTRAINT messages_conversation_fk FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash CHAR(64) NOT NULL PRIMARY KEY,
      expires_at BIGINT UNSIGNED NOT NULL,
      created_at BIGINT UNSIGNED NOT NULL,
      KEY sessions_expiration (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;
  for (const statement of schema.split(';').map(value => value.trim()).filter(Boolean)) await db.query(statement);
  await db.query('SELECT 1');
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key)));
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function respond(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  const securityHeaders = {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    ...(PRODUCTION ? { 'strict-transport-security': 'max-age=31536000' } : {}),
    ...headers
  };
  res.writeHead(status, securityHeaders);
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
  const value = `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', value);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return !PRODUCTION;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function requireSession(req) {
  const token = cookieValue(req, COOKIE_NAME);
  if (!token || token.length > 200) return false;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const [rows] = await db.execute('SELECT expires_at FROM sessions WHERE token_hash = ?', [hash]);
  const row = rows[0];
  if (!row || Number(row.expires_at) < Date.now()) {
    if (row) await db.execute('DELETE FROM sessions WHERE token_hash = ?', [hash]);
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

function extractBody(message) {
  if (message.type === 'text') return message.text?.body || '';
  if (message.type === 'button') return message.button?.text || '[button reply]';
  if (message.type === 'interactive') return message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '[interactive reply]';
  const item = message[message.type];
  return item?.caption || `[${message.type || 'message'}]`;
}

async function storeInbound(phoneId, contactId, message) {
  const connection = await db.getConnection();
  const now = new Date().toISOString();
  const messageEpoch = Number(message.timestamp);
  const sentAt = Number.isFinite(messageEpoch) && messageEpoch > 0 && messageEpoch <= 8640000000000
    ? new Date(messageEpoch * 1000).toISOString()
    : now;
  try {
    await connection.beginTransaction();
    await connection.execute(`INSERT INTO phone_numbers(phone_number_id, updated_at) VALUES(?, ?)
      ON DUPLICATE KEY UPDATE updated_at=VALUES(updated_at)`, [phoneId, now]);
    await connection.execute(`INSERT INTO contacts(wa_id, updated_at) VALUES(?, ?)
      ON DUPLICATE KEY UPDATE updated_at=VALUES(updated_at)`, [contactId, now]);
    const [contactRows] = await connection.execute('SELECT id FROM contacts WHERE wa_id=?', [contactId]);
    const contact = contactRows[0];
    await connection.execute(`INSERT INTO conversations(phone_number_id, contact_id, created_at, updated_at)
      VALUES(?, ?, ?, ?) ON DUPLICATE KEY UPDATE id=id`, [phoneId, contact.id, now, now]);
    const [conversationRows] = await connection.execute('SELECT id FROM conversations WHERE phone_number_id=? AND contact_id=?', [phoneId, contact.id]);
    const conversation = conversationRows[0];
    const preview = extractBody(message).slice(0, 500);
    const [insert] = await connection.execute(`INSERT IGNORE INTO messages(conversation_id, wa_message_id, direction, message_type, body, status, sent_at, created_at)
      VALUES(?, ?, 'inbound', ?, ?, 'received', ?, ?)`, [conversation.id, message.id, message.type || 'unknown', extractBody(message), sentAt, now]);
    if (insert.affectedRows) {
      await connection.execute(`UPDATE conversations SET last_message_at=?, last_message_preview=?, unread_count=unread_count+1,
        state='open', updated_at=? WHERE id=?`, [sentAt, preview, now, conversation.id]);
    }
    const displayName = message.profile_name;
    if (displayName) await connection.execute('UPDATE contacts SET profile_name=? WHERE id=?', [String(displayName).slice(0, 255), contact.id]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function processWebhook(payload) {
  for (const entry of payload.entry || []) for (const change of entry.changes || []) {
    const value = change.value || {};
    const phoneId = value.metadata?.phone_number_id;
    const names = new Map((value.contacts || []).map(contact => [contact.wa_id, contact.profile?.name || null]));
    for (const message of value.messages || []) {
      if (!phoneId || !message.id || !message.from) continue;
      message.profile_name = names.get(message.from);
      await storeInbound(phoneId, message.from, message);
    }
    for (const status of value.statuses || []) {
      if (!status.id || !status.status) continue;
      const errorCode = status.errors?.[0]?.code ? String(status.errors[0].code) : null;
      await db.execute('UPDATE messages SET status=?, error_code=COALESCE(?,error_code) WHERE wa_message_id=?', [status.status, errorCode, status.id]);
    }
  }
}

async function conversationList({ search = '', state = 'open' } = {}) {
  const term = `%${search}%`;
  const stateFilter = ['open', 'closed', 'all'].includes(state) ? state : 'open';
  const [rows] = await db.execute(`SELECT c.id, c.phone_number_id, c.last_message_at, c.last_message_preview, c.unread_count, c.state,
      p.display_phone_number, p.verified_name, t.wa_id, t.profile_name
    FROM conversations c JOIN contacts t ON t.id=c.contact_id
    LEFT JOIN phone_numbers p ON p.phone_number_id=c.phone_number_id
    WHERE (?='all' OR c.state=?) AND (?='' OR t.wa_id LIKE ? OR COALESCE(t.profile_name,'') LIKE ? OR c.last_message_preview LIKE ?)
    ORDER BY COALESCE(c.last_message_at,'') DESC LIMIT 300`, [stateFilter, stateFilter, search, term, term, term]);
  return rows;
}

async function syncNumbers() {
  const version = GRAPH_VERSION;
  const wabaId = process.env.WA_BUSINESS_ACCOUNT_ID || '';
  const accessToken = process.env.WA_ACCESS_TOKEN || '';
  if (!/^v\d+\.\d+$/.test(version) || !/^\d+$/.test(wabaId) || !accessToken) throw new Error('Set WA_GRAPH_API_VERSION, WA_BUSINESS_ACCOUNT_ID, and WA_ACCESS_TOKEN in Hostinger private environment settings first.');
  let nextUrl = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/phone_numbers`);
  nextUrl.searchParams.set('fields', 'id,display_phone_number,verified_name,quality_rating');
  nextUrl.searchParams.set('limit', '100');
  const numbers = new Map();
  while (nextUrl) {
    const response = await fetch(nextUrl, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || `Meta phone-number sync failed (${response.status}).`);
    for (const number of body.data || []) if (number.id) numbers.set(number.id, number);
    const rawNext = body.paging?.next;
    if (!rawNext) nextUrl = null;
    else {
      const candidate = new URL(rawNext);
      if (candidate.protocol !== 'https:' || candidate.hostname !== 'graph.facebook.com') throw new Error('Unexpected Meta pagination host.');
      candidate.searchParams.delete('access_token');
      candidate.searchParams.delete('appsecret_proof');
      nextUrl = candidate;
    }
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    for (const number of numbers.values()) {
      await connection.execute(`INSERT INTO phone_numbers(phone_number_id, display_phone_number, verified_name, quality_rating, status, updated_at)
        VALUES(?, ?, ?, ?, 'connected', ?) ON DUPLICATE KEY UPDATE display_phone_number=VALUES(display_phone_number),
        verified_name=VALUES(verified_name), quality_rating=VALUES(quality_rating), status='connected', updated_at=VALUES(updated_at)`,
      [number.id, number.display_phone_number || null, number.verified_name || null, number.quality_rating || null, new Date().toISOString()]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return numbers.size;
}

async function sendText(conversationId, text) {
  const token = process.env.WA_ACCESS_TOKEN || '';
  const version = GRAPH_VERSION;
  if (!token || !/^v\d+\.\d+$/.test(version)) throw new Error('WhatsApp Cloud API is not configured. Add the API token and Graph API version in Hostinger private environment settings.');
  const [conversationRows] = await db.execute(`SELECT c.id, c.phone_number_id, t.wa_id FROM conversations c
    JOIN contacts t ON t.id=c.contact_id WHERE c.id=?`, [conversationId]);
  const conversation = conversationRows[0];
  if (!conversation) throw Object.assign(new Error('Conversation not found.'), { statusCode: 404 });
  const [phoneRows] = await db.execute('SELECT display_phone_number FROM phone_numbers WHERE phone_number_id=?', [conversation.phone_number_id]);
  const now = new Date().toISOString();
  const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(conversation.phone_number_id)}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: conversation.wa_id, type: 'text', text: { preview_url: false, body: text } }),
    signal: AbortSignal.timeout(20000)
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(responseBody?.error?.message || `Meta send failed (${response.status}).`), { statusCode: 502 });
  const waMessageId = responseBody.messages?.[0]?.id || null;
  await db.execute(`INSERT INTO messages(conversation_id, wa_message_id, direction, message_type, body, status, sent_at, created_at)
    VALUES(?, ?, 'outbound', 'text', ?, 'sent', ?, ?)`, [conversation.id, waMessageId, text, now, now]);
  await db.execute('UPDATE conversations SET last_message_at=?, last_message_preview=?, updated_at=?, state=\'open\' WHERE id=?', [now, text.slice(0, 500), now, conversation.id]);
  return { id: waMessageId, status: 'sent', from: phoneRows[0]?.display_phone_number || conversation.phone_number_id };
}

function requireGraphConfigured() {
  return Boolean(process.env.WA_BUSINESS_ACCOUNT_ID && process.env.WA_ACCESS_TOKEN && /^v\d+\.\d+$/.test(GRAPH_VERSION));
}

async function serveStatic(url, res) {
  let requested;
  try { requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)); }
  catch { return respond(res, 400, { error: 'invalid_path' }); }
  const safe = path.resolve(PUBLIC_DIR, requested);
  if (!safe.startsWith(PUBLIC_DIR + path.sep)) return respond(res, 400, { error: 'invalid_path' });
  try {
    const data = await fs.readFile(safe);
    const ext = path.extname(safe);
    const type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      ...(PRODUCTION ? { 'strict-transport-security': 'max-age=31536000' } : {}),
      'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    });
    res.end(data);
  } catch (error) {
    respond(res, error.code === 'ENOENT' ? 404 : 500, { error: 'not_found' });
  }
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`); }
  catch { return respond(res, 400, { error: 'invalid_url' }); }
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      await db.query('SELECT 1');
      return respond(res, 200, { status: 'ok', database: 'ok', whatsapp_configured: requireGraphConfigured() });
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
      if (payload?.object !== 'whatsapp_business_account') return respond(res, 400, { error: 'unexpected_object' });
      await processWebhook(payload);
      return respond(res, 200, { received: true });
    }

    if (url.pathname === '/api/auth/status' && req.method === 'GET') {
      return respond(res, 200, { configured: Boolean(ADMIN_EMAIL && adminPasswordHash), authenticated: await requireSession(req), email: ADMIN_EMAIL || null });
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      if (!sameOrigin(req)) return respond(res, 403, { error: 'origin_rejected' });
      if (!ADMIN_EMAIL || !adminPasswordHash) return respond(res, 503, { error: 'Set ADMIN_EMAIL and ADMIN_PASSWORD in Hostinger private environment settings before signing in.' });
      const ip = req.socket.remoteAddress || 'unknown';
      const attempt = loginAttempts.get(ip) || { count: 0, until: 0 };
      if (attempt.until > Date.now() && attempt.count >= 10) return respond(res, 429, { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
      const body = await readJsonBody(req);
      const provided = await scrypt(String(body.password || ''), 'relaydesk-admin-v1');
      const valid = String(body.email || '').trim().toLowerCase() === ADMIN_EMAIL && safeEqual(provided, adminPasswordHash);
      if (!valid) {
        const next = attempt.until > Date.now() ? attempt : { count: 0, until: Date.now() + 15 * 60 * 1000 };
        next.count += 1;
        loginAttempts.set(ip, next);
        return respond(res, 401, { error: 'Email or password is incorrect.' });
      }
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      const now = Date.now();
      await db.execute('DELETE FROM sessions WHERE expires_at < ?', [now]);
      await db.execute('INSERT INTO sessions(token_hash, expires_at, created_at) VALUES(?,?,?)', [hash, now + SESSION_TTL_MS, now]);
      setSessionCookie(res, token, Math.floor(SESSION_TTL_MS / 1000));
      return respond(res, 200, { authenticated: true, email: ADMIN_EMAIL });
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) return respond(res, 403, { error: 'origin_rejected' });
      const token = cookieValue(req, COOKIE_NAME);
      if (token) await db.execute('DELETE FROM sessions WHERE token_hash=?', [crypto.createHash('sha256').update(token).digest('hex')]);
      setSessionCookie(res, '', 0);
      return respond(res, 200, { authenticated: false });
    }

    if (!url.pathname.startsWith('/api/')) return serveStatic(url, res);
    if (!(await requireSession(req))) return respond(res, 401, { error: 'sign_in_required' });
    if (req.method !== 'GET' && !sameOrigin(req)) return respond(res, 403, { error: 'origin_rejected' });

    if (req.method === 'GET' && url.pathname === '/api/overview') {
      const [totalsRows] = await db.query(`SELECT COUNT(*) AS conversations,
        SUM(CASE WHEN unread_count>0 THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN state='open' THEN 1 ELSE 0 END) AS open FROM conversations`);
      const [numberRows] = await db.query('SELECT COUNT(*) AS count FROM phone_numbers');
      return respond(res, 200, { ...totalsRows[0], numbers: numberRows[0].count, whatsapp_configured: requireGraphConfigured(), webhook_configured: Boolean(VERIFY_TOKEN && APP_SECRET) });
    }
    if (req.method === 'GET' && url.pathname === '/api/conversations') {
      return respond(res, 200, { conversations: await conversationList({ search: (url.searchParams.get('q') || '').slice(0, 100), state: url.searchParams.get('state') || 'open' }) });
    }
    const conversationMatch = url.pathname.match(/^\/api\/conversations\/(\d+)(?:\/(messages|state))?$/);
    if (conversationMatch) {
      const id = Number(conversationMatch[1]);
      const action = conversationMatch[2];
      if (!Number.isSafeInteger(id)) return respond(res, 400, { error: 'invalid_conversation_id' });
      if (req.method === 'GET' && action === 'messages') {
        const [exists] = await db.execute('SELECT id FROM conversations WHERE id=?', [id]);
        if (!exists.length) return respond(res, 404, { error: 'conversation_not_found' });
        await db.execute('UPDATE conversations SET unread_count=0 WHERE id=?', [id]);
        const [messages] = await db.execute('SELECT id, wa_message_id, direction, message_type, body, status, error_code, sent_at FROM messages WHERE conversation_id=? ORDER BY sent_at DESC, id DESC LIMIT 200', [id]);
        return respond(res, 200, { messages: messages.reverse() });
      }
      if (req.method === 'POST' && action === 'messages') {
        const body = await readJsonBody(req);
        const text = String(body.text || '').trim();
        if (!text || text.length > 4096) return respond(res, 400, { error: 'Message must be 1–4096 characters.' });
        try { return respond(res, 201, await sendText(id, text)); }
        catch (error) { return respond(res, error.statusCode || 502, { error: error.message || 'message_send_failed' }); }
      }
      if (req.method === 'POST' && action === 'state') {
        const body = await readJsonBody(req);
        if (!['open', 'closed'].includes(body.state)) return respond(res, 400, { error: 'Invalid conversation state.' });
        const [result] = await db.execute('UPDATE conversations SET state=?, updated_at=? WHERE id=?', [body.state, new Date().toISOString(), id]);
        if (!result.affectedRows) {
          const [exists] = await db.execute('SELECT id FROM conversations WHERE id=?', [id]);
          if (!exists.length) return respond(res, 404, { error: 'conversation_not_found' });
        }
        return respond(res, 200, { id, state: body.state });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/numbers') {
      const [numbers] = await db.execute('SELECT phone_number_id, display_phone_number, verified_name, quality_rating, status, updated_at FROM phone_numbers ORDER BY COALESCE(display_phone_number,phone_number_id)');
      return respond(res, 200, { numbers, configured: requireGraphConfigured() });
    }
    if (req.method === 'POST' && url.pathname === '/api/numbers/sync') {
      try { return respond(res, 200, { synced: await syncNumbers() }); }
      catch (error) { return respond(res, 400, { error: error.message || 'number_sync_failed' }); }
    }
    return respond(res, 404, { error: 'not_found' });
  } catch (error) {
    const status = error.statusCode || (error instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error('request failed:', error.message);
    return respond(res, status, { error: status === 500 ? 'server_error' : (error.message || 'invalid_request') });
  }
});

server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 5000;
server.listen(PORT, HOST, () => console.log(`Relaydesk listening on ${HOST}:${PORT}; MySQL database ready.`));

async function shutdown(signal) {
  console.log(`Received ${signal}; closing server.`);
  server.close(async error => {
    try { await db.end(); } finally { process.exit(error ? 1 : 0); }
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function loadEnv(file) {
  let contents;
  try { contents = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at < 1) continue;
    const key = trimmed.slice(0, at).trim();
    let value = trimmed.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
