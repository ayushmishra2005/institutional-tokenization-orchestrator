import { getConfig } from '../platform/config/index.js';
import { createDbHandle } from './pool.js';
import { runMigrations } from './migrator.js';

const config = getConfig();
const handle = createDbHandle({ url: config.DATABASE_URL, maxConnections: 2 });

try {
  const applied = await runMigrations(handle.pool);
  console.log(applied.length === 0 ? 'no pending migrations' : `applied: ${applied.join(', ')}`);
} finally {
  await handle.close();
}
