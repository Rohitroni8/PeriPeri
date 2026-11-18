// End-to-end test: starts the real app against a real MySQL/MariaDB database,
// with Meta's Graph API replaced by test/mock-graph.mjs.
// Usage: DB_HOST=127.0.0.1 DB_USER=... DB_PASSWORD=... DB_NAME=relaydesk_test node test/e2e.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!/test/i.test(process.env.DB_NAME || '')) throw new Error('Refusing to run: DB_NAME must contain "test" because this suite wipes the database.');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'relaydesk-e2e-'));
const graphLog = path.join(work, 'graph.log');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE;
const env = {
  ...process.env,
  NODE_ENV: 'production', PORT: String(PORT), HOST: '127.0.0.1',
  ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'correct-horse-battery-staple',
  WA_VERIFY_TOKEN: 'verify-me', META_APP_SECRET: 'app-secret-for-tests',
  WA_BUSINESS_ACCOUNT_ID: '999000111', WA_ACCESS_TOKEN: 'test-token', WA_GRAPH_API_VERSION: 'v99.0',
  MOCK_GRAPH_LOG: graphLog, BACKUP_DIR: path.join(work, 'backups'), BACKUP_KEEP: '2'
};
const PHONE = '1148479081159296';

const db = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME });
await db.query('SET FOREIGN_KEY_CHECKS=0');
for (const t of ['messages', 'conversations', 'contacts', 'phone_numbers', 'sessions']) await db.query(`DROP TABLE IF EXISTS \`${t}\``);
await db.query('SET FOREIGN_KEY_CHECKS=1');

