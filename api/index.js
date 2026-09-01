console.log('Vercel bare function loaded.');

export default async function (request, response) {
  console.log('Vercel bare function invoked.');
  response.writeHead(200, { 'Content-Type': 'text/plain' });
  response.end('Hello from bare Vercel function!');
}
