import 'dotenv/config.js';
import { fileURLToPath } from 'node:url';

export const developmentBusiness = { id: process.env.BUSINESS_ID || '00000000-0000-4000-8000-000000000001', name: process.env.BUSINESS_NAME || 'Tradies Hotline Development Business', requiresEmail: process.env.REQUIRE_EMAIL === 'true' };
export async function seedDevelopmentBusiness(pool) {
  await pool.query('INSERT INTO businesses (id, name, requires_email) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, requires_email = EXCLUDED.requires_email, updated_at = NOW()', [developmentBusiness.id, developmentBusiness.name, developmentBusiness.requiresEmail]);
  return developmentBusiness;
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
  await seedDevelopmentBusiness(pool); await pool.end(); console.log(`Seeded ${developmentBusiness.id}`);
}
