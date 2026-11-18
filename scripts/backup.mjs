// Writes a gzipped NDJSON snapshot of the Relaydesk tables and prunes old ones.
// Usage: node scripts/backup.mjs            (BACKUP_DIR, BACKUP_KEEP from env)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/env.mjs';
import { createPool, initializeDatabase } from '../lib/db.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.join(here, '..', '.env'));

// Sessions are deliberately excluded: they are short-lived login tokens.
export const BACKUP_TABLES = [
  ['phone_numbers', 'phone_number_id'],
  ['contacts', 'id'],
  ['conversations', 'id'],
  ['messages', 'id']
];
const dir = path.resolve(process.env.BACKUP_DIR || path.join(os.homedir(), 'relaydesk-backups'));
const keep = Math.max(1, Number(process.env.BACKUP_KEEP || 14));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const finalPath = path.join(dir, `relaydesk-${stamp}.ndjson.gz`);
const tempPath = `${finalPath}.partial`;

await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
const pool = createPool({ connectionLimit: 2, queueLimit: 10 });
const counts = {};
try {
  await initializeDatabase(pool);
  const gzip = zlib.createGzip();
  const out = fs.createWriteStream(tempPath, { mode: 0o600 });
  const done = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); gzip.on('error', reject); });
  gzip.pipe(out);
  const write = async line => { if (!gzip.write(`${JSON.stringify(line)}\n`)) await once(gzip, 'drain'); };
  await write({ relaydesk_backup: 1, created_at: new Date().toISOString(), tables: BACKUP_TABLES.map(t => t[0]) });
  for (const [table, key] of BACKUP_TABLES) {
    counts[table] = 0;
    let last = null;
    for (;;) {
      const [rows] = await pool.query(
        `SELECT * FROM \`${table}\` ${last === null ? '' : `WHERE \`${key}\` > ?`} ORDER BY \`${key}\` LIMIT 1000`,
        last === null ? [] : [last]
      );
      for (const row of rows) await write({ table, row });
      counts[table] += rows.length;
      if (rows.length < 1000) break;
      last = rows[rows.length - 1][key];
    }
  }
  await write({ end: true, counts });
  gzip.end();
  await done;
  await fsp.rename(tempPath, finalPath);
} catch (error) {
  await fsp.rm(tempPath, { force: true });
  throw error;
} finally {
  await pool.end();
}

const existing = (await fsp.readdir(dir)).filter(name => /^relaydesk-.*\.ndjson\.gz$/.test(name)).sort();
for (const name of existing.slice(0, Math.max(0, existing.length - keep))) await fsp.rm(path.join(dir, name));
console.log(`Backup written: ${finalPath}`);
console.log(`Rows: ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(', ')}. Keeping newest ${keep} backup(s).`);
