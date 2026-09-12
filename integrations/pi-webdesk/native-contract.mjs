import { Ajv } from 'ajv';
import { isDeepStrictEqual } from 'node:util';
import { caseSchema } from './case-contract.mjs';
export const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const text = { type: 'string', minLength: 1, maxLength: 4096 }, id = { type: 'string', minLength: 1, maxLength: 100 };
const anyObject = { type: 'object' };
const request = (kind, fields = {}) => object({ version: { const: 1 }, kind: { const: kind }, ...fields });
export const bridgeSchema = { anyOf: [
  request('bind', { socket: text }), request('turn', { turnId: id, content: text }), request('stop'),
  request('tool.propose', { invocationId: id, tool: { enum: ['read', 'write', 'edit', 'bash'] }, input: anyObject }),
  request('tool.dispatch', { invocationId: id }),
  request('tool.result', { invocationId: id, result: { anyOf: [anyObject, { type: 'null' }] }, error: { anyOf: [text, { type: 'null' }] } }),
  request('model.intent', { invocationId: id, input: anyObject }),
  request('model.observed', { invocationId: id }),
  request('model.result', { invocationId: id, output: anyObject }),
] };
const validate = new Ajv({ strict: true }).compile(bridgeSchema);
export function bridgeRequest(value) {
  if (!validate(value)) throw new Error('INVALID_PI_BRIDGE_REQUEST');
  if (value.kind === 'tool.result' && (value.error === null) === (value.result === null)) throw new Error('CONTRADICTORY_TOOL_RESULT');
  return value;
}
export const nativeToolSchemas = ['read', 'write', 'edit', 'bash'].map(name => ({
  name, input: object({ invocationId: id, input: anyObject }), output: anyObject,
}));
const legacyFixtureSchema = object({
  case: { enum: ['baseline-a', 'denied-write', 'interrupted-write'] }, files: anyObject,
  session: { anyOf: [anyObject, { type: 'null' }] }, observations: { type: 'array', items: anyObject, maxItems: 200 }, runtime: anyObject,
});
export const fixtureSchema = { anyOf: [legacyFixtureSchema, object({
  case: { const: 'declared-v1' }, definition: caseSchema, files: anyObject,
  session: { anyOf: [anyObject, { type: 'null' }] }, observations: { type: 'array', items: anyObject, maxItems: 200 }, runtime: anyObject,
})] };
export class InvocationLedger {
  calls = new Map();
  propose(invocationId, tool, input) {
    if (this.calls.has(invocationId) || this.calls.size >= 50) throw new Error('DUPLICATE_OR_EXCESS_INVOCATION');
    const call = { invocationId, tool, input: structuredClone(input), operationId: null, phase: 'proposed', outcome: null };
    this.calls.set(invocationId, call); return call;
  }
  get(id) { const call = this.calls.get(id); if (!call) throw new Error('UNKNOWN_INVOCATION'); return call; }
  admit(id, tool, input, operationId) {
    const call = this.get(id);
    if (call.phase !== 'proposed' || call.tool !== tool || !isDeepStrictEqual(call.input, input)) throw new Error('INVALID_CALLBACK_ADMISSION');
    Object.assign(call, { operationId, phase: 'admitted' }); return call;
  }
  async dispatch(id, acknowledge) {
    const call = this.get(id);
    if (call.phase !== 'admitted') throw new Error('INVALID_CALLBACK_DISPATCH');
    call.phase = 'acknowledging'; // A concurrent duplicate cannot cross the barrier.
    await acknowledge(call.operationId);
    if (call.phase !== 'acknowledging') throw new Error('STOPPED_DURING_DISPATCH_ACK');
    call.phase = 'dispatched'; return call;
  }
  finish(id, outcome) {
    const call = this.get(id);
    if ((outcome === 'not_dispatched' && call.phase !== 'admitted') || (outcome !== 'not_dispatched' && call.phase !== 'dispatched')) throw new Error('INVALID_CALLBACK_RESULT');
    call.phase = 'closed'; call.outcome = outcome; return call;
  }
  stop() { for (const call of this.calls.values()) if (call.phase !== 'closed') { call.phase = 'stopped'; call.outcome = 'outcome_unknown'; } }
}
