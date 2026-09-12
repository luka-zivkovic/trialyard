# Credentials and redacted exports

Date: 2026-09-07. **CURRENT:** the local preview supports explicit credential bindings, known-value masking before persistence, and source-linked whole-file omission exports. Adapter-owned model observations are covered by the [model accounting contract](model-accounting.md); customer adapters remain a later milestone. Tests use newly generated synthetic values; no customer account or trace is involved.

## Pass credentials to an adapter

Add names and recipients to the plan, never values:

```json
"secretBindings": [
  { "name": "AGENT_API_TOKEN", "recipient": "agent" },
  { "name": "TEST_SERVICE_TOKEN", "recipient": "environment" }
]
```

Provide those variables through the operator's shell or CI secret store before `trial run`. Each variable is injected only into its selected worker's process environment. The runner does not include these values in argv, pinned configuration or an identity digest. The SDK/adapter reads the selected variables through its normal environment API. Other parent variables are excluded; the runner supplies PATH as the Node executable's directory, LANG as `C.UTF-8`, and TZ as `UTC`. Runtime-control names such as PATH, HOME, NODE_OPTIONS and loader-related prefixes cannot be bindings.

The preview accepts up to 32 distinct binding names and 16 KiB of values overall. Values contain 8–4,096 UTF-8 bytes, without NUL or the reserved `REDACTED` marker. Available invalid values fail before resolving value-bearing paths. Missing values prevent a new execution. A previously accepted request still returns with missing or valid rotated credentials; a new execution requires a new request ID. Rotation does not alter the identity of a historical trial, and no credential fingerprint is stored. `trial show` never requires credentials. Static validation checks binding declarations without reading the operator environment or executing an adapter.

Known bound values are forbidden in pinned source/configuration inputs and runner identities. Such an input is rejected before the store or workers are created. Keep credentials in their bindings instead of fixtures, scenarios or source files.

## What gets masked

Live tool requests and responses preserve the candidate's actual behavior. Copies destined for the journal, snapshots, handshake/stop/disposal observations, runner errors and retained cleanup metadata are masked before writing. Known values and their canonical JSON-escaped spellings are recognized, including a credential embedded in an assistant's serialized JSON string. Matching strings become `REDACTED`; matching numeric literals become `null`. Diagnostic masking retains a bounded suffix across chunks so splitting a credential across stderr writes does not bypass matching.

File-level `evidence.redactedPaths` records affected captured files. Any removed content conservatively adds `required_content_redacted` and makes native evidence incomplete. The execution and cleanup observations remain separate. A credential in a structural key or correlation identity stops the affected capture instead of fabricating valid identity/accounting. The manifest and CLI do not expose the removed value. A literal `REDACTED` in ordinary adapter output is not itself evidence of redaction.

This mechanism matches known values and the documented JSON spelling; it does not detect arbitrary encodings, transformations, unbound credentials or personal information. It does not govern files written independently by an adapter, nor prevent an adapter from transmitting data to another service or through its tool responses. Recipient selection describes the runner's credential injection. Operator-trusted adapters still own their data flows. This is not a hostile-code sandbox or general data-loss prevention.

## Export a smaller evidence bundle

Create a local policy file, for example `redaction.json`:

```json
{
  "schemaVersion": "trial-runner/redaction/v1",
  "omitFiles": ["events.ndjson", "initial-state.json", "final-state.json"]
}
```

Then use actual bundle paths from a run:

```sh
npm run trial -- export <original-bundle> --format redacted-bundle --redaction redaction.json --out /tmp/trial-share
npm run trial -- verify /tmp/trial-share --source <original-bundle> --sha256 <printed-derivative-digest>
```

The destination must be new, its parent must exist, and it must be outside the original bundle. Each selected path must name an existing source content file. There are no glob patterns or field replacements. This removes only the selected files; other copies or sensitive metadata are not searched automatically. Retained file bytes are copied unchanged. The export is local; no upload or publication occurs.

The source first passes native verification. The derivative uses the separate closed `trial-runner/redacted-evidence/v1` manifest, a new exact-byte digest, the original digest in `parentBundleSha256`, inherited trial/execution/cleanup identities and source gaps, and explicit omitted paths. Every omission export is conservatively incomplete. The original manifest is not copied; the new manifest excludes the source's reason, profile prose and operation summary. Retained content can still contain metadata or source/configuration files. Export is capped at 192 MiB of retained files and publishes its manifest last without overwriting the destination. Source bytes are checked again during export and verification.

Derivative verification requires the original local source. It verifies the claimed ancestry and exact retained inventory; a parent hash by itself is not proof. Native verification rejects a derivative, so it cannot masquerade as unredacted execution evidence. Derivative chaining and assessment-input export from a derivative are not supported in this batch. The existing assessment-input mapping remains for verified native bundles and carries native redaction gaps. No external portfolio consumer is claimed to support these contracts yet.

## Qualification evidence

Contract tests cover invalid/missing binding values, runtime-control variables, overlapping and split credentials, escaped JSON, structural keys, omission policies and coverage upgrades. Actual-process tests check selected environments, original live responses, initial/final state, prepared bindings, tool results, assistant content, stderr, error messages and retained cleanup files. Store scans check synthetic credential values, canonical JSON spellings and value digests; assistant content is also checked after decoding. Preflight tests reject embedded credentials before acceptance. Matching requests do not rerun when credentials are missing or rotated.

Native and independently written derivative consumers exercise actual exports and reject forged ancestry, modified bytes/inventory, missing/extra files, symlinks, source swaps/tampering, hidden omissions and coverage upgrades. CLI tests exercise export and explicit-source verification. Independent review checks the exact implementation before this batch is applied to the standalone repository.
