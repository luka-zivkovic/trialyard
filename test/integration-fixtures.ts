import { capabilityNames, type IntegrationDiscovery, type IntegrationContract } from "../src/connection/integration-contract.js";

export function integrationFixture() {
  const discovery: IntegrationDiscovery = {
    schemaVersion: "trial-runner/integration-discovery/v1", id: "example", scope: "Local inventory trial",
    repositories: [{ id: "candidate", location: "/not-opened/candidate", revision: null }],
    sources: [{ id: "source", repository: "candidate", path: "agent.js", sha256: "a".repeat(64) }],
    facts: [{ id: "entrypoint", area: "entrypoint", claim: "createAgent retains the original loop", certainty: "observed", evidence: ["source"] }],
    unknowns: [{ id: "scenario", area: "state", question: "Which fixture should this trial use?", resolution: "owner", blocking: true, recommendation: "Use the declared disposable inventory" }],
  };
  const contract: IntegrationContract = {
    schemaVersion: "trial-runner/integration-contract/v1", id: "example", discovery: { path: "discovery.json", sha256: "b".repeat(64) }, scope: "Local inventory trial", entrypointFactId: "entrypoint",
    decisions: [{ questionId: "scenario", answer: "Declared disposable inventory", basis: "existing_scope", reference: "Operator's stated trial scenario" }],
    capabilities: capabilityNames.map(name => ({ name, required: true, state: "supported", mechanism: "Explicit adapter boundary; confirm with qualification", factIds: ["entrypoint"], limitations: [] })),
    fidelity: [{ component: "inventory", mode: "substituted", description: "Stateful fixture with independent readback" }],
    bounds: { maxBuildAttempts: 2, maxTrialRuns: 3, maxWallTimeMs: 300000, provider: "none", allowanceRef: null },
    qualification: capabilityNames.map(capability => ({ id: capability, capability, procedure: "Exercise the boundary and inspect the native bundle", expected: "Retain required observations and successful cleanup" })),
    handoff: (["build", "run", "inspect", "verify", "rebuild", "cleanup"] as const).map(action => ({ action, command: null, notes: "Document the integration-specific command before handoff" })),
  };
  return { discovery, contract };
}
