// Runs Relaydesk locally with the simulated Meta API and sample conversations,
// so the interface can be explored without a real WhatsApp number.
// Usage: npm run demo   (starts a throwaway MongoDB; nothing is kept)
//    or: MONGODB_URI=mongodb://... npm run demo   (uses and resets database relaydesk_demo)
// Sign in with demo@relaydesk.test / demo-password-2026 (override with DEMO_EMAIL / DEMO_PASSWORD).
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const memory = process.env.MONGODB_URI ? null : await MongoMemoryReplSet.create({ replSet: { count: 1 } });
const MONGODB_URI = process.env.MONGODB_URI || memory.getUri();
const PORT = Number(process.env.PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'demo-app-secret';
const PHONE = '1148479081159296';
const env = {
  ...process.env, MONGODB_URI, MONGODB_DB: 'relaydesk_demo', NODE_ENV: 'development', PORT: String(PORT), HOST: process.env.HOST || '0.0.0.0',
  ADMIN_EMAIL: process.env.DEMO_EMAIL || 'demo@relaydesk.test', ADMIN_PASSWORD: process.env.DEMO_PASSWORD || 'demo-password-2026',
  WA_VERIFY_TOKEN: 'demo-verify', META_APP_SECRET: SECRET, WA_BUSINESS_ACCOUNT_ID: '999000111',
  WA_ACCESS_TOKEN: 'demo-token', WA_GRAPH_API_VERSION: 'v99.0'
};

const mongo = await MongoClient.connect(MONGODB_URI);
await mongo.db('relaydesk_demo').dropDatabase();
await mongo.close();

const app = spawn(process.execPath, ['--import', './test/mock-graph.mjs', 'app.mjs'], { cwd: root, env, stdio: 'inherit' });
process.on('SIGINT', () => app.kill('SIGINT'));
process.on('SIGTERM', () => app.kill('SIGTERM'));
app.on('exit', async code => { await memory?.stop(); process.exit(code ?? 0); });
for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 100)); }

const now = Math.floor(Date.now() / 1000);
async function post(value) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '999000111', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE }, ...value } }] }] });
  const res = await fetch(`${BASE}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}` }, body: raw });
  if (!res.ok) throw new Error(`seed webhook failed: ${res.status}`);
}
let n = 0;
const inbound = (from, name, text, agoSeconds, extra = {}) => post({ contacts: [{ wa_id: from, profile: { name } }], messages: [{ id: `wamid.DEMO${++n}`, from, timestamp: String(now - agoSeconds), type: 'text', text: { body: text }, ...extra }] });

// Sign in through the API to seed outbound replies the same way the UI does.
const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = (p, body) => fetch(`${BASE}${p}`, { method: body ? 'POST' : 'GET', headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());

await api('/api/numbers/sync', {});
await inbound('447700900101', 'Maya Patel', 'Hi! Checking on the delivery for order 4817.', 1500);
await inbound('447700900101', 'Maya Patel', 'Could you share the updated delivery window?', 1380);
const convs = async () => (await api('/api/conversations?state=all')).conversations;
await inbound('447700900101', 'Maya Patel', '', 600, { type: 'image', text: undefined, image: { id: 'MEDIA_DEMO1', mime_type: 'image/png', caption: 'This is the label on the parcel' } });
await inbound('447700900101', 'Maya Patel', 'Also, can I change the delivery address?', 240);
const maya = (await convs()).find(c => c.wa_id === '447700900101');
const reply = await api(`/api/conversations/${maya.id}/messages`, { text: 'Of course! The carrier says Thursday 9–12. Send me the new address and I will update it.' });
await post({ statuses: [{ id: reply.wa_message_id, status: 'read', timestamp: String(now), recipient_id: '447700900101' }] });

await inbound('447700900102', 'Noah Williams', 'Do you have a team plan for 20 people?', 3 * 86400);
await inbound('447700900103', 'Aisha Khan', 'Could you resend last month’s invoice please?', 5400);
const aisha = (await convs()).find(c => c.wa_id === '447700900103');
const sent = await api(`/api/conversations/${aisha.id}/messages`, { text: 'Sure — sending it over shortly.' });
await post({ statuses: [{ id: sent.wa_message_id, status: 'delivered', timestamp: String(now), recipient_id: '447700900103' }] });
await inbound('919800000104', 'Arjun Mehta', 'Is this available in the smaller size?', 26 * 3600);
await inbound('447700900105', 'Sofia Garcia', 'Thanks, that works for me 👍', 900);
const sofia = (await convs()).find(c => c.wa_id === '447700900105');
await api(`/api/conversations/${sofia.id}/state`, { state: 'closed' });
await api('/api/conversations', { phone_number_id: PHONE, to: '+44 0000 000000', template: { name: 'hello', language: 'en_US' } }).catch(() => {});

console.log(`\nDemo ready at ${BASE}  —  sign in with ${env.ADMIN_EMAIL} / ${env.ADMIN_PASSWORD}`);
console.log('Meta is simulated: replies, templates and syncs never leave this machine. Ctrl+C to stop.');
