import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { MemoryRequestRepository, PostgresRequestRepository } from './repositories/request-repository.js';
import { MemoryKnowledgeRepository } from './knowledge/repository.js';
import { KnowledgeService } from './knowledge/service.js';
import { S3DocumentStorage, LocalDocumentStorage } from './knowledge/storage.js';
import { PostgresKnowledgeRepository } from './repositories/knowledge-repository.js';
import { IntakeReasoningService } from './reasoning/service.js';
import { RuleBasedIntakeProvider } from './reasoning/provider.js';
import { authenticateOwner, ownerTokenMap } from './security/auth.js';
import 'dotenv/config';

const root = fileURLToPath(new URL('../public', import.meta.url));
const config = { businessName: process.env.BUSINESS_NAME, requiresEmail: process.env.REQUIRE_EMAIL === 'true', businessId: process.env.PUBLIC_BUSINESS_ID ?? process.env.BUSINESS_ID ?? 'dev-business' };

// Build the document storage adapter lazily so deployments without Spaces credentials still boot.
// Returns an S3-backed adapter when all four Spaces variables are set, otherwise a local-disk stub.
function buildDocumentStorage() {
  const { SPACES_REGION, SPACES_ENDPOINT, SPACES_KEY, SPACES_SECRET, SPACES_BUCKET } = process.env;
  if (SPACES_REGION && SPACES_ENDPOINT && SPACES_KEY && SPACES_SECRET && SPACES_BUCKET) {
    return new S3DocumentStorage({
      region: SPACES_REGION,
      endpoint: SPACES_ENDPOINT,
      credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET },
      bucket: SPACES_BUCKET,
    });
  }
  console.warn('DigitalOcean Spaces credentials are not fully configured; using LocalDocumentStorage. Knowledge uploads will not persist across deploys.');
  return new LocalDocumentStorage('/tmp/knowledge');
}

// LAZY DATABASE CONNECTION: Do NOT create the Pool at module load time.
// Instead, create it on first use. This prevents serverless function crashes
// when the database is temporarily unreachable during cold starts.
let cachedPool = null;
async function getDbPool() {
  if (cachedPool) return cachedPool;
  
  const { Pool } = await import('pg');
  const { URL } = await import('node:url');
  const dbUrl = new URL(process.env.DATABASE_URL);
  
  console.log('[db] Creating PostgreSQL connection pool...');
  cachedPool = new Pool({
    host: dbUrl.hostname,
    port: parseInt(dbUrl.port, 10),
    database: dbUrl.pathname.replace('/', ''),
    user: dbUrl.username,
    password: dbUrl.password,
    ssl: { rejectUnauthorized: false },
    // Serverless timeout: allow up to 30s for a connection attempt
    connectionTimeoutMillis: 30000,
    // Idle timeout: close idle connections after 10 seconds
    idleTimeoutMillis: 10000,
    // Max pool size kept modest for serverless
    max: 2,
  });
  
  console.log('[db] PostgreSQL connection pool created successfully');
  return cachedPool;
}

async function repositoriesFromEnvironment() {
  if (!process.env.DATABASE_URL) {
    console.log('[db] No DATABASE_URL; using in-memory repositories');
    if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production');
    return { requestRepository: new MemoryRequestRepository(), knowledgeRepository: new MemoryKnowledgeRepository() };
  }
  if (!process.env.BUSINESS_ID) throw new Error('BUSINESS_ID is required when DATABASE_URL is set');
  
  try {
    const pool = await getDbPool();
    console.log('[db] Creating repository instances with PostgreSQL pool');
    return { requestRepository: new PostgresRequestRepository(pool), knowledgeRepository: new PostgresKnowledgeRepository(pool) };
  } catch (error) {
    console.error('[db] Failed to initialize database repositories:', error.message);
    throw error;
  }
}

