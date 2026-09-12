import { AdapterPeer } from "../src/sdk/peer.js";
import { ModelRecorder } from "../src/sdk/models.js";
import type { Frame, Json } from "../src/contracts/types.js";

// A protocol wrapper only. The candidate module is loaded only during an explicit run.
type Message = { role: "user" | "assistant"; content: string };
interface FunctionAgent { runTurn(context: { input: string; history: Message[]; bindings: Json; signal: AbortSignal;
  tool: (name: string, args: Json, logicalCallId?: string | null) => Promise<Record<string, Json>>;
  models: ModelRecorder | null }): Promise<string> | string; }
let agent: FunctionAgent | undefined;
let bindings: Json = null;
let capture = "not_applicable";
let recorder: ModelRecorder | null = null;
let active = false;
const abort = new AbortController();
const history: Message[] = [];
const peer = new AdapterPeer(async (frame: Frame) => {
  if (frame.kind === "start") {
    const settings = frame.payload.settings as { entrypoint: string };
    // Preparation restricts this path; import resolution remains the candidate's responsibility.
    const module = await import(new URL(`./${settings.entrypoint}`, import.meta.url).href);
    if (typeof module.createAgent !== "function") throw new Error("node-function/v1 requires createAgent()");
    agent = await module.createAgent();
    if (!agent || typeof agent.runTurn !== "function") throw new Error("createAgent() must return runTurn()");
    if (abort.signal.aborted) return;
    bindings = frame.payload.bindings!;
    capture = String(frame.payload.modelCapture);
    peer.reply(frame, "ready", { adapterId: "template.node-function", adapterVersion: "1.0.0", artifactSha256: frame.payload.artifactSha256!,
      capabilities: ["scripted-turns", "routed-tools", "conversation-events", ...(capture === "not_applicable" ? [] : [`model-${capture}`])], modelCapture: capture });
  } else if (frame.kind === "user_turn") {
    if (!agent || active || abort.signal.aborted) throw new Error("Invalid function adapter lifecycle");
    active = true;
    recorder = capture === "not_applicable" ? null : new ModelRecorder(peer);
    const models = recorder;
    const input = String(frame.payload.content);
    history.push({ role: "user", content: input });
    let turnOpen = true, pendingTools = 0;
    const tool = async (name: string, args: Json, logicalCallId: string | null = null) => {
      if (!turnOpen || abort.signal.aborted) throw new Error("Turn is closed");
      pendingTools++;
      try { return (await peer.request("tool_call", { turnId: frame.payload.turnId!, tool: name, args, logicalCallId })).payload; }
      finally { pendingTools--; }
    };
    let output: string;
    try { output = await agent.runTurn({ input, history: structuredClone(history), bindings: structuredClone(bindings), signal: abort.signal, tool, models }); }
    catch { turnOpen = false; active = false; if (!abort.signal.aborted) peer.notify("agent_error", { message: "Candidate runTurn failed" }); return; }
    turnOpen = false; active = false;
    if (abort.signal.aborted) return;
    if (pendingTools) throw new Error("runTurn returned with unawaited tool calls");
    if (typeof output !== "string") throw new Error("runTurn must return a string");
    const modelOperations = models?.completeTurn();
    models?.stop();
    history.push({ role: "assistant", content: output });
    peer.reply(frame, "turn_finished", { turnId: frame.payload.turnId!, output, outstandingOperationIds: [], ...(modelOperations ? { modelOperations } : {}) });
  } else if (frame.kind === "stop") {
    abort.abort(); recorder?.stop();
    peer.reply(frame, "stopped", { outstandingOperationIds: recorder?.outstandingOperations() ?? [] });
  } else throw new Error("Unsupported function adapter request");
});
