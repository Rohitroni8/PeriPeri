// Removes expired sessions and, when MESSAGE_RETENTION_DAYS is set, messages
// older than that many days. Safe to run daily from a cron job.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/env.mjs';
import { connect, initializeDatabase } from '../lib/db.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.join(here, '..', '.env'));

const { client, db } = await connect({ maxPoolSize: 2 });
try {
  await initializeDatabase(db);
  const sessions = await db.collection('sessions').deleteMany({ expires_at: { $lt: Date.now() } });
  console.log(`Expired sessions removed: ${sessions.deletedCount}`);
  const days = Number(process.env.MESSAGE_RETENTION_DAYS || 0);
  if (Number.isFinite(days) && days > 0) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const result = await db.collection('messages').deleteMany({ sent_at: { $lt: cutoff } });
    console.log(`Messages older than ${days} days removed: ${result.deletedCount}`);
  } else {
    console.log('MESSAGE_RETENTION_DAYS not set; messages are kept indefinitely.');
  }
} finally {
  await client.close();
}