function json(response, status, payload) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); }
async function body(request) { let raw = ''; for await (const chunk of request) raw += chunk; return JSON.parse(raw || '{}'); }
async function staticFile(response, pathname) { const file = pathname === '/' ? 'index.html' : pathname === '/owner' ? 'owner.html' : pathname.slice(1); if (file.includes('..')) return false; try { const content = await readFile(join(root, file)); const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript' }; response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }); response.end(content); return true; } catch { return false; } }

export async function createRequestHandler({ request, response }) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    const { app, ownerTokens } = await getCachedApp();
    if (request.method === 'GET' && url.pathname === '/api/config') {
      const cfg = app.config;
      return json(response, 200, cfg);
    }
    if (request.method === 'POST' && url.pathname === '/api/requests') {
      const result = await app.submitIntake(await body(request));
      return json(response, result.status, result.ok ? { requestId: result.request.id, accessToken: result.customerAccessToken } : { errors: result.errors });
    }
    const continueMatch = url.pathname.match(/^\/api\/requests\/([\w-]+)\/messages$/);
    if (request.method === 'POST' && continueMatch) {
      const payload = await body(request);
      const result = await app.continueIntake(continueMatch[1], request.headers['x-request-token'], payload.message);
      return result ? json(response, 200, result) : json(response, 404, { error: 'Request not found' });
    }
    const owner = authenticateOwner(request.headers, ownerTokens);
    if (url.pathname.startsWith('/api/owner/') || url.pathname.startsWith('/api/admin/')) { if (!owner) return json(response, 401, { error: 'Owner authentication required' }); }
    if (request.method === 'GET' && url.pathname === '/api/owner/requests') return json(response, 200, { requests: await app.listRequests(owner.businessId) });
    const match = url.pathname.match(/^\/api\/owner\/requests\/([\w-]+)$/);
    if (request.method === 'GET' && match) { const item = await app.getRequest(match[1], owner.businessId); return item ? json(response, 200, { request: item }) : json(response, 404, { error: 'Request not found' }); }
    if (request.method === 'GET' && url.pathname === '/api/admin/knowledge') return json(response, 200, { documents: await app.listKnowledge(owner.businessId) });
    if (request.method === 'POST' && url.pathname === '/api/admin/knowledge') return json(response, 201, { document: await app.uploadKnowledge(owner.businessId, await body(request)) });
    const knowledge = url.pathname.match(/^\/api\/admin\/knowledge\/([\w-]+)\/(activate|reindex)$/);
    if (request.method === 'POST' && knowledge) {
      const document = knowledge[2] === 'activate'
        ? await app.setKnowledgeActive(knowledge[1], owner.businessId, (await body(request)).isActive)
        : await app.reindexKnowledge(knowledge[1], owner.businessId);
      return document ? json(response, 200, { document }) : json(response, 404, { error: 'Document not found' });
    }
    if (request.method === 'GET' && await staticFile(response, url.pathname)) return;
    json(response, 404, { error: 'Not found' });
  } catch (error) { console.error('[handler]', error); json(response, 500, { error: 'Unable to process request' }); }
}

// Cache the app across invocations to avoid reconnecting to Postgres on every serverless request.
// Database connection is now LAZY: only created when first needed.
async function getCachedApp() {
  if (!globalThis.__tradiesAppPromise) {
    console.log('[app] Initializing Tradies app (first request)...');
    globalThis.__tradiesAppPromise = (async () => {
      const { requestRepository, knowledgeRepository } = await repositoriesFromEnvironment();
      const storage = buildDocumentStorage();
      const knowledgeService = new KnowledgeService({ repository: knowledgeRepository, storage });
      // The provider is an injected adapter: replace this configured adapter with any model provider without changing retrieval or request state.
      const provider = new RuleBasedIntakeProvider();
      const app = createApp({
        repository: requestRepository,
        knowledgeService,
        reasoningService: new IntakeReasoningService({ repository: requestRepository, knowledgeService, provider }),
        config,
      });
      
      const ownerTokens = ownerTokenMap();
      console.log('[app] Tradies app initialized successfully');
      return { app, ownerTokens };
    })();
  }
  return await globalThis.__tradiesAppPromise;
}

export async function startServer() {
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer(async (request, response) => createRequestHandler({ request, response }));
  server.listen(port, () => console.log(`Tradies Hotline listening on http://localhost:${port}`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startServer();
