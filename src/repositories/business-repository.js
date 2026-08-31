export class PostgresBusinessRepository {
  constructor(pool) { this.pool = pool; }
  async create({ id, name, requiresEmail = false }) { const { rows } = await this.pool.query('INSERT INTO businesses (id, name, requires_email) VALUES ($1, $2, $3) RETURNING id, name, requires_email AS "requiresEmail", created_at AS "createdAt", updated_at AS "updatedAt"', [id, name, requiresEmail]); return rows[0]; }
  async getById(id) { const { rows } = await this.pool.query('SELECT id, name, requires_email AS "requiresEmail", created_at AS "createdAt", updated_at AS "updatedAt" FROM businesses WHERE id = $1', [id]); return rows[0] ?? null; }
}
