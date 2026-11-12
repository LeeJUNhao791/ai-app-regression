import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createAlternateBackend() {
  const orders = new Map();
  return createServer(async (request, response) => {
    const reply = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    if (request.method === 'POST' && request.url === '/v2/orders') {
      const chunks = [];
      let bytes = 0;
      let input;
      try {
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 16 * 1024) return reply(413, { error: 'too_large' });
          chunks.push(chunk);
        }
        input = JSON.parse(Buffer.concat(chunks));
      } catch {
        return reply(400, { error: 'invalid_json' });
      }
      if (typeof input?.description !== 'string' || !input.description.trim()) {
        return reply(400, { error: 'description_required' });
      }
      const reference = `WO-${randomUUID()}`;
      const record = {
        order: { reference, description: input.description, state: 'resolved' },
        classification: { asset: 'pump-1', issue: 'leak' },
      };
      orders.set(reference, record);
      return reply(201, record);
    }
    const record = request.method === 'GET' && request.url.startsWith('/v2/orders/')
      ? orders.get(request.url.slice('/v2/orders/'.length)) : undefined;
    return record ? reply(200, record) : reply(404, { error: 'not_found' });
  });
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  createAlternateBackend().listen(8090, '127.0.0.1', () => {
    console.log('Alternate backend listening on http://127.0.0.1:8090');
  });
}
