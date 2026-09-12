import { AdapterPeer } from "../src/sdk/peer.js";
import type { Frame, Json } from "../src/contracts/types.js";

let variant = "normal";
let turns = 0;
let stopping = false;
const peer = new AdapterPeer(async (frame: Frame) => {
  if (frame.kind === "start") {
    variant = String((frame.payload.settings as Record<string, Json>).variant);
    peer.reply(frame, "ready", { adapterId: "reference.agent", adapterVersion: "0.1.0", artifactSha256: frame.payload.artifactSha256!,
      capabilities: ["scripted-turns", "routed-tools", "conversation-events"], modelCapture: "not_applicable" });
  } else if (frame.kind === "user_turn") {
    const call = async (tool: string, args: Json): Promise<Record<string, Json>> => {
      if (stopping) throw new Error("Agent stopped");
      return (await peer.request("tool_call", { turnId: frame.payload.turnId!, tool, args, logicalCallId: null })).payload;
    };
    if (variant === "crash") process.exit(7);
    if (variant === "candidate-error") { peer.notify("agent_error", { message: "Synthetic candidate failure" }); return; }
    if (variant === "hang") return;
    turns++;
    let output: string;
    if (turns === 1) {
      await call("stock", {});
      if (variant === "false-claim") output = "I reserved one unit.";
      else {
        const result = await call("reserve", { key: "request-1", quantity: 1 });
        if (variant === "duplicate") await call("reserve", { key: "request-2", quantity: 1 });
        output = JSON.stringify(result);
      }
    } else output = JSON.stringify(await call("reservations", {}));
    if (!stopping) peer.reply(frame, "turn_finished", { turnId: frame.payload.turnId!, output, outstandingOperationIds: [] });
  } else if (frame.kind === "stop") {
    stopping = true; peer.reply(frame, "stopped", { outstandingOperationIds: [] });
  } else throw new Error("Unsupported agent request");
});
