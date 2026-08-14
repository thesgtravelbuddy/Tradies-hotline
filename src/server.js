import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { MemoryRequestRepository, PostgresRequestRepository } from './repositories/request-repository.js';
import { MemoryKnowledgeRepository } from './knowledge/repository.js';
import { KnowledgeService } from './knowledge/service.js';
import { LocalDocumentStorage } from './knowledge/storage.js';
import { IntakeReasoningService } from './reasoning/service.js';
import { RuleBasedIntakeProvider } from './reasoning/provider.js';

const root = fileURLToPath(new URL('../public', import.meta.url));
const config = { businessName: process.env.BUSINESS_NAME, requiresEmail: process.env.REQUIRE_EMAIL === 'true' };
async function repositoryFromEnvironment() {
  if (!process.env.DATABASE_URL) return new MemoryRequestRepository();
  if (!process.env.BUSINESS_ID) throw new Error('BUSINESS_ID is required when DATABASE_URL is set');
  const { Pool } = await import('pg');
  return new PostgresRequestRepository(new Pool({ connectionString: process.env.DATABASE_URL }));
}
function json(response, status, payload) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); }
async function body(request) { let raw = ''; for await (const chunk of request) raw += chunk; return JSON.parse(raw || '{}'); }
async function staticFile(response, pathname) { const file = pathname === '/' ? 'index.html' : pathname === '/owner' ? 'owner.html' : pathname.slice(1); if (file.includes('..')) return false; try { const content = await readFile(join(root, file)); const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript' }; response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }); response.end(content); return true; } catch { return false; } }

export async function startServer() {
  const repository = await repositoryFromEnvironment(); const knowledgeService = new KnowledgeService({ repository: new MemoryKnowledgeRepository(), storage: new LocalDocumentStorage() });
  // The provider is an injected adapter: replace this configured adapter with any model provider without changing retrieval or request state.
  const provider = new RuleBasedIntakeProvider();
  const app = createApp({ repository, knowledgeService, reasoningService: new IntakeReasoningService({ repository, knowledgeService, provider }), config });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    try {
      if (request.method === 'GET' && url.pathname === '/api/config') return json(response, 200, app.config);
      if (request.method === 'POST' && url.pathname === '/api/requests') { const result = await app.submitIntake(await body(request)); return json(response, result.status, result.ok ? { request: result.request } : { errors: result.errors }); }
      const continueMatch = url.pathname.match(/^\/api\/requests\/([\w-]+)\/messages$/);
      if (request.method === 'POST' && continueMatch) { const result = await app.continueIntake(continueMatch[1], (await body(request)).message); return result ? json(response, 200, result) : json(response, 404, { error: 'Request not found' }); }
      if (request.method === 'GET' && url.pathname === '/api/owner/requests') return json(response, 200, { requests: await app.listRequests() });
      const match = url.pathname.match(/^\/api\/owner\/requests\/([\w-]+)$/);
      if (request.method === 'GET' && match) { const item = await app.getRequest(match[1]); return item ? json(response, 200, { request: item }) : json(response, 404, { error: 'Request not found' }); }
      if (request.method === 'GET' && url.pathname === '/api/admin/knowledge') return json(response, 200, { documents: await app.listKnowledge() });
      if (request.method === 'POST' && url.pathname === '/api/admin/knowledge') return json(response, 201, { document: await app.uploadKnowledge(await body(request)) });
      const knowledge = url.pathname.match(/^\/api\/admin\/knowledge\/([\w-]+)\/(activate|reindex)$/);
      if (request.method === 'POST' && knowledge) { const document = knowledge[2] === 'activate' ? await app.setKnowledgeActive(knowledge[1], (await body(request)).isActive) : await app.reindexKnowledge(knowledge[1]); return document ? json(response, 200, { document }) : json(response, 404, { error: 'Document not found' }); }
      if (request.method === 'GET' && await staticFile(response, url.pathname)) return;
      json(response, 404, { error: 'Not found' });
    } catch (error) { console.error(error); json(response, 500, { error: 'Unable to process request' }); }
  });
  const port = Number(process.env.PORT || 3000); server.listen(port, () => console.log(`Tradies Hotline listening on http://localhost:${port}`));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) startServer();
