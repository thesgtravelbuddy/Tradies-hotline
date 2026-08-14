export class MemoryRequestRepository {
  constructor() { this.customers = new Map(); this.requests = new Map(); this.messages = new Map(); }
  async create({ customer, request, message }) { this.customers.set(customer.id, customer); this.requests.set(request.id, request); this.messages.set(request.id, [message]); return this.getById(request.id); }
  async list() { return [...this.requests.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((request) => ({ ...request, customer: this.customers.get(request.customerId) })); }
  async getById(id) { const request = this.requests.get(id); if (!request) return null; return { ...request, customer: this.customers.get(request.customerId), messages: this.messages.get(id) ?? [] }; }
  async appendMessage(id, message) { if (!this.requests.has(id)) return null; this.messages.get(id).push(message); return message; }
  async updateState(id, requestState, status = 'in_progress') { const request = this.requests.get(id); if (!request) return null; request.requestState = requestState; request.status = status; request.updatedAt = new Date().toISOString(); return request; }
}

export class PostgresRequestRepository {
  constructor(pool) { this.pool = pool; }
  async create({ customer, request, message }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO customers (id, business_id, name, phone, email, service_address, preferred_contact_method, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [customer.id, process.env.BUSINESS_ID, customer.name, customer.phone, customer.email, customer.serviceAddress, customer.preferredContactMethod, customer.createdAt]);
      await client.query('INSERT INTO requests (id, business_id, customer_id, status, initial_description, request_state, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [request.id, process.env.BUSINESS_ID, request.customerId, request.status, request.initialDescription, request.requestState, request.createdAt, request.updatedAt]);
      await client.query('INSERT INTO request_messages (id, request_id, sender, body, created_at) VALUES ($1, $2, $3, $4, $5)', [message.id, message.requestId, message.sender, message.body, message.createdAt]);
      await client.query('COMMIT'); return this.getById(request.id);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async list() { const { rows } = await this.pool.query("SELECT r.id, r.status, r.initial_description AS \"initialDescription\", r.request_state AS \"requestState\", r.created_at AS \"createdAt\", r.updated_at AS \"updatedAt\", json_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'email', c.email, 'serviceAddress', c.service_address, 'preferredContactMethod', c.preferred_contact_method) AS customer FROM requests r JOIN customers c ON c.id = r.customer_id ORDER BY r.created_at DESC"); return rows; }
  async getById(id) { const { rows } = await this.pool.query("SELECT r.id, r.status, r.initial_description AS \"initialDescription\", r.request_state AS \"requestState\", r.created_at AS \"createdAt\", r.updated_at AS \"updatedAt\", json_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'email', c.email, 'serviceAddress', c.service_address, 'preferredContactMethod', c.preferred_contact_method) AS customer FROM requests r JOIN customers c ON c.id = r.customer_id WHERE r.id = $1", [id]); if (!rows[0]) return null; const messages = await this.pool.query('SELECT id, request_id AS "requestId", sender, body, created_at AS "createdAt" FROM request_messages WHERE request_id = $1 ORDER BY created_at', [id]); return { ...rows[0], messages: messages.rows }; }
  async appendMessage(id, message) { await this.pool.query('INSERT INTO request_messages (id, request_id, sender, body, created_at) VALUES ($1, $2, $3, $4, $5)', [message.id, id, message.sender, message.body, message.createdAt]); return message; }
  async updateState(id, requestState, status = 'in_progress') { const { rows } = await this.pool.query('UPDATE requests SET request_state = $2, status = $3, updated_at = NOW() WHERE id = $1 RETURNING id, status, request_state AS "requestState", updated_at AS "updatedAt"', [id, requestState, status]); return rows[0] ?? null; }
}
