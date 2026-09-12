# Initialize an existing repository

Use this when the selected repository has no Trialyard declarations, when the user wants a first connection, or when the CLI has not been built. This is an assistant-guided workflow using existing commands. It does not add an in-repository `trial init`, a `doctor` command or a published npm installer.

## Establish the tooling and selected source

Use an explicitly supplied Trialyard checkout when available. Otherwise locate an installed CLI or choose a separate tooling directory for the public source checkout. Keep the user's agent repository as the candidate; cloning Trialyard or running its reference example does not connect that candidate.

The source-distributed preview is built with the runtime versions declared in `.nvmrc` and `package.json`. The current versions are Node 24.15.0 and npm 11.12.1:

```sh
git clone https://github.com/luka-zivkovic/trialyard.git /absolute/tooling/trialyard
cd /absolute/tooling/trialyard
nvm install
nvm use
npm ci --ignore-scripts
npm run build
```

Use an already installed matching runtime if available; nvm is optional. Check the actual CLI's `--help`. Do not claim `npx trialyard` works merely because the repository is public. The commands below abbreviate `node /absolute/tooling/trialyard/dist/src/cli/main.js` as `trial`; retain the actual executable and working directory in the handoff.

Inspect the selected repository's status and relevant public source before edits. Do not overwrite an existing declaration or change the application's package/module settings to fit a template. Record the baseline source identity. Read no credential values; record only required binding names.

## Discover a real connection

Run `trial inspect <agent-repository>`. `SETUP_MISSING` means a declaration must be authored; it is not a reason to abandon the actual agent or copy in the inventory demo. Inspect does not investigate application source. Use the host's repository tools and [discovery](discovery.md) for the entrypoint, loop, tools, state and lifecycle. Reuse existing owner decisions. Ask only material unresolved questions about the intended task, acceptable substitutions, expected behavior sources and execution scope.

Route to [node-function](node-function.md) only when the real candidate satisfies that interface and explicitly uses the reference inventory. Author a new `trial-runner.setup.json` from the shipped schema/example, selecting the actual entrypoint, required public files, model-capture mode, credential names, user scenario and repetitions. Copy the declaration shape, not the example's answers or candidate. A model-using agent cannot be declared `not_applicable` to avoid instrumentation. A thin adapter may translate the entrypoint contract but must not implement missing business behavior on the candidate's behalf.

For other tools, services, module formats or framework dependencies, use [manual-adapter](manual-adapter.md) and retain the custom discovery/integration contract. Do not change a real service into a canned successful response without an explicit fidelity decision. Unsupported required capabilities remain visible and block the affected scope.

Keep external expected behavior and answer keys out of the candidate's runtime file allowlist, prompt and scenario messages. Trace-derived scenarios remain development drafts with provenance; traces are not accepted answers. Follow [qualification](qualification.md) before running the selected matrix.

## Prepare and execute explicitly

For the supported Node function path, choose a new connection directory outside the candidate repository, with an existing parent directory:

```sh
trial connect /absolute/my-agent --out /absolute/my-agent-trials/connection-1
trial check-connection /absolute/my-agent-trials/connection-1/connection.json
trial run /absolute/my-agent-trials/connection-1/prepared/plan.json --request first --store /absolute/my-agent-trials/store
trial show --request first --store /absolute/my-agent-trials/store --format text
```

Review the generated plan, scenario, fixture and capture requirements before execution. `connect` and `check-connection` perform static preparation/checks; neither proves live readiness. Framework integrations use their maintained build path. Verify every returned native bundle using its printed digest. Preserve incomplete or failed results.

`trial init <new-directory>` creates a standalone synthetic example; `trial init .` in an existing repository is unsupported. An optional example smoke check verifies the tooling only. Never report it as the user's agent trial.

Leave the public declaration/adapter and concise project-specific run/inspect/rebuild instructions with the user. Record the exact tooling version, store, retained connections and observed capability gaps. A new request ID starts intentional execution with fresh declared state; an accepted ID returns its recorded result. An ordinary Node source edit uses `rebuild` into a new connection. Earlier evidence stays intact.
