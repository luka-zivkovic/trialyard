#!/usr/bin/env node
import * as path from "node:path";
import { readableRun } from "./format-run.js";
import { connectionHints, inspectionHint } from "./next-steps.js";
import { checkConnection, connectRepository } from "../connection/recipe.js";
import { rebuildConnection } from "../connection/rebuild.js";
import { setupSkillContext } from "../connection/skill.js";
import { checkIntegration } from "../connection/integration.js";
import { inspectRepository } from "../discovery/inspect.js";
import { prepareRepository } from "../discovery/prepare.js";
import { DiscoveryError, discoveryMessage, publicJson, readPublic, repositoryRoot } from "../discovery/safe.js";
import { initExample } from "./init.js";
import { resolvePlan } from "../core/plan.js";
import { AcceptedRunError, runPlan, showRun } from "../core/run.js";
import { verifyBundle } from "../contracts/verify.js";
import { assessmentInput, verifyAssessmentInput } from "../contracts/handoff.js";
import { contract } from "../contracts/validate.js";
import { readJson, jsonBytes, writeAtomic } from "../core/files.js";
import type { Scenario } from "../contracts/types.js";
import { CancelledError } from "../core/process.js";
import { inspectRun } from "../core/inspect.js";
import { exportRedactedBundle, verifyRedactedBundle } from "../export/redacted.js";

