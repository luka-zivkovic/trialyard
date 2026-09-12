import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseJson } from "../contracts/strict-json.js";
import { connectionPath, distinct } from "./contracts.js";

export const capabilityNames = ["agent-loop", "tool-routing", "model-capture", "fresh-state", "independent-readback", "cancellation", "cleanup", "dependency-closure"] as const;
type Capability = typeof capabilityNames[number];
type Area = "entrypoint" | "runtime" | "hooks" | "state" | "lifecycle" | "dependencies";
export interface IntegrationDiscovery {
  schemaVersion: "trial-runner/integration-discovery/v1"; id: string; scope: string;
  repositories: { id: string; location: string; revision: string | null }[];
  sources: { id: string; repository: string; path: string; sha256: string }[];
  facts: { id: string; area: Area; claim: string; certainty: "observed" | "inferred"; evidence: string[] }[];
  unknowns: { id: string; area: Area; question: string; resolution: "source" | "owner"; blocking: boolean; recommendation: string | null }[];
}
export interface IntegrationContract {
  schemaVersion: "trial-runner/integration-contract/v1"; id: string; scope: string;
  discovery: { path: string; sha256: string }; entrypointFactId: string | null;
  decisions: { questionId: string; answer: string; basis: "user" | "existing_scope"; reference: string }[];
  capabilities: { name: Capability; required: boolean; state: "supported" | "gap" | "not_applicable"; mechanism: string; factIds: string[]; limitations: string[] }[];
  fidelity: { component: string; mode: "real" | "substituted" | "unobserved"; description: string }[];
  bounds: { maxBuildAttempts: number; maxTrialRuns: number; maxWallTimeMs: number; provider: "none" | "existing_allowance"; allowanceRef: string | null };
  qualification: { id: string; capability: Capability; procedure: string; expected: string }[];
  handoff: { action: "build" | "run" | "inspect" | "verify" | "rebuild" | "cleanup"; command: string | null; notes: string }[];
}

const schema = parseJson(readFileSync(new URL("../../../skills/connect-agent/references/integration.schema.json", import.meta.url)));
const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: false });
ajv.addSchema(schema as object, "integration");
const validators = {
  discovery: ajv.compile({ $ref: "integration#/$defs/discovery" }),
  contract: ajv.compile({ $ref: "integration#/$defs/contract" }),
};
function requireThat(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
export function integrationDiscovery(value: unknown): IntegrationDiscovery {
  requireThat(validators.discovery(value), "INVALID_INTEGRATION_DISCOVERY");
  const d = value as IntegrationDiscovery;
  distinct(d.repositories.map(r => r.id)); distinct([...d.sources, ...d.facts, ...d.unknowns].map(r => r.id));
  distinct(d.sources.map(s => `${s.repository}/${s.path}`));
  for (const s of d.sources) {
    connectionPath(s.path);
    requireThat(d.repositories.some(r => r.id === s.repository), "UNKNOWN_SOURCE_REPOSITORY");
  }
  for (const f of d.facts) {
    distinct(f.evidence);
    requireThat(f.evidence.every(id => d.sources.some(s => s.id === id)), "UNKNOWN_FACT_SOURCE");
  }
  return d;
}
export function integrationContractDocument(value: unknown): IntegrationContract {
  requireThat(validators.contract(value), "INVALID_INTEGRATION_CONTRACT");
  const c = value as IntegrationContract;
  connectionPath(c.discovery.path);
  return c;
}
export function integrationContract(value: unknown, discovery: IntegrationDiscovery): IntegrationContract {
  const d = integrationDiscovery(discovery);
  const c = integrationContractDocument(value);
  distinct(c.decisions.map(q => q.questionId)); distinct(c.capabilities.map(k => k.name));
  distinct(c.qualification.map(q => q.id)); distinct(c.handoff.map(h => h.action));
  distinct(c.fidelity.map(f => f.component));
  if (c.entrypointFactId !== null) requireThat(d.facts.some(f => f.id === c.entrypointFactId && f.area === "entrypoint" && f.certainty === "observed"), "UNESTABLISHED_ENTRYPOINT");
  for (const q of c.decisions) requireThat(d.unknowns.some(u => u.id === q.questionId && u.resolution === "owner"), "INVALID_OWNER_DECISION");
  for (const k of c.capabilities) {
    distinct(k.factIds);
    requireThat(k.factIds.every(id => d.facts.some(f => f.id === id)), "UNKNOWN_CAPABILITY_FACT");
    if (k.state === "supported") requireThat(k.factIds.some(id => d.facts.some(f => f.id === id && f.certainty === "observed")), "UNSUPPORTED_CAPABILITY_CLAIM");
    if (k.required) {
      requireThat(k.state !== "not_applicable", "REQUIRED_CAPABILITY_OMITTED");
      requireThat(c.qualification.some(q => q.capability === k.name), "MISSING_CAPABILITY_QUALIFICATION");
    }
    if (["agent-loop", "fresh-state", "independent-readback", "cleanup"].includes(k.name)) requireThat(k.required, "REQUIRED_LIFECYCLE_CAPABILITY");
  }
  requireThat((c.bounds.provider === "none") === (c.bounds.allowanceRef === null), "INVALID_PROVIDER_ALLOWANCE");
  return c;
}
export function integrationRequirements(c: IntegrationContract, d: IntegrationDiscovery) {
  return [
    ...(c.entrypointFactId === null ? [{ code: "UNESTABLISHED_ENTRYPOINT", subject: "entrypoint", message: "Locate and select the actual agent entrypoint." }] : []),
    ...d.unknowns.filter(u => u.blocking && !c.decisions.some(q => q.questionId === u.id)).map(u => ({ code: "UNRESOLVED_QUESTION", subject: u.id, message: u.question })),
    ...c.capabilities.filter(k => k.required && k.state === "gap").map(k => ({ code: "CAPABILITY_GAP", subject: k.name, message: k.mechanism })),
  ];
}
