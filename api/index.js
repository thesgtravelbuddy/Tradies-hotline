import { createRequestHandler } from '../src/server.js';

console.log('Vercel function loading started...');

export default async function (request, response) {
  console.log('Vercel function invoked.');
  return createRequestHandler({ request, response });
}
