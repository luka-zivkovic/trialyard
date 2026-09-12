"""Translate the integration's bounded interchange to real Scenario SDK steps.

This format is owned by Trialyard, not LangWatch. Arbitrary Scenario Python
scripts cannot be reverse-compiled. No dynamic user, judge or cached agent step
is admitted by this interchange.
"""
import scenario

def to_script(dialogue):
    if set(dialogue) != {"schemaVersion", "id", "description", "steps"} or dialogue["schemaVersion"] != "trial-runner/static-dialogue/v1":
        raise ValueError("UNSUPPORTED_STATIC_DIALOGUE")
    steps = dialogue["steps"]
    if not isinstance(steps, list) or not 2 <= len(steps) <= 20 or len(steps) % 2:
        raise ValueError("UNSUPPORTED_STATIC_DIALOGUE")
    ids, script = [], []
    for i in range(0, len(steps), 2):
        user, agent = steps[i:i + 2]
        if set(user) != {"kind", "id", "content"} or user["kind"] != "user" or not isinstance(user["id"], str) or not user["id"] or not isinstance(user["content"], str) or not 1 <= len(user["content"]) <= 4096 or agent != {"kind": "agent"}:
            raise ValueError("UNSUPPORTED_STATIC_DIALOGUE_STEP")
        ids.append(user["id"])
        script.extend([scenario.user(user["content"]), scenario.agent()])
    if len(ids) != len(set(ids)):
        raise ValueError("DUPLICATE_STATIC_TURN")
    return script
