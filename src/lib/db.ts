// Database connection utility
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  console.warn(
    "[db] DATABASE_URL is not set. Database connections will fail. " +
    "Set DATABASE_URL in your environment or Kubernetes secrets."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Log pool errors instead of crashing the process
pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

/** Pool stats for health checks */
export function getPoolStats() {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
}

export default pool;
