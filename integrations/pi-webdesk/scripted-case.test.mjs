import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { caseContract } from './case-contract.mjs';
import { scriptedResponse } from './scripted-response.mjs';
const definition = caseContract(JSON.parse(readFileSync(new URL('./cases/recovery-direct.json', import.meta.url))));
const model = { api: 'trial-scripted', provider: 'trial-scripted', id: 'fixture' };
test('a known original-tool error continues through the declared recovery path', () => {
  const context = { messages: [{ role: 'user', content: definition.turns[0].content }] };
  assert.equal(scriptedResponse(model, context, 'declared-v1', definition).content[0].id, 'missing-read');
  context.messages.push({ role: 'toolResult', toolCallId: 'missing-read', isError: true });
  assert.equal(scriptedResponse(model, context, 'declared-v1', definition).content[0].id, 'fallback-read');
  context.messages[1].isError = false;
  assert.throws(() => scriptedResponse(model, context, 'declared-v1', definition), /UNEXPECTED_TOOL_HISTORY/);
});
test('dropped history and unknown user turns fail explicitly', () => {
  assert.throws(() => scriptedResponse(model, { messages: [{ role: 'user', content: 'unknown' }] }, 'declared-v1', definition), /UNEXPECTED_TURN/);
  assert.throws(() => scriptedResponse(model, { messages: definition.turns.map(t => ({ role: 'user', content: t.content })) }, 'declared-v1', definition), /UNEXPECTED_TOOL_HISTORY/);
});
