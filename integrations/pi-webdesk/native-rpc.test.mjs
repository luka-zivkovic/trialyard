import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { serve, rpc } from './native-rpc.mjs';
import { Ajv2020 } from 'ajv/dist/2020.js';

test('malformed and duplicate-key bridge messages fail without crashing the persistent server', async t => {
  const root = mkdtempSync('/tmp/pi-rpc-'), socket = `${root}/bridge.sock`; let calls = 0;
  const server = await serve(socket, async () => { calls++; return 'ok'; });
  t.after(async () => { await server.close(); rmSync(root, { recursive: true }); });
  const send = body => new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: '/rpc', method: 'POST' }, res => { let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve(JSON.parse(text))); });
    req.on('error', reject); req.end(body);
  });
  for (const body of ['{', '{}', '{"version":1,"kind":"stop","kind":"bind"}', '{"version":1,"kind":"unknown"}']) assert.equal((await send(body)).ok, false);
  assert.equal(calls, 0); assert.equal(await rpc(socket, { kind: 'stop' }), 'ok'); assert.equal(calls, 1);
});
test('native prepared frame uses an identifier and retains the path in bindings', () => {
  const schema = JSON.parse(readFileSync(new URL('../../contracts/v1.schema.json', import.meta.url)));
  const ajv = new Ajv2020({ strict: true, validateFormats: false }); ajv.addSchema(schema, 'native');
  const validate = ajv.compile({ $ref: 'native#/$defs/frame' });
  const frame = { protocol: 'trial-runner/process/v1', trialId: 'trial', messageId: 'response', replyTo: 'prepare', kind: 'prepared', payload: { leaseId: 'lease-1', bindings: { environmentSocket: '/private/tmp/pi-lease/environment.sock' }, snapshot: { state: {}, stable: true, pendingOperations: [], observedAt: new Date().toISOString() } } };
  assert.equal(validate(frame), true, JSON.stringify(validate.errors));
  frame.payload.leaseId = '/private/tmp/pi-lease'; assert.equal(validate(frame), false);
});
