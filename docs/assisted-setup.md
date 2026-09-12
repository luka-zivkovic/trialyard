# Assisted setup: Node function template

**CURRENT — M2 supported interface.** Inspection reads two public declarations. Preparation wraps a self-contained Node ESM function and copies its explicitly selected files unchanged. No candidate code runs until `run`. This is a narrow adapter path: arbitrary repositories, framework discovery, dependency installation and real service environments are not supported automatically.

## First run

Build Trialyard using the pinned Node 24.15.0/npm 11.12.1 toolchain (`npm ci --ignore-scripts`, `npm run build`). Define `trial` as an alias to `node /absolute/path/to/trialyard/dist/src/cli/main.js`, or use that absolute command for each step. The commands below assume that alias. No global installation is needed.

From a scratch directory outside the source repository, copy the shipped `examples/node-agent` directory to `./my-agent`. Its `agent.js` is the actual candidate function; no protocol adapter or installed dependency is required.

```sh
cp -R /absolute/trialyard/examples/node-agent ./my-agent
trial connect ./my-agent --out ./connection
trial run ./connection/prepared/plan.json --request first-trial --store ./trial-store
trial show --request first-trial --store ./trial-store --format text
```

After `connect`, review the plan, scenario, fixture, profile, setup provenance and preparation report under `connection/prepared/` before running. The CLI prints fully qualified run/inspection commands with an explicit store. `connect` includes static validation; `trial check-connection ./connection/connection.json` can recheck retained bytes separately.

Inspect the returned bundle paths and verify each with `trial verify <absolute-bundle-directory> --sha256 <printed-digest>`. Two repetitions should finish, each starting with three units and no reservations. Each conversation reserves one unit then reads it. An accepted request is never replayed; use a new ID for intentional execution. Evidence completeness does not judge business correctness.

After editing `my-agent/agent.js`, use `trial rebuild ./connection/connection.json --source ./my-agent --out ./candidate-2`, then run `candidate-2/prepared/plan.json` under a new request in the same store. Read [candidate rebuilds](connection-rebuild.md) for the supported scope. Runtime errors are available as safely quoted diagnostics in `show --format text`; retain the failed attempt while repairing the source.

`inspect` and `prepare` are lower-level tools. Use `trial inspect ./my-agent --out ./inspection.json` for a separate declaration report, then `trial prepare ./my-agent --inspection ./inspection.json --out ./prepared` when a preparation without the connection/skill package is specifically useful. Preparation's structured next-step argv are relative to its directory and use the documented `trial` alias; CLI hints use the actual absolute executable. These steps are alternatives to `connect`, not extra onboarding prerequisites.

For your own supported module, author `trial-runner.setup.json` using the shipped example and the closed `$defs.setup` schema in `contracts/v1.schema.json`. This declaration is public: use only credential **names**, never values. The selected reference inventory is explicit and suitable only for its documented `stock`, `reserve` and `reservations` tool contract. It is not an inferred simulation of your production services. If your agent needs another environment, use the existing explicit adapter contract or wait for a separately qualified integration.

## Function contract: node-function/v1

The root package must declare `"type": "module"`. Your selected `.js` or `.mjs` module exports `createAgent()`, optionally async, which returns an object with `runTurn(context)`. Preparation does not inspect source syntax, import modules or prove this export exists. Missing exports, module-load import failures and failed factories become adapter failures during explicit execution. The factory runs once per trial and its object survives all turns. Every repetition starts a new process and fresh environment.

`runTurn` receives:

- `input`: the current scenario message string.
- `history`: a copy of prior user/assistant messages **including the current user message**. The wrapper appends the returned assistant string once, after successful completion. Mutating this copy does not change retained history.
- `tool(name, args, logicalCallId = null)`: routes an actual call through the runner and returns its full `tool_result` payload (`operationId`, `outcome`, `value`, `error`). Business failures and unknown outcomes remain explicit; inspect `outcome` before using `value`. All tool requests must finish within the current turn; await them before returning. Returning with a pending request is an adapter failure. There is no automatic retry.
- `bindings`: a copy of the environment preparation bindings. It contains no automatic production connections.
- `signal`: aborted on stop, timeout or cancellation. Candidate work must cooperate; the runner's bounded process shutdown remains the final control. This is operator-trusted local execution, not a hostile-code sandbox.
- `models`: `null` for `not_applicable`, otherwise a per-turn `ModelRecorder` from the documented SDK. Use `intent` and await its durable acknowledgment before dispatch, `observed` only at the actual dispatch boundary, and `finish` with actual outcome and provenance. Every retry needs its own operation. Finish all operations before returning. The wrapper owns turn completion and stop accounting; candidates must not call `completeTurn` or keep helpers for later turns.

