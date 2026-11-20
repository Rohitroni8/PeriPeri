// Replaces the Relaydesk collections with the contents of a backup file.
// Usage: node scripts/restore.mjs <backup.ndjson.gz> --yes
//
// The backup is loaded into temporary collections and checked first; the live
// collections are only swapped out once the whole file has loaded correctly,
// so a truncated or invalid file leaves the current data untouched.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { BSON } from 'mongodb';
const { EJSON } = BSON;
import { loadEnv } from '../lib/env.mjs';
import { connect, createIndexes } from '../lib/db.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.join(here, '..', '.env'));

const file = process.argv[2];
if (!file || !process.argv.includes('--yes')) {
  console.error('Usage: node scripts/restore.mjs <backup.ndjson.gz> --yes\nThis DELETES the current conversations, contacts, numbers and messages and replaces them with the backup.');
  process.exit(2);
}

const ORDER = ['phone_numbers', 'contacts', 'conversations', 'messages'];
const staging = name => `restore_tmp_${name}`;
const { client, db } = await connect({ maxPoolSize: 2 });
try {
  for (const name of ORDER) {
    await db.collection(staging(name)).drop().catch(() => {});
    // Unique indexes also reject a backup that contains duplicates; rename keeps them.
    await db.createCollection(staging(name));
    await createIndexes(db, name, staging(name));
  }
  let header = null, footer = null;
  const counts = Object.fromEntries(ORDER.map(t => [t, 0]));
  const batches = new Map(ORDER.map(t => [t, []]));
  const flush = async name => {
    const docs = batches.get(name);
    if (docs.length) await db.collection(staging(name)).insertMany(docs, { ordered: true });
    batches.set(name, []);
  };
  const lines = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = EJSON.parse(line, { relaxed: true });
    if (!header) {
      if (record.relaydesk_backup !== 2 || record.database !== 'mongodb') throw new Error('Not a Relaydesk MongoDB backup file.');
      header = record;
      continue;
    }
    if (record.end) { footer = record; continue; }
    if (!batches.has(record.collection)) throw new Error(`Unexpected collection in backup: ${record.collection}`);
    if (!record.doc || record.doc._id === undefined) throw new Error(`Document without _id in ${record.collection}`);
    batches.get(record.collection).push(record.doc);
    counts[record.collection] += 1;
    if (batches.get(record.collection).length >= 500) await flush(record.collection);
  }
  for (const name of ORDER) await flush(name);
  if (!footer) throw new Error('Backup file is truncated (no end marker); nothing was restored.');
  for (const name of ORDER) if ((footer.counts?.[name] ?? counts[name]) !== counts[name]) throw new Error(`Document count mismatch for ${name}.`);

  for (const name of ORDER) {
    await db.collection(staging(name)).rename(name, { dropTarget: true });
  }
  // New IDs must continue after the highest restored one.
  for (const name of ['contacts', 'conversations', 'messages']) {
    const [top] = await db.collection(name).find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).toArray();
    await db.collection('counters').updateOne({ _id: name }, { $set: { seq: top ? Number(top._id) : 0 } }, { upsert: true });
  }
  console.log(`Restored backup from ${header.created_at}: ${ORDER.map(t => `${t}=${counts[t]}`).join(', ')}.`);
} catch (error) {
  console.error(`Restore failed; current data was not changed: ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const name of ORDER) await db.collection(staging(name)).drop().catch(() => {});
  await client.close();
}
