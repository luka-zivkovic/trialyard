import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { rpc } from './native-rpc.mjs';
import { scriptedResponse } from './scripted-response.mjs';
import { readFileSync } from 'node:fs';
import { caseContract } from './case-contract.mjs';

export default function nativeProbe(pi) {
  const socket = process.env.TRIAL_PI_SOCKET, caseId = process.env.TRIAL_PI_CASE;
  if (!socket || !caseId) throw new Error('Missing native bridge configuration');
  const definition = caseId === 'declared-v1' ? caseContract(JSON.parse(readFileSync(process.env.TRIAL_PI_DEFINITION, 'utf8'))) : null;
  // Load this extension before the original policy. This gate records intent,
  // then yields to that policy; it does not make the approval decision.
  pi.on('tool_call', async event => {
    await rpc(socket, { kind: 'tool.propose', invocationId: event.toolCallId, tool: event.toolName, input: event.input });
  });
  for (const factory of [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition]) {
    const original = factory(process.cwd());
    pi.registerTool({ ...original, async execute(id, input, signal, onUpdate, ctx) {
      await rpc(socket, { kind: 'tool.dispatch', invocationId: id });
      let result;
      try {
        if (signal?.aborted) throw new Error('Aborted after dispatch admission');
        result = await original.execute(id, input, signal, onUpdate, ctx);
      } catch (error) {
        await rpc(socket, { kind: 'tool.result', invocationId: id, result: null, error: String(error).slice(0, 4096) }); throw error;
      }
      await rpc(socket, { kind: 'tool.result', invocationId: id, result, error: null });
      return result;
    } });
  }
  pi.registerProvider('trial-scripted', {
    baseUrl: 'http://127.0.0.1:1/unused', apiKey: 'local-scripted-placeholder', api: 'trial-scripted',
    models: [{ id: 'fixture', name: 'Local scripted native fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream(), invocationId = randomUUID();
      void (async () => {
        try {
          await rpc(socket, { kind: 'model.intent', invocationId, input: context });
          if (options?.signal?.aborted) throw new Error('Aborted before scripted responder entry');
          const output = scriptedResponse(model, context, caseId, definition);
          await rpc(socket, { kind: 'model.observed', invocationId });
          await rpc(socket, { kind: 'model.result', invocationId, output });
          stream.push({ type: 'start', partial: output }); stream.push({ type: 'done', reason: output.stopReason, message: output });
        } catch (error) {
          const output = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: String(error), timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: 'error', reason: output.stopReason, error: output });
        } finally { stream.end(); }
      })(); return stream;
    },
  });
}
