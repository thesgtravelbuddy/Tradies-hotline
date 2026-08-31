export class MemoryRequestRepository {
  constructor() { this.customers = new Map(); this.requests = new Map(); this.messages = new Map(); }
  async create({ customer, request, message }) { this.customers.set(customer.id, customer); this.requests.set(request.id, request); this.messages.set(request.id, [message]); return this.getByIdForBusiness(request.id, request.businessId); }
  async list(businessId) { return [...this.requests.values()].filter((request) => request.businessId === businessId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((request) => ({ ...request, customer: this.customers.get(request.customerId) })); }
  async getById(id) { const request = this.requests.get(id); if (!request) return null; return { ...request, customer: this.customers.get(request.customerId), messages: this.messages.get(id) ?? [] }; }
  async appendMessage(id, businessId, message) { const request = this.requests.get(id); if (!request || request.businessId !== businessId) return null; this.messages.get(id).push(message); return message; }
  async updateState(id, businessId, requestState, status = 'IN_PROGRESS') { const request = this.requests.get(id); if (!request || request.businessId !== businessId) return null; request.requestState = requestState; request.status = status; request.updatedAt = new Date().toISOString(); return request; }
  async getByIdForBusiness(id, businessId) { const request = await this.getById(id); return request?.businessId === businessId ? request : null; }
  async getByCustomerToken(id, tokenHash) { const request = await this.getById(id); return request?.customerAccessTokenHash === tokenHash ? request : null; }
}

export class PostgresRequestRepository {
  constructor(pool) { this.pool = pool; }
  async create({ customer, request, message }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO customers (id, business_id, name, phone, email, service_address, preferred_contact_method, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [customer.id, customer.businessId, customer.name, customer.phone, customer.email, customer.serviceAddress, customer.preferredContactMethod, customer.createdAt]);
      await client.query('INSERT INTO requests (id, business_id, customer_id, customer_access_token_hash, status, initial_description, request_state, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [request.id, request.businessId, request.customerId, request.customerAccessTokenHash, request.status, request.initialDescription, request.requestState, request.createdAt, request.updatedAt]);
      await client.query('INSERT INTO request_messages (id, business_id, request_id, sender, body, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [message.id, request.businessId, message.requestId, message.sender, message.body, message.createdAt]);
      await client.query('COMMIT'); return this.getByIdForBusiness(request.id, request.businessId);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async list(businessId) { const { rows } = await this.pool.query("SELECT r.id, r.business_id AS \"businessId\", r.status, r.initial_description AS \"initialDescription\", r.request_state AS \"requestState\", r.created_at AS \"createdAt\", r.updated_at AS \"updatedAt\", json_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'email', c.email, 'serviceAddress', c.service_address, 'preferredContactMethod', c.preferred_contact_method) AS customer FROM requests r JOIN customers c ON c.id = r.customer_id WHERE r.business_id = $1 ORDER BY r.created_at DESC", [businessId]); return rows; }
  async getByIdForBusiness(id, businessId) { const { rows } = await this.pool.query("SELECT r.id, r.business_id AS \"businessId\", r.customer_access_token_hash AS \"customerAccessTokenHash\", r.status, r.initial_description AS \"initialDescription\", r.request_state AS \"requestState\", r.created_at AS \"createdAt\", r.updated_at AS \"updatedAt\", json_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'email', c.email, 'serviceAddress', c.service_address, 'preferredContactMethod', c.preferred_contact_method) AS customer FROM requests r JOIN customers c ON c.id = r.customer_id WHERE r.id = $1 AND r.business_id = $2", [id, businessId]); if (!rows[0]) return null; const messages = await this.pool.query('SELECT id, request_id AS "requestId", sender, body, created_at AS "createdAt" FROM request_messages WHERE request_id = $1 AND business_id = $2 ORDER BY created_at', [id, businessId]); return { ...rows[0], messages: messages.rows }; }
  async getByCustomerToken(id, tokenHash) { const { rows } = await this.pool.query('SELECT business_id AS "businessId" FROM requests WHERE id = $1 AND customer_access_token_hash = $2', [id, tokenHash]); return rows[0] ? this.getByIdForBusiness(id, rows[0].businessId) : null; }
  async appendMessage(id, businessId, message) { const { rowCount } = await this.pool.query('INSERT INTO request_messages (id, business_id, request_id, sender, body, created_at) SELECT $1, $2, $3, $4, $5, $6 WHERE EXISTS (SELECT 1 FROM requests WHERE id = $3 AND business_id = $2)', [message.id, businessId, id, message.sender, message.body, message.createdAt]); return rowCount ? message : null; }
  async updateState(id, businessId, requestState, status = 'IN_PROGRESS') { const { rows } = await this.pool.query('UPDATE requests SET request_state = $3, status = $4, updated_at = NOW() WHERE id = $1 AND business_id = $2 RETURNING id, status, request_state AS "requestState", updated_at AS "updatedAt"', [id, businessId, requestState, status]); return rows[0] ?? null; }
}
