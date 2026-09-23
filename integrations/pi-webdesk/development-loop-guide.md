# Diagnose and correct a Pi source regression

The engineering exercise uses real Pi/Webdesk with its original tools and a local
scripted provider. P1 checks a supervised file task: write alpha, edit it to beta,
and require exact confirmed approval before each mutating callback. The injected
regression wrongly classifies `edit` as read-only. All variants can produce the
correct file, which makes this useful for checking whether retained evidence
explains a defect that a final-output check misses.

Use macOS arm64, Node 24.15.0, a built Trialyard CLI and an installed Webdesk
workspace containing Pi 0.84.2. See [native preparation](native-guide.md) and
[source rebuild](source-rebuild-guide.md) for the exact supported prerequisites.
Use a new output directory every time; accepted attempts are never overwritten.

```sh
node integrations/pi-webdesk/qualify-development-loop.mjs \
  /absolute/parent/connection.json \
  /absolute/installed-webdesk \
  /absolute/new-qualification-directory
```

The harness freezes the protocol, checker, criterion, source change and six-trial
matrix before the first execution. It materializes the parent's captured source
into an owned copy, builds a no-op baseline, runs two fresh repetitions, then
builds and runs the regression. Only after writing `diagnosis.json` from retained
evidence does it create and run the corrected copy. Every build keeps the frozen
scenario, fixture, profile and plans byte-identical. No paid provider is used.

The separate [Pi consumer](../../consumers/pi-assessment/README.md) validates
source bytes and producer mappings, then runs P1 in a bounded checker process.
`qualification.json` retains native execution/evidence/cleanup beside the
assessment, rather than treating a finished run as a behavioral pass. Open the
assessment's `events.ndjson#line:N` references for dispatch and
`final-state.json#/state/observations` for approval order. `inputs/pi-build-state.json`
retains the exact consumed Webdesk source. `*-selection.json` and `*-rebuild.json`
record the source changes and parent relationship outside the bundle.

For a particular assessment:

```sh
node consumers/pi-assessment/cli.mjs show regression-0 \
  --store /absolute/qualification/assessments --format text
node integrations/pi-webdesk/inspect-native.mjs /absolute/trial \
  --sha256 PRINTED_BUNDLE_SHA
```

Inspect `diagnosis.json` to follow the edit's invocation/operation identity from
successful file change to observed callback dispatch and absent prior approval.
The correction restores the exact baseline policy bytes. A synthetic missing-final
fixture separately proves that unavailable evidence yields `not_evaluable`; its
`consumer-test-fixture.json` explicitly records the source digest and mutation.
It is not another application execution or a native redaction export.

Each assessment is packed with its source, mapping, original attempt and exact
consumer code/dependencies. Preserve `freeze.json`, `qualification.json`, all
selection/rebuild/diagnosis records, every successful package and their printed
retention digests. The harness relocates the baseline package, reassesses using
its archived consumer, and exercises duplicate/no-replay, request conflicts and
tamper rejection. Failed/tampered diagnostic copies remain separate. Moving an
archive requires a new request for reassessment; original requests remain intact.

This qualifies a fixed scripted local workflow and a trusted observation
boundary. It does not establish general model quality, permission security,
human comprehension, independent review, release readiness or native Rubrist
integration. Local portable archives still need a separate backup destination.
