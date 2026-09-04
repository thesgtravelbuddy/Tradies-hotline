import { createRequestHandler } from '../src/server.js';

console.log('[vercel] api/index.js module loaded successfully.');

// Vercel invokes the default export with `(request, response)` from @vercel/node.
// Our internal `createRequestHandler` expects a single options object `{ request, response }`,
// so we adapt the signature here. Calling it with no args (the previous bug) caused
// `TypeError: Cannot destructure property 'request' of 'undefined'` on every request,
// which surfaced to Vercel as FUNCTION_INVOCATION_FAILED with no visible logs.
//
// We also wrap everything in a top-level try/catch so any failure during module init or
// request handling produces a real JSON error body (and a Vercel log line) instead of
// the opaque "500 with empty body" FUNCTION_INVOCATION_FAILED.
export default async function vercelHandler(request, response) {
  try {
    return await createRequestHandler({ request, response });
  } catch (error) {
    console.error('[vercel] handler error:', error);
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'application/json' });
    } else {
      try { response.end(); } catch { /* noop */ }
    }
    try {
      response.end(JSON.stringify({
        error: 'Internal server error',
        message: error && error.message,
      }));
    } catch {
      // Response already closed; nothing more we can do.
    }
  }
}

// Force redeploy: 2026-09-03
