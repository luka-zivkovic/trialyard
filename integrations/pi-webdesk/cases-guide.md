# Declared Pi file cases

**CURRENT — experimental, qualified local scripted scope:** author a new case as JSON, materialize it against an updated native connection, and run ordinary Trialyard plans. The same compiled adapter accepts both tested recovery paths. This does not select a real model provider or support arbitrary services, shell commands, nested directories or model-driven user simulation.

Use the existing macOS arm64 / Node 24.15.0 / Pi 0.84.2 prerequisites in [native preparation](native-guide.md). A native build made before `declared-v1` support is rejected by materialization; create one updated base build first. Existing retained builds remain unchanged.

```sh
node integrations/pi-webdesk/build-native.mjs /absolute/installed-webdesk /absolute/new-native-build
node integrations/pi-webdesk/materialize-case.mjs /absolute/new-native-build/connection.json integrations/pi-webdesk/cases/recovery-direct.json /absolute/new-case
node dist/src/cli/main.js check-connection /absolute/new-case/connection.json
node dist/src/cli/main.js run /absolute/new-case/case-plan.json --request recovery-1 --store /absolute/trial-store
```

The materializer optionally accepts the expected parent connection SHA-256 as its fourth argument. It never executes the candidate. It retains the original case bytes, a static dialogue projection and parent/case digests; the original case bytes and projection are also pinned into the native artifact inventory. Each generated plan requests two fresh repetitions. Existing output directories are rejected, including partially written failed attempts.

`case-contract.mjs` defines the closed versioned case schema and semantic checks. A case declares initial files, permitted flat filenames, permitted read/write/edit tools, ordered user turns, provenance, external criterion references and a separate local scripted responder. Tool admission checks capabilities and arguments; it does not require a particular scripted invocation ID or sequence. The scripted responder checks its expected results/history independently. A new path within these capabilities needs a different JSON case, with zero adapter or application source edits.

The recovery examples exercise an original read of a nonexistent file, followed by either writing the fallback directly or writing an intermediate value and editing it. The failed variant leaves the result absent. R1 is an experimental external state-recovery criterion in `recovery-assessment.mjs`; it is not a governed Rubrist evaluator. It checks stable fresh state, the observed original read failure and the recovered file across both turns. It does not require an exact successful trajectory or grade the assistant's prose. Its code is not imported into the native agent or environment.

```sh
node integrations/pi-webdesk/qualify-cases.mjs /absolute/new-native-build/connection.json /absolute/new-qualification
```

The qualifier freezes its criterion and case identities, materializes three cases, executes six trials, checks distinct leases/sessions and cleanup, assesses the outcomes, and verifies duplicate requests do not replay. Missing-final checks are explicit synthetic assessment inputs, not extra candidate executions.

The `trial-runner/static-dialogue/v1` interchange is owned by this integration. It supports only alternating explicit user messages and agent-response steps. The [Scenario experiment](../scenario/README.md) consumes it through the actual SDK. Arbitrary Scenario Python functions, adaptive users, judges, injected agent output and caching are not represented. The τ-bench influence is the separation of domain capabilities from case/criterion data; no τ-bench dependency is used.

Source rebuild commands still apply to the maintained native base connection and preserve its configured trial set. To run an edited candidate on one of these cases, build/select/rebuild the native base as appropriate, then materialize the same case bytes into a new case connection. A declared-case connection is not yet a direct parent for the Pi-specific source rebuild command.

See [current support](../../docs/current-preview.md). These are local engineering results; real-model recovery quality, human onboarding and general framework compatibility remain unqualified.
