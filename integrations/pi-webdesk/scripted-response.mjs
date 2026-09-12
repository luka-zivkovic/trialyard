import { prompts, scripts } from './scenario.mjs';
export function scriptedResponse(model, context, caseId, definition = null) {
  if (caseId === 'declared-v1') return declaredResponse(model, context, definition);
  const users = context.messages.filter(m => m.role === 'user'), latest = users.at(-1);
  const text = typeof latest?.content === 'string' ? latest.content : latest?.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const turn = Object.entries(prompts).find(([, prompt]) => prompt === text)?.[0];
  if (!turn || (caseId === 'baseline-a' ? !['first', 'followup'].includes(turn) : turn !== (caseId === 'denied-write' ? 'denied' : 'interrupted'))) throw new Error('Unexpected user turn');
  if (turn === 'followup' && (users.length !== 2 || !context.messages.some(m => m.role === 'toolResult' && m.toolCallId === 'first-write' && !m.isError))) throw new Error('Missing first-turn history');
  const results = context.messages.slice(context.messages.lastIndexOf(latest) + 1).filter(m => m.role === 'toolResult');
  for (const [i, result] of results.entries()) if (result.toolCallId !== scripts[turn][i]?.id || Boolean(result.isError) !== (turn === 'denied')) throw new Error('Unexpected tool result or order');
  const call = scripts[turn][results.length];
  return {
    role: 'assistant', content: call ? [{ type: 'toolCall', ...call }] : [{ type: 'text', text: turn === 'denied' ? 'The policy denied the write.' : 'The scripted tool sequence completed.' }],
    api: model.api, provider: model.provider, model: model.id, stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
function declaredResponse(model, context, definition) {
  const users = context.messages.filter(m => m.role === 'user'), index = users.length - 1;
  const content = message => typeof message.content === 'string' ? message.content : message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (!definition || index < 0 || index >= definition.turns.length || users.some((m, i) => content(m) !== definition.turns[i].content)) throw new Error('PI_CASE_UNEXPECTED_TURN');
  const previous = definition.provider.turns.slice(0, index).flatMap(t => t.steps), current = definition.provider.turns[index];
  const allResults = context.messages.filter(m => m.role === 'toolResult');
  const expected = [...previous, ...current.steps];
  if (allResults.length < previous.length || allResults.length > expected.length || allResults.some((r, i) => r.toolCallId !== expected[i].id || Boolean(r.isError) !== expected[i].expectError)) throw new Error('PI_CASE_UNEXPECTED_TOOL_HISTORY');
  const next = current.steps[allResults.length - previous.length];
  return { role: 'assistant', content: next ? [{ type: 'toolCall', id: next.id, name: next.name, arguments: next.arguments }] : [{ type: 'text', text: current.finalText }],
    api: model.api, provider: model.provider, model: model.id, stopReason: next ? 'toolUse' : 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
