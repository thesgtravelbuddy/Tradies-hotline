import { randomUUID } from 'node:crypto';
import { validateDecision } from './provider.js';

export class IntakeReasoningService {
  constructor({ repository, knowledgeService, provider }) { this.repository = repository; this.knowledgeService = knowledgeService; this.provider = provider; }
  async respond(requestId, customerMessage) {
    const request = await this.repository.getById(requestId); if (!request) return null;
    const text = String(customerMessage ?? '').trim(); if (!text) throw new Error('A customer message is required');
    const retrievedKnowledge = await this.knowledgeService.search(`${request.initialDescription}\n${text}`, 4);
    const decision = validateDecision(await this.provider.decide({ customerMessage: text, requestState: request.requestState ?? {}, previousAnswers: request.messages, retrievedKnowledge: retrievedKnowledge.map(({ content, metadata }) => ({ content, metadata })), safetyRules: ['Never diagnose, prescribe a repair, or claim a cause.', 'Escalate possible immediate safety risks.'] }));
    const state = { ...(request.requestState ?? {}), facts: { ...(request.requestState?.facts ?? {}), ...decision.updated_facts }, asked: decision.question ? [...new Set([...(request.requestState?.asked ?? []), decision.missing_important_information[0]])] : (request.requestState?.asked ?? []), safetyFlag: decision.safety_flag, readyForOwner: decision.ready_for_owner, lastDecision: decision };
    const now = new Date().toISOString(); await this.repository.appendMessage(requestId, { id: randomUUID(), requestId, sender: 'customer', body: text, createdAt: now }); if (decision.question) await this.repository.appendMessage(requestId, { id: randomUUID(), requestId, sender: 'assistant', body: decision.question, createdAt: now }); await this.repository.updateState(requestId, state, decision.ready_for_owner ? 'complete' : 'in_progress');
    return { decision, retrievedKnowledge: retrievedKnowledge.map(({ document, content, score }) => ({ documentId: document.id, filename: document.filename, content, score })) };
  }
}
