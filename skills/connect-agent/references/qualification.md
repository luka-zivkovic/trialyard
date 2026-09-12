# Build, qualification and independent replay

Start from the explicit integration scope and contract. Use a maintained adapter/build when applicable. If new wiring is needed, preserve the original loop and callbacks, keep application logic in `integrations/`, and expose the exact changed files. Use an isolated output and record source/build identities and dependency prerequisites. Inspect diffs before editing; retain unrelated changes.

## Define what successful setup means

Qualify that the declared integration executes the real candidate, controls the stated environment and captures sufficient evidence to inspect its behavior. A behavioral violation is a useful result. Candidate quality does not have to become green before setup is complete.

Keep three kinds of work distinct:

| Work | What success establishes | What it cannot establish |
| --- | --- | --- |
| Tooling and adapter smoke checks | A command, transport, fixture or capture mechanism works in its stated scope | The user's agent is correct; a scripted responder is a real-provider qualification |
| Known-defect controls | A deliberately introduced, labeled defect produces distinguishable evidence at the claimed boundary | Representative production failure rates or general evaluator accuracy |
| User scenarios | Observed behavior on independently motivated cases, with external assessment where available | Unseen quality, a release decision, or correctness outside the declared scope |

For an execution-only setup without an accepted external expectation, qualify capture and leave behavior unassessed. Do not invent a rubric or a passing label. Trialyard does not own governed assessment criteria.

## Freeze cases before qualification

Build cases from supplied requirements, owner decisions, documented service contracts and reported failures. The implementation is evidence of how the agent works; its output is not the authority for how it should behave. Include a normal case and relevant boundary/failure cases justified by that scope, such as denied access, absent data, ambiguous requests, a lost response or follow-up state. Explain omissions; a universal checklist of unrelated adversarial cases is not required.

Before the qualification matrix executes, retain a small `qualification-plan.md` or equivalent existing experiment record. Record the selected source/build identity, scenario/fixture/capture digests, case purpose and origin, required observations, externally owned expectation reference/status, repetitions and execution bounds. For each result, retain the source bundle/digest and the separate observation/assessment. This is a host-maintained record, not a new native schema or machine-enforced freeze. Do not put answer keys in candidate inputs.

An expectation needs a source independent of the candidate output and a recorded owner/authority. Proposed expectations remain unreviewed; missing owner decisions can block assessment without blocking authorized evidence collection. Prefer observed state or supported relations over exact prose or one tool trajectory unless the supplied requirement actually demands them.

Preserve the whole declared matrix and every repetition, including failed, incomplete and not-started trials. Do not drop difficult cases, reclassify misses as out of scope after seeing results, rerun until a preferred answer appears, or adjust fixture/expectation thresholds to match the output. If a case or environment is wrong, record the evidence for that diagnosis and create a versioned amendment under existing owner authority or a new decision. Retain the original result and start a new comparison; never rewrite its verdict retrospectively.

Cases created after inspecting failures are useful development regressions. Mark their exposure. A set seen by the setup or repair assistant is not a sealed holdout. If an unseen-quality claim is needed, arrange separately owned cases and evaluation access; a second agent that sees the same cases does not make them independent.

## Check whether a defect remains visible

When claiming that this integration can expose a particular behavior defect, choose a relevant known-defect control before execution. Use a supplied defect or an explicitly labeled mutation in an owned copy, within the authorized scope. Examples include a no-op write paired with a confident success message, duplicated side effects, dropped follow-up context, or dispatch after a denied action. Preserve the ordinary cases, environment semantics, observations and external expectation. Record the exact mutation. Never silently modify the user's original candidate.

Check the independent resulting state and operation record, not just assistant text or the runner exit code. A complete `finished` run can expose a violation. A declared rejection before dispatch can also be correct behavior. Proving an action never occurred requires complete observation of the relevant boundary; missing capture is unknown, not evidence of absence.

If the defect remains indistinguishable, report a detection gap. Investigate the observer, fixture, assessment and control applicability instead of strengthening the claim or weakening the case. If no meaningful control can be run within scope, leave that detection claim unqualified; do not broaden permissions to manufacture one. An artificial missing-evidence fixture must remain labeled and yield unknown/not-evaluable behavior, never a pass.

## Execution and bounded repair

Write the planned build/run/time bounds before execution. Reuse existing authorization and provider allowance; missing execution scope remains a question. The host must enforce these bounds, including nested qualification drivers. Never infer free provider calls from null cost observations. Count setup-assistant usage separately when measurable.

