import { createRequestHandler } from '../src/server.js';

export default async function (request, response) {
  return createRequestHandler({ request, response });
}
