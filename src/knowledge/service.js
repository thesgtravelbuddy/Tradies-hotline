import { cleanText, splitIntoChunks } from './chunking.js';
import { embed } from './embeddings.js';
import { newKnowledgeDocument } from './repository.js';
import { extractText } from './extraction.js';

export class KnowledgeService {
  constructor({ repository, storage }) { this.repository = repository; this.storage = storage; }
  async upload({ filename, contentType = 'text/plain', text, base64, tags = [] }) { if (!filename || (!text && !base64)) throw new Error('A document is required'); const sourceText = cleanText(extractText({ filename, text, base64 })); if (!sourceText) throw new Error('No readable text could be extracted from this document'); const document = newKnowledgeDocument({ filename, contentType, storageKey: await this.storage.save(filename, sourceText), sourceText, tags }); await this.repository.saveDocument(document); await this.reindex(document.id); return this.repository.getDocument(document.id); }
  async reindex(id) { const document = await this.repository.getDocument(id); if (!document) return null; const chunks = splitIntoChunks(document.sourceText).map((content, index) => ({ id: `${document.id}:${index}`, documentId: document.id, index, content, metadata: { filename: document.filename, tags: document.tags }, embedding: embed(content) })); await this.repository.replaceChunks(id, chunks); document.indexedAt = new Date().toISOString(); return document; }
  search(query, limit) { return this.repository.search(query, limit); }
}
