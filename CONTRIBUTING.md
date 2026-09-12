# Contributing to Trialyard

Trialyard is an execution and evidence tool. Changes should make it easier to connect an actual agent, control its declared environment, and understand what happened.

Read [AGENTS.md](AGENTS.md), the [product charter](PRODUCT.md), and the [decision record](docs/decisions.md) before changing behavior. Use **TARGET** for accepted direction, **CURRENT** for implemented behavior, and **ASSUMPTION** for unresolved choices.

## Local checks

Use the versions in `.nvmrc` and `package.json`:

```sh
nvm use
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:pi
npm --prefix consumers/pi-assessment ci --ignore-scripts
npm run test:assessment
npm run check:docs
```

Core tests use synthetic fixtures and real local worker processes. They need no model credentials or external application. Pi contract tests are also local; native Pi execution requires the separately documented [source/runtime prerequisites](integrations/pi-webdesk/native-guide.md). Python experiments have their own pinned requirements.

## Making a change

- Keep customer-specific adapters in `integrations/`; core and reference fixtures remain independent.
- Preserve execution state, evidence completeness, operation outcome, and cleanup as separate facts.
- For contract changes, define semantic invariants and positive/negative fixtures before runtime behavior. Incompatible wire changes need a new version.
- Test affected failure boundaries and duplicate-request behavior when changing execution or evidence handling.
- Describe the behavior changed, how it was checked, and the scope that remains unqualified.

Report bugs with the command, runtime version, expected behavior, and a minimal synthetic reproduction. Review evidence bundles before attaching them: they can contain conversation, tool results, source files, and environment state. Never include credentials or private customer data.
