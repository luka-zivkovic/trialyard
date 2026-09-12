import { createServer, request as httpRequest } from 'node:http';
import { bridgeRequest } from './native-contract.mjs';
import { parseJson } from '../../src/contracts/strict-json.ts';
const LIMIT = 1048576;
export function bounded(promise, ms = 45000) {
  let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PI_BRIDGE_TIMEOUT')), ms); })]).finally(() => clearTimeout(timer));
}
export function rpc(socket, request) {
  const payload = Buffer.from(JSON.stringify(bridgeRequest({ version: 1, ...request })));
  if (payload.length > LIMIT) throw new Error('PI_BRIDGE_LIMIT');
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: socket, path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length } }, res => {
      let bytes = 0; const chunks = [];
      res.on('data', chunk => { bytes += chunk.length; if (bytes > LIMIT) res.destroy(new Error('PI_BRIDGE_LIMIT')); else chunks.push(chunk); });
      res.on('error', reject); res.on('end', () => {
        try { const result = parseJson(Buffer.concat(chunks)); if (res.statusCode !== 200 || result.ok !== true || !Object.hasOwn(result, 'value')) throw new Error(result.error ?? 'PI_BRIDGE_FAILED'); resolve(result.value); } catch (error) { reject(error); }
      });
    });
    req.setTimeout(45000, () => req.destroy(new Error('PI_BRIDGE_TIMEOUT'))); req.on('error', reject); req.end(payload);
  });
}
export async function serve(socket, handler) {
  const server = createServer(async (req, res) => {
    let timer;
    try {
      if (req.method !== 'POST' || req.url !== '/rpc') throw new Error('INVALID_PI_BRIDGE_ROUTE');
      timer = setTimeout(() => req.destroy(), 3000);
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > LIMIT) throw new Error('PI_BRIDGE_LIMIT'); chunks.push(chunk); }
      clearTimeout(timer);
      const value = await bounded(handler(bridgeRequest(parseJson(Buffer.concat(chunks)))));
      const body = JSON.stringify({ ok: true, value }); if (Buffer.byteLength(body) > LIMIT) throw new Error('PI_BRIDGE_LIMIT');
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(body);
    } catch (error) { if (!res.destroyed) { res.writeHead(200); res.end(JSON.stringify({ ok: false, error: String(error.message).slice(0, 200) })); } }
    finally { clearTimeout(timer); }
  });
  server.maxConnections = 24; server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  return { close: () => bounded(new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }), 2000) };
}
export function deferred() {
  let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
  promise.catch(() => {}); return { promise, resolve, reject };
}
