# Implementation and acceptance plan

**TARGET:** preserve the product boundary and milestone acceptance criteria below. **CURRENT:** the independent local core and declared Node setup are implemented. The public snapshot also includes Pi execution and separate assessment experiments; see [current support](current-preview.md).

Private pilot work does not establish publicly reproducible support. Human onboarding observation, broader integration reuse and consumer-owner acceptance remain open. Source discovery and qualification guidance are available through the [setup skill](connection-setup.md); an automated investigation or repair service remains unimplemented.

## Repository layout

```text
PRODUCT.md
README.md
AGENTS.md
docs/
contracts/             # schemas, semantic invariants, producer fixtures
src/core/              # run/trial lifecycle, journals, limits, identities
src/cli/               # local commands and diagnostic presentation
src/sdk/               # process protocol and TypeScript adapter helpers
src/discovery/         # bounded static inspection and versioned templates
src/export/            # native bundle and assessment-input mapping
reference/             # independently specified scripted agent/environment
test/                  # conformance, failure injection, consumer verification
integrations/          # external adapters, each with declared support/fidelity
```

The core must not import integrations, a model-provider SDK, repository-specific schemas or tracing-vendor clients. Packaging must allow reference tests to run with no customer repository, traces, database or model credentials. Select and lock exact toolchain versions at M0. The names above specify responsibility, not a requirement to split a tiny first implementation into many packages.

## Milestones

| Milestone | Deliverable | Exit evidence |
| --- | --- | --- |
| M0 — contract foundation | Closed schemas and semantic validators for plan, scenario, process frames, environment calls, events, manifests and assessment-input mapping; documented terminal truth table | All positive fixtures accepted; negative fixtures for unknown fields/versions, unsafe paths, identity mismatch, duplicate IDs, invalid lifecycle and missing evidence rejected by an independent consumer validator |
| M1 — developer preview | Local explicit-config CLI; request journal; process adapter/SDK; fresh state; scripted turns; fixed repetitions; limits; cancellation; snapshots; evidence bundles | M1 rows of the reference matrix pass without a network or model key; crash/duplicate-request behavior and file-boundary checks pass; documented exit codes match results |
| M2 — assisted setup | Static Node repository discovery, template preparation, specific unresolved-capability reports and guided local run | Clean supported fixture repository onboards using docs; unsupported repositories fail honestly; no repository script or secret file is read/executed/uploaded by inspection |
| M3 — first external integration | Onboard an external application using the same published configuration, adapter and evidence contracts | Real agent execution in a disposable environment; record manual work and fidelity; observe a controlled regression and correction under separately reviewed expectations; no customer-specific core branches |
| M4 — assessment handoff | Qualified external assessment-input consumer and documented portfolio mappings | A consumer verifies an actual bundle, applies an independent criterion, retains source identity and incompleteness, and rejects tampering; specific portfolio support requires the owning consumer's contract checks |
| M5 — broader reuse | A second unrelated agent integration | Measured setup effort, adapter changes and capability gaps; same core contracts or an explicit generally justified contract revision |

M1 is a developer preview. M2–M4 qualify the first customer MVP for its documented supported integration. M5 is the gate for broader plug-and-play claims. This sequence avoids building a universal mock catalog before testing whether one honest onboarding path works.

## Independent reference integration

Use a deliberately small inventory-reservation environment with a written contract, created independently of all customer applications and traces. Start each trial with three available units and no reservations. Its tools expose stock lookup, reservation creation with an explicit idempotency key, and reservation lookup. Repeating the same key with the same request returns the same reservation without another deduction; reusing it with changed arguments is a conflict. Reserving unavailable stock changes nothing.

The scripted reference agent can look up stock, reserve one unit and report the resulting reservation on a follow-up. A second turn sees the same trial state. The next repetition starts from three units again. The reference contract's expected state is maintained separately from the environment implementation, so a test does not merely echo whatever the fixture returns.

Reference variants inject a duplicate physical reservation under a new key, a false assistant claim without a write, a lost response after a committed write, a hanging operation, an agent crash and a missing snapshot. These validate harness/accounting behavior. They neither require nor establish LLM intelligence.

## Required acceptance matrix

