# Edit and rebuild a Pi candidate

**CURRENT — 2026-09-11:** maintained Pi builds publish `connection.json`, a snapshot of consumed Webdesk TypeScript source and fixed compiler/dependency identities. The integration-specific commands below freeze a source edit, rebuild it against the same runtime, preserve the trial configuration and retain parent lineage. Build/select/check do not execute a candidate. [Current support](../../docs/current-preview.md).

## First connection

Use macOS arm64, Node 24.15.0 and an installed Webdesk/Pi 0.84.2 dependency workspace. From the Trialyard checkout:

```sh
npm run build
node integrations/pi-webdesk/build-native.mjs /absolute/pi-webdesk /absolute/new-pi-parent
node integrations/pi-webdesk/rebuild.mjs check /absolute/new-pi-parent/connection.json
node dist/src/cli/main.js run /absolute/new-pi-parent/baseline-plan.json --request pi-before --store /absolute/pi-store
node dist/src/cli/main.js show --request pi-before --store /absolute/pi-store --format text
```

The baseline has two fresh repetitions, each with two turns. `denied-plan.json` and `interrupted-plan.json` are also retained. The [native guide](native-guide.md) explains those fixtures and failure qualification. A generic `check-connection` validates the native recipe's bytes and baseline plan; the Pi `check` above additionally checks the other maintained plans and Pi source/parent lineage. Keep the printed recipe digest when externally pinned identity matters, and pass it using `--sha256`.

Older native builds without `connection.json` and `pi-build-state.json` remain runnable. Make a fresh connection with this builder to begin source iteration. Generic `trial rebuild` handles the Node function template; it does not implement Pi compilation.

## Select the edit, then rebuild

Edit the actual application in your working checkout or an isolated source copy. The current selected scope consists of the existing consumed `.ts` files under `packages/pi-bridge/src/` and `packages/pi-bridge/extensions/`, as listed in `pi-build-state.json`. No candidate fixture, scripted-provider or adapter edit is needed.

```sh
node integrations/pi-webdesk/rebuild.mjs select /absolute/new-pi-parent/connection.json --source /absolute/edited-webdesk --out /absolute/new-pi-selection.json
node integrations/pi-webdesk/rebuild.mjs build /absolute/new-pi-parent/connection.json --selection /absolute/new-pi-selection.json --runtime /absolute/installed-webdesk --out /absolute/new-pi-candidate
node integrations/pi-webdesk/rebuild.mjs check /absolute/new-pi-candidate/connection.json
node dist/src/cli/main.js run /absolute/new-pi-candidate/baseline-plan.json --request pi-after --rerun-of pi-before --store /absolute/pi-store
node dist/src/cli/main.js show --request pi-after --store /absolute/pi-store --format text
```

`--source` supplies the selected application files. `--runtime` supplies the installed compiler and dependency workspace; these can be the same checkout. Selection freezes source bytes, so subsequent working-copy edits cannot silently change that build. Review `sourceChanges` and `selectedSources` in the selection result; unlisted files are not inspected or selected. An edit outside that scope will not appear as a candidate change.

Build output directories and selection files must be new. The compiler worker has a 120-second deadline, a 1 MiB output limit and cancellation support. Output/failure records remain in the new directory; a failed build has no published `connection.json`. No package installation, provider request or application process runs during rebuild. Explicit trial execution retains the existing native lifecycle limits.

To continue from the revised candidate, use its `connection.json` as the next parent. A no-op selection is explicit and can be rebuilt; it preserves source and compiled policy bytes while producing a new build record. Build timestamps mean the overall input digest can change even for a no-op. Reusing an accepted request returns its original run; changed inputs under the same request ID conflict. Use a new ID for each intentional run and the same explicit store for inspection.

## What stays fixed

The rebuild copies the verified parent's scenario, fixture, profile, limits, repetitions, settings schemas, tools, clock/fault settings, credential bindings and packaged Pi dependencies byte-for-byte. The compiler and its binary, host Node, adapter/instrumentation source, fixed consumed inputs, recorded resolution manifests, source inventory and captured import graph must match the parent. The builder uses explicit ES2023 TypeScript class-field/verbatim-module settings and Node 24 ESM output, so ambient tsconfig discovery cannot silently change compilation.

Changed dependencies, compiler/tooling, captured imports, new or removed source files, or trial configuration require a deliberately prepared new connection. A selected-source edit is not a proof that the application still satisfies the previous capture boundary: review changes and inspect the actual new trial. Computed runtime behavior and arbitrary side effects cannot be established by an import graph. This remains operator-trusted local execution, not a sandbox or build-authenticity claim.

## Inspect what changed

The revised directory contains:

- `connection.json`: native recipe, baseline input identity and all selected build/configuration files.
- `pi-build-state.json`: exact consumed source text/hashes and compiler, dependency and import identities. It is pinned in the native adapter artifacts.
- `pi-selection.json`: the source snapshot used by this rebuild and its expected parent digest.
- `pi-rebuild.json`: changed source hashes, immediate parent/input identities and preserved-file inventory.
- `pi-parent-connection.json` and `pi-parent-state.json`: exact immediate-parent records for offline lineage checks.
- `build-worker.log`: bounded compiler diagnostics, outside the published recipe inventory.

Use `show` to inspect both runs and `verify <bundle> --sha256 <printed-digest>` for their exact returned bundles. Native execution evidence does not include a quality comparison or a release decision. The source lineage explains which input changed; the actual tool/model events and independently read Pi session explain its observed effect.

The generic text view shortens large snapshots. To see the exact tool-result content, including a changed policy explanation, use the Pi reader on the returned bundle:

```sh
node integrations/pi-webdesk/inspect-native.mjs /absolute/trial-bundle --sha256 PRINTED_BUNDLE_DIGEST
```

It verifies the bundle and snapshot bytes, then prints independent files and Pi tool results with their session line numbers. Unavailable sessions remain null; unlisted snapshot files are not read. It does not infer results from assistant prose or create an assessment.

For a concrete exercise, the qualification driver copies the selected source, appends a sentence to Webdesk's approval-denial explanation, selects it, edits the working copy again, and rebuilds the frozen selection. It observes the selected explanation in the Pi-owned session and subsequent model input, with the write still denied. Parent and candidate baseline/denied trials retain identical configuration, complete evidence and successful cleanup. No original Webdesk checkout is modified.

```sh
node integrations/pi-webdesk/qualify-rebuild.mjs /absolute/new-pi-parent/connection.json /absolute/installed-webdesk /absolute/new-rebuild-check
```

That driver performs four accepted requests/six trials, a no-op descendant rebuild and explicit rejection checks. Invalid-syntax and changed-import attempts are intentional negative tests and remain unpublished. It does not exercise an arbitrary scenario/provider, infer agent quality or close human onboarding. Generic cancellation/crash qualification remains separately available in the native guide.
