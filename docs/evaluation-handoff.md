# Evidence and assessment handoffs

**CURRENT:** the separate [Pi observation consumer](../consumers/pi-assessment/README.md) verifies retained native evidence and applies the frozen P1 approval criterion. Its [retention tool](../consumers/pi-assessment/retention/README.md) packages source, mapping, terminal attempts and the matching consumer runtime. The [Inspect AI experiment](../integrations/inspect-ai/README.md) reuses that consumer for offline assessment.

These are bounded local consumers, not native Rubrist or Dailies integrations. A consumer can reassess retained evidence without rerunning the candidate. Missing required observations remain `not_evaluable`; source rejection and assessor failure produce no behavioral judgment.

## Execution evidence and assessment

**ASSUMPTION — specified boundary:** the runner emits execution evidence. It does not author the business rule, decide that a candidate passed, or turn historical outputs into correct answers. Structural checks inside the runner verify protocol, coverage and environment lifecycle only.

An assessment consumer selects a criterion, reads the required evidence, and emits a separate result tied to the trial bundle digest. A customer can start with human review or a deterministic check and later use a governed evaluator. The runner does not need a rubric to execute a declared scenario.

| Criterion example | Runner supplies | Assessment responsibility |
| --- | --- | --- |
| Exactly one reservation exists | Independently read reservation records and operation history | A deterministic evaluator checks the approved count and identity rule |
| A protected record was not exposed | Tool results, final response, access scope and capture gaps | An evaluator applies the approved disclosure rule; missing channels cannot count as a pass |
| The explanation is supported | Conversation, returned source material and state references | A human or calibrated semantic evaluator assesses groundedness |
| The agent handles a lost response correctly | Actual request attempts, unknown response outcome and resulting state | An evaluator checks the domain's idempotency/recovery rule |
| Cost stayed within a policy | Available physical-call usage, estimates and unknown amounts | The policy owner determines whether that evidence is sufficient and within its threshold |

These are examples, not built-in criteria or sample gold labels. The independent reference fixture's software tests verify its specified state transitions; they are not evidence of an arbitrary agent's quality.

Single criteria stay separate. An unavailable judge, missing state or unknown provider operation is not converted into candidate failure or success. A trace of a known agent error can be complete, and an assessor can judge it against an applicable criterion. Missing evidence for one criterion does not erase another criterion's captured observations.

## Assessment-input envelope

**ASSUMPTION:** a native export mapping `trial-runner/assessment-input/v1` carries:

- Exact trial bundle digest and scenario identity/repetition index.
- Candidate identity and declared evidence scope, with identity strength and capture limits.
- Selected artifact references and role labels: conversation, tool trajectory, initial state, final state, runtime events.
- Capture/completeness state for each selected input, including redaction and unknown outcomes.
- Optional external criterion/reference IDs supplied by the caller, kept out of the agent context.
- Mapping version and source manifest digest.

It contains no assessment label, calibration claim or release decision. It does not carry gold answers copied from trace output. Consumers must verify the original bundle and their required observations; a mapping must never improve the source trust or completeness. The native format is the new product's contract. Compatibility with another product requires an actual reviewed exporter and consumer verifier.

## Portfolio responsibilities

**TARGET:** the [product charter](../PRODUCT.md) assigns assessment governance to Rubrist and release coordination/policy to Dailies. Trialyard supplies execution evidence. Native interoperability requires reviewed mappings and consumer checks.

**ASSUMPTION — proposed integration contracts:**

| Product | Input from/to the runner | Qualification before claiming support |
| --- | --- | --- |
| Ironside | Export of captured trial activity with source bundle identity and original provenance | See the Ironside note below; live delivery and Ironside-owner review remain open |
| Rubrist | Assessment-ready evidence or a trace import preserving source identity and capture gaps | Verify the actual intake mapping; separate source execution evidence from the assessment receipt Rubrist later emits |
| Dailies | One resolved candidate execution request and returned trial evidence; caller retains release item/scope correlation | Review delegated-execution ownership, request identity, deadlines, cancellation, unknown outcomes and trust classification before adding a native integration |
| Casefile | Optional static admission of a packaged adapter/capability artifact | Preserve no-execution inspection; admission is not certification of runtime safety or simulation fidelity |

**CURRENT — Ironside offline export:** `trial export <bundle> --format ironside --out <file>` implements the [Ironside export mapping](ironside-export.md) `trial-runner/ironside-ingest/v1`. It verifies the bundle (or a redacted derivative against its local original), maps one trial repetition to one Ironside trace in native `POST /api/v1/ingest` request bodies, keeps capture gaps and redaction as explicit `trialyard.*` markers, separates the candidate's claimed outcome from observed final state, and tags the trace with run, scenario, repetition and bundle digest. Tests cover mapping, refusals, redaction and batching; a local check ran the output through Ironside's published request schema and native mapper without errors. It emits no scores or assessment labels.

**ASSUMPTION — Ironside live delivery:** `--ironside-url` with `IRONSIDE_API_KEY` posts those requests. It has been exercised only against a local HTTP stub, not a running Ironside deployment, and Ironside's contract owner has not reviewed this producer. Rubrist selection of exported traces is likewise unqualified.

For delegated execution, Dailies chooses the agent target, cases, scope, repetition plan and absolute deadline. The runner executes the accepted single-target run. Dailies sends a non-idempotent request once unless the integration supplies the runner's durable request identity. Polling can be retried; started execution cannot be silently replayed. Dailies stopping its wait does not prove the local runner or a remote provider stopped. A timeout remains attributable to its boundary.

In standalone CLI use, the operator supplies that same execution plan. Neither mode performs a release comparison. An already completed export can be imported without running the candidate again.

## Full loop and its qualification

**ASSUMPTION:** the intended composed journey is scenario/environment → runner execution → trace review and assessment → customer-owned release decision → production observation → a reviewed new scenario. Production observation is optional for starting the loop. A historical trace may suggest a test, but it is not a frozen environment or accepted expected outcome.

Before describing this as a supported portfolio flow, a producer and each consumer must agree on the versioned mapping and independently pass positive and negative fixtures for truncation, swapped identities, missing state, unknown versions, event loss, unsupported coverage, repeated requests and timeout. Existing product implementation gates remain in force; this specification authorizes no changes inside them.

Repeated trials are retained individually with fixed requested coverage. A consumer may analyze variability under its declared statistical procedure, but the runner publishes no universal pass rate, pass@k or confidence claim. A visible regression corpus is not representative production evidence. Runner reference tests, customer development scenarios and sealed evaluator-validation data remain distinct.
