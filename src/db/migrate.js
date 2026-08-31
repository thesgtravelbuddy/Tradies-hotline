import 'dotenv/config.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDirectory = fileURLToPath(new URL('../../db/migrations', import.meta.url));
export async function runMigrations(pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
  for (const filename of files) {
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename]);
    if (applied.rowCount) continue;
    const sql = await readFile(join(migrationsDirectory, filename), 'utf8'); const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const statements = sql.split(';').filter(s => s.trim());
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i].trim();
        if (!stmt) continue;
        await client.query(`SAVEPOINT sp${i}`);
        try {
          await client.query(stmt);
          await client.query(`RELEASE SAVEPOINT sp${i}`);
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT sp${i}`);
          if (err.code !== '42P07' && err.code !== '42710' && err.code !== '23505') throw err;
        }
      }
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { Pool } = await import('pg');
  const { URL } = await import('node:url');
  const dbUrl = new URL(process.env.DATABASE_URL);
  const pool = new Pool({
    host: dbUrl.hostname,
    port: parseInt(dbUrl.port, 10),
    database: dbUrl.pathname.replace('/', ''),
    user: dbUrl.username,
    password: dbUrl.password,
    ssl: { rejectUnauthorized: false },
  });
  await runMigrations(pool); await pool.end(); console.log('Migrations complete.');
}
