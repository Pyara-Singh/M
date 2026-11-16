const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7463021)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const dir = path.join(__dirname, '..', 'migrations');
    for (const name of (await fs.readdir(dir)).filter(n => n.endsWith('.sql')).sort()) {
      if ((await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name])).rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(await fs.readFile(path.join(dir, name), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      console.log(`Applied ${name}`);
    }
  } finally { await client.query('SELECT pg_advisory_unlock(7463021)'); client.release(); await pool.end(); }
}
migrate().catch(error => { console.error(error); process.exitCode = 1; });
