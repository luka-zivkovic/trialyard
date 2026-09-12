# Source discovery and the integration proposal

Use this for a custom connection or an unresolved integration boundary. The deterministic `inspect` command is a declaration report; source investigation is performed by the assistant host. Scope reads to the selected repositories and relevant public files. Exclude secrets, unrelated workspaces and bulk traces. Follow source references as needed; record the inspected bytes rather than treating a Git revision as a complete identity.

Trace the actual entrypoint through its agent loop, tool callbacks, model invocation, state and lifecycle. Establish these concrete points:

- Runtime/build versions and reachable dependencies, including dynamic imports and runtime assets.
- Supported hooks that preserve the original agent and callback semantics; intentional substitutions and unobserved effects.
- Per-trial state ownership, reset/seeding, persistence across turns and independent initial/final readback.
- Long-running or background work, cancellation propagation, process/service ownership and verified disposal.

Retain facts with source references and distinguish observed code from inferred behavior. Code inspection does not establish that lifecycle or capture works. Unknowns have a specific question, `source` or `owner` resolution, whether they block the selected scope, and an optional recommendation. Out-of-scope unknowns can remain visible without blocking unrelated work.

## Ask owner questions at decision points

Resolve repository facts with source/tools before asking the user. Ask about intended entrypoint when several are valid, the trial scenario, acceptable service substitutions, permitted data and external execution. Give the relevant evidence and recommended choice. Batch related unresolved questions and continue independent investigation while waiting. Reuse earlier answers; do not reconfirm already authorized actions. Elapsed time never answers a required question.

Record owner answers under the contract's `decisions`, with `basis: user` or `existing_scope` and a concrete message/decision reference. These are retained claims, not machine-verified authorization. Do not turn a source unknown into an owner answer to bypass discovery. Resolve a source unknown by updating findings, removing the resolved unknown, and writing a new discovery revision. Never overwrite a record already referenced by a build or replay.

## Artifacts and offline checking

Load `trial skill connect-agent --reference integration-schema` for the canonical JSON Schema. Its `$defs.discovery` and `$defs.contract` describe two separate JSON files (not a combined object):

- `discovery.json`: scope; repository IDs/locations/revisions; source IDs with repository-relative public paths and SHA-256 of exact file bytes; facts with source-ID evidence; unresolved questions. Locations and source claims are recorded, not opened or rechecked by the validator. Do not retain file contents or credentials here.
- `integration-contract.json`: exact relative discovery path and SHA-256; selected observed entrypoint fact (or null while unresolved); owner decisions; all eight capability entries; real/substituted/unobserved fidelity; finite attempt/run/time bounds and provider allowance reference; qualification procedures and expected observations; build/run/inspect/verify/rebuild/cleanup handoff entries.

All object fields in the schema are required; use the declared nulls or empty arrays where appropriate. IDs are lowercase. Fact evidence names source IDs; capability `factIds` name fact IDs. Do not cite prose or source paths where an ID is required. The checker rejects missing references, duplicates, unsupported versions/fields, unsafe paths, contradictory requirements and required capabilities without qualification procedures.

Every capability appears once: `agent-loop`, `tool-routing`, `model-capture`, `fresh-state`, `independent-readback`, `cancellation`, `cleanup`, `dependency-closure`. `supported` describes a source-backed proposed mechanism, not a completed qualification. Explain the capture boundary and limitations; merely citing a source cannot prove its meaning. Agent loop, fresh state, independent readback and cleanup are always required. Other requirements come from the actual selected trial/profile. A required gap remains blocked. An optional `not_applicable` needs an explanation, such as an agent with no tools. Do not lower requirements because an adapter is difficult.

A qualification row links a capability to an executable procedure and its expected observations. Handoff command strings are documentation, never commands executed by the checker. A null command records an unavailable step with its reason in `notes`; make those gaps visible at handoff. Attempt limits count failed attempts; `maxTrialRuns` counts new accepted run requests, including requests started by qualification drivers, not the number of repetitions. Record the driver's exact scope before running it. Bounds are enforced by the assistant host, not this JSON checker. `provider: none` means no external model-provider execution by the candidate; the setup assistant's own usage is separate and must not be invented.

Compute the discovery SHA-256 after finalizing its bytes. Run:

```sh
trial check-integration /absolute/setup/integration-contract.json
```

Exit 0 / `consistent` means the records agree structurally. Exit 2 / `blocked` identifies unresolved required questions, entrypoint or capability gaps. Exit 1 means malformed, changed or unsafe input. The result explicitly leaves source verification, qualification and execution unproved. Retain its printed contract digest; `--sha256 <digest>` detects subsequent contract changes. Checking reads only the two declared JSON files, with bounded public-file checks, and does not execute handoff commands.

These records are setup provenance alongside `connection.json` or a maintained compiled build. They are not a runnable recipe, a readiness certificate or a requirement for the simple Node template path.

## Conditional delegation

Use subagents only when the host permits delegation and the work splits into useful independent investigations. One may trace agent/runtime hooks while another traces state/services/lifecycle. Supply selected roots, scope, questions and expected source-backed findings. Keep their scopes read-only unless separate edits are deliberately assigned. Small declared integrations can stay with one agent.

One coordinator reconciles findings, writes the contract, records decisions and asks the user questions. Investigators return questions to that coordinator; they do not each ask the user, silently choose competing entrypoints or duplicate provider runs. Review disagreements against source and keep unresolved facts visible. Host permissions, not this prose, decide whether delegation is callable.
