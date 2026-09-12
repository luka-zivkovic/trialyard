import { isDeepStrictEqual } from "node:util";
import { verifyRunState } from "../contracts/handoff.js";
import { parseJson } from "../contracts/strict-json.js";
import type { RunIndex } from "../contracts/types.js";
import { hash, safeFile } from "./files.js";

/** The request registry pins the complete allocation before any trial executes. */
export async function verifyAcceptance(root: string, index: RunIndex, digest: string): Promise<void> {
  const bytes = await safeFile(root, "accepted.json", 8 * 1024 * 1024);
  if (hash(bytes) !== digest) throw new Error("Accepted allocation digest mismatch");
  const accepted = verifyRunState(parseJson(bytes, 8 * 1024 * 1024));
  verifyRunState(index);
  if (accepted.state !== "accepted" || accepted.trials.some(slot => slot.execution !== "not_started" || slot.bundleSha256 !== null)) throw new Error("Invalid initial allocation");
  const allocation = (run: RunIndex) => ({ ...run, state: "accepted", finishedAt: null, exitCode: null,
    trials: run.trials.map(slot => ({ ...slot, execution: "not_started", bundleSha256: null })) });
  if (!isDeepStrictEqual(allocation(index), accepted)) throw new Error("Run index differs from accepted allocation");
}
