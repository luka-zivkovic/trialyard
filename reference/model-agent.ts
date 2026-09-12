import { AdapterPeer } from "../src/sdk/peer.js";
import { ModelRecorder } from "../src/sdk/models.js";
import type { Frame, Json, ModelObservation } from "../src/contracts/types.js";

// Synthetic local callback, never a provider SDK or a real model quality example.
const synthetic = (attempt: number) => ({ output: { next: "inspect inventory" }, error: attempt === 0 ? "Synthetic temporary failure" : null,
  observation: { provider: "local-synthetic", model: "reference-model", modelRevision: null, requestId: null,
    usage: { inputTokens: 3, outputTokens: 2, source: "provider_reported" }, cost: null } satisfies ModelObservation });
let recorder: ModelRecorder | null = null, stopped = false, turn = 0;
const history: Json[] = [];
let capture = "accounted";
const peer = new AdapterPeer(async (frame: Frame) => {
  if (frame.kind === "start") {
    capture = String(frame.payload.modelCapture);
    peer.reply(frame, "ready", { adapterId: "reference.model-agent", adapterVersion: "0.1.0", artifactSha256: frame.payload.artifactSha256!,
      capabilities: ["scripted-turns", "routed-tools", "conversation-events", `model-${capture}`], modelCapture: capture });
  } else if (frame.kind === "user_turn") {
    recorder = new ModelRecorder(peer); turn++; history.push({ role: "user", content: frame.payload.content! });
    const logical = `turn-${turn}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const operation = await recorder.intent({ provider: "local-synthetic", model: "reference-alias", settings: { attempt }, input: history }, logical);
      const result = synthetic(attempt); // This invocation is the declared local dispatch boundary.
      await recorder.observed(operation);
      await recorder.finish(operation, result.error ? "known_failure" : "known_result", result.error ? null : result.output, result.error, result.observation);
    }
    if (stopped) return;
    const result = await peer.request("tool_call", { turnId: frame.payload.turnId!, tool: turn === 1 ? "reserve" : "reservations", args: turn === 1 ? { key: "model-reference", quantity: 1 } : {}, logicalCallId: null });
    const output = JSON.stringify(result.payload); history.push({ role: "assistant", content: output });
    if (!stopped) peer.reply(frame, "turn_finished", { turnId: frame.payload.turnId!, output, outstandingOperationIds: [], modelOperations: recorder.completeTurn() });
  } else if (frame.kind === "stop") {
    stopped = true; recorder?.stop(); peer.reply(frame, "stopped", { outstandingOperationIds: recorder?.outstandingOperations() ?? [] });
  }
});
