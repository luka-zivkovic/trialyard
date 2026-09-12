import { isDeepStrictEqual } from "node:util";
import { capabilities, sameTools, type ResolvedPlan } from "../core/plan.js";
import { contract, snapshotContract } from "./validate.js";
import { parseJson } from "./strict-json.js";
import type { Event, Frame, Manifest, Snapshot } from "./types.js";

/** Bind recorded lifecycle observations to the declared trial, independently of
 * model capture. Missing observations remain legal at interrupted boundaries. */
export async function verifyObservations(manifest: Manifest,
  resolved: Pick<ResolvedPlan, "plan" | "profile" | "tools" | "fixtureValidator">,
  events: Event[], initial: Snapshot | null, read: (name: string) => Promise<Buffer>): Promise<void> {
  const observation = async (name: string, kind: string): Promise<Frame | null> => {
    if (!manifest.files.some(file => file.path === name)) return null;
    const frame = contract<Frame>("frame", parseJson(await read(name)));
    if (frame.kind !== kind || frame.trialId !== manifest.trialId) throw new Error(`Invalid ${name} observation`);
    return frame;
  };
  const described = await observation("environment-described.json", "described");
  const prepared = await observation("environment-prepared.json", "prepared");
  const ready = await observation("agent-ready.json", "ready");
  const stopped = await observation("agent-stopped.json", "stopped");
  const disposed = await observation("environment-disposed.json", "disposed");
  const { plan, profile } = resolved;

  if (described) {
    if (described.payload.adapterId !== plan.environment.adapterId || described.payload.adapterVersion !== plan.environment.adapterVersion) throw new Error("Environment observation identity differs from pinned declaration");
    capabilities(described.payload.capabilities as string[], plan.environment.capabilities, "effective environment");
    if (!manifest.evidence.redactedPaths.includes("environment-described.json")) sameTools(described.payload.tools, resolved.tools);
  }
  if (prepared) {
    if (!described) throw new Error("Preparation lacks environment description observation");
    const snapshot = snapshotContract(prepared.payload.snapshot);
    if (!manifest.evidence.redactedPaths.includes("environment-prepared.json") && !resolved.fixtureValidator(snapshot.state)) throw new Error("Prepared snapshot state violates pinned fixture schema");
    if (!initial || !isDeepStrictEqual(snapshot, initial)) throw new Error("Prepared initial state differs from snapshot observation");
    for (const fault of plan.environment.faultPlan) {
      if (!(described.payload.faultModes as string[]).includes(fault.mode)) throw new Error("Preparation lacks declared fault capability");
    }
  }
  if (ready) {
    if (!prepared || !initial?.stable || initial.pendingOperations.length) throw new Error("Agent handshake lacks stable preparation observation");
    if (ready.payload.adapterId !== plan.agent.adapterId || ready.payload.adapterVersion !== plan.agent.adapterVersion ||
      ready.payload.modelCapture !== profile.modelCapture || ready.payload.artifactSha256 !== manifest.identity.agentArtifactSha256) {
      const boundary = profile.modelCapture === "not_applicable" ? "agent" : "model";
      throw new Error(`Effective ${boundary} handshake differs from pinned declaration`);
    }
    capabilities(ready.payload.capabilities as string[], plan.agent.capabilities, "effective agent");
  }
  if (events.some(event => event.kind === "user.turn") && !ready) throw new Error("Execution lacks effective agent handshake observation");
  if (stopped && (stopped.payload.outstandingOperationIds as string[]).length && !manifest.evidence.gaps.includes("agent_reported_outstanding_work")) {
    throw new Error("Outstanding adapter work cannot disappear from evidence");
  }
  if (disposed) {
    if (disposed.payload.status !== manifest.cleanup) throw new Error("Cleanup summary contradicts disposal observation");
  } else if (manifest.cleanup === "failed" || (manifest.cleanup === "succeeded" &&
    (manifest.execution !== "not_started" || described || prepared || ready || initial))) {
    throw new Error("Known cleanup result lacks disposal observation");
  }
}
