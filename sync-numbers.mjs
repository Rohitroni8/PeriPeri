import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.mjs';
import { connect, initializeDatabase } from './lib/db.mjs';
import { syncNumbers } from './lib/graph.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.join(here, '.env'));

const { client, db } = await connect({ maxPoolSize: 2 });
try {
  await initializeDatabase(db);
  const { synced, pages } = await syncNumbers(db);
  console.log(`Synced ${synced} phone-number records across ${pages} page(s) into MongoDB.`);
} finally {
  await client.close();
}
