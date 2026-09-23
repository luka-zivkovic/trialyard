# Decision record

Specification date: 2026-09-06. Implementation update: 2026-09-07. After completing the specification, the user said “Ok, lets start” and authorized standalone implementation. This was the original implementation authorization; public publication was subsequently authorized in D7. No existing product ADR is superseded.

## Confirmed directions — TARGET

| ID | Direction | Basis | Revisit only when |
| --- | --- | --- | --- |
| D1 | Separate focused execution-environment project | User explicitly keeps portfolio products focused | The user changes the product boundary |
| D2 | Build the independent core before testing a customer integration | User corrected the build order | External testing exposes a general contract defect, documented explicitly |
| D3 | Customer traces are optional onboarding input, not core requirements or gold answers | User's correction and requested flow | The user requests a distinct trace-analysis product; it must not silently replace this one |
| D4 | Complete the specification before code | Completed; user subsequently authorized implementation | Product boundary changes remain explicit |
| D5 | Assume users understand the core concepts; optimize their technical workflows | User clarification on 2026-09-10 following the audit | Observed integration or iteration friction justifies a specific workflow change; preserve explicit semantics |
| D6 | Guide custom integration through source discovery, explicit owner decisions, a retained capability/fidelity contract, bounded qualification and reusable handoff | User approved the workflow and a fresh Pi replay on 2026-09-11 | Measured replay friction warrants changes; automatic orchestration and human qualification retain separate gates |
| D7 | Name the product Trialyard and create a new public repository with a polished README | User selection and publication authorization on 2026-09-13 | The user changes the name or publication scope |

## Specified defaults — ASSUMPTION

These choices make v0.1 implementable. They are proposed decisions, not historical approvals or validation results.

| ID | Choice | Benefit and cost | Evidence that would justify revision |
| --- | --- | --- | --- |
| S1 | Local CLI and customer-owned CI | Small deployable unit; user still operates test services | Repeated pilot need for managed setup and an agreed isolation model |
| S2 | TypeScript core/helper; process protocol for adapters | Fits existing engineering context without embedding a model SDK; custom agents still need adapters | A supported integration cannot meet the contract without excessive overhead |
| S3 | One target per run, sequential trials, fixed repetitions | Clear state and accounting; lower throughput | Measured workload requires concurrency and isolation is independently qualified |
| S4 | Explicit configuration before assisted setup | Runtime is testable before discovery; first preview needs more engineering effort | Measured onboarding failures show a different minimum entry path is necessary |
| S5 | Stateful fixtures plus a disposable-service adapter contract | Supports both substitutions and real state; service provisioning remains adapter work | External integrations reveal a missing general lifecycle capability |
| S6 | Raw execution evidence; business grading stays external | Preserves product boundaries; standalone users need a separate assessment step | Explicit product-boundary decision across the owning projects |
| S7 | Versioned exact-byte local evidence, no attestation claim | Inspectable integrity without inventing trust; no proof against a compromised host | A reviewed producer-authentication or isolation contract is implemented |
| S8 | Scripted user turns first | Cheap and inspectable; limited dialogue diversity | A validated scenario needs adaptive user behavior |

## Deferred choices

Packaging registry, pricing, hosting, enterprise identity, additional adapter catalog, model-driven simulation and multi-host execution are outside v0.1. These are not blockers to the specified local core.

Integration acceptance by Ironside, Rubrist or Dailies is not assumed. Their contract owners must review actual producer/consumer mappings and fixtures before an integration is described as supported. This does not block the independent developer preview.

## Authority and evidence labels

- **TARGET:** accepted product direction in PRODUCT.md and confirmed decisions above.
- **CURRENT:** implemented behavior, bounded by documented support and actual checks.
- **ASSUMPTION:** a proposed default or unresolved direction; it does not override accepted scope.

The public snapshot preserves the short `trial` command, `trial-runner.setup.json`, v1 schema identifiers, and frozen consumer identities. Private customer integrations and historical evidence archives are retained in the original repository. The public setup skill is 0.4.0; readers retain support for earlier snapshots.
