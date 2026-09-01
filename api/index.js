import { createRequestHandler } from '../src/server.js';

console.log('Vercel API handler loaded.');

// Vercel invokes the default export with `(request, response)` from @vercel/node.
// Our internal `createRequestHandler` expects a single options object `{ request, response }`,
// so we adapt the signature here. Calling it with no args (the previous bug) caused
// `TypeError: Cannot destructure property 'request' of 'undefined'` on every request,
// which surfaced to Vercel as FUNCTION_INVOCATION_FAILED with no visible logs.
export default async function vercelHandler(request, response) {
  return createRequestHandler({ request, response });
}
