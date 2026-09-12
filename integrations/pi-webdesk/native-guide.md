# Pi Webdesk native scripted slice

**CURRENT — 2026-09-11:** this integration builds ordinary Trialyard v1 plans and native evidence bundles. It packages real Pi 0.84.2 with its installed dependencies, uses Webdesk's existing RPC bridge/supervisor and supervised policy, and delegates to Pi's original read/write/edit/bash implementations. The model provider is a local scripted fixture. [Current support and limits](../../docs/current-preview.md).

## Build and run

Prerequisites: macOS arm64, Node **24.15.0**, the installed Trialyard dependencies, and a Pi Webdesk checkout with Pi **0.84.2** and esbuild installed. Build the runner with the pinned toolchain. No provider credential or network model request is used. Use new build/output directories and new request IDs for intentional executions.

From the Trialyard root:

```sh
npm run build
node integrations/pi-webdesk/build-native.mjs /absolute/path/to/pi-webdesk .trial-runs/pi-native-new
node dist/src/cli/main.js validate .trial-runs/pi-native-new/baseline-plan.json
node dist/src/cli/main.js run .trial-runs/pi-native-new/baseline-plan.json --request pi-first --store .trial-runs/pi-native-store
node dist/src/cli/main.js show --request pi-first --store .trial-runs/pi-native-store --format text
```

The baseline plan runs two fresh repetitions, each with two user turns. `notes.txt` changes from absent to `alpha\n`, then to `beta\n`. The prepared directory also contains `denied-plan.json` and `interrupted-plan.json`. The interrupted fixture's shell command writes `started\n`, waits 30 seconds and would append `finished\n`; the qualification driver cancels after independently observing the first write. Running that plan alone without cancellation lets the command finish.

The native CLI prints each bundle directory and digest. Inspect or verify the retained bundle with its ordinary commands:

```sh
node dist/src/cli/main.js verify /absolute/bundle/directory --sha256 <printed-digest>
```

A matching repeated request ID returns the accepted result without executing again. Changing the plan or its inputs under that ID conflicts. Current builds also publish `connection.json` and consumed-source/compiler records. Use the [source rebuild workflow](source-rebuild-guide.md) to select ordinary Webdesk TypeScript edits, preserve the trial configuration and retain parent lineage. Generic `trial rebuild` remains the Node function path; older builds without source records need a fresh connection before Pi source iteration.

## Qualification driver

```sh
node --test integrations/pi-webdesk/*.test.mjs
node integrations/pi-webdesk/qualify-native.mjs .trial-runs/pi-native-new .trial-runs/pi-native-check-new
```

The driver copies the build into a new location, executes five trials, verifies every native bundle, checks duplicate-request behavior, and rejects modified package/bundle bytes. Its crash case deliberately kills the one native agent child it owns, after observing the fixture's first write. It preserves every run and its assertion results under the new output directory. It never starts the Webdesk daemon or operates an existing user task.

The qualifier exits 0 when the declared assertions pass. Within that qualification, the cancellation run still has native exit **130**, and the agent-crash run still has native exit **2**. Both retain incomplete evidence and an unknown interrupted tool outcome. A successful qualification does not rewrite those outcomes as successful agent execution.

## Execution and capture boundary

The native environment owns one private lease, fresh Git repository, private Pi configuration/session directories, Unix-socket bridge and Pi process tree. Pi's pre-tool hook waits for the runner's durable intent. The original Webdesk policy then asks for approval. The host approves only the exact declared fixture actions; the denied-write case receives an explicit denial. An allowed original callback waits for the environment's native dispatch-observation acknowledgment before invocation. Denial is recorded as `not_dispatched` without a dispatch observation.

The native agent uses the shipped `AdapterPeer` and `ModelRecorder`. Each local scripted responder invocation has intent, observed entry and a result, including the actual Pi-bound context. Native usage/cost observations are null; Pi's internal synthetic zero usage fields are not measured provider usage. Source/build identity, the scenario and fixed fixture are pinned before execution.

Initial/final files are read by the environment. `final-state.json` includes `/state/files`, the exact Pi-owned session JSONL at `/state/session/raw`, callback/approval observations and process ownership/readback. The UI's bounded session projection is used only to obtain final assistant text. It is not the raw evidence source. On cancellation or agent disconnection, the environment remains available to stop Pi and capture state. Unknown operation outcomes and missing turn coverage remain explicit.

## Packaging and current limits

The builder traverses the installed Pi pnpm dependency graph, preserves file bytes and contained links, normalizes permissions to regular/executable files, compresses it and emits chunks of at most 8 MiB. All chunks, the package metadata, bridge/policy/probe and native adapters are pinned native artifacts. Preparation checks compressed and expanded hashes, record limits, file bytes, duplicate paths and contained link targets before writing into a new lease. Execution uses that extracted graph. The original Pi checkout is a build prerequisite rather than a runtime lookup path.

This is operator-trusted local execution. Node, macOS, Git, bash and `ps` remain platform prerequisites. Packaging is not authenticity attestation, a sandbox, a reproducible compiler proof or universal portability. Arbitrary tools, provider retries, arbitrary dynamic dependencies, daemonizing shell workloads, a Webdesk UI/worktree-manager flow, controller/environment-worker crashes, and cancellation during package expansion are outside this qualification. Cleanup diagnostics and original failed attempts remain evidence; an unknown cleanup result is not repaired by relabeling its bundle.

The supplied scenarios and scripted tool calls are intentionally fixed for this slice. Source edits within the maintained consumed TypeScript scope use the [qualified rebuild workflow](source-rebuild-guide.md). General scenario/provider selection, human onboarding, M4 external assessment and full M5 reuse qualification remain open.
