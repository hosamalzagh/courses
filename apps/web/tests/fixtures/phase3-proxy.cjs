const http = require('node:http');
const fs = require('node:fs');

const log = process.env.COURSES_PHASE3_QUERY_LOG;
if (!log) throw new Error('COURSES_PHASE3_QUERY_LOG is required');

http.createServer((request, response) => {
  const api = request.url.startsWith('/api/') || request.url.startsWith('/sanctum/');
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: api ? 8154 : 3054,
    path: request.url,
    method: request.method,
    headers: request.headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
    if (api && request.method === 'GET' && request.url.startsWith('/api/v1/center/')) {
      const raw = upstreamResponse.headers['x-courses-query-count'];
      const count = raw === undefined ? null : Number(raw);
      fs.appendFileSync(log, JSON.stringify({
        at: new Date().toISOString(),
        host: request.headers.host,
        path: request.url,
        status: upstreamResponse.statusCode,
        count: Number.isInteger(count) ? count : null,
      }) + '\n');
    }
    upstreamResponse.pipe(response);
  });
  upstream.on('error', (error) => {
    response.writeHead(502);
    response.end(error.message);
  });
  request.pipe(upstream);
}).listen(8054, '127.0.0.1');
