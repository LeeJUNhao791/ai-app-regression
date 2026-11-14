import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createLibraryBackend() {
  const receipts = new Map();
  const page = readFileSync(new URL('./reserve.html', import.meta.url));
  return createServer(async (request, response) => {
    const reply = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    if (request.method === 'GET' && request.url === '/reserve') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end(page);
    }
    if (request.method === 'POST' && request.url === '/v1/reservations') {
      const chunks = [];
      let bytes = 0;
      let requestNote;
      try {
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 16 * 1024) return reply(413, { error: 'too_large' });
          chunks.push(chunk);
        }
        ({ requestNote } = JSON.parse(Buffer.concat(chunks)));
      } catch {
        return reply(400, { error: 'invalid_json' });
      }
      if (typeof requestNote !== 'string' || !requestNote.trim()) {
        return reply(400, { error: 'request_note_required' });
      }
      const number = `RES-${randomUUID()}`;
      const record = {
        receipt: { number, note: requestNote, state: 'accepted' },
        routing: { branchCode: 'branch-2', spaceType: 'study-room' },
      };
      receipts.set(number, record);
      return reply(201, record);
    }
    const lookupPrefix = '/v1/receipts/';
    const record = request.method === 'GET' && request.url.startsWith(lookupPrefix)
      ? receipts.get(request.url.slice(lookupPrefix.length)) : undefined;
    return record ? reply(200, record) : reply(404, { error: 'not_found' });
  });
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  createLibraryBackend().listen(8091, '127.0.0.1', () => {
    console.log('Library reservation example listening on http://127.0.0.1:8091/reserve');
  });
}