Return a string (or promise of one). Exceptions from `runTurn` are candidate errors; malformed outputs or open model operations are adapter/protocol failures. Do not log to stdout: it is the process protocol. No business/model work belongs in module initialization or the factory. Instrumentation is candidate-declared: supplying a recorder does not prove every model call used it. `reported` and `accounted` retain their existing capture meanings; no new model provider is qualified by this template. See [model accounting](model-accounting.md).

## Public files and declarations

`agent.files` is an explicit preparation read/copy allowlist, up to 128 public `.js`, `.mjs` or `.json` files, 2 MiB each and 16 MiB total. Include the entrypoint and all relative imports/assets. Paths are ASCII relative paths, at most 256 characters and 16 components; no traversal, hidden components, credential names, dependency directories, nested `package.json` or reserved wrapper filenames. The generated candidate package preserves ESM mode only. Package import aliases are unsupported; external dependencies are not installed or copied. A prebuilt self-contained module may be declared, but `declared-files-only` is an operator assertion, not static proof of dependency completeness. Relative runtime filesystem reads use the prepared `candidate/` working directory.

Inspection reads only root `package.json` and `trial-runner.setup.json`: at most 256 KiB each, JSON depth 24 and 10,000 values, 64 package scripts and 128 dependency entries. It does not open scripts, candidate source, README/instructions, lockfiles, dependencies, generated output or environment/secret files. Package commands are data. Only simple `node path.js` declarations become unvalidated candidates; script bodies, URL/git dependency values and arbitrary manifest text are not echoed. Public manifests can themselves contain sensitive text; inspection is not a secret scanner and requires public declarations.

The caller-selected root's ancestor aliases (such as macOS `/tmp`) are canonicalized. The root itself and every declared descendant reject symlinks. Regular files with multiple hardlinks, devices and FIFOs are rejected before open; handles and source bytes are rechecked. Operate on a quiescent checkout: these local path checks are not an OS sandbox against an adversary concurrently replacing ancestor directories. Preparation validates the entire allowlist and file metadata before reading any source payload, then copies bytes and rechecks them. Files excluded from inspection can be read by preparation only when explicitly allowed.

Optional `limits` replaces all published M1 limits; otherwise defaults are preparation 60 s, trial 120 s, stop 500 ms, snapshot/cleanup 15 s, 20 turns, 1 MiB frame, 10,000 events and 64 MiB recorded bytes. `secretBindings` names are agent-only in this template and must satisfy the existing credential policy; inspection/preparation never looks up their values. Configure them only for an explicit run.

## Reports, failures and provenance

`inspect` exits 0 for syntactically supported declarations, or 2 with a blocked report. Neither means runtime readiness. Findings retain the exact source path/digest, fact, interpretation and certainty (`observed`, `inferred`, `user_declared`; runtime validation remains separate). The report lists exclusions and specific unresolved requirements. Invalid manifest diagnostics do not echo source values.

`prepare` exits 0 with a statically validated plan or 2 with a blocked draft (`setup-draft.json`, `inspection.json`, instructions and `preparation.json`). A draft has no plan and chooses no environment on your behalf. Add explicit missing declarations and prepare into a **new** directory. Invalid/unsafe copying, stale reports or existing/overlapping destinations fail with exit 1; existing/source files are preserved. Destination parents must exist, and aliases into the source are rejected.

Supplying `--inspection` requires exact agreement with a fresh deterministic report, including template digest. It pins the public declarations and template; candidate source is first read and pinned during preparation. The preparation marker is written last and inventories output bytes (excluding itself to avoid recursion). `setup-provenance.json` binds public source-manifest digests, copied file digests, discovery digest and the shipped versioned template digest. It is part of the pinned agent artifact and retained in the eventual bundle under `inputs/`. Hashes identify observed bytes, not authorship or authenticity. Review reports and source before running; no hosted service receives them.

Optional trace-derived suggestions, repository-wide search, Context7, LLM assistance and real application/environment integration remain later work. None is required for this deterministic onboarding path.
