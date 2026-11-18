import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.mjs';
import { createPool, initializeDatabase } from './lib/db.mjs';
import { syncNumbers } from './lib/graph.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.join(here, '.env'));

const pool = createPool({ connectionLimit: 2, queueLimit: 10 });
try {
  await initializeDatabase(pool);
  const { synced, pages } = await syncNumbers(pool);
  console.log(`Synced ${synced} phone-number records across ${pages} page(s) into MySQL.`);
} finally {
  await pool.end();
}
