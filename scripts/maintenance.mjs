// Removes expired sessions and, when MESSAGE_RETENTION_DAYS is set, messages
// older than that many days. Safe to run daily from a cron job.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/env.mjs';
import { createPool, initializeDatabase } from '../lib/db.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.join(here, '..', '.env'));

const pool = createPool({ connectionLimit: 2, queueLimit: 10 });
try {
  await initializeDatabase(pool);
  const [sessions] = await pool.execute('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  console.log(`Expired sessions removed: ${sessions.affectedRows}`);
  const days = Number(process.env.MESSAGE_RETENTION_DAYS || 0);
  if (Number.isFinite(days) && days > 0) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    let total = 0;
    for (;;) {
      const [result] = await pool.execute('DELETE FROM messages WHERE sent_at < ? LIMIT 5000', [cutoff]);
      total += result.affectedRows;
      if (result.affectedRows < 5000) break;
    }
    console.log(`Messages older than ${days} days removed: ${total}`);
  } else {
    console.log('MESSAGE_RETENTION_DAYS not set; messages are kept indefinitely.');
  }
} finally {
  await pool.end();
}
