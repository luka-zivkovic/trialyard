# Application and service integrations

For a repository with framework dependencies, an HTTP entrypoint, authentication or external state, keep the real entrypoint and use a process adapter plus an environment adapter. Do not generate an imitation agent from its prompt or replace original tool callbacks with scripted answers.

Use a maintained integration recipe/guide when one exists in Trialyard's `integrations/` directory. `trial check-connection <recipe>` verifies listed local integration files but does not resolve external source, install dependencies, create services or authorize a run. A manual recipe remains blocked until a separately built native plan is available; editing its requirements away does not create one.

Resolve the concrete missing choices:

- Source/build/runtime versions and the supported application entrypoint.
- Each service's real disposable, stateful substitute or isolated customer-owned mode.
- Authentication and credential names; fixture fields must come from a valid reviewed scenario.
- Per-trial ownership, fresh-state reset, independent initial/final readback and verified cleanup.
- Actual model/tool capture boundaries, required observations and uncontrolled side effects.

Unknown business state is not an empty fixture. Tool schemas describe shapes, not state transitions or idempotency. Historical responses may suggest fixture data but cannot establish reset semantics or gold answers. Unmatched operations must not fall back to production.

When the existing adapter cannot supply a required capability, retain the blocked draft and name the engineering work. The current skill does not automatically generate or qualify arbitrary framework adapters. Installation, build, service preparation and trial execution are distinct actions with their own existing authorization and limits. Existing failed runs and uncertain provider activity remain retained.


For Pi Webdesk, follow `integrations/pi-webdesk/native-guide.md` in the Trialyard checkout. It supplies the pinned source/runtime prerequisites, native build, scripted trials, independent file/session evidence, failure qualification and cleanup boundary. It uses the real Pi loop and original tools with a local scripted provider. Current builds publish `connection.json` with a baseline plan and retained source/build identities. Follow `integrations/pi-webdesk/source-rebuild-guide.md` for selecting consumed Webdesk TypeScript edits, rebuilding with fixed trial inputs, checking Pi lineage, and running with new request IDs. Older builds without source records need a fresh build. General scenarios/providers and generic `trial rebuild` remain unsupported.

Use [discovery](discovery.md) to retain the source-backed integration contract and [qualification](qualification.md) to record execution, bounded repairs and the reusable handoff. A maintained guide reduces repeated investigation; recheck the source identities and relevant boundaries when they have changed.
