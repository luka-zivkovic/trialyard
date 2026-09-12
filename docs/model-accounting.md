# Model observations in the developer preview

**CURRENT — M1:** the process protocol and TypeScript helper support adapter-owned model operations. The runner does not import a provider SDK or replace the agent's orchestration. Qualification uses synthetic local callbacks and actual worker processes; real provider/framework integrations belong to M3.

## Try it without an account

```sh
npm run build
npm run trial -- init /tmp/model-example --example model-accounting
npm run trial -- validate /tmp/model-example/plan.json
npm run trial -- run /tmp/model-example/plan.json --request model-example
```

The example performs two turns and two fresh repetitions. Each turn calls a synthetic local function twice: a known failure followed by a successful retry, then an inventory tool call. It retains each physical attempt under a distinct operation ID and shares the logical call ID between retries. This demonstrates accounting and state continuity; it is not a real model or a quality evaluation.

## Connect an adapter

Set the pinned profile's `modelCapture` to `accounted` or `reported`, explain the observable boundary in `captureBoundary` and `modelCaptureReason`, and declare the matching `model-accounted` or `model-reported` agent capability. The effective `ready` response must match before any user turn is released. Use `not_applicable` only when the adapter makes no model calls.

For each user turn, create `new ModelRecorder(peer)` from `src/sdk/models.ts`. Its sequence is:

1. `await recorder.intent(request, logicalCallId, parentOperationId)` records intent and waits for a durable acknowledgment. The returned handle identifies this one physical attempt.
2. Dispatch through the agent's existing model client. Call `await recorder.observed(handle)` only after that adapter actually observes its declared send boundary. An acknowledgment of intent is not an observed dispatch.
3. Call `await recorder.finish(handle, outcome, value, error, observation)` for a known result, known failure, unknown outcome, or known non-dispatch. Non-result outcomes require a null value; results require a null error. Non-dispatch cannot carry provider observations.
4. Include `modelOperations: recorder.completeTurn()` in `turn_finished`. `[]` explicitly declares zero calls; null or omitted coverage leaves model evidence incomplete. The recorder refuses to close a turn with open calls. On stop, call `recorder.stop()`, report `recorder.outstandingOperations()` in the stop acknowledgment, and stop initiating work; observed closing outcomes can still be recorded.

Each explicit retry calls `intent` again, with a fresh operation ID and the same logical call ID. The runner never retries automatically. Optional parents must be open agent-owned model operations in the same turn; children close before parents. Runner-routed tools retain the runner's separate accounting ownership. An environment cannot claim a model dispatch, and an agent cannot create a second accounting record for a routed tool.

The helper deliberately does not infer when an SDK physically sent a request. An integration must instrument that boundary correctly. Use `reported` if hidden SDK retries or missing hooks prevent full attempt coverage. This preview conservatively marks reported mode incomplete with `model_attempts_unverified`. `accounted` means that the adapter declares full accounting at its pinned boundary; it is not authentication or proof of provider-internal behavior.

## Closed metadata and unknown values

`modelRequest` contains `provider`, `model`, public `settings`, and the exposed `input`. Never include chain-of-thought or credentials in a configuration. Runtime known-value masking also applies to model request/result copies and observations before persistence.

The optional `model` field on `operation.finished` contains nullable reported `provider`, `model`, `modelRevision`, `requestId`, `usage`, and `cost`. It is available for failures and unknown outcomes as well as successful results. The operation's output stays in `value`; an error stays in `error`.

Usage has nullable `inputTokens` and `outputTokens` plus `source: provider_reported | adapter_estimated`. Cost has nullable `amount`, a `currency` identifier, `source`, and a `pricingId` identifying the provider price or adapter estimate basis. Unknown usage/cost stays null. A missing count is never converted to zero. Estimates are retained as estimates; the runner does not calculate charges or enforce monetary caps.

The optional profile flag `required.modelUsage` defaults to false. When true, each dispatched model operation needs both token counts with `source: provider_reported`; absent, partial or estimated usage produces `model_usage_missing`. Known non-dispatch is exempt. Requested aliases remain separate from nullable observed model/revision IDs. A reported revision is not an attestation that a provider alias is immutable.

Manifest `provider` fields are per-operation arrays derived from the captured journal, or null when no model operations were recorded. They preserve attempt IDs and unknowns, including failed-call usage. They are not totals. The native consumer recomputes these fields and rejects forged summaries, changed provenance, mismatched handshake coverage and incorrect turn declarations even if an attacker recomputes file hashes.

## Termination and missing coverage

An explicit candidate/model failure frame produces `agent_error`. An unclassified worker exit produces `adapter_error` and incomplete evidence. A handled failed model call can be followed by a retry and a finished trial. A crash or timeout closes unresolved operations as unknown; the evidence retains missing turn coverage and unknown model outcomes rather than reconstructing calls.

The runner retains an available `stopped` acknowledgment in `agent-stopped.json`. Reported outstanding work adds `agent_reported_outstanding_work`. Local process-group termination does not establish cancellation of remote activity. Capture limits and failures retain their existing incomplete/unfinished behavior; the stop record shares the recorded-payload allowance.

The native assessment-input export preserves these gaps. External portfolio consumers and customer integrations have separate qualification gates.
