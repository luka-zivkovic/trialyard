# Current support

**CURRENT — public developer preview, 2026-09-13.** Trialyard includes a local execution core, explicit Node setup and source iteration, a Pi/Webdesk integration, and separate evidence-consumer experiments.

## Support matrix

| Surface | Available behavior | Boundary |
| --- | --- | --- |
| Local core and reference | Sequential scripted trials, fresh state, limits, interruption, inspection, verification and exports | Node 24.15.0; operator-trusted processes on macOS/Linux. Synthetic reference runs need no provider or service. |
| Node function setup | Static declarations, copied source, retained connection, files-only rebuilds | Self-contained ESM createAgent/runTurn with explicitly selected inventory tools. No dependency installation or arbitrary framework inference. |
| Setup skill 0.4.0 | Fresh-repository initialization guidance, discovery, owner decisions, capability/fidelity contracts, and qualification that preserves candidate failures | Host-assisted instructions; no in-place init command, automatic investigator, enforced case freeze or assessment-quality guarantee. |
| Pi/Webdesk | Native plans, original tool callbacks, approval observations, source rebuilds and declared file cases | Pinned external Webdesk source/runtime, Pi 0.84.2, Node 24.15.0, macOS arm64, local scripted provider. |
| Pi observation consumer | Frozen P1 assessment, immutable attempts, portable retention | Separate package; narrow approved-task scope. It never runs the candidate. |
| Inspect AI | Offline import and reassessment of retained P1 sources | Experimental; no candidate execution or model generation. |
| Ironside export | `trial export --format ironside`: one verified trial bundle or redacted derivative → Ironside native ingest requests, offline by default | Offline mapping checked against Ironside's published request schema and native mapper; `--ironside-url` delivery tested only against a local stub; no live Ironside or owner review. See [Ironside export](ironside-export.md). |
| Scenario | Static conversation replay from verified Pi evidence | Experimental authoring subset; no adaptive user simulation or live candidate connection. |

See the [documentation index](README.md) and each integration guide for commands. The [Pi development-loop protocol](pi-development-loop-protocol.md) defines its regression/correction exercise.

## Verification and limits

The public CI workflow runs typechecking, the full core suite on Linux and macOS, Pi integration contract tests, the separate Pi consumer suite, documentation-link checks, and the README reference flow. These use synthetic local fixtures. Native Pi execution and Python SDK experiments require separate prerequisites and are not implied by green core CI.

Earlier native Pi experiments exercised approval, denial, interruption, recovery and source regression/correction. Their historical run archives are not distributed in this public snapshot; generate and retain new evidence using the documented qualification drivers. Private customer pilot integrations and their evidence remain outside this repository.

Human onboarding observation, broad framework compatibility, live-provider selection in the Pi path, and governed portfolio-consumer acceptance remain open. A scripted provider exercise does not establish model quality or production readiness.

## Current wire and runtime restrictions


The v1 schemas and semantic rules are qualified together for this local preview. A later incompatible change requires a new wire version; no external portfolio interoperability is implied.

- Both agent and environment descriptors include `argv`, `cwd`, `artifactManifest`, `settingsSchema`, `settings` and declared capabilities. Paths resolve relative to the plan directory, including scenario overrides and artifact inventory entries.
- The first launcher supports only `["node", "relative-file.js"]`. It uses the exact running Node executable. Every declared runtime dependency must be included in the operator-supplied artifact inventory. The runner verifies those bytes; it does not discover all dynamic dependencies or attest the build.
- `modelCapture` supports `not_applicable`, `reported` and `accounted`. Model modes require a matching static and effective capability. `reported` conservatively retains `model_attempts_unverified`; `accounted` covers only the declared adapter boundary. Turn declarations, unknown outcomes and optional required provider-reported token usage govern completeness. Nullable model revisions/costs remain unknown. No provider SDK is imported by core; see [model accounting](model-accounting.md).
- `secretBindings` select named operator variables for one worker's environment. At most 32 bindings and 16 KiB total value bytes are supported; individual values require 8–4,096 UTF-8 bytes with no NUL or reserved masking marker. Runtime-control variables are rejected. The preview otherwise supplies only its fixed PATH/LANG/TZ values. Bound values and canonical JSON-escaped spellings are masked in runner-controlled evidence, including streamed diagnostics. See [privacy and export limits](privacy-and-exports.md).
- Operator-provided settings, fixture and tool schemas use a bounded subset: `$schema`, `title`, `description`, `type`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, `enum`, `const`, `anyOf`, `oneOf`. Remote references, regular-expression schemas and custom executable keywords are rejected. Maximum schema size is 64 KiB, depth 24 and 2,000 visited nodes.
- Inputs are bounded to 900 distinct files and 64 MiB overall; individual code files to 16 MiB and JSON inputs to 2 MiB. Relative traversal and descendant symlinks are rejected. The filesystem code is not a hostile-host race defense.
- The runtime supports 16 KiB–64 MiB of capture allowance. Journal termination/error/operation closure capacity is reserved so limits can produce a valid partial bundle. Events, snapshots and handshake observations consume one incremental allowance; pinned inputs and manifest/index metadata are separate. Each encoded event is capped at 2 MiB, and each trial at 10,000 operations. See the [transport bounds and failure checks](runtime-hardening.md) for shared wire accounting, LF framing and diagnostic queues.
- Preparation, agent ready/turns, stop, snapshot and cleanup waits have finite ceilings. This requires a responsive host/filesystem. CPU, memory, network, hard dollar limits and guaranteed cancellation of remote activity are unsupported.
- Every event is bounded and durably appended before its acknowledgment. Source provenance is explicit. The runner owns routed tool accounting; the agent adapter owns its model operations. An available stop acknowledgment is retained in `agent-stopped.json`, with outstanding activity preserved as an evidence gap.
- A manifest is published last using a no-overwrite atomic file operation. An unfinished run may have journals and captured snapshots without manifests. An accepted request is never replayed even if its writer crashed. `show` verifies the accepted allocation, inspects complete journal records, distinguishes intended/observed/known-not-dispatched operations and preserves unknown outcomes. It does not check executor liveness or perform automatic cleanup/recovery. Legacy stores without an allocation digest report unverified coverage.