Validate the native plan or retained connection offline. Execute the declared cases with fresh request IDs and one explicit store. Record every command's start/end, exit status, output paths and failure; keep previous builds, runs and contracts. After failure, distinguish a setup defect, candidate behavior, missing evidence and cleanup failure. Repair only supported wiring within the agreed scope and remaining bounds. Check the affected boundary again, with a new build/request if inputs changed. Do not remove required observations or change the scenario to hide the failure.

Use the observed evidence to classify the next action:

| Finding | Setup action |
| --- | --- |
| Adapter, fixture or dependency violates its declared contract | Repair the integration within scope; retain the failed attempt and recheck the affected cases. |
| Candidate violates an accepted behavior expectation | Preserve and report the defect. Finish the integration handoff if its own required checks pass. Candidate repair is a separate explicitly requested work item. |
| Required evidence is absent or observations disagree | Report the gap/uncertainty; repair capture only when supported. Do not guess a business outcome or silently weaken the profile. |
| The expectation itself is unsupported or ambiguous | Retain evidence, leave that assessment unresolved, and seek the missing owner decision. |

If candidate repair is already authorized, first retain the original observation, then create a separately identified candidate revision and rerun the unchanged applicable matrix. Setup work is not permission to rewrite prompts, tools or application logic to make a test pass.

Stop dependent execution when ownership/cleanup is uncertain. Inspect retained evidence and identify exact owned resources before recovery. Record recovery separately; do not relabel an old bundle's cleanup state. A plan, contract or build change is an explicit revision, not permission to replay an accepted request.

## Qualification and review

For each required capability, retain a concrete check and result. For custom stateful integrations, include two fresh repetitions, state persistence across turns, independent readback, relevant denied/failed actions, interruption during an observed operation, a relevant worker crash and verified cleanup. Choose failures at actual boundaries; report unexercised boundaries rather than implying universal fault coverage. Also verify bundles and duplicate-request behavior. Use maintained drivers when they cover the selected scope, and inspect their retained results rather than treating exit 0 as successful execution of every case.

An independent reviewer can challenge a concrete contract/diff for missed effects, changed callback semantics, capture gaps, dependency assumptions and lifecycle failures. When the host authorizes delegation and the risk warrants it, give that reviewer the selected requirements, cases and raw evidence rather than the implementer's success summary; ask which plausible defects could still pass unnoticed. Keep the assignment read-only and have one owner schedule experiments. Reviewer opinions supplement executable evidence. Keep execution, evidence completeness, operation outcome and cleanup separate; unknown remains unknown.

## Handoff and a fresh replay

Retain `discovery.json`, `integration-contract.json`, the checker result, build identity, native plan/recipe, run paths and digests. Record working directory, runtime prerequisites and concrete build/run/show/verify/rebuild/cleanup commands. Explain how fresh state and resource ownership work. Make unsupported maintenance steps explicit. Check that every instruction/reference needed for the selected path is reachable from the shipped skill or maintained guide.

For a forward test, use a new agent with no inherited conversation, or a person unfamiliar with the work. Supply the realistic request, skill location, selected source checkout, toolchain, new output directory and permitted execution/time/attempt scope. Do not supply prior audit conclusions, a prefilled discovery/contract, historical success reports or expected fixes. The agent may read maintained guides and their declared assertions. A maintained-adapter replay tests reuse and handoff, not discovery or generation from scratch.

Have the participant retain `replay.json` with:

- Start/end timestamps, participant type and provided inputs/scope.
- Questions that needed owner answers, answers reused from scope, and unresolved questions.
- Command attempts (phase, command/argv, start/end, exit status and output paths), repairs and manual interventions, including count zero when observed.
- Records/build/run/bundle paths and digests; execution/evidence/cleanup outcomes; supported checks and remaining gaps.
- Frozen qualification-plan identity, complete case/repetition coverage, labeled controls, observed candidate defects, unassessed behavior and amendments. Integration completion and candidate assessment are separate conclusions.
- Whether source edits/rebuild were actually exercised. Timing includes the observed replay only; prior integration engineering, dependency installation and unmeasured assistant spend remain separate.

Do not invent elapsed active work, provider spend or unseen interventions. A fresh-agent exercise is not the human onboarding/comprehension gate. Retain the first outcome before fixing material friction, then distinguish any replay after corrections from the original attempt. Once checks pass, stop; repeat only for an actual change or unresolved concern.
