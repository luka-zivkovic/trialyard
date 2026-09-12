# Scenario static-authoring experiment

**CURRENT:** the actual LangWatch Scenario Python SDK 1.5.0 executes a bounded static dialogue projection using responses from verified, retained Pi trials. This establishes the declared authoring subset and conversation/history mapping. It is replay, with zero new candidate executions, and does not establish a live Scenario-to-Pi integration.

Use Python 3.12.14, an isolated environment with `requirements.txt`, Node 24.15.0 and the output of `qualify-cases.mjs`.

```sh
/absolute/venv/bin/python integrations/scenario/qualify_static.py /absolute/case-qualification/qualification.json /absolute/new-scenario-output /absolute/node-24.15.0
```

`static_dialogue.py` translates the integration-owned `trial-runner/static-dialogue/v1` format to `scenario.user(text)` / `scenario.agent()` steps. This JSON is not a native LangWatch serialization format. Executable/adaptive steps, judges, injected agent responses and cached execution are outside the interchange. Native case round-tripping is checked by the Node case-contract tests; the Python qualification checks SDK behavior and unsupported-step rejection.

Scenario requires a user-role adapter even when each user message is explicit. The experiment supplies a static adapter whose generation method raises if invoked. The target adapter checks user-message order and retained history before returning each recorded reply. Every replay uses one Scenario thread. Native bundle verification runs before extracting messages. Network connections are disabled, telemetry is not configured, and no provider is used.

The Scenario script explicitly marks authoring replay complete. That success is not a behavioral assessment: the failed-recovery source also completes replay, while its separate R1 judgment remains violated. Results retain both meanings and source bundle digests. Full model-driven simulation remains outside the current Trialyard scope.
