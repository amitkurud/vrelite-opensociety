import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import { neon } from '@neondatabase/serverless'
import pg from 'pg'
import * as schema from './schema'

// Factory: build a Drizzle client from an explicit connection string.
// - Neon hosts use the stateless neon-http driver — ideal for per-request use on
//   Cloudflare Workers (no connection pooling/cleanup) and works the same in Node.
// - Any other PostgreSQL server (self-hosted) uses node-postgres with one pooled
//   connection set per connection string, since callers create a client per request.
// Cloudflare Workers has no process.env at module-load time; the connection
// string arrives per-request via the fetch handler's `env`, so callers there
// use createDb(env.DATABASE_URL).
export function createDb(connectionString: string): Database {
  if (isNeon(connectionString)) {
    const sql = neon(connectionString)
    return drizzle({ client: sql, schema })
  }
  return createPgDb(connectionString)
}

// Self-hosted clients are shaped like the Neon client (incl. an atomic batch()).
export type Database = NeonHttpDatabase<typeof schema>

function isNeon(connectionString: string) {
  try {
    return new URL(connectionString).hostname.endsWith('.neon.tech')
  } catch {
    return false
  }
}

type BatchQuery = { toSQL(): { sql: string; params: unknown[] } }
const pools = new Map<string, Database>()

function createPgDb(connectionString: string): Database {
  const cached = pools.get(connectionString)
  if (cached) return cached
  const pool = new pg.Pool({ connectionString, max: Number(process.env.DATABASE_POOL_MAX ?? 10) })
  // Idle-client errors (e.g. a Postgres restart) must not crash the process; the
  // pool discards the client and the next query reconnects.
  pool.on('error', (err) => console.error('postgres pool error:', err.message))
  const db = drizzlePg({ client: pool, schema })
  // neon-http's batch() runs its queries in one transaction; match that here so
  // callers that rely on atomic batches behave the same on plain PostgreSQL.
  const batch = async (queries: BatchQuery[]) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const results = []
      for (const query of queries) {
        const { sql, params } = query.toSQL()
        results.push((await client.query(sql, params)).rows)
      }
      await client.query('COMMIT')
      return results
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }
  const database = Object.assign(db, { batch }) as unknown as Database
  pools.set(connectionString, database)
  return database
}

// Closes self-hosted pools so a Node process can exit cleanly on shutdown.
export async function closeDbPools() {
  const all = [...pools.values()]
  pools.clear()
  await Promise.all(all.map((db) => (db as unknown as { $client: pg.Pool }).$client.end()))
}

// Convenience for Node contexts (scripts/tests) where DATABASE_URL is present.
let cached: Database | undefined
export function getDb(): Database {
  if (!cached) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set')
    cached = createDb(url)
  }
  return cached
}
