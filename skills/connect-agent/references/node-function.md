# Supported Node function connection

This path requires an existing self-contained ESM `.js`/`.mjs` module exporting `createAgent()`. The factory returns an object with `runTurn(context)`; its object lives for one trial. `context.input` is the current message, `history` includes that message, and `tool(name, args)` returns an operation result with an explicit outcome. Return an assistant string and await every tool/model operation. The wrapper supplies history; do not append the current user message again.

The public root package declares `type: module`. The public `trial-runner.setup.json` uses `trial-runner/setup/v1`, `node-function/v1`, an explicit source-file allowlist and `declared-files-only`. Use Trialyard's existing setup schema and shipped `examples/node-agent/trial-runner.setup.json` as the format reference; use the user's own scenario and source. Preparation installs nothing, preserves allowlisted bytes and does not prove that imports or exports work.

Select `reference-inventory/v1` only when the agent actually uses its `stock`, `reserve` and `reservations` contract: three initial units, idempotent reservation keys and fresh state per repetition. It cannot stand in for a database, CRM, calendar or email service simply because a tool has a similar name. For a different environment, return to the manual-adapter path.

Model capture is an explicit declaration. `not_applicable` means the actual agent has no model calls. `reported` retains uncertainty. `accounted` requires real instrumentation using the supplied model recorder, including nested calls and physical retries at the declared boundary. Do not switch modes to make validation pass. Required usage cannot accompany `not_applicable`.

Credential bindings contain names only and go to the declared worker. Do not read `.env` files or place values in public declarations, instructions or command arguments. Runtime code handles the supported injection/masking boundary. Report missing configuration without requesting the secret in chat.

`connect` writes `connection.json`, `prepared/` and a skill snapshot. Resolve the recipe's plan path relative to the connection directory. `validated` means its static files and declarations agree. Import failures, incomplete capture or bad lifecycle behavior can still appear during the explicit trial.

After an ordinary source edit, use `trial rebuild` with the existing connection, source root and a new output directory. It retains the scenario, environment, limits and capture policy. A configuration change requires a deliberately reviewed new connection. Use `show --format text` with the same explicit store to inspect captured diagnostics and independent state.
