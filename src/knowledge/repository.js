import { randomUUID } from 'node:crypto';
import { cosine, embed } from './embeddings.js';

export class MemoryKnowledgeRepository {
  constructor() { this.documents = new Map(); this.chunks = new Map(); }
  async saveDocument(document) { this.documents.set(document.id, document); return document; }
  async replaceChunks(documentId, chunks) { this.chunks.set(documentId, chunks); }
  async listDocuments() { return [...this.documents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async getDocument(id) { return this.documents.get(id) ?? null; }
  async setActive(id, isActive) { const document = this.documents.get(id); if (!document) return null; document.isActive = isActive; return document; }
  async search(query, limit = 5) { const vector = embed(query); return [...this.documents.values()].filter((document) => document.isActive).flatMap((document) => (this.chunks.get(document.id) ?? []).map((chunk) => ({ ...chunk, document, score: cosine(vector, chunk.embedding) }))).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit); }
}

export function newKnowledgeDocument({ filename, contentType, storageKey, sourceText, tags = [] }) { return { id: randomUUID(), filename, contentType, storageKey, sourceText, tags, isActive: true, indexedAt: null, createdAt: new Date().toISOString() }; }
