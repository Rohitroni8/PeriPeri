// Writes a gzipped snapshot (one Extended JSON document per line) of the
// Relaydesk collections and prunes old ones.
// Usage: node scripts/backup.mjs            (BACKUP_DIR, BACKUP_KEEP from env)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { BSON } from 'mongodb';
const { EJSON } = BSON;
import { loadEnv } from '../lib/env.mjs';
import { connect, initializeDatabase } from '../lib/db.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.join(here, '..', '.env'));

// Sessions are deliberately excluded: they are short-lived login tokens.
// Counters are rebuilt from the restored data, so they are not needed either.
export const BACKUP_COLLECTIONS = ['phone_numbers', 'contacts', 'conversations', 'messages'];
const dir = path.resolve(process.env.BACKUP_DIR || path.join(os.homedir(), 'relaydesk-backups'));
const keep = Math.max(1, Number(process.env.BACKUP_KEEP || 14));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const finalPath = path.join(dir, `relaydesk-${stamp}.ndjson.gz`);
const tempPath = `${finalPath}.partial`;

await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
const { client, db } = await connect({ maxPoolSize: 2 });
const counts = {};
try {
  await initializeDatabase(db);
  const gzip = zlib.createGzip();
  const out = fs.createWriteStream(tempPath, { mode: 0o600 });
  const done = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); gzip.on('error', reject); });
  gzip.pipe(out);
  const write = async line => { if (!gzip.write(`${EJSON.stringify(line, { relaxed: false })}\n`)) await once(gzip, 'drain'); };
  await write({ relaydesk_backup: 2, database: 'mongodb', created_at: new Date().toISOString(), collections: BACKUP_COLLECTIONS });
  for (const name of BACKUP_COLLECTIONS) {
    counts[name] = 0;
    for await (const doc of db.collection(name).find().sort({ _id: 1 })) {
      await write({ collection: name, doc });
      counts[name] += 1;
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
  await client.close();
}

const existing = (await fsp.readdir(dir)).filter(name => /^relaydesk-.*\.ndjson\.gz$/.test(name)).sort();
for (const name of existing.slice(0, Math.max(0, existing.length - keep))) await fsp.rm(path.join(dir, name));
console.log(`Backup written: ${finalPath}`);
console.log(`Documents: ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(', ')}. Keeping newest ${keep} backup(s).`);
