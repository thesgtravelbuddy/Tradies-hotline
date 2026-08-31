import { randomUUID } from 'node:crypto';
import { cosine, embed } from './embeddings.js';

export class MemoryKnowledgeRepository {
  constructor() { this.documents = new Map(); this.chunks = new Map(); }
  async saveDocument(document) { this.documents.set(document.id, document); return document; }
  async replaceChunks(documentId, businessId, chunks) { const document = this.documents.get(documentId); if (document?.businessId === businessId) this.chunks.set(documentId, chunks); }
  async listDocuments(businessId) { return [...this.documents.values()].filter((document) => document.businessId === businessId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async getDocument(id, businessId) { const document = this.documents.get(id); return document?.businessId === businessId ? document : null; }
  async setActive(id, businessId, isActive) { const document = this.documents.get(id); if (!document || document.businessId !== businessId) return null; document.isActive = isActive; return document; }
  async search(query, { businessId, limit = 5 } = {}) { const vector = embed(query); return [...this.documents.values()].filter((document) => document.isActive && document.businessId === businessId).flatMap((document) => (this.chunks.get(document.id) ?? []).map((chunk) => ({ ...chunk, document, score: cosine(vector, chunk.embedding) }))).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit); }
}

export function newKnowledgeDocument({ businessId, filename, contentType, storageKey, sourceText, tags = [] }) { return { id: randomUUID(), businessId, filename, contentType, storageKey, sourceText, tags, isActive: true, indexedAt: null, createdAt: new Date().toISOString() }; }
