// Replaces the Relaydesk tables with the contents of a backup file.
// Usage: node scripts/restore.mjs <backup.ndjson.gz> --yes
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/env.mjs';
import { createPool, initializeDatabase } from '../lib/db.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.join(here, '..', '.env'));

const file = process.argv[2];
if (!file || !process.argv.includes('--yes')) {
  console.error('Usage: node scripts/restore.mjs <backup.ndjson.gz> --yes\nThis DELETES the current conversations, contacts, numbers and messages and replaces them with the backup.');
  process.exit(2);
}

const ORDER = ['phone_numbers', 'contacts', 'conversations', 'messages'];
const pool = createPool({ connectionLimit: 2, queueLimit: 10 });
const connection = await (async () => { await initializeDatabase(pool); return pool.getConnection(); })();
try {
  const [cols] = await connection.query('SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()');
  const allowed = new Map(ORDER.map(t => [t, new Set()]));
  for (const { t, c } of cols) allowed.get(t)?.add(c);

  let header = null, footer = null;
  const counts = Object.fromEntries(ORDER.map(t => [t, 0]));
  const batches = new Map();
  const flush = async table => {
    const rows = batches.get(table);
    if (!rows?.length) return;
    const columns = Object.keys(rows[0]);
    await connection.query(`INSERT INTO \`${table}\` (${columns.map(c => `\`${c}\``).join(',')}) VALUES ?`, [rows.map(r => columns.map(c => r[c]))]);
    batches.set(table, []);
  };

  await connection.beginTransaction();
  await connection.query('SET FOREIGN_KEY_CHECKS=0');
  for (const table of [...ORDER].reverse()) await connection.query(`DELETE FROM \`${table}\``);
  // Create the reader only now: lines emitted during the awaits above would be lost.
  const lines = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (!header) {
      if (record.relaydesk_backup !== 1) throw new Error('Not a Relaydesk backup file.');
      header = record;
      continue;
    }
    if (record.end) { footer = record; continue; }
    const columns = allowed.get(record.table);
    if (!columns) throw new Error(`Unexpected table in backup: ${record.table}`);
    for (const key of Object.keys(record.row)) if (!columns.has(key)) throw new Error(`Unexpected column ${record.table}.${key}`);
    const batch = batches.get(record.table) || [];
    if (batch.length && Object.keys(batch[0]).join() !== Object.keys(record.row).join()) await flush(record.table);
    (batches.get(record.table) || batches.set(record.table, []).get(record.table)).push(record.row);
    counts[record.table] += 1;
    if (batches.get(record.table).length >= 500) await flush(record.table);
  }
  for (const table of ORDER) await flush(table);
  if (!footer) throw new Error('Backup file is truncated (no end marker); nothing was restored.');
  for (const table of ORDER) if ((footer.counts?.[table] ?? counts[table]) !== counts[table]) throw new Error(`Row count mismatch for ${table}.`);
  await connection.query('SET FOREIGN_KEY_CHECKS=1');
  await connection.commit();
  console.log(`Restored backup from ${header.created_at}: ${ORDER.map(t => `${t}=${counts[t]}`).join(', ')}.`);
} catch (error) {
  await connection.rollback();
  await connection.query('SET FOREIGN_KEY_CHECKS=1').catch(() => {});
  console.error(`Restore failed and was rolled back: ${error.message}`);
  process.exitCode = 1;
} finally {
  connection.release();
  await pool.end();
}
