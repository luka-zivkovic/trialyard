# Contract examples

These are **CURRENT — illustrative JSON shapes matching the experimental schema**. They contain no customer traces, model credentials or business-quality labels. They are not a self-contained runnable directory; use `npm run trial -- init <new-directory>` after building to generate the actual reference and its hashed runtime files.

- [run-plan.json](run-plan.json) shows the configuration structure and explicit limits emitted by the current reference initializer. Its runtime/schema references are supplied by `init`, not by this illustrative directory.
- [scenario.json](scenario.json) contains two scripted user turns, not expected answers.
- [initial-state.json](initial-state.json) describes synthetic inventory state.
- [evidence-profile.json](evidence-profile.json) declares the required capture boundary; it does not judge reservation correctness.
- [tool-event.json](tool-event.json) illustrates a terminal journal event for one observed operation. A real log must also contain its earlier dispatch event and validate their correlation.

The schema and positive/negative fixtures are implemented under `contracts/` and `test/`. These examples clarify fields and semantics; they are not a substitute for that conformance work or a ready-to-run package.
