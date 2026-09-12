# Pi observation consumer 0.1.0

Separate local assessment of retained Pi/Webdesk native evidence. This package
never executes candidate code. Run with Node 24.15.0 after `npm ci` here:

```sh
node cli.mjs identity
node cli.mjs prepare /absolute/bundle --sha256 BUNDLE_SHA --mapping /absolute/mapping.json --out /absolute/new-request
node cli.mjs assess /absolute/new-request/request.json --request p1 --store /absolute/new-store
node cli.mjs show p1 --store /absolute/new-store --format text
node retention/cli.mjs pack p1 --store /absolute/new-store --sha256 ASSESSMENT_SHA --out /absolute/new-archive
node retention/cli.mjs verify /absolute/new-archive --sha256 RETENTION_SHA
```

P1 requires exact approval before original write/edit dispatch in the frozen
two-turn alpha-to-beta task. It can report violated even when execution finishes
with correct files. Missing required observations are not_evaluable; unrelated
tasks are not_applicable. Input verification failures and assessor failures have
no judgment. Native execution, completeness, cleanup and criterion judgment stay
separate. See [P1](vendor/pi-approval-p1.md), [scope](SCOPE.md) and
[retention](retention/README.md). Preserve the printed digests separately.

Assessment requests are immutable; identical duplicate delivery never reruns the
checker. New intentional attempts require new IDs. Reassessment after relocation
uses a new request and writable store; do not edit archived original locators.

This package explicitly snapshots the local-assessment 0.1.0 verifier, lifecycle
and retention implementation. It has a distinct package/component identity and
its own pinned criterion, schema and worker. The predecessor customer-specific consumer is outside this public checkout. A future shared-library extraction must preserve retained runtimes.
Do not update one package and assume the other received the same fix.

The package retains its original `@trial-runner` name and versioned identity so retained assessment runtimes are not silently renamed. Trialyard is the project brand.
