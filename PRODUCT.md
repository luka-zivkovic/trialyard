# Product charter

Status: specification v0.1. Authority and evidence labels are defined in the [decision record](docs/decisions.md#authority-and-evidence-labels).

## User and job

**ASSUMPTION — primary user:** an engineer responsible for an agent whose behavior depends on tools, application state and a conversation. A quality or domain owner reviews desired outcomes. They may work at the same company or be the same person; the runner does not certify independent human review.

The engineer wants to exercise the existing agent without manually rebuilding a test environment for every change, then explain what ran, what it changed, and what remains unknown.

The product promise is:

> Connect a supported agent, prepare a controlled environment, run repeatable scenarios, and obtain inspectable execution evidence.

“Repeatable” means the declared setup and procedure can be repeated. It does not promise identical model responses or permanent availability of a provider model alias.

The first user can run a local development environment and configure test credentials. This is an engineer-facing product with guided setup. A nontechnical user connecting an arbitrary repository without engineering support is outside the first version's supported scope.

**TARGET — audience clarification, 2026-09-10:** assume users understand agent execution, scenarios, tool/state boundaries and evidence completeness. Optimize for reproducible integration, efficient iteration and precise diagnostics. Keep technical controls and evidence semantics explicit; introductory education is not a prerequisite product goal.

## One focused responsibility

**TARGET — confirmed direction:** this is an independent execution-environment product. It must work without customer applications, tracing services, production traces or the other portfolio products being installed.

**ASSUMPTION — owned capabilities:**

- Agent and environment connection contracts, adapter SDK and compatibility checks.
- Local trial preparation, state isolation, lifecycle, bounded execution and cleanup.
- Scripted multi-turn scenarios and fixed, separately recorded repetitions.
- Tool routing where an adapter exposes it, stateful substitutes and disposable-service connections.
- Declared fault injection within an environment contract.
- Collection of observable model/tool events, conversation and externally read final state.
- Inspectable local evidence bundles, completeness diagnostics and export mappings.
- Repository inspection and optional trace/document inputs that help prepare a reviewable configuration.

The runner may verify that its own protocol, declared environment and evidence contract were satisfied. Those are execution checks, not a judgment of the agent's business quality.

## Boundaries with adjacent work

**TARGET — existing portfolio boundaries:** Rubrist governs human truth, criteria, evaluator lifecycle, calibration and policy-free assessment evidence. Dailies owns release-run coordination, paired baseline/candidate comparisons, evidence trust and customer release policy. Casefile owns static no-execution capability-artifact intake. Ironside supplies observability.

**ASSUMPTION — new relationship:** when Dailies delegates execution, this product is a single-target execution provider. It owns the internals of the accepted trial run, while Dailies retains the overall release-run lifecycle and deadline. This requires a reviewed integration contract; it is not a claim that current Dailies already supports the new wire format.

Non-goals for v0.1 are:

- Defining quality rubrics, promoting trace outputs to gold answers, adjudicating labels or calibrating evaluators.
- An embedded business-grading engine, composite quality score, release thresholds, deployment or rollback.
- Replacing the customer's production agent loop with a runner-authored approximation.
- Production observability storage, serving-path proxying, or ongoing traffic capture.
- General hostile-code execution, a multi-tenant hosted sandbox, enterprise identity or billing.
- Universal framework support, automatic simulation of every service, and autonomous production-data cloning.
- Model-driven user simulation, browser/desktop operation and distributed scheduling in the first version.
- Semantic clustering.

## Support and fidelity

The developer preview supports a local executable that implements the versioned process adapter protocol. A TypeScript helper reduces integration work; other languages can implement the protocol, but shipping one helper does not establish support for their frameworks.

The reference environment is stateful and synthetic. External integrations can also use disposable real services through an environment adapter. Every integration declares which tools, data, clocks and side effects are controlled, which are real, and which are unobserved. The product must not describe substituted-tool execution as proof of the complete application.

Fresh state is created for every repetition. State persists across turns within one trial. There is no implicit reuse of mutable application data between trials.

## Commercial and operational scope

**ASSUMPTION:** deliver locally and in customer-owned CI first. The customer controls model accounts and test infrastructure. No subscription, hosted account or revenue assumption is needed to implement this scope. Pricing and willingness to pay remain unvalidated; they are not invented in this specification.

A company can pilot the runner inside its existing infrastructure. Managed isolation, private networking, SSO, tenant administration, retention enforcement and unattended fleet operation would require a separately qualified hosted product phase.

## Success

The runner is useful when a customer can configure an independent agent, obtain a first inspectable trial, repeat it with fresh state, and diagnose an incomplete run without changes hidden in the core.

The customer MVP requires a qualified external integration, understandable setup diagnostics, and a documented path from evidence to an external assessment. Broader claims require a second unrelated project. Measure setup time, manual edits, custom adapter work, unsupported capabilities and the user's ability to distinguish execution completeness from agent quality. Do not invent a time-to-first-result promise before measuring it.

## Product tests

- Customer-specific names, prompts, schemas and trace contents never enter the core or its reference fixtures.
- Missing evidence never becomes a successful quality claim.
- A trace-suggested scenario carries its provenance and remains an ungraded draft until expected behavior is reviewed elsewhere.
- An agent's statement that an action happened is distinguished from an observation of resulting environment state.
- A new integration can identify a general defect in the contract; an explicit versioned correction is allowed. Customer-specific branches inside the core are not.
