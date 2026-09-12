# Setup skill and reusable connections

**CURRENT — 2026-09-13:** setup skill 0.4.0 adds a fresh-repository initialization route and explicit qualification guidance that preserves candidate failures. Versions 0.1.0 through 0.3.2 remain readable. The deterministic connection workflow supports the declared Node function template; custom integration guidance covers source discovery, owner questions, capability/fidelity records and bounded qualification.

**TARGET:** maintain setup instructions as versioned product assets. Automatic source investigation and application-hosted generation/repair remain later work.

## Start before configuration exists

Give an assistant with repository/terminal access the Trialyard checkout, the selected agent repository and [SKILL.md](../skills/connect-agent/SKILL.md). Ask it to initialize a connection to the actual agent and leave reusable commands. The [initialization reference](../skills/connect-agent/references/initialization.md) covers CLI bootstrap, missing declarations, source investigation and supported routing. It can be read directly before the CLI exists; after building, load it with `trial skill connect-agent --reference initialization`.

This workflow uses host tools to author the declaration or adapter. `inspect` itself still reads only public manifests. The existing `init` command creates a synthetic example in a new directory; this skill does not implement in-place initialization, a `doctor` command or an npm release.

## Preserve failures during setup

The [qualification reference](../skills/connect-agent/references/qualification.md) requires an explicit separation between integration checks, known-defect controls and user scenarios. Freeze the declared cases, expected-behavior authority, evidence scope, repetitions and bounds before qualification. Preserve all outcomes and amendments. Behavioral expectations are externally owned; absent or unreviewed expectations do not become passing labels.

For example, an agent may say a reservation succeeded while a complete independent snapshot shows no reservation. That can establish a working observation path and expose incorrect candidate behavior at the same time. Setup should retain the evidence and hand off the defect. Changing the agent to correct it requires a separately requested repair; if repair is already authorized, retain the original result first and rerun the unchanged applicable cases on a new candidate revision.

Known-defect controls challenge a specific detection claim. They do not establish general evaluator accuracy, unseen-case quality or a release decision. Skill prose guides the host; `check-integration` does not enforce a case freeze, approve expectations, prevent cherry-picking or prove that the assistant followed these instructions. Independent human onboarding and fresh-assistant behavioral qualification remain separate evidence gates.

## Use the supported flow

Build with the pinned Node 24.15.0/npm 11.12.1 toolchain. `trial` below means `node /absolute/trialyard/dist/src/cli/main.js`. Use a repository with the existing supported public declarations described in [assisted setup](assisted-setup.md).

```sh
trial connect /absolute/agent --out /absolute/new-connection
trial check-connection /absolute/new-connection/connection.json
trial run /absolute/new-connection/prepared/plan.json --request first --store /absolute/trial-store
trial show --request first --store /absolute/trial-store --format text
```

Optionally use `trial skill connect-agent --reference node-function` to load maintained instructions. The `skill` command exposes maintained instructions to an assistant host; it does not call a model. The human/operator can use `connect` without an assistant or installed personal skill. `connect` is deterministic preparation, not a repository investigator or an automatic framework adapter generator. It uses the same public declarations, source allowlist, original function wrapper and explicit reference inventory as M2. It installs nothing, looks up no credential values, performs no network access and executes no candidate.

`connect` requires a new directory outside the source. It writes `prepared/`, a snapshot of `skill/`, and publishes `connection.json` last. Failure before publication removes only that exclusively created output. Existing directories and source remain intact. Unsupported declarations publish a blocked draft, retained requirements and no plan.

`check-connection` is read-only. Exit 0 and `status: validated` mean listed bytes and the native plan agree under offline validation. They do not establish working imports, an effective environment, complete capture or agent quality. Exit 2 and `status: blocked` retain unresolved requirements. Invalid paths, changed files, unsupported shapes or digest conflicts exit 1. Candidate execution remains the separate `run` command, with its existing execution/evidence/cleanup results and request identity semantics.

The connection can be moved and checked again. Its plan can be run repeatedly without the setup assistant. The native plan and artifact manifests pin candidate execution inputs; the skill is not part of the agent's context. Preserve the connection separately as setup provenance. After changing source, use the rebuild command below; the old connection remains bound to its copied bytes. A check explicitly reports `sourceVerification: recorded_not_rechecked`, since it does not revisit the external source repository.

Retain the printed recipe SHA-256 externally when exact connection identity matters:

```sh
trial check-connection /absolute/new-connection/connection.json --sha256 EXPECTED_RECIPE_SHA256
```

**CURRENT — 2026-09-10:** after a source edit, `trial rebuild /absolute/new-connection/connection.json --source /absolute/agent --out /absolute/candidate-2` creates a revised connection with source/file deltas and new artifact identities as needed. It preserves the existing trial configuration and rejects drift. Run the revised plan with a new request ID. See [candidate rebuilds](connection-rebuild.md) for the supported Node files-only boundary, optional parent digest and retained lineage.

