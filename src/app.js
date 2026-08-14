import { createRequest, validateIntake } from './domain/request.js';

export function createApp({ repository, knowledgeService, reasoningService, config = {} }) {
  const options = { requiresEmail: config.requiresEmail === true };
  return {
    config: { businessName: config.businessName ?? 'Your Trade Business', requiresEmail: options.requiresEmail },
    async submitIntake(payload) { const validation = validateIntake(payload, options); if (!validation.valid) return { ok: false, status: 422, errors: validation.errors }; const created = await repository.create(createRequest(payload, options)); return { ok: true, status: 201, request: created }; },
    listRequests: () => repository.list(),
    getRequest: (id) => repository.getById(id),
    uploadKnowledge: (document) => knowledgeService.upload(document),
    listKnowledge: () => knowledgeService.repository.listDocuments(),
    setKnowledgeActive: (id, isActive) => knowledgeService.repository.setActive(id, isActive),
    reindexKnowledge: (id) => knowledgeService.reindex(id),
    retrieveKnowledge: (query, limit) => knowledgeService.search(query, limit),
    continueIntake: (id, message) => reasoningService.respond(id, message)
  };
}
