// Explicitly loaded by Pi. The provider is substituted; the original tool
// definitions and Pi's own agent/session/RPC implementation execute unchanged.
import { appendFileSync, openSync, closeSync, fsyncSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { prompts, scripts, expectedCalls } from './scenario.mjs';
import { callbackGate } from './callback-gate.mjs';

export default function probe(pi) {
  const root = process.env.TRIAL_PROBE_DIR;
  const caseId = process.env.TRIAL_PROBE_CASE;
  if (!root || !caseId) throw new Error('Missing explicit feasibility configuration');
  let sequence = 0;
  function record(kind, data) {
    const fd = openSync(join(root, 'raw.jsonl'), 'a', 0o600);
    try { appendFileSync(fd, JSON.stringify({ sequence: ++sequence, at: new Date().toISOString(), kind, ...data }) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  const gate = callbackGate({ calls: expectedCalls(caseId), record, permitted: id => existsSync(join(root, `${id}.permit`)) });
  for (const factory of [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition]) {
    const original = factory(process.cwd());
    pi.registerTool({
      ...original,
      async execute(toolCallId, input, signal, onUpdate, ctx) {
        return gate({ id: toolCallId, tool: original.name, input, signal, execute: () => original.execute(toolCallId, input, signal, onUpdate, ctx) });
      },
    });
  }
  pi.on('tool_result', async event => { record('pi.tool_result', { event }); });
  pi.registerProvider('trial-scripted', {
    // Satisfies Pi's custom-provider registration; no network implementation.
    baseUrl: 'http://127.0.0.1:1/unused', apiKey: 'local-scripted-placeholder',
    api: 'trial-scripted',
    models: [{ id: 'fixture', name: 'Local scripted feasibility fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const output = {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'pending', timestamp: Date.now(),
      };
      try {
        record('scripted.request', { model: { provider: model.provider, id: model.id }, context });
        if (options?.signal?.aborted) throw new Error('Scripted request aborted');
        const users = context.messages.filter(m => m.role === 'user');
        const latest = users.at(-1);
        const text = typeof latest?.content === 'string' ? latest.content : latest?.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        const turn = Object.entries(prompts).find(([, prompt]) => prompt === text)?.[0];
        if (!turn || (caseId.startsWith('baseline-') ? !['first', 'followup'].includes(turn) : turn !== (caseId === 'denied-write' ? 'denied' : 'interrupted'))) throw new Error('Unexpected user turn');
        if (turn === 'followup' && (users.length !== 2 || !context.messages.some(m => m.role === 'toolResult' && m.toolCallId === 'first-write' && !m.isError))) throw new Error('Missing first-turn history');
        const tail = context.messages.slice(context.messages.lastIndexOf(latest) + 1);
        const results = tail.filter(m => m.role === 'toolResult');
        for (const [i, result] of results.entries()) {
          if (result.toolCallId !== scripts[turn][i]?.id || Boolean(result.isError) !== (turn === 'denied')) throw new Error('Unexpected tool result or result order');
        }
        const call = scripts[turn][results.length];
        output.content = call ? [{ type: 'toolCall', ...call }] : [{ type: 'text', text: turn === 'denied' ? 'The policy denied the write.' : 'The scripted tool sequence completed.' }];
        output.stopReason = call ? 'toolUse' : 'stop';
        record('scripted.response', { output });
        stream.push({ type: 'start', partial: output });
        stream.push({ type: 'done', reason: output.stopReason, message: output });
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
        output.errorMessage = String(error);
        record('scripted.error', { error: String(error) });
        stream.push({ type: 'error', reason: output.stopReason, error: output });
      }
      stream.end();
      return stream;
    },
  });
}