let passed = 0;
const results = [];
async function step(name, fn) {
  try { await fn(); passed += 1; results.push(`  ✓ ${name}`); }
  catch (error) { results.push(`  ✗ ${name}\n    ${error.message.split('\n').slice(0, 8).join('\n    ')}`); throw error; }
}
const graphCalls = () => fs.existsSync(graphLog) ? fs.readFileSync(graphLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
let cookie = '';
async function call(method, p, body, { headers = {}, raw = false } = {}) {
  const res = await fetch(BASE + p, {
    method, redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: ORIGIN } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  if (raw) return res;
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
}
function signed(payload, secret = env.META_APP_SECRET) {
  const raw = JSON.stringify(payload);
  return { raw, sig: `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}` };
}
async function webhook(payload, secret) {
  const { raw, sig } = signed(payload, secret);
  const res = await fetch(`${BASE}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const envelope = value => ({ object: 'whatsapp_business_account', entry: [{ id: env.WA_BUSINESS_ACCOUNT_ID, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '447862617669', phone_number_id: PHONE }, ...value } }] }] });
const nowSec = () => Math.floor(Date.now() / 1000);
const inbound = (id, from, text, ts = nowSec(), name = 'Test Customer') => envelope({ contacts: [{ wa_id: from, profile: { name } }], messages: [{ id, from, timestamp: String(ts), type: 'text', text: { body: text } }] });
const status = (id, s, extra = {}) => envelope({ statuses: [{ id, status: s, timestamp: String(nowSec()), recipient_id: '447700900001', ...extra }] });

const app = spawn(process.execPath, ['--import', './test/mock-graph.mjs', 'app.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let appOutput = '';
app.stdout.on('data', d => { appOutput += d; });
app.stderr.on('data', d => { appOutput += d; });
const exited = new Promise(resolve => app.on('exit', resolve));

try {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ }
    if (app.exitCode !== null) throw new Error(`App exited during startup:\n${appOutput}`);
    await new Promise(r => setTimeout(r, 100));
  }

  await step('health reports database and config status without secrets', async () => {
    const r = await call('GET', '/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { status: 'ok', database: 'ok', whatsapp_configured: true, webhook_configured: true });
    assert.match(r.headers.get('strict-transport-security'), /max-age/);
  });

  await step('schema created with all tables and added columns', async () => {
    const [cols] = await db.query("SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('messages','conversations')");
    const names = cols.map(c => c.c);
    for (const c of ['media_id', 'media_mime', 'error_title', 'last_inbound_at']) assert.ok(names.includes(c), c);
  });

  await step('static UI served with CSP; unknown paths 404; traversal rejected', async () => {
    const r = await call('GET', '/', undefined, { raw: true });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await call('GET', '/nope.js')).status, 404);
    assert.notEqual((await call('GET', '/..%2F.env.example')).status, 200);
  });

  await step('API requires a session', async () => {
    assert.equal((await call('GET', '/api/conversations')).status, 401);
  });

  await step('login rejects wrong password, missing/foreign origin; accepts valid admin', async () => {
    assert.equal((await call('POST', '/api/auth/login', { email: env.ADMIN_EMAIL, password: 'wrong-password-123' })).status, 401);
    const foreign = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }) });
    assert.equal(foreign.status, 403);
    const noOrigin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }) });
    assert.equal(noOrigin.status, 403, 'production requires an Origin header');
    const ok = await call('POST', '/api/auth/login', { email: ' ADMIN@example.test ', password: env.ADMIN_PASSWORD });
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Secure/);
    cookie = setCookie.split(';')[0];
    assert.equal((await call('GET', '/api/auth/status')).data.authenticated, true);
  });

  await step('webhook verification handshake', async () => {
    const good = await fetch(`${BASE}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
    assert.equal(good.status, 200); assert.equal(await good.text(), '12345');
    assert.equal((await fetch(`${BASE}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status, 403);
  });

  await step('webhook rejects bad signatures', async () => {
    assert.equal((await webhook(inbound('wamid.X', '447700900001', 'hi'), 'wrong-secret')).status, 401);
    const unsigned = await fetch(`${BASE}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(inbound('wamid.X', '447700900001', 'hi')) });
    assert.equal(unsigned.status, 401);
    const [[{ n }]] = await db.query('SELECT COUNT(*) n FROM messages');
    assert.equal(Number(n), 0);
  });

  let convA;
  await step('inbound text stored; redelivery is idempotent', async () => {
    const r = await webhook(inbound('wamid.IN1', '447700900001', 'Hello, is my order shipped?'));
    assert.equal(r.status, 200); assert.equal(r.data.messages, 1);
    const again = await webhook(inbound('wamid.IN1', '447700900001', 'Hello, is my order shipped?'));
    assert.equal(again.data.messages, 0);
    const list = await call('GET', '/api/conversations');
    assert.equal(list.data.conversations.length, 1);
    convA = list.data.conversations[0];
    assert.equal(convA.profile_name, 'Test Customer');
    assert.equal(convA.unread_count, 1);
    assert.equal(convA.window_open, true);
    assert.equal(convA.last_message_preview, 'Hello, is my order shipped?');
  });

  await step('older out-of-order inbound does not replace newer preview', async () => {
    await webhook(inbound('wamid.IN0', '447700900001', 'earlier message', nowSec() - 600));
    const c = (await call('GET', '/api/conversations')).data.conversations[0];
    assert.equal(c.last_message_preview, 'Hello, is my order shipped?');
    assert.equal(c.unread_count, 2);
  });

  let imageMessageId;
  await step('inbound image stored with media reference and caption', async () => {
    const payload = envelope({ contacts: [{ wa_id: '447700900001', profile: { name: 'Test Customer' } }], messages: [{ id: 'wamid.IMG1', from: '447700900001', timestamp: String(nowSec()), type: 'image', image: { id: 'MEDIA123', mime_type: 'image/jpeg', caption: 'Damaged box' } }] });
    assert.equal((await webhook(payload)).status, 200);
    const msgs = (await call('GET', `/api/conversations/${convA.id}/messages`)).data.messages;
    const img = msgs.find(m => m.message_type === 'image');
    assert.equal(img.body, 'Damaged box'); assert.equal(img.has_media, true); assert.equal(img.media_mime, 'image/jpeg');
    assert.equal(msgs[0].body, 'earlier message', 'messages ordered by sent time');
    imageMessageId = img.id;
  });

  await step('opening a conversation clears unread count', async () => {
    const c = (await call('GET', '/api/conversations')).data.conversations[0];
    assert.equal(c.unread_count, 0);
  });

  await step('media proxy streams bytes with safe headers', async () => {
    const r = await call('GET', `/api/messages/${imageMessageId}/media`, undefined, { raw: true });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.match(r.headers.get('content-disposition'), /^inline/);
    assert.match(r.headers.get('content-security-policy'), /sandbox/);
    assert.equal(await r.text(), 'FAKEJPEGBYTES');
    const calls = graphCalls().filter(c => c.host === 'lookaside.fbsbx.com');
    assert.equal(calls.length, 1); assert.equal(calls[0].auth, 'Bearer test-token');
    assert.equal((await call('GET', `/api/messages/999999/media`)).status, 404);
  });

  await step('number sync follows pagination and strips echoed token', async () => {
    const r = await call('POST', '/api/numbers/sync', {});
    assert.equal(r.status, 200); assert.equal(r.data.synced, 3); assert.equal(r.data.pages, 2);
    const pageCalls = graphCalls().filter(c => c.path.endsWith('/phone_numbers'));
    assert.equal(pageCalls.length, 2);
    assert.equal(pageCalls[1].query.access_token, undefined);
    const numbers = (await call('GET', '/api/numbers')).data.numbers;
    const mine = numbers.find(n => n.phone_number_id === PHONE);
    assert.equal(mine.display_phone_number, '+44 7862 617669');
    assert.equal(mine.open_conversations, 1);
  });

  let outId;
  await step('text reply inside window is sent through Graph API', async () => {
    const r = await call('POST', `/api/conversations/${convA.id}/messages`, { text: 'Yes, it ships today.' });
    assert.equal(r.status, 201); assert.match(r.data.wa_message_id, /^wamid\.OUT/);
    outId = r.data.wa_message_id;
    const sent = graphCalls().filter(c => c.method === 'POST' && c.path.endsWith('/messages')).at(-1);
    assert.equal(sent.path, `/v99.0/${PHONE}/messages`);
    assert.deepEqual(sent.body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '447700900001', type: 'text', text: { preview_url: false, body: 'Yes, it ships today.' } });
  });

  await step('status webhooks never move backwards; failures record error', async () => {
    await webhook(status(outId, 'delivered'));
    await webhook(status(outId, 'sent'));
    let [[m]] = await db.query('SELECT status FROM messages WHERE wa_message_id=?', [outId]);
    assert.equal(m.status, 'delivered');
    await webhook(status(outId, 'read'));
    [[m]] = await db.query('SELECT status FROM messages WHERE wa_message_id=?', [outId]);
    assert.equal(m.status, 'read');
    await webhook(status(outId, 'failed', { errors: [{ code: 131049, title: 'Not delivered to maintain ecosystem health' }] }));
    [[m]] = await db.query('SELECT status, error_code, error_title FROM messages WHERE wa_message_id=?', [outId]);
    assert.deepEqual({ ...m }, { status: 'failed', error_code: '131049', error_title: 'Not delivered to maintain ecosystem health' });
  });

  let convOld;
  await step('free-form reply refused when 24h window is closed', async () => {
    await webhook(inbound('wamid.OLD1', '447700900002', 'old question', nowSec() - 2 * 86400, 'Old Customer'));
    convOld = (await call('GET', '/api/conversations?q=Old')).data.conversations[0];
    assert.equal(convOld.window_open, false);
    const before = graphCalls().length;
    const r = await call('POST', `/api/conversations/${convOld.id}/messages`, { text: 'hi' });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'window_closed');
    assert.equal(graphCalls().length, before, 'no Graph call made');
  });

  await step('templates: only approved listed; unsupported ones flagged', async () => {
    const r = await call('GET', '/api/templates');
    assert.equal(r.status, 200);
    const names = r.data.templates.map(t => t.name);
    assert.deepEqual(names, ['hello', 'order_update', 'promo_image']);
    const order = r.data.templates.find(t => t.name === 'order_update');
    assert.equal(order.body_params, 2); assert.equal(order.header_params, 1); assert.equal(order.supported, true);
    assert.equal(r.data.templates.find(t => t.name === 'promo_image').supported, false);
  });

  await step('template send works outside window and validates variables', async () => {
    const bad = await call('POST', `/api/conversations/${convOld.id}/template`, { name: 'order_update', language: 'en_GB', body_params: ['Sam'], header_params: ['#1'] });
    assert.equal(bad.status, 400);
    const unsupported = await call('POST', `/api/conversations/${convOld.id}/template`, { name: 'promo_image', language: 'en_US' });
    assert.equal(unsupported.status, 400);
    const r = await call('POST', `/api/conversations/${convOld.id}/template`, { name: 'order_update', language: 'en_GB', body_params: ['Sam', 'on its way'], header_params: ['#4817'] });
    assert.equal(r.status, 201);
    const sent = graphCalls().filter(c => c.method === 'POST' && c.path.endsWith('/messages')).at(-1);
    assert.deepEqual(sent.body.template, { name: 'order_update', language: { code: 'en_GB' }, components: [
      { type: 'header', parameters: [{ type: 'text', text: '#4817' }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Sam' }, { type: 'text', text: 'on its way' }] }] });
    const msgs = (await call('GET', `/api/conversations/${convOld.id}/messages`)).data.messages;
    assert.equal(msgs.at(-1).body, 'Order #4817\n\nHi Sam, your order is on its way.\n\nElite Gold Signal');
  });

  await step('new conversation via template; bad input rejected; Meta failure recorded', async () => {
    assert.equal((await call('POST', '/api/conversations', { phone_number_id: PHONE, to: 'abc', template: { name: 'hello', language: 'en_US' } })).status, 400);
    assert.equal((await call('POST', '/api/conversations', { phone_number_id: '42', to: '+44 7700 900123', template: { name: 'hello', language: 'en_US' } })).status, 400);
    const ok = await call('POST', '/api/conversations', { phone_number_id: PHONE, to: '+44 7700 900123', template: { name: 'hello', language: 'en_US' } });
    assert.equal(ok.status, 201, JSON.stringify(ok.data)); assert.ok(ok.data.conversation_id);
    const conv = (await call('GET', `/api/conversations/${ok.data.conversation_id}`)).data.conversation;
    assert.equal(conv.wa_id, '447700900123'); assert.equal(conv.window_open, false);
    const fail = await call('POST', '/api/conversations', { phone_number_id: PHONE, to: '+44 0000 000000', template: { name: 'hello', language: 'en_US' } });
    assert.equal(fail.status, 502); assert.equal(fail.data.code, '131026');
    const [[m]] = await db.query("SELECT status, error_code FROM messages WHERE direction='outbound' ORDER BY id DESC LIMIT 1");
    assert.deepEqual({ ...m }, { status: 'failed', error_code: '131026' });
  });

  await step('close / reopen conversation and state filters', async () => {
    assert.equal((await call('POST', `/api/conversations/${convA.id}/state`, { state: 'closed' })).status, 200);
    assert.ok(!(await call('GET', '/api/conversations?state=open')).data.conversations.some(c => c.id === convA.id));
    assert.ok((await call('GET', '/api/conversations?state=closed')).data.conversations.some(c => c.id === convA.id));
    await webhook(inbound('wamid.IN9', '447700900001', 'one more thing'));
    assert.ok((await call('GET', '/api/conversations?state=open')).data.conversations.some(c => c.id === convA.id), 'new inbound reopens');
    assert.equal((await call('POST', `/api/conversations/${convA.id}/state`, { state: 'bogus' })).status, 400);
    assert.equal((await call('POST', '/api/conversations/987654/state', { state: 'open' })).status, 404);
  });

  await step('filter by number and search', async () => {
    assert.equal((await call('GET', `/api/conversations?state=all&phone=${PHONE}`)).data.conversations.length, 4, 'includes the conversation whose first template failed');
    assert.equal((await call('GET', '/api/conversations?state=all&phone=100000000000001')).data.conversations.length, 0);
    assert.equal((await call('GET', '/api/conversations?state=all&q=900002')).data.conversations.length, 1);
  });

  await step('mutating API calls from a foreign origin are rejected', async () => {
    const r = await call('POST', `/api/conversations/${convA.id}/state`, { state: 'closed' }, { headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  });

  await step('overview counts', async () => {
    const o = (await call('GET', '/api/overview')).data;
    assert.equal(o.conversations, 4); assert.equal(o.numbers, 3); assert.equal(o.whatsapp_configured, true);
  });

  await step('backup → wipe → restore drill reproduces data exactly', async () => {
    const snapshot = async () => {
      const out = {};
      for (const t of ['phone_numbers', 'contacts', 'conversations', 'messages']) [out[t]] = await db.query(`SELECT * FROM \`${t}\` ORDER BY 1`);
      return JSON.stringify(out);
    };
    const before = await snapshot();
    execFileSync(process.execPath, ['scripts/backup.mjs'], { cwd: root, env, stdio: 'pipe' });
    execFileSync(process.execPath, ['scripts/backup.mjs'], { cwd: root, env, stdio: 'pipe' });
    execFileSync(process.execPath, ['scripts/backup.mjs'], { cwd: root, env, stdio: 'pipe' });
    const files = fs.readdirSync(env.BACKUP_DIR).sort();
    assert.equal(files.length, 2, 'retention keeps BACKUP_KEEP files');
    assert.equal(fs.statSync(path.join(env.BACKUP_DIR, files[1])).mode & 0o777, 0o600);
    await db.query('SET FOREIGN_KEY_CHECKS=0');
    await db.query('DELETE FROM messages'); await db.query('DELETE FROM conversations');
    await db.query('SET FOREIGN_KEY_CHECKS=1');
    assert.throws(() => execFileSync(process.execPath, ['scripts/restore.mjs', path.join(env.BACKUP_DIR, files[1])], { cwd: root, env, stdio: 'pipe' }), 'requires --yes');
    const out = execFileSync(process.execPath, ['scripts/restore.mjs', path.join(env.BACKUP_DIR, files[1]), '--yes'], { cwd: root, env, stdio: 'pipe' }).toString();
    assert.match(out, /Restored backup/);
    assert.equal(await snapshot(), before);
    // A truncated backup must not destroy current data.
    const truncated = path.join(work, 'truncated.ndjson.gz');
    const zlib = await import('node:zlib');
    const lines = zlib.gunzipSync(fs.readFileSync(path.join(env.BACKUP_DIR, files[1]))).toString().trim().split('\n');
    fs.writeFileSync(truncated, zlib.gzipSync(lines.slice(0, -2).join('\n')));
    assert.throws(() => execFileSync(process.execPath, ['scripts/restore.mjs', truncated, '--yes'], { cwd: root, env, stdio: 'pipe' }));
    assert.equal(await snapshot(), before, 'failed restore rolled back');
  });

  await step('maintenance applies message retention', async () => {
    await db.query("UPDATE messages SET sent_at='2020-01-01T00:00:00.000Z' WHERE wa_message_id='wamid.IN0'");
    const out = execFileSync(process.execPath, ['scripts/maintenance.mjs'], { cwd: root, env: { ...env, MESSAGE_RETENTION_DAYS: '365' }, stdio: 'pipe' }).toString();
    assert.match(out, /removed: 1/);
    const [[{ n }]] = await db.query("SELECT COUNT(*) n FROM messages WHERE wa_message_id='wamid.IN0'");
    assert.equal(Number(n), 0);
  });

  await step('sync-numbers CLI works', async () => {
    const out = execFileSync(process.execPath, ['--import', './test/mock-graph.mjs', 'sync-numbers.mjs'], { cwd: root, env, stdio: 'pipe' }).toString();
    assert.match(out, /Synced 3 phone-number records across 2 page/);
  });

  await step('logout ends the session', async () => {
    assert.equal((await call('POST', '/api/auth/logout', {})).status, 200);
    assert.equal((await call('GET', '/api/conversations')).status, 401);
    cookie = '';
  });

  await step('login throttled after 10 failures', async () => {
    for (let i = 0; i < 10; i += 1) assert.equal((await call('POST', '/api/auth/login', { email: env.ADMIN_EMAIL, password: `nope-${i}-xxxxxxxx` })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD })).status, 429);
  });

  await step('no Graph request ever carried the token in the URL', async () => {
    assert.ok(graphCalls().every(c => !c.query.access_token));
  });
} catch (error) {
  process.exitCode = 1;
  if (!results.some(r => r.includes('✗'))) results.push(`  ✗ ${error.message}`);
} finally {
  app.kill('SIGTERM');
  await exited;
  await db.end();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(results.join('\n'));
  console.log(`\n${passed} passed${process.exitCode ? ', 1 failed' : ''}`);
  if (process.exitCode) console.log(`\nApp output:\n${appOutput}`);
}
