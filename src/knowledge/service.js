import { cleanText, splitIntoChunks } from './chunking.js';
import { embed } from './embeddings.js';
import { newKnowledgeDocument } from './repository.js';
import { extractText } from './extraction.js';

export class KnowledgeService {
  constructor({ repository, storage }) { this.repository = repository; this.storage = storage; }
  async upload({ businessId, filename, contentType = 'text/plain', text, base64, tags = [] }) { if (!businessId || !filename || (!text && !base64)) throw new Error('A business and document are required'); const sourceText = cleanText(extractText({ filename, text, base64 })); if (!sourceText) throw new Error('No readable text could be extracted from this document'); const document = newKnowledgeDocument({ businessId, filename, contentType, storageKey: await this.storage.save(filename, sourceText), sourceText, tags }); await this.repository.saveDocument(document); await this.reindex(document.id, businessId); return this.repository.getDocument(document.id, businessId); }
  async reindex(id, businessId) { const document = await this.repository.getDocument(id, businessId); if (!document) return null; const indexedAt = new Date().toISOString(); const chunks = splitIntoChunks(document.sourceText).map((content, index) => ({ id: `${document.id}:${index}`, documentId: document.id, index, content, metadata: { filename: document.filename, tags: document.tags }, embedding: embed(content) })); await this.repository.replaceChunks(id, businessId, chunks); document.indexedAt = indexedAt; if (this.repository.replaceDocument) await this.repository.replaceDocument(document); return document; }
  search(query, options) { return this.repository.search(query, options); }
}
