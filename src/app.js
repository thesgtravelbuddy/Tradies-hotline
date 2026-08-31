import { createHash } from 'node:crypto';
import { createRequest, validateIntake } from './domain/request.js';

export function createApp({ repository, knowledgeService, reasoningService, config = {} }) {
  const options = { requiresEmail: config.requiresEmail === true, businessId: config.businessId ?? 'dev-business' };
  return {
    config: { businessName: config.businessName ?? 'Your Trade Business', requiresEmail: options.requiresEmail },
    async submitIntake(payload) { const validation = validateIntake(payload, options); if (!validation.valid) return { ok: false, status: 422, errors: validation.errors }; const entity = createRequest(payload, options); const created = await repository.create(entity); return { ok: true, status: 201, request: created, customerAccessToken: entity.customerAccessToken }; },
    listRequests: (businessId) => repository.list(businessId),
    getRequest: (id, businessId) => repository.getByIdForBusiness(id, businessId),
    uploadKnowledge: (businessId, document) => knowledgeService.upload({ ...document, businessId }),
    listKnowledge: (businessId) => knowledgeService.repository.listDocuments(businessId),
    setKnowledgeActive: (id, businessId, isActive) => knowledgeService.repository.setActive(id, businessId, isActive),
    reindexKnowledge: (id, businessId) => knowledgeService.reindex(id, businessId),
    retrieveKnowledge: (query, options) => knowledgeService.search(query, options),
    async continueIntake(id, accessToken, message) { const hash = createHash('sha256').update(accessToken ?? '').digest('hex'); const request = await repository.getByCustomerToken(id, hash); return request ? reasoningService.respond(id, request.businessId, message) : null; }
  };
}