| ID | Situation | Required result |
| --- | --- | --- |
| A01 | Two turns in one trial | Second turn sees the first turn's state and conversation |
| A02 | Two repetitions | Distinct leases and trial IDs; identical initial fixture; no shared reservations |
| A03 | Preparation/reset failure | Zero agent dispatch; incomplete/not-started trial record |
| A04 | Known incorrect agent behavior, fully captured | Evidence can be complete; CLI does not invent a behavioral pass or release decision |
| A05 | Declared tool failure before mutation | Error captured with unchanged state; no invented result |
| A06 | Lost response after mutation | Actual dispatch and unknown response outcome retained; independent snapshot shows available truth; no runner auto-replay |
| A07 | Agent intentionally repeats a call | Every physical attempt recorded; idempotency applies only under the environment's stated contract |
| A08 | Unsupported tool or capture capability | Required preflight mismatch prevents dispatch; newly encountered unsupported operation yields an explicit environment/adapter gap |
| A09 | Timeout or cancellation | No new work dispatched; bounded local stop and cleanup; unresolved remote activity remains unknown |
| A10 | Agent/model error vs broken adapter | Correct execution category and error boundary, with completeness assessed independently |
| A11 | Missing final snapshot or unresolved later write | Required final-state evidence incomplete, even if assistant says success |
| A12 | Frame/event/byte limits exceeded | Explicit capture gap and bounded termination; no silent truncation |
| A13 | Duplicate request and conflicting request | Same accepted identity cannot start another agent; changed input under same request ID conflicts |
| A14 | Crash before intent acknowledgment, after acknowledgment/before send, or after send/before result | No controlled dispatch before durable acknowledgment; recovery distinguishes known non-dispatch, observed dispatch and unknown dispatch/outcome; prior journal retained and no automatic replay |
| A15 | Cleanup failure | Owned-resource diagnostics retained; remaining slots not started; operational exit nonzero |
| A16 | Bundle tampering | Consumer rejects altered bytes, missing files, unsafe paths, event reordering, identity swaps and unsupported version |
| A17 | Missing usage, mutable model alias or unverified build | Unknown/declared provenance remains visible; no manufactured zero cost or verified identity |
| A18 | Redacted export removes required evidence | New derivative digest and incomplete coverage for affected profile |
| A19 | Inspect an untrusted repository | No scripts run, no automatic network, no secret reads or external symlink traversal; malicious instructions are treated as data |
| A20 | External deadline shorter than configured trial | Caller ceiling wins; late cleanup/remote work is separately accounted |
| A21 | Multiple planned trials with a partial run | Every planned slot appears; denominator and not-started reasons cannot disappear |
| A22 | External assessment failure | Execution evidence retained; no fabricated candidate label or release decision |

Milestone assignment: A01–A18 and A20–A21 belong to M1; A19 belongs to M2; A22 belongs to M4. M0 defines their schema/semantic fixtures before execution. M3 reruns the applicable M1 checks through the external integration, with real model and service boundaries, rather than claiming the reference fixture qualified that integration.

Include failure injection at the actual adapter/process/filesystem boundaries, not only mocked return values. Native schema validation and consumer verification must both run. The independent consumer should be authored from the documented contract and include adversarial fixtures absent from the producer happy path.

## Onboarding qualification

Before the first external session, freeze the task and record prerequisites: supported OS/toolchain, adapter status, model access and disposable-service availability. Start the clock at repository selection; distinguish installation wait, adapter authoring, scenario review and actual runner interaction. Log every manual edit, undocumented command, assistance request and unsupported capability. Report the observations without a market-wide extrapolation from one project.

The user must be able to explain the declared environment boundary, which values were observed vs reported, why a trial is incomplete, and where behavioral judgment happens. A second engineer should repeat the supported flow from the documentation. If bespoke adapter code is needed, measure it separately rather than hiding it behind “automatic setup.”


## Definition of done for implementation

An implementation milestone needs its listed tests, documented supported scope and an independent review of the exact changes. It must report limitations and unqualified handoffs. Passing M1 does not permit a claim of production sandboxing, calibrated agent quality, a complete enterprise environment or a fully supported portfolio release loop.

This specification is complete when all required contracts, state transitions, limits, failure outcomes, product boundaries and milestone exits are defined, examples are internally consistent, and independent review has no unresolved correctness blockers. That is the completion criterion for the current documentation task; it is separate from implementing these milestones.
