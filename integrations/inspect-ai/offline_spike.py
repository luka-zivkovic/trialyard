"""Qualify Inspect log/scorer reuse over three pinned, retained P1 packages."""
import os
os.environ.update(OTEL_SDK_DISABLED="true", LITELLM_LOCAL_MODEL_COST_MAP="True", LANGWATCH_API_KEY="", SCENARIO_HEADLESS="true")
import socket
blocked_connections = []
_connect = socket.socket.connect
def offline_connect(sock, address):
    if sock.family in (socket.AF_INET, socket.AF_INET6):
        blocked_connections.append(str(address))
        raise RuntimeError("NETWORK_DISABLED_FOR_OFFLINE_SPIKE")
    return _connect(sock, address)
socket.socket.connect = offline_connect

import asyncio
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone
from importlib.metadata import version
from inspect_ai import score as rescore
from inspect_ai.log import EvalLog, EvalSpec, EvalDataset, EvalConfig, EvalSample, read_eval_log, write_eval_log
from inspect_ai.model import ChatMessageUser, ChatMessageAssistant, Model
from inspect_ai.scorer import Score, SampleScore, scorer, metric

ROOT = Path(__file__).resolve().parents[2]
NODE = None
BRIDGE = Path(__file__).with_name("retained-p1.mjs")
model_generations = []
async def forbidden_generate(*args, **kwargs):
    model_generations.append(True)
    raise RuntimeError("GENERATION_DISABLED_FOR_RESCORING")
Model.generate = forbidden_generate

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def bridge(command, descriptor, out=None):
    args = [str(NODE), str(BRIDGE), command, str(descriptor)] + ([str(out)] if out else [])
    process = subprocess.run(args, cwd=ROOT, env={"PATH": str(NODE.parent), "LANG": "C.UTF-8", "TZ": "UTC"}, capture_output=True, text=True, timeout=45)
    if process.returncode:
        raise RuntimeError(process.stderr.strip())
    return json.loads(process.stdout)

@metric(scores="unreduced")
def judgment_counts():
    def calculate(scores: list[SampleScore]):
        categories = ["satisfied", "violated", "not_evaluable", "not_applicable", "assessment_error"]
        counts = {c: sum(s.score.value == c for s in scores) for c in categories}
        return {**counts, "total": len(scores), "evaluable": counts["satisfied"] + counts["violated"]}
    return calculate

@scorer(metrics=[judgment_counts()])
def retained_p1(attempt_root: str):
    async def assess(state, target):
        descriptor = Path(state.metadata["descriptor"])
        # Bind the locator and trust anchor used when exporting this sample.
        if digest(descriptor) != state.metadata["descriptorSha256"]:
            raise ValueError("DESCRIPTOR_CHANGED")
        checked = await asyncio.to_thread(bridge, "assess", descriptor, Path(attempt_root) / str(state.sample_id))
        for field in ["source", "criterion", "consumer", "archiveSha256"]:
            if checked[field] != state.metadata[field]:
                raise ValueError("ASSESSMENT_SOURCE_OR_CRITERION_CHANGED")
        record = checked["attempt"]["result"]
        result = record.get("result")
        if record["execution"] != "completed" or not result:
            return Score(value="assessment_error", explanation=record.get("errorCode"), metadata={"receipt": record, "assessmentSha256": checked["attempt"]["sha256"]})
        return Score(value=result["judgment"], explanation=result["reason"], metadata={"receipt": record, "assessmentSha256": checked["attempt"]["sha256"], "observations": result["observations"], "candidateExecutions": 0})
    return assess

