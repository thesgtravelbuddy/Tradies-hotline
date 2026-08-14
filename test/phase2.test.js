import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeService } from '../src/knowledge/service.js';
import { MemoryKnowledgeRepository } from '../src/knowledge/repository.js';

class TestStorage { async save(filename) { return `test/${filename}`; } }
test('semantic retrieval connects ordinary customer language to trade guidance', async () => {
  const service = new KnowledgeService({ repository: new MemoryKnowledgeRepository(), storage: new TestStorage() });
  await service.upload({ filename: 'toilet-leaks.md', tags: ['plumbing', 'toilet'], text: 'Water leaking from toilet base after flushing. Ask whether water appears every time the toilet is flushed and collect a wide photo of the bathroom.' });
  const results = await service.search('Every time I pull the chain, water comes out underneath the loo.');
  assert.equal(results.length, 1); assert.match(results[0].content, /toilet base after flushing/i); assert.equal(results[0].document.filename, 'toilet-leaks.md');
});
test('inactive knowledge is not returned and a document can be re-indexed', async () => {
  const repository = new MemoryKnowledgeRepository(); const service = new KnowledgeService({ repository, storage: new TestStorage() }); const document = await service.upload({ filename: 'sink.md', text: 'A sink leak may need details about when the water appears.' });
  await repository.setActive(document.id, false); assert.equal((await service.search('My basin leaks')).length, 0); await service.reindex(document.id); assert.ok((await repository.getDocument(document.id)).indexedAt);
});
