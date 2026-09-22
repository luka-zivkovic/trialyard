# Ironside trace export

Date: 2026-09-22. This document specifies `trial-runner/ironside-ingest/v1`, a one-way mapping from one verified Trialyard trial bundle to Ironside's native JSON ingest contract (`POST /api/v1/ingest`, trace envelope v1). It exists so a reproduced agent failure can be stored beside production traces and later selected by an external assessment owner. It adds no grading, evaluator calibration, release policy, static admission, or serving proxy.

**CURRENT — offline mapping:** `trial export … --format ironside --out <file>` writes the mapping described here, validated against the closed `$defs.ironsideIngest` schema in [`contracts/v1.schema.json`](../contracts/v1.schema.json) and re-derived from the verified source before it is written. The mapped bodies were checked against Ironside's published shapes (`packages/shared/src/api.ts`, `envelope.ts`, `domain.ts`, and `packages/mappers/src/native.ts` at the time of writing). Tests exercise the mapping, refusals, redacted derivatives, and HTTP delivery against a local stub. On 2026-09-22 the native, redacted-derivative and model-operation outputs were also parsed by Ironside's `ingestRequestSchema` and `mapNativeEvents` from a local build of Ironside checkout `7e56e57`, with zero mapper errors; that was a one-off local check, not a committed cross-repository test.

**ASSUMPTION — live delivery:** `--ironside-url` has been exercised only against a local HTTP stub that imitates the documented `202 {batchId, received}` response. It has not been run against a live Ironside deployment, its worker mapper or ClickHouse. Ironside's contract owner has not reviewed this producer. Do not describe this as a supported portfolio integration until that review and a live round trip exist.

## Commands

```sh
# Offline (default): writes ingest request bodies, performs no network access.
trial export <bundle> --format ironside [--sha256 <manifest digest>] --out <new-file.json>

# Redacted derivative: verified against its local original; only retained files are read.
trial export <redacted-dir> --source <original-bundle> --format ironside [--sha256 <derivative digest>] --out <new-file.json>

# Explicit delivery. The key is read only from IRONSIDE_API_KEY.
IRONSIDE_API_KEY=… trial export <bundle> --format ironside --ironside-url https://ironside.example.com [--out <new-file.json>]
```

- The source must pass the same verification as `trial verify`. A tampered file, a manifest digest that differs from `--sha256`, a derivative presented without `--source`, or a derivative whose ancestry does not verify is refused before any output is written or any request is sent.
- `--out` must name a new file. When both `--out` and `--ironside-url` are supplied, the file is written first and exactly those bytes' requests are posted.
- The credential name matches Ironside's machine-credential guidance (`IRONSIDE_API_KEY`, an Ingest-preset `ironside_sc_…` token with the `ingest` capability). There is deliberately no CLI option for the key; it is never written to the export, stdout or stderr.
- `--ironside-url` is the deployment base URL; `/api/v1/ingest` is appended. It must be `https:`, except `http:` for `localhost`, `127.0.0.1` or `[::1]`. Embedded credentials, query strings and fragments are rejected.

One trial bundle is one repetition, so each export produces exactly one Ironside trace. Export each trial bundle of a run to cover its repetitions; they share an Ironside `sessionId`.

## Export document

```json
{
  "schemaVersion": "trial-runner/ironside-ingest/v1",
  "target": { "product": "ironside", "wire": "native-json-ingest", "endpoint": "/api/v1/ingest", "ingestSchemaVersion": 1 },
  "source": { "bundleSha256": "…", "bundleKind": "native", "parentBundleSha256": null, "runId": "…", "trialId": "…", "…": "…" },
  "traceId": "trialyard-<bundle digest>",
  "requests": [ { "events": [ { "type": "trace-upsert", "body": { "…": "…" } } ] } ]
}
```

Each `requests[i]` is a complete `POST /api/v1/ingest` body (`{events: [{type, body}]}`). Requests hold at most 500 events and at most 10 MiB of serialized JSON, matching Ironside's `MAX_EVENTS_PER_BATCH` and request body limit. An individual event that cannot fit is refused rather than truncated. Envelope `id`, `idempotencyKey`, `source` and `projectId` are left for Ironside to assign; the credential selects the project.

Trace and observation IDs are derived from the exported bundle digest, so reposting the same export upserts the same rows. A redacted derivative has its own digest and therefore its own trace.

## Mapping

