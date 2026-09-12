import * as path from "node:path";
import { hash } from "../core/files.js";
import { publicJson, readPublic, repositoryRoot } from "../discovery/safe.js";
import { connectionPath } from "./contracts.js";
import { integrationContractDocument, integrationContract, integrationDiscovery, integrationRequirements } from "./integration-contract.js";

// Only these two declared public JSON files are read. Repository locations, source
// references, decisions and command strings are retained claims, never dispatches.
export async function checkIntegration(filename: string, expectedSha256?: string) {
  const absolute = path.resolve(filename), name = path.basename(absolute);
  connectionPath(name);
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("INVALID_INTEGRATION_DIGEST");
  const root = await repositoryRoot(path.dirname(absolute));
  const bytes = await readPublic(root, name), digest = hash(bytes);
  if (expectedSha256 !== undefined && expectedSha256 !== digest) throw new Error("INTEGRATION_DIGEST_MISMATCH");
  const draft = integrationContractDocument(publicJson(bytes));
  if (draft.discovery.path.toLowerCase() === name.toLowerCase()) throw new Error("INTEGRATION_SELF_REFERENCE");
  const discoveryBytes = await readPublic(root, draft.discovery.path);
  if (hash(discoveryBytes) !== draft.discovery.sha256) throw new Error("INTEGRATION_DISCOVERY_CHANGED");
  const discovery = integrationDiscovery(publicJson(discoveryBytes));
  const contract = integrationContract(draft, discovery);
  const requirements = integrationRequirements(contract, discovery);
  return { schemaVersion: "trial-runner/integration-check/v1", contract: absolute, contractSha256: digest,
    discoverySha256: draft.discovery.sha256, status: requirements.length ? "blocked" : "consistent", requirements,
    unknowns: discovery.unknowns, decisions: contract.decisions, handoffGaps: contract.handoff.filter(h => h.command === null),
    sourceVerification: "recorded_not_rechecked", qualification: "not_checked", execution: "not_run", authorization: "not_checked" };
}