const help = `Trialyard 0.1.0 — local developer preview

  trial skill connect-agent [--reference <id from availableReferences>]
  trial connect <repository> --out <new-directory>
  trial rebuild <connection.json> --source <repository> --out <new-directory> [--sha256 <parent recipe digest>]
  trial check-connection <connection.json> [--sha256 <expected recipe digest>]
  trial check-integration <integration-contract.json> [--sha256 <expected contract digest>]
  trial inspect <repository> [--out <new-report.json>]
  trial prepare <repository> --out <new-directory> [--inspection <report.json>]
  trial init <new-directory> [--example inventory|model-accounting]
  trial validate <plan.json>
  trial run <plan.json> --request <id> [--store <directory>] [--deadline <ISO time>] [--rerun-of <request-id>]
  trial show --request <id> [--store <directory>] [--format json|text]
  trial verify <bundle-directory> [--sha256 <expected manifest digest>]
  trial verify <redacted-directory> --source <original-bundle> [--sha256 <expected digest>]
  trial export <bundle-directory> --format assessment-input --out <new-file.json>
  trial export <bundle-directory> --format redacted-bundle --redaction <policy.json> --out <new-directory>

Default store: .trial-runs in the current directory.
Exit 0 means execution/evidence checks succeeded; it is not an agent-quality verdict.
Run exits: 1 invalid before acceptance; 2 failed/incomplete/unfinished run; 130 user cancellation.
Accepted request IDs are never replayed, including after interruption.
`;

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || ["help", "--help", "-h"].includes(command)) { process.stdout.write(help); return; }
  const positional: string[] = [];
  const options = new Map<string, string>();
  const allowed: Record<string, string[]> = { skill: ["reference"], connect: ["out"], rebuild: ["source", "out", "sha256"], "check-connection": ["sha256"], "check-integration": ["sha256"], inspect: ["out"], prepare: ["out", "inspection"], init: ["example"], validate: [], run: ["request", "store", "deadline", "rerun-of"], show: ["request", "store", "format"], verify: ["sha256", "source"], export: ["format", "out", "redaction"] };
  if (!(command in allowed)) throw new Error("Unknown command; use --help");
  if (rest.includes("--help") || rest.includes("-h")) {
    const syntax = help.split("\n").filter(line => line.startsWith(`  trial ${command} `)).join("\n");
    const details: Record<string, string> = {
      connect: "Freeze a supported Node function and reference environment in a new connection. Runs no candidate code. Use rebuild for changes to an existing connection.",
      prepare: "Lower-level preparation used by connect. --inspection optionally pins an earlier discovery report. Prefer connect for a reusable connection.",
      inspect: "Read public package/setup declarations. Reports declared or blocked; runtime readiness is not checked.",
      rebuild: "Refresh declared Node runtime files while preserving the trial configuration. Requires a new output directory and a compatible retained connection.",
      run: "Explicit execution. Reusing an accepted request returns its recorded run; changed inputs conflict. Use a new request ID for intentional execution.",
      show: "Read recorded evidence. Use --format text for conversation, state and diagnostics. Supply the same --store used by run.",
      "check-connection": "Verify retained bytes and static plan consistency without execution. Does not check live service availability.",
      "check-integration": "Check a discovery/contract pair offline. Exit 0 consistent, 2 unresolved required decisions/capabilities, 1 invalid. Does not check source claims, readiness, qualification or authorization."
    };
    process.stdout.write(`${syntax}\n\n${details[command] ?? "See the repository workflow guide for this command."}\nDefault store: .trial-runs in the current directory.\n`); return;
  }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) positional.push(arg);
    else {
      const name = arg.slice(2); const value = rest[++i];
      if (!allowed[command]!.includes(name)) throw new Error(`Unknown option ${JSON.stringify(arg)}; use trial ${command} --help`);
      if (options.has(name)) throw new Error(`Repeated --${name}; use trial ${command} --help`);
      if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}; use trial ${command} --help`);
      options.set(name, value);
    }
  }
  const need = (name: string): string => { const value = options.get(name); if (!value) throw new Error(`Missing --${name}`); return value; };
  if (positional.length !== (command === "show" ? 0 : 1)) throw new Error("Incorrect arguments; use --help");
  const target = positional[0]!;
  if (command === "skill") {
    if (target !== "connect-agent") throw new Error("UNKNOWN_SKILL");
    process.stdout.write(JSON.stringify(await setupSkillContext(options.get("reference")), null, 2) + "\n");
  } else if (command === "check-integration") {
    const result = await checkIntegration(target, options.get("sha256"));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.status === "blocked") process.exitCode = 2;
  } else if (command === "rebuild") {
    const result = await rebuildConnection(target, need("source"), need("out"), options.get("sha256"));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    connectionHints(result.recipe, result.plan);
  } else if (command === "connect" || command === "check-connection") {
    const result = command === "connect" ? await connectRepository(target, need("out")) : await checkConnection(target, options.get("sha256"));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.status === "blocked") process.exitCode = 2;
    if (command === "connect" && "recipe" in result) connectionHints(String(result.recipe), result.plan);
  } else if (command === "inspect") {
    const report = await inspectRepository(target);
    if (options.has("out")) await writeAtomic(path.resolve(need("out")), jsonBytes(report));
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (report.status === "blocked") process.exitCode = 2;
  } else if (command === "prepare") {
    let prior: unknown;
    if (options.has("inspection")) {
      const reportPath = path.resolve(need("inspection"));
      try { prior = publicJson(await readPublic(await repositoryRoot(path.dirname(reportPath)), path.basename(reportPath))); }
      catch { throw new Error("INVALID_INSPECTION_REPORT"); }
    }
    const result = await prepareRepository(target, need("out"), prior);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.status === "blocked") process.exitCode = 2;
    connectionHints(path.join(path.resolve(need("out")), "preparation.json"), result.plan);
  } else if (command === "init") {
    const example = options.get("example") ?? "inventory";
    if (example !== "inventory" && example !== "model-accounting") throw new Error("Unknown reference example");
    process.stdout.write(`Created independent reference: ${await initExample(target, example)}\n`);
  }
  else if (command === "validate") {
    const result = await resolvePlan(target);
    process.stdout.write(`Static validation succeeded. ${result.scenarios.length * result.plan.repetitions} planned trials; input ${result.inputSha256}. No adapter executed.\n`);
  } else if (command === "run") {
    const abort = new AbortController(); const cancel = (): void => abort.abort();
    process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
    try {
      const result = await runPlan(target, { requestId: need("request"), store: options.get("store") ?? ".trial-runs", signal: abort.signal,
        ...(options.has("deadline") ? { deadlineAt: options.get("deadline")! } : {}), ...(options.has("rerun-of") ? { rerunOf: options.get("rerun-of")! } : {}) });
      process.stdout.write(JSON.stringify({ ...result, notice: result.duplicate ? "Existing request returned; no execution replayed" : "Execution evidence only; quality assessment remains external" }, null, 2) + "\n");
      inspectionHint(result.index.requestId, options.get("store") ?? ".trial-runs");
      process.exitCode = result.index.exitCode ?? 2;
    } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
  } else if (command === "show") {
    if (options.has("format") && !["json", "text"].includes(need("format"))) throw new Error("Unsupported show format");
    const store = path.resolve(options.get("store") ?? ".trial-runs");
    const result = await showRun(store, need("request")).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`REQUEST_NOT_FOUND: ${JSON.stringify(need("request"))} in store ${JSON.stringify(store)}. Supply --store with the directory used by run; use trial show --help.`);
      throw error;
    });
    const inspection = await inspectRun(result.root, result.index, result.acceptanceSha256);
    if (options.get("format") === "text") process.stdout.write(await readableRun(result, inspection));
    else process.stdout.write(JSON.stringify({ ...result, inspection, notice: result.index.state === "accepted" ? "Unfinished accepted run: it may be active or interrupted. Inspection does not resume execution or infer missing outcomes." : "Recorded run inspected against its retained evidence" }, null, 2) + "\n");
    if (inspection.trials.some(trial => trial.state === "invalid")) process.exitCode = 2;
  } else {
    if (command === "verify" && options.has("source")) {
      const result = await verifyRedactedBundle(path.resolve(target), path.resolve(need("source")), options.get("sha256"));
      process.stdout.write(`Verified derivative ${result.digest}; source=${result.manifest.parentBundleSha256}; evidence=incomplete; authenticity=not_attested\n`);
      return;
    }
    if (command === "export" && need("format") === "redacted-bundle") {
      const policyFile = path.resolve(need("redaction"));
      const result = await exportRedactedBundle(path.resolve(target), path.resolve(need("out")), await readJson(path.dirname(policyFile), path.basename(policyFile)));
      process.stdout.write(JSON.stringify({ root: result.root, digest: result.digest, parentBundleSha256: result.manifest.parentBundleSha256, evidence: result.manifest.evidence }, null, 2) + "\n");
      return;
    }
    if (options.has("redaction")) throw new Error("--redaction applies only to redacted-bundle export");
    const result = await verifyBundle(path.resolve(target), options.get("sha256"));
    if (command === "verify") process.stdout.write(`Verified ${result.digest}; execution=${result.manifest.execution}; evidence=${result.manifest.evidence.state}; cleanup=${result.manifest.cleanup}; authenticity=not_attested\n`);
    else {
      if (need("format") !== "assessment-input") throw new Error("Unsupported export format");
      const scenario = contract<Scenario>("scenario", await readJson(path.resolve(target), "scenario.json"));
      const input = assessmentInput(result.manifest, result.digest, scenario);
      verifyAssessmentInput(input, result.manifest, result.digest, scenario);
      await writeAtomic(path.resolve(need("out")), jsonBytes(input));
      process.stdout.write(`Wrote assessment input to ${path.resolve(need("out"))}. Consumer integration is not yet qualified.\n`);
    }
  }
}

main(process.argv.slice(2)).catch(error => { process.stderr.write(`Trialyard: ${error instanceof Error ? error.message : "Unexpected failure"}${error instanceof DiscoveryError && error.detail ? `\n${discoveryMessage(error)}` : ""}\n`); process.exitCode = error instanceof CancelledError ? 130 : error instanceof AcceptedRunError ? 2 : 1; });
