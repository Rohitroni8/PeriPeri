import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const here = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.join(here, '.env'));

const version = (process.env.WA_GRAPH_API_VERSION || '').replace(/^\/+|\/+$/g, '');
const wabaId = process.env.WA_BUSINESS_ACCOUNT_ID || '';
const accessToken = process.env.WA_ACCESS_TOKEN || '';
const missingDb = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter(key => !process.env[key]);
if (missingDb.length) throw new Error(`Missing required MySQL settings: ${missingDb.join(', ')}`);
if (!/^v\d+\.\d+$/.test(version)) throw new Error('Set WA_GRAPH_API_VERSION to the version supported by your Meta app.');
if (!/^\d+$/.test(wabaId)) throw new Error('Set WA_BUSINESS_ACCOUNT_ID to the WABA ID.');
if (!accessToken) throw new Error('Set WA_ACCESS_TOKEN in Hostinger private environment settings.');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 2,
  queueLimit: 10,
  charset: 'utf8mb4',
  connectTimeout: 10000
});

try {
  const fields = 'id,display_phone_number,verified_name,quality_rating';
  let nextUrl = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(wabaId)}/phone_numbers`);
  nextUrl.searchParams.set('fields', fields);
  nextUrl.searchParams.set('limit', '100');
  const numberMap = new Map();
  let page = 0;
  while (nextUrl) {
    if (nextUrl.protocol !== 'https:' || nextUrl.hostname !== 'graph.facebook.com') throw new Error('Meta returned an unexpected pagination host; stopped before sending credentials.');
    const response = await fetch(nextUrl, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = body?.error?.code ?? response.status;
      throw new Error(`Phone-number listing failed (${code}): ${body?.error?.message || 'Meta Graph API request failed'}`);
    }
    for (const number of body.data || []) if (number.id) numberMap.set(number.id, number);
    page += 1;
    const rawNext = body.paging?.next;
    if (!rawNext) nextUrl = null;
    else {
      const candidate = new URL(rawNext);
      if (candidate.protocol !== 'https:' || candidate.hostname !== 'graph.facebook.com') throw new Error('Meta returned an unexpected pagination URL; stopped before sending credentials.');
      candidate.searchParams.delete('access_token');
      candidate.searchParams.delete('appsecret_proof');
      nextUrl = candidate;
    }
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const number of numberMap.values()) {
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
  console.log(`Synced ${numberMap.size} phone-number records across ${page} page(s) into MySQL.`);
} finally {
  await pool.end();
}

async function loadEnv(file) {
  let contents;
  try { contents = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
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
