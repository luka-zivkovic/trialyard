import { isDeepStrictEqual } from "node:util";
import { contract } from "./validate.js";
import type { Event, Json, Manifest, ModelObservation, ModelRequest, Profile } from "./types.js";

/** These are adapter reports at a declared boundary, never provider attestation. */
export function modelRequest(value: unknown): ModelRequest {
  const request = contract<ModelRequest>("modelRequest", value);
  if (!request.provider.trim() || !request.model.trim()) throw new Error("Model request identity cannot be blank");
  return request;
}
export function modelObservation(value: unknown): ModelObservation | null {
  if (value === null) return null;
  const observation = contract<ModelObservation>("modelObservation", value);
  if ([observation.provider, observation.model, observation.modelRevision, observation.requestId].some(field => field !== null && !field.trim()) ||
      (observation.cost && (!observation.cost.currency.trim() || !observation.cost.pricingId.trim()))) throw new Error("Model observation identity and units cannot be blank");
  return observation;
}

export function verifyModelTurn(declared: unknown, ids: string[]): void {
  if (declared === undefined || declared === null) return; // Coverage gaps are profile-dependent.
  if (!Array.isArray(declared) || new Set(declared).size !== declared.length || !isDeepStrictEqual([...declared].sort(), [...ids].sort())) throw new Error("Model turn coverage differs from recorded operations");
}

export function modelGaps(profile: Profile, events: Event[]): string[] {
  const intents = events.filter(e => e.kind === "operation.dispatch_intent" && e.payload.boundary === "model");
  if (profile.modelCapture === "not_applicable") return intents.length ? ["model_capture_declaration_contradicted"] : [];
  const gaps = new Set<string>();
  if (profile.modelCapture === "reported") gaps.add("model_attempts_unverified");
  for (const turn of events.filter(e => e.kind === "user.turn")) {
    const closure = events.find(e => e.kind === "assistant.turn" && e.turnId === turn.turnId);
    if (!Array.isArray(closure?.payload.modelOperations)) gaps.add("model_turn_coverage_missing");
  }
  for (const intent of intents) {
    const finished = events.find(e => e.kind === "operation.finished" && e.operationId === intent.operationId);
    if (!finished || finished.payload.outcome === "outcome_unknown") gaps.add("model_operation_outcome_unknown");
    if (profile.required.modelUsage && finished?.payload.outcome !== "not_dispatched") {
      const metadata = finished?.payload.model as unknown as ModelObservation | null | undefined;
      if (metadata?.usage?.source !== "provider_reported" || metadata.usage.inputTokens == null || metadata.usage.outputTokens == null) gaps.add("model_usage_missing");
    }
  }
  return [...gaps].sort();
}

/** Per-operation values preserve unknowns and retries. No implicit totals or zero cost. */
export function providerSummary(events: Event[]): Manifest["provider"] {
  const intents = events.filter(e => e.kind === "operation.dispatch_intent" && e.payload.boundary === "model");
  if (!intents.length) return { requested: null, observed: null, usage: null, cost: null };
  const requested: Json[] = [], observed: Json[] = [], usage: Json[] = [], cost: Json[] = [];
  for (const intent of intents) {
    const request = modelRequest(intent.payload.args);
    const terminal = events.find(e => e.kind === "operation.finished" && e.operationId === intent.operationId);
    const metadata = terminal?.payload.model == null ? null : modelObservation(terminal.payload.model);
    const operationId = intent.operationId!;
    requested.push({ operationId, provider: request.provider, model: request.model, settings: request.settings });
    observed.push({ operationId, source: "adapter_reported", provider: metadata?.provider ?? null, model: metadata?.model ?? null,
      modelRevision: metadata?.modelRevision ?? null, requestId: metadata?.requestId ?? null });
    usage.push({ operationId, value: metadata?.usage ?? null });
    cost.push({ operationId, value: metadata?.cost ?? null });
  }
  return { requested, observed, usage, cost };
}
