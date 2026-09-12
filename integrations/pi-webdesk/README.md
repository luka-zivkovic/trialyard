# Pi Webdesk feasibility harness

**CURRENT:** the [native scripted integration](native-guide.md) now builds ordinary Trialyard plans and verified native bundles, including cancellation and an agent-worker crash. Use that guide for the current build/run/inspection path and the [source rebuild guide](source-rebuild-guide.md) for ordinary consumed Webdesk TypeScript edits. Real-provider accounting, general scenario selection, human onboarding and full M5 qualification remain open.

The earlier bounded experiment used real Pi 0.84.2, the existing Webdesk RPC bridge/supervisor and supervised policy, original exported Pi tool implementations, and a local scripted provider. Four cases passed: two fresh two-turn file-edit repetitions, a denied write, and interruption after a partial shell write. Historical run archives are outside this public checkout; run the driver below to retain fresh evidence.

Read [the preregistered feasibility scope](selection.md) before changing the earlier cases. The feasibility harness below still emits `pi-webdesk-feasibility` reports with `nativeBundle: false`; the native guide documents its separate successor.

## Run

Prerequisites: macOS, the Trialyard pinned Node 24.15.0 and installed Trialyard dependencies, a Pi Webdesk checkout with its installed Pi 0.84.2 and esbuild dependencies. Dependencies are reused; this command does not install them. Use a new output directory every time; existing outputs are rejected.

From the Trialyard root:

```sh
node --test integrations/pi-webdesk/*.test.mjs
node integrations/pi-webdesk/run-feasibility.mjs /absolute/path/to/pi-webdesk .trial-runs/pi-feasibility-new
```

The script bundles selected Webdesk bridge/policy code into the output directory, records source/build identities, creates fresh disposable Git repositories and private Pi configuration/session directories, then starts Pi through Webdesk's actual supervisor. It disables ambient extensions, skills, templates, context files, themes and startup network operations. The explicit scripted provider has no network implementation; no model-provider credential is inherited. The only shell command approved is the exact synthetic write/wait fixture. The original policy decides whether the callback can proceed; the host answers only the expected dialogs.

The probe uses Pi's supported tool overrides and delegates to its original tool definitions. Each callback must await an external file permit after a durable interception record. The host holds each gate for at least 100 ms, observes unchanged fixture state, durably records release, then permits execution. This file gate tests a continuation boundary; it is not a production transport or a hostile-code sandbox.

Exit 0 means all declared feasibility assertions and cleanup checks passed. The interruption case still records `execution: interrupted` and `operationOutcome: partial_effect_observed`. Provider output is deterministic test input, not model-quality evidence.

## Retained output

- `report.json`: closed feasibility schema, separate execution/evidence/outcome/cleanup fields and per-case checks.
- `identity.json`, `source/`, `build/`: selected source hashes, compiled bridge/policy/probe bytes, Pi/toolchain identity and dependency-lock hash. The external Pi dependency closure is not vendored or fully attested.
- Each case: original Pi session, raw scripted-provider contexts and callback records, bounded Webdesk events, approval/gate/abort/process journal, and independent initial/between/final/post-disposal filesystem observations.

The raw Pi session is preserved separately from the bridge's bounded UI projections. Cleanup checks the observed supervisor/Pi/shell descendants by PID and start time, then removes the owned disposable lease. An unverified process cleanup retains the lease path and prevents a successful result. These observations do not prove cleanup of arbitrary daemonizing tools. Earlier invocations are retained, including preparation failures.

Tests exercise duplicate dispatch prevention, mismatched requests, gate timeout, abort-before-dispatch and partial callback failure, plus report invariants and invalid claims. They do not qualify the native runner protocol.
