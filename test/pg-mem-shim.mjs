// Stands in for the `pg` module so server/db.js runs against an in-memory
// Postgres. Lets the real journal code — real queries, real route handlers —
// be exercised without a database server.
//
// Not a substitute for Postgres. pg-mem is more permissive in places, so a
// green run here is strong evidence rather than proof; the first deploy is
// the real confirmation.
import { newDb } from 'pg-mem';

export const memDb = newDb({ autoCreateForeignKeyIndices: true });

// pg-mem doesn't implement every builtin the app touches.
memDb.public.registerFunction({
  name: 'now', returns: 'timestamptz', implementation: () => new Date(),
});

const { Pool: MemPool, Client } = memDb.adapters.createPg();

// db.js calls pool.on('error', …); pg-mem's pool may not be an EventEmitter.
class Pool extends MemPool {
  on(...args) { return typeof super.on === 'function' ? super.on(...args) : this; }
}

export default { Pool, Client };
export { Pool, Client };
