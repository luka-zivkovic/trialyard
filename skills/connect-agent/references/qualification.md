# Build, qualification and independent replay

Start from the explicit integration scope and contract. Use a maintained adapter/build when applicable. If new wiring is needed, preserve the original loop and callbacks, keep application logic in `integrations/`, and expose the exact changed files. Use an isolated output and record source/build identities and dependency prerequisites. Inspect diffs before editing; retain unrelated changes.

## Execution and bounded repair

Write the planned build/run/time bounds before execution. Reuse existing authorization and provider allowance; missing execution scope remains a question. The host must enforce these bounds, including nested qualification drivers. Never infer free provider calls from null cost observations. Count setup-assistant usage separately when measurable.

Validate the native plan or retained connection offline. Execute the declared cases with fresh request IDs and one explicit store. Record every command's start/end, exit status, output paths and failure; keep previous builds, runs and contracts. After failure, distinguish a setup defect, candidate behavior, missing evidence and cleanup failure. Repair only supported wiring within the agreed scope and remaining bounds. Check the affected boundary again, with a new build/request if inputs changed. Do not remove required observations or change the scenario to hide the failure.

Stop dependent execution when ownership/cleanup is uncertain. Inspect retained evidence and identify exact owned resources before recovery. Record recovery separately; do not relabel an old bundle's cleanup state. A plan, contract or build change is an explicit revision, not permission to replay an accepted request.

## Qualification and review

For each required capability, retain a concrete check and result. For custom stateful integrations, include two fresh repetitions, state persistence across turns, independent readback, relevant denied/failed actions, interruption during an observed operation, a relevant worker crash and verified cleanup. Choose failures at actual boundaries; report unexercised boundaries rather than implying universal fault coverage. Also verify bundles and duplicate-request behavior. Use maintained drivers when they cover the selected scope, and inspect their retained results rather than treating exit 0 as successful execution of every case.

An independent reviewer can challenge a concrete contract/diff for missed effects, changed callback semantics, capture gaps, dependency assumptions and lifecycle failures. Give a bounded read-only assignment and have one owner schedule experiments. Reviewer opinions supplement executable evidence. Keep execution, evidence completeness, operation outcome and cleanup separate; unknown remains unknown.

## Handoff and a fresh replay

Retain `discovery.json`, `integration-contract.json`, the checker result, build identity, native plan/recipe, run paths and digests. Record working directory, runtime prerequisites and concrete build/run/show/verify/rebuild/cleanup commands. Explain how fresh state and resource ownership work. Make unsupported maintenance steps explicit. Check that every instruction/reference needed for the selected path is reachable from the shipped skill or maintained guide.

For a forward test, use a new agent with no inherited conversation, or a person unfamiliar with the work. Supply the realistic request, skill location, selected source checkout, toolchain, new output directory and permitted execution/time/attempt scope. Do not supply prior audit conclusions, a prefilled discovery/contract, historical success reports or expected fixes. The agent may read maintained guides and their declared assertions. A maintained-adapter replay tests reuse and handoff, not discovery or generation from scratch.

Have the participant retain `replay.json` with:

- Start/end timestamps, participant type and provided inputs/scope.
- Questions that needed owner answers, answers reused from scope, and unresolved questions.
- Command attempts (phase, command/argv, start/end, exit status and output paths), repairs and manual interventions, including count zero when observed.
- Records/build/run/bundle paths and digests; execution/evidence/cleanup outcomes; supported checks and remaining gaps.
- Whether source edits/rebuild were actually exercised. Timing includes the observed replay only; prior integration engineering, dependency installation and unmeasured assistant spend remain separate.

Do not invent elapsed active work, provider spend or unseen interventions. A fresh-agent exercise is not the human onboarding/comprehension gate. Retain the first outcome before fixing material friction, then distinguish any replay after corrections from the original attempt. Once checks pass, stop; repeat only for an actual change or unresolved concern.
