import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { authenticateOwner, ownerTokenMap } from '../src/security/auth.js';
import { MemoryRequestRepository } from '../src/repositories/request-repository.js';

const intake = { name: 'Pat', phone: '0400', serviceAddress: '1 Test Street', preferredContactMethod: 'phone', description: 'A leak.' };
test('owner bearer tokens authenticate only their configured business', () => {
  const tokens = ownerTokenMap('{"token-for-a":"business-a","token-for-b":"business-b"}');
  assert.deepEqual(authenticateOwner({ authorization: 'Bearer token-for-a' }, tokens), { businessId: 'business-a' });
  assert.equal(authenticateOwner({ authorization: 'Bearer wrong-token' }, tokens), null);
});
test('request data is isolated by business and customer continuation needs its secret token', async () => {
  const repository = new MemoryRequestRepository(); const reasoningService = { async respond(id) { return { id }; } };
  const appA = createApp({ repository, reasoningService, config: { businessId: 'business-a' } }); const appB = createApp({ repository, reasoningService, config: { businessId: 'business-b' } });
  const created = await appA.submitIntake(intake); await appB.submitIntake({ ...intake, name: 'Other business' });
  assert.equal((await appA.listRequests('business-a')).length, 1); assert.equal((await appB.listRequests('business-b')).length, 1); assert.equal(await appB.getRequest(created.request.id, 'business-b'), null);
  assert.equal(await appA.continueIntake(created.request.id, 'wrong-token', 'More detail'), null); assert.deepEqual(await appA.continueIntake(created.request.id, created.customerAccessToken, 'More detail'), { id: created.request.id });
});
