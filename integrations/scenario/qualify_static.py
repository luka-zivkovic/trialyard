import os
os.environ.update(OTEL_SDK_DISABLED="true", LITELLM_LOCAL_MODEL_COST_MAP="True", LANGWATCH_API_KEY="", SCENARIO_HEADLESS="true")
import socket
blocked_connections = []
_connect = socket.socket.connect
def offline_connect(sock, address):
    if sock.family in (socket.AF_INET, socket.AF_INET6):
        blocked_connections.append(str(address))
        raise RuntimeError("NETWORK_DISABLED_FOR_STATIC_REPLAY")
    return _connect(sock, address)
socket.socket.connect = offline_connect

import asyncio
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from importlib.metadata import version
import scenario
from scenario.types import AgentRole
from static_dialogue import to_script

ROOT = Path(__file__).resolve().parents[2]
scenario.configure(headless=True, verbose=False, fetch_remote_traces=False, observability={"instrumentors": []})

class StaticUser(scenario.AgentAdapter):
    role = AgentRole.USER
    async def call(self, input):
        raise AssertionError('STATIC_USER_GENERATION_FORBIDDEN')

class RetainedReplies(scenario.AgentAdapter):
    name = "Retained Pi conversation — replay only"
    def __init__(self, turns, replies):
        self.turns, self.replies, self.calls, self.threads = turns, replies, 0, set()
    async def call(self, input):
        assert input.last_new_user_message_str() == self.turns[self.calls]
        assert [m["content"] for m in input.messages if m["role"] == "user"] == self.turns[:self.calls + 1]
        self.threads.add(input.thread_id)
        response = self.replies[self.calls]
        self.calls += 1
        return response

async def main():
    qualification = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2]).resolve(); out.mkdir()
    node = Path(sys.argv[3]).resolve()
    source = json.loads(qualification.read_text())
    records = []
    for record in source["results"][::2]:
        bundle = Path(record["path"])
        checked = subprocess.run([str(node), str(ROOT / "integrations/pi-webdesk/inspect-native.mjs"), str(bundle), "--sha256", record["bundleSha256"]], cwd=ROOT, env={"PATH": str(node.parent), "LANG": "C.UTF-8", "TZ": "UTC"}, capture_output=True, text=True, timeout=30)
        assert checked.returncode == 0, checked.stderr
        events = [json.loads(line) for line in (bundle / "events.ndjson").read_text().splitlines()]
        turns = [e["payload"]["content"] for e in events if e["kind"] == "user.turn"]
        replies = [e["payload"]["content"] for e in events if e["kind"] == "assistant.turn"]
        dialogue = json.loads((bundle / "inputs/case-dialogue.json").read_text())
        assert turns == [s["content"] for s in dialogue["steps"] if s["kind"] == "user"]
        assert len(replies) == len(turns)
        adapter = RetainedReplies(turns, replies)
        result = await scenario.run(name="static-replay-" + record["mode"], description=dialogue["description"], agents=[StaticUser(), adapter], script=to_script(dialogue) + [scenario.succeed("Static authoring/replay contract completed; no quality judgment.")], max_turns=10, verbose=False, fetch_remote_traces=False, metadata={"evidenceKind": "retained-conversation-replay", "bundleSha256": record["bundleSha256"], "candidateExecutions": 0})
        assert result.success and adapter.calls == len(turns) and len(adapter.threads) == 1
        (out / (record["mode"] + ".json")).write_text(result.model_dump_json(indent=2) + "\n")
        records.append({"mode": record["mode"], "sourceBundleSha256": record["bundleSha256"], "sdkReplayCompleted": result.success, "adapterCalls": adapter.calls, "candidateExecutions": 0, "behaviorJudgment": record["assessment"]["judgment"]})
    for bad in [{"kind": "judge"}, {"kind": "agent", "content": "fabricated answer"}, {"kind": "proceed"}]:
        changed = copy.deepcopy(dialogue); changed["steps"][1] = bad
        try:
            to_script(changed)
            raise AssertionError("Unsupported step accepted")
        except ValueError:
            pass
    report = {"kind": "scenario-static-qualification/v1", "scenarioVersion": version("langwatch-scenario"), "sourceQualificationSha256": hashlib.sha256(qualification.read_bytes()).hexdigest(), "results": records, "unsupportedStepsRejected": True, "candidateExecutions": 0, "blockedNetworkAttempts": blocked_connections, "limits": "Static common subset and retained replay only. No live Scenario-to-Pi lifecycle integration or user simulation."}
    (out / "qualification.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))

if __name__ == "__main__": asyncio.run(main())
