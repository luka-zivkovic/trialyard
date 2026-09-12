import * as fs from "node:fs/promises";
import * as path from "node:path";
import { contract } from "../contracts/validate.js";
import type { Artifact, Plan, Profile } from "../contracts/types.js";
import { hash, jsonBytes, writeAtomic } from "../core/files.js";
import { resolvePlan } from "../core/plan.js";
import { compareInspection, inspectRepository, setupDeclaration, templateFiles } from "./inspect.js";
import type { Preparation } from "./types.js";
import { DiscoveryError, FILE_LIMIT, TOTAL_LIMIT, declaredFile, fail, metadata, newDestination, publicJson, readPublic, record, repositoryRoot } from "./safe.js";

const instructions = [
  "Read docs/assisted-setup.md in Trialyard and author a public trial-runner.setup.json in your repository.",
  "Keep actual agent logic in an ESM module exporting createAgent() returning an object with runTurn(context).",
  "List every public runtime file; no dependencies are installed and no application logic is synthesized.",
  "Explicitly select a compatible environment, scenario, model capture declaration and credential names.",
  "Run inspect again, then prepare into another new directory. This draft contains no runnable plan.",
];
export async function prepareRepository(directory: string, output: string, priorReport?: unknown): Promise<Preparation> {
  let created: string | undefined;
  try {
    const root = await repositoryRoot(directory);
    const destination = await newDestination(root, output);
    const inspection = await inspectRepository(root);
    if (priorReport !== undefined) compareInspection(priorReport, inspection);
    const discoverySha256 = hash(jsonBytes(inspection));
    const result: Preparation = { schemaVersion: "trial-runner/preparation/v1", status: "blocked", template: inspection.template, discoverySha256,
      sources: [...inspection.sources], outputs: [], plan: null, execution: "not_run", nextSteps: [] };
    const files = new Map<string, Buffer>([["inspection.json", jsonBytes(inspection)]]);
    const sources = new Map<string, Buffer>();
    if (inspection.status === "declared") {
      const declaration = await readPublic(root, "trial-runner.setup.json");
      if (hash(declaration) !== inspection.sources.find(f => f.path === "trial-runner.setup.json")?.sha256) fail("SOURCE_CHANGED");
      const setup = setupDeclaration(publicJson(declaration));
      // Check the entire inventory before reading ANY source payload, including late invalid entries.
      let total = 0;
      for (const name of setup.agent.files) {
        total += (await declaredFile(name, "prepare", () => metadata(root, name, FILE_LIMIT))).size;
        if (total > TOTAL_LIMIT) fail("SOURCE_BYTE_LIMIT");
      }
      total = 0;
      for (const name of setup.agent.files) {
        const bytes = await declaredFile(name, "prepare", () => readPublic(root, name, FILE_LIMIT));
        total += bytes.length;
        if (total > TOTAL_LIMIT) fail("SOURCE_BYTE_LIMIT");
        sources.set(name, bytes);
      }
      for (const [name, bytes] of sources) result.sources.push(record(name, bytes));
      const template = await templateFiles();
      if (template.identity.sha256 !== inspection.template.sha256) fail("TEMPLATE_CHANGED");
      for (const [name, bytes] of template.files) files.set(name, bytes);
      files.delete("reference/agent.js"); files.delete("reference/model-agent.js");
      for (const [name, bytes] of sources) files.set(`candidate/${name}`, bytes);
      files.set("candidate/package.json", jsonBytes({ private: true, type: "module" }));
      const plan = JSON.parse(files.get("plan.json")!.toString()) as Plan;
      const profile = JSON.parse(files.get("profile.json")!.toString()) as Profile;
      plan.id = "prepared-node-function";
      plan.agent = { adapterId: "template.node-function", adapterVersion: "1.0.0", argv: ["node", "trial-adapter.js"], cwd: "candidate", artifactManifest: "agent-artifact.json",
        capabilities: ["scripted-turns", "routed-tools", "conversation-events", ...(setup.agent.modelCapture === "not_applicable" ? [] : [`model-${setup.agent.modelCapture}`])], settingsSchema: "agent-settings.schema.json", settings: { entrypoint: setup.agent.entrypoint } };
      plan.repetitions = setup.repetitions;
      if (setup.limits) plan.limits = setup.limits;
      plan.secretBindings = setup.agent.secretBindings.map(name => ({ name, recipient: "agent" }));
      profile.id = "prepared-function-evidence";
      profile.captureBoundary = "Candidate-declared Node function, runner-routed reference inventory tools; model instrumentation remains the candidate's responsibility";
      profile.modelCapture = setup.agent.modelCapture;
      profile.modelCaptureReason = setup.agent.modelCaptureReason;
      if (setup.agent.requireUsage) profile.required.modelUsage = true;
      files.set("plan.json", jsonBytes(plan)); files.set("profile.json", jsonBytes(profile)); files.set("scenario.json", jsonBytes(setup.scenario));
      files.set("agent-settings.schema.json", jsonBytes({ type: "object", properties: { entrypoint: { type: "string", enum: [setup.agent.entrypoint] } }, required: ["entrypoint"], additionalProperties: false }));
      const provenance = { schemaVersion: "trial-runner/setup-provenance/v1", template: result.template, discoverySha256, sources: result.sources };
      files.set("setup-provenance.json", jsonBytes(contract("setupProvenance", provenance)));
      const artifact = (names: string[]): Buffer => jsonBytes({ schemaVersion: "trial-runner/artifact/v1", files: names.sort().map(name => record(name, files.get(name)!)) } satisfies Artifact);
      files.set("agent-artifact.json", artifact([...files.keys()].filter(name => name.startsWith("candidate/") || name.startsWith("src/sdk/") || ["package.json", "setup-provenance.json"].includes(name))));
      files.set("environment-artifact.json", artifact(["package.json", "reference/environment.js", "reference/contract.js", "src/sdk/peer.js"]));
      result.status = "prepared";
      result.nextSteps = [["trial", "validate", "plan.json"], ["trial", "run", "plan.json", "--request", "first-trial", "--store", ".trial-runs"], ["trial", "show", "--request", "first-trial", "--store", ".trial-runs", "--format", "text"]];
      files.set("GETTING_STARTED.md", Buffer.from("# Prepared Node function trial\n\nRun the argv steps in preparation.json from this directory using your installed Trialyard command. Review plan.json, scenario.json, profile.json, fixture.json and setup-provenance.json first. Source code is copied unchanged under candidate/. The reference inventory starts with three units and no reservations.\n\nNo candidate code has run. The files-only dependency and model capture declarations are unverified operator claims. This local execution mode trusts the candidate and is not a security sandbox. Configure declared credential names only for an explicit run, then inspect the recorded outcomes and verify each returned bundle path with `trial verify <bundle-directory>`. Evidence completeness is not a quality verdict.\n"));
    } else {
      const draft = { schemaVersion: "trial-runner/setup-draft/v1", template: "node-function/v1", entrypointCandidates: inspection.candidates.map(c => c.argv[1]!), environmentTemplate: null, modelCapture: null, instructions };
      files.set("setup-draft.json", jsonBytes(contract("setupDraft", draft)));
      files.set("GETTING_STARTED.md", Buffer.from("# Setup blocked\n\nRead inspection.json for specific unresolved capabilities. No runnable plan or environment was selected.\n\n" + instructions.map(i => `- ${i}`).join("\n") + "\n"));
    }
    const unchanged = async (): Promise<void> => {
      compareInspection(inspection, await inspectRepository(root));
      for (const [name, bytes] of sources) if (!(await readPublic(root, name, FILE_LIMIT)).equals(bytes)) fail("SOURCE_CHANGED");
    };
    await unchanged();
    await fs.mkdir(destination, { mode: 0o700 }); created = destination;
    for (const [name, bytes] of files) await writeAtomic(path.join(destination, name), bytes);
    if (result.status === "prepared") {
      const resolved = await resolvePlan(path.join(destination, "plan.json"));
      result.plan = { path: "plan.json", inputSha256: resolved.inputSha256 };
    }
    await unchanged();
    result.outputs = [...files].map(([name, bytes]) => record(name, bytes)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    contract("preparation", result);
    // Publication marker is last. Its inventory excludes itself, avoiding a recursive digest.
    await writeAtomic(path.join(destination, "preparation.json"), jsonBytes(result));
    return result;
  } catch (error) {
    if (created) await fs.rm(created, { recursive: true, force: true });
    if (error instanceof DiscoveryError) throw error;
    return fail("PREPARATION_FAILED"); // Do not echo filesystem paths, source snippets or validation keys.
  }
}
