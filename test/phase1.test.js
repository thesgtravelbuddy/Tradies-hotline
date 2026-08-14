import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { MemoryRequestRepository } from '../src/repositories/request-repository.js';

const intake = { name: 'John Smith', phone: '0400 000 000', email: 'john@example.com', serviceAddress: '10 Example Street', preferredContactMethod: 'phone', description: 'My kitchen sink is leaking.' };

test('customer intake creates a new request, customer and initial text message', async () => {
  const app = createApp({ repository: new MemoryRequestRepository() });
  const result = await app.submitIntake(intake);
  assert.equal(result.status, 201); assert.equal(result.request.status, 'new'); assert.equal(result.request.customer.name, 'John Smith'); assert.equal(result.request.messages[0].body, intake.description);
});

test('invalid contact data is rejected before storage', async () => {
  const repository = new MemoryRequestRepository(); const app = createApp({ repository, config: { requiresEmail: true } });
  const result = await app.submitIntake({ ...intake, email: '', phone: '' });
  assert.equal(result.status, 422); assert.equal(result.errors.email, 'Email is required'); assert.equal(result.errors.phone, 'Required'); assert.deepEqual(await app.listRequests(), []);
});

test('owner can list and open submitted request details', async () => {
  const app = createApp({ repository: new MemoryRequestRepository() }); const created = await app.submitIntake(intake); const requests = await app.listRequests(); const detail = await app.getRequest(created.request.id);
  assert.equal(requests.length, 1); assert.equal(requests[0].customer.serviceAddress, intake.serviceAddress); assert.equal(detail.initialDescription, intake.description); assert.equal(detail.messages.length, 1);
});
