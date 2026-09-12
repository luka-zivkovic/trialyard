import { AdapterPeer } from '../../src/sdk/peer.ts';
import { ModelRecorder } from '../../src/sdk/models.ts';
import { rpc, serve } from './native-rpc.mjs';

let environment, server, current, stopping = false;
const modelCalls = new Map();
async function handle(request) {
  if (stopping || !current) throw new Error('NO_ACTIVE_PI_TURN');
  if (request.kind === 'tool.propose') {
    const response = await peer.request('tool_call', { turnId: current.frame.payload.turnId, tool: request.tool, args: { invocationId: request.invocationId, input: request.input }, logicalCallId: null });
    return response.payload;
  }
  const recorder = current.recorder;
  if (request.kind === 'model.intent') {
    if (modelCalls.has(request.invocationId)) throw new Error('DUPLICATE_MODEL_INVOCATION');
    modelCalls.set(request.invocationId, null);
    const operation = await recorder.intent({ provider: 'trial-scripted', model: 'fixture', settings: { boundary: 'local_scripted_responder', usage: 'not_measured' }, input: request.input });
    modelCalls.set(request.invocationId, { recorder, operation }); return null;
  }
  const call = modelCalls.get(request.invocationId);
  if (!call || call.recorder !== recorder) throw new Error('UNKNOWN_MODEL_INVOCATION');
  if (request.kind === 'model.observed') { await recorder.observed(call.operation); return null; }
  if (request.kind === 'model.result') {
    await recorder.finish(call.operation, 'known_result', request.output, null, { provider: 'trial-scripted', model: 'fixture', modelRevision: null, requestId: null, usage: null, cost: null });
    return null;
  }
  throw new Error('UNSUPPORTED_PI_AGENT_REQUEST');
}
async function stop() {
  stopping = true; current?.recorder.stop();
  if (environment) await rpc(environment, { kind: 'stop' });
  await server?.close();
}
const peer = new AdapterPeer(async frame => {
  try {
    if (frame.kind === 'start') {
      if (environment || frame.payload.modelCapture !== 'accounted') throw new Error('INVALID_PI_START');
      const bindings = frame.payload.bindings;
      environment = bindings.environmentSocket;
      server = await serve(bindings.agentSocket, handle);
      await rpc(environment, { kind: 'bind', socket: bindings.agentSocket });
      peer.reply(frame, 'ready', { adapterId: 'pi-webdesk.agent', adapterVersion: '0.1.0', artifactSha256: frame.payload.artifactSha256, capabilities: ['scripted-turns', 'routed-tools', 'conversation-events', 'model-accounted'], modelCapture: 'accounted' });
    } else if (frame.kind === 'user_turn') {
      if (stopping || current) throw new Error('INVALID_PI_TURN');
      current = { frame, recorder: new ModelRecorder(peer) };
      try {
        const result = await rpc(environment, { kind: 'turn', turnId: frame.payload.turnId, content: frame.payload.content });
        if (!stopping) {
          peer.reply(frame, 'turn_finished', { turnId: frame.payload.turnId, output: result.output, outstandingOperationIds: [], modelOperations: current.recorder.completeTurn() });
          current = null;
        }
      } catch (error) { if (!stopping) throw error; }
    } else if (frame.kind === 'stop') {
      await stop(); peer.reply(frame, 'stopped', { outstandingOperationIds: current?.recorder.outstandingOperations() ?? [] });
    } else throw new Error('UNSUPPORTED_PI_AGENT_FRAME');
  } catch (error) {
    process.stderr.write(`PI_AGENT_FAILURE: ${String(error)}\n`);
    try { await stop(); } catch { /* Coordinator retains missing stop/cleanup evidence. */ }
    process.exit(1);
  }
});