Without that expected digest, checking establishes internal consistency. Hashes do not prove authorship or prevent an operator from replacing both files and manifests. Static validation and execution are separate operations on an operator-controlled, quiescent filesystem; this is not hostile-host containment or a guarantee against concurrent changes.

## Contract and ownership

The closed contracts are in [connection.schema.json](../contracts/connection.schema.json), with semantic checks in `src/connection/contracts.ts`. They do not change the frozen plan/evidence v1 meanings.

| Field or artifact | Meaning |
| --- | --- |
| `method: prepared-plan/v1` | A supported prepared connection, or a blocked draft awaiting declarations |
| `method: manual-integration/v1` | A pinned integration guide/asset inventory with unresolved manual requirements; never a runnable plan |
| `files` | Exact selected local input paths, byte lengths and SHA-256 identities; the recipe excludes itself |
| `sources` | Recorded external source inventory; not re-read or authenticated by connection checks |
| `plan` | A relative native plan path and resolved input digest, or null while blocked |
| `requirements` | Nonempty for blocked recipes; a plan cannot coexist with unresolved requirements |
| `skill` | Optional exact package id/version/content digest, verified against the retained snapshot |

For a prepared plan, its environment descriptor, fixture, capabilities and profile retain their native lifecycle/capture meaning; the recipe does not invent another execution state machine. This first recipe version packages prepared artifacts and records manual prerequisites. It is not yet a general executable build/provisioning specification.

Both the recipe entry filename and every declared path obey the public path policy. Validation rejects hidden/credential paths, traversal, case collisions, symlinks, hardlinks and special files. It prechecks the entire selected inventory before payload reads, limits it to 512 files/64 MiB with 16 MiB per file, and refuses plan references outside that inventory before opening them. Recipe JSON remains bounded to 256 KiB and the existing strict JSON limits. Public declarations must contain no secrets; the checker is not an arbitrary-content secret scanner. Unlisted unrelated files are not inspected or certified.

The skill package keeps instructions in [SKILL.md](../skills/connect-agent/SKILL.md), a closed package manifest and seven conditional references, including initialization and the canonical integration-record schema. The loader hashes all package files and emits only the main instructions plus the selected reference. Instruction changes alter identity even if a maintainer forgets to bump the version; intentional releases should update the version and corresponding supported contracts together. No duplicated prompt text lives in the CLI.

## Assisted integration records

For custom adapters or unresolved boundaries, the host follows [discovery](../skills/connect-agent/references/discovery.md), retaining source-backed facts, inferences and questions in `discovery.json`. `integration-contract.json` binds those exact bytes and records scope, owner decisions, eight capability declarations, fidelity, attempt/run/time bounds, qualification procedures and the handoff. The [closed schema](../skills/connect-agent/references/integration.schema.json) and `src/connection/integration-contract.ts` define their shapes and semantic checks. These are separate setup artifacts; they do not change the native plan, connection recipe or evidence wire format.

```sh
trial skill connect-agent --reference discovery
trial skill connect-agent --reference integration-schema
trial check-integration /absolute/setup/integration-contract.json
```

`check-integration` reads only the two declared public JSON records. Exit 0 / `consistent` establishes their structure, identities and internal references; exit 2 / `blocked` retains required unanswered questions, an unresolved entrypoint or required capability gaps; exit 1 rejects malformed or changed records. Optional `--sha256` checks an externally retained contract digest. Each record is limited to 256 KiB; public paths, strict JSON, regular-file and link checks apply. Repository locations, source references and handoff commands are recorded claims and are never opened or executed. Null handoff commands are returned as gaps.

This check does not recheck source claims, compare the proposal with an actual plan, verify owner authorization, enforce execution budgets or qualify the connection. Those duties remain with the host and actual execution checks. A consistent proposal may still have unexercised capabilities or unsupported maintenance steps. Follow [qualification](../skills/connect-agent/references/qualification.md) and retain native results separately. Discovery, questions and conditional subagent assignments are skill guidance; no model orchestrator is installed. The short declared Node path does not require a separate dossier.

A future application imports `setupSkillContext` or consumes `trial skill` JSON, supplies structured repository/setup context and dispatches tools through its own code. The returned tool effects are metadata, not grants of authority. The current CLI enforces its own no-execution setup paths; a host must enforce its execution permissions and any repair/provider bounds. It cannot delegate those controls to skill prose. This change implements the loader/tool surface, not a hosted chat UI or model orchestrator. `assistant: not_invoked` describes these deterministic commands, not a claim that no external assistant participated.

Context7 guidance is conditional and creates no documentation client or upload. Assistant model identity, retrieved-document provenance and setup-provider spend must be recorded by a later assistant host when those operations actually occur; they are not fabricated in the current deterministic connection.

## Remaining work

See [current support](current-preview.md) and the [acceptance plan](implementation-plan.md). Human onboarding, broader integration reuse and automated setup retain separate gates.