| Trialyard evidence | Ironside row | Notes |
| --- | --- | --- |
| Trial bundle | Trace `trialyard-<digest>` | `timestamp` from the first journal event, otherwise from a retained snapshot's `observedAt`; export is refused when no retained observation carries a time. `sessionId` is `trialyard-run:<runId>`. |
| `user.turn` + `assistant.turn` | `span` `turn:<turnId>` | Input is the scripted user message (`runner_observed`); output is the assistant text (`candidate_claim`). A turn without an assistant reply has no `endTime`/output and `trialyard.claim=not_observed`. |
| Routed tool operation | `span` named by the tool | Input is the arguments. Output only for `known_result`; `known_failure` sets level `error` and `statusMessage`. `outcome_unknown` and `not_dispatched` set level `warning` with no output. `trialyard.dispatch` is `observed` or `not_observed`. |
| Adapter model operation | `generation` | `model` is the adapter-reported model, else the requested model. Scalar request settings become `modelParameters`. `usageDetails` carries only non-null token counts; `costDetails.total` only a non-null USD amount. Everything else, including usage/cost source and pricing ID, stays in metadata. Missing values stay absent, never zero. |
| `trial.started`, `trial.terminal`, `agent.error`, `runtime.error`, `capture.gap`, `diagnostic` | `event` named by the kind | Errors use level `error`, capture gaps and non-`finished` terminals `warning`, diagnostics `debug`. Parent is the enclosing turn when correlated. |
| `initial-state.json` / `final-state.json` | `event` `environment.initial_state` / `environment.final_state` | Output is the snapshot (`environment_observed`) at its `observedAt`. When the file is absent or redacted, an output-less marker with level `warning`, `trialyard.unobserved=true` and the capture status is emitted instead; its placement time is labelled in `trialyard.timestampSource`. |

Timestamps are normalized to UTC ISO 8601 with milliseconds; the original producer timestamp, when present, is kept in `trialyard.producerTimestamp`. Every observation carries `trialyard.source` (the original provenance) and `trialyard.sequences` (journal sequence numbers). Operation observations also carry `trialyard.operationId`, `trialyard.owner`, `trialyard.boundary`, `trialyard.outcome` and any logical call ID.

### Claimed outcome versus observed state

Trace `output` keeps the two apart and never merges them:

- `candidateClaim`: `{source: "candidate_claim", status, content?}` — the last assistant message, if one was captured.
- `observedFinalState`: `{source: "environment_observed", status, stable?, pendingOperations?, observedAt?, state?}` — the retained final snapshot.

The same statuses are repeated as `trialyard.claimedOutcome.status` and `trialyard.observedState.status` metadata. Neither is a judgment that the agent succeeded.

### Capture gaps and redaction

Each captured part (`conversation`, `toolActivity`, `initialState`, `finalState`) has a status in `trialyard.capture.<part>`:

- `observed` — retained and not redacted.
- `observed_masked` — retained, but known credential values were masked before capture.
- `redacted` — omitted by a redacted-evidence derivative.
- `not_captured` — absent from the source bundle.

`trialyard.unobserved` lists every part that is not `observed`. `trialyard.evidenceGaps` and `trialyard.redactedPaths` copy the verified manifest. The mapping never improves evidence state: an incomplete source exports as `trialyard.evidenceState=incomplete`, and a redacted derivative is always incomplete. For a derivative, only the derivative's retained files and its own manifest fields are read; the original bundle is used solely to verify ancestry, so omitted content cannot reach Ironside through this export. The source manifest's reason, profile text, operation summary and capture boundary are not exported from a derivative.

### Selection tags

Trace `tags` are stable for later selection: `trialyard`, `trialyard:run:<runId>`, `trialyard:scenario:<scenarioId>`, `trialyard:repetition:<n>`, `trialyard:bundle:<digest>`, `trialyard:evidence:<state>` and `trialyard:execution:<state>`. The same identities, plus request/trial IDs, bundle kind, parent digest, cleanup, authenticity (`not_attested`) and the mapping version, are repeated in `trialyard.*` metadata. Ironside's native metadata values must be strings, so lists and objects are JSON-encoded.

## Delivery semantics

Requests are posted in order with `Authorization: Bearer $IRONSIDE_API_KEY`. Each must return `202` with `received` equal to its event count; anything else stops delivery and reports how many requests were accepted. Ironside accepts batches asynchronously, so `202` does not prove its worker mapped the rows. Because IDs are deterministic upserts, a partially delivered export can be posted again. A trace is settled by Ironside's quiet-period rule, not by this export.

## Limits

The export inherits the source's integrity limits: digests establish internal consistency, not authenticity. Masking covers known bound credential values only. The mapping is not an assessment input for Coeval and emits no scores; score events are never produced. Coeval or Dailies consumption of these traces remains unqualified.
