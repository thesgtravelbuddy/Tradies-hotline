import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../src/db/migrate.js';
import { createRequest } from '../src/domain/request.js';
import { PostgresBusinessRepository } from '../src/repositories/business-repository.js';
import { PostgresRequestRepository } from '../src/repositories/request-repository.js';
import { PostgresKnowledgeRepository } from '../src/repositories/knowledge-repository.js';
import { createApp } from '../src/app.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgres = databaseUrl ? await import('pg') : null;
const { URL } = databaseUrl ? await import('node:url') : { URL: null };
function buildPool() {
  if (!databaseUrl) return null;
  const dbUrl = new URL(databaseUrl);
  return new postgres.Pool({
    host: dbUrl.hostname,
    port: parseInt(dbUrl.port, 10),
    database: dbUrl.pathname.replace('/', ''),
    user: dbUrl.username,
    password: dbUrl.password,
    ssl: { rejectUnauthorized: false },
  });
}
const pool = buildPool();
test.after(async () => { if (pool) await pool.end(); });
async function business(name) { const item = { id: randomUUID(), name, requiresEmail: false }; await new PostgresBusinessRepository(pool).create(item); return item; }

test('PostgreSQL persists requests, message state, and all workflow statuses', { skip: !pool && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests' }, async () => {
  await runMigrations(pool); const owner = await business('Persistence test'); const repository = new PostgresRequestRepository(pool); const entity = createRequest({ name: 'Jane', phone: '0400', serviceAddress: '1 Test St', preferredContactMethod: 'phone', description: 'A sink leak' }, { businessId: owner.id });
  await repository.create(entity); await repository.appendMessage(entity.request.id, owner.id, { id: randomUUID(), requestId: entity.request.id, sender: 'assistant', body: 'Where is the water visible?', createdAt: new Date().toISOString() });
  for (const status of ['NEW', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'READY_FOR_OWNER', 'OWNER_REVIEW', 'CONTACTED', 'COMPLETED', 'CANCELLED']) await repository.updateState(entity.request.id, owner.id, { status }, status);
  const recreatedRepository = new PostgresRequestRepository(pool); const stored = await recreatedRepository.getByIdForBusiness(entity.request.id, owner.id);
  assert.equal(stored.status, 'CANCELLED'); assert.equal(stored.messages.length, 2); assert.deepEqual(stored.requestState, { status: 'CANCELLED' });
});

test('PostgreSQL request and knowledge records are isolated by business', { skip: !pool && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests' }, async () => {
  await runMigrations(pool); const a = await business('Business A'); const b = await business('Business B'); const requests = new PostgresRequestRepository(pool); const entity = createRequest({ name: 'Pat', phone: '0401', serviceAddress: '2 Test St', preferredContactMethod: 'phone', description: 'Light is out' }, { businessId: a.id }); await requests.create(entity);
  assert.equal(await requests.getByIdForBusiness(entity.request.id, b.id), null); assert.equal((await requests.list(b.id)).length, 0);
  const knowledge = new PostgresKnowledgeRepository(pool); const document = { id: randomUUID(), businessId: a.id, filename: 'safety.md', contentType: 'text/markdown', storageKey: 'test/safety.md', sourceText: 'Safety text', tags: ['electrical'], isActive: true, indexedAt: new Date().toISOString(), createdAt: new Date().toISOString() }; await knowledge.saveDocument(document); await knowledge.replaceChunks(document.id, a.id, [{ id: randomUUID(), documentId: document.id, index: 0, content: 'Safety text', metadata: {}, embedding: {} }]);
  assert.equal((await knowledge.listDocuments(b.id)).length, 0); assert.equal(await knowledge.getDocument(document.id, b.id), null);
});

test('stored customer token is required for PostgreSQL follow-up access', { skip: !pool && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests' }, async () => {
  await runMigrations(pool); const owner = await business('Token test'); const repository = new PostgresRequestRepository(pool); const app = createApp({ repository, reasoningService: { async respond(id) { return { id }; } }, config: { businessId: owner.id } }); const created = await app.submitIntake({ name: 'Lee', phone: '0402', serviceAddress: '3 Test St', preferredContactMethod: 'phone', description: 'Blocked sink' });
  assert.equal(await app.continueIntake(created.request.id, 'wrong', 'More detail'), null); assert.deepEqual(await app.continueIntake(created.request.id, created.customerAccessToken, 'More detail'), { id: created.request.id });
});