def main():
    global NODE
    NODE = Path(sys.argv[3]).resolve()
    archive = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2]).resolve(); out.mkdir()
    index = json.loads((archive / "index.json").read_text())
    selected = [next(p for p in index["packages"] if p["name"] == name) for name in ["baseline-0", "regression-0", "missing-final-fixture"]]
    samples, sources = [], []
    for package in selected:
        descriptor = out / (package["name"] + "-descriptor.json")
        descriptor.write_text(json.dumps({"directory": str(archive / "packages" / package["name"]), "sha256": package["sha256"]}, indent=2) + "\n")
        checked = bridge("read", descriptor)
        messages = []
        # Display projection only; source state/operations remain in the pinned archive.
        for event in checked["conversation"]:
            payload = event["payload"]
            if event["kind"] == "user.turn": messages.append(ChatMessageUser(content=payload["content"]))
            else: messages.append(ChatMessageAssistant(content=payload["content"]))
        assert len(messages) == 2 * len(checked["scenario"]["messages"]), "CONVERSATION_PROJECTION_INCOMPLETE"
        metadata = {key: checked[key] for key in ["source", "criterion", "consumer", "native", "archiveSha256", "originalAssessmentSha256"]}
        metadata.update(descriptor=str(descriptor), descriptorSha256=digest(descriptor), evidenceKind="retained-native-execution", candidateExecutions=0)
        samples.append(EvalSample(id=package["name"], epoch=1, input=messages[0].content, messages=messages, target="", metadata=metadata))
        sources.append({"name": package["name"], "expected": checked["originalAssessment"]["result"]["judgment"], **metadata})
    log = EvalLog(status="success", eval=EvalSpec(created=datetime.now(timezone.utc).isoformat(), task="retained-pi-p1-offline-import", dataset=EvalDataset(name="retained-p1", samples=3), model="mockllm/offline-no-generation", config=EvalConfig(), metadata={"imported": True, "modelFieldPurpose": "Inert Inspect configuration; actual candidate/provider identity remains in native evidence.", "candidateExecutions": 0}), samples=samples)
    imported = out / "imported.eval"; write_eval_log(log, str(imported)); original_hash = digest(imported)
    (out / "attempts").mkdir()
    scored = rescore(read_eval_log(str(imported)), retained_p1(str(out / "attempts")), epochs_reducer=[], display="none")
    write_eval_log(scored, str(out / "scored.eval"))
    reread = read_eval_log(str(out / "scored.eval"))
    judgments = []
    sources_by_id = {s["name"]: s for s in sources}
    assert {s.id for s in reread.samples} == set(sources_by_id)
    for sample in reread.samples:
        source = sources_by_id[sample.id]
        result = next(iter(sample.scores.values()))
        assert result.value == source["expected"], (sample.id, result)
        assert result.metadata["receipt"]["source"]["bundleSha256"] == source["source"]["bundleSha256"]
        assert result.metadata["receipt"]["criterion"] == source["criterion"]
        assert result.metadata["receipt"]["consumer"] == source["consumer"]
        judgments.append({"id": sample.id, "value": result.value, "assessmentSha256": result.metadata["assessmentSha256"]})
        bridge("read", Path(sample.metadata["descriptor"]))
    counts = {m.name: m.value for m in reread.results.scores[0].metrics.values()}
    assert counts == {"satisfied": 1, "violated": 1, "not_evaluable": 1, "not_applicable": 0, "assessment_error": 0, "total": 3, "evaluable": 2}, counts
    assert digest(imported) == original_hash
    assert not model_generations
    # A wrong trust anchor fails before any checker dispatch.
    tampered = out / "bad-descriptor.json"
    tampered.write_text(json.dumps({"directory": selected[0]["directory"], "sha256": "0" * 64}))
    try:
        bridge("assess", tampered, out / "must-not-exist")
        raise AssertionError("Wrong trust anchor accepted")
    except RuntimeError as error:
        assert "RETENTION_DIGEST_MISMATCH" in str(error)
    assert not (out / "must-not-exist").exists()
    record = {"kind": "inspect-offline-qualification/v1", "inspectVersion": version("inspect-ai"), "python": sys.version, "node": str(NODE), "bridgeSha256": digest(BRIDGE), "importSha256": original_hash, "scoredSha256": digest(out / "scored.eval"), "sources": sources, "judgments": judgments, "results": reread.results.model_dump(mode="json"), "candidateExecutions": 0, "modelGenerations": len(model_generations), "blockedNetworkAttempts": blocked_connections, "checks": {"importUnchanged": True, "archivesReverified": True, "wrongTrustAnchorRejectedBeforeAssessment": True}}
    (out / "qualification.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({"judgments": judgments, "candidateExecutions": 0, "modelGenerations": len(model_generations)}))

if __name__ == "__main__": main()
