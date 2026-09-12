import * as fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { exampleFiles } from "../cli/init.js";
import { hash, jsonBytes } from "../core/files.js";
import { validateSecretBindings } from "../core/privacy.js";
import { contract } from "../contracts/validate.js";
import type { DiscoveryReport, Setup, TemplateIdentity } from "./types.js";
import { DiscoveryError, discoveryMessage, fail, publicJson, publicPath, readPublic, record, repositoryRoot } from "./safe.js";
import { setupIssue } from "./diagnostics.js";

export async function templateFiles(): Promise<{ files: Map<string, Buffer>; identity: TemplateIdentity }> {
  const files = await exampleFiles();
  files.set("candidate/trial-adapter.js", await fs.readFile(new URL("../../reference/node-function.js", import.meta.url)));
  const identity: TemplateIdentity = { id: "node-function/v1", environment: "reference-inventory/v1",
    sha256: hash(jsonBytes([...files].map(([name, bytes]) => record(name, bytes)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) };
  return { files, identity };
}

export function setupDeclaration(value: unknown): Setup {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const declaration = value as Record<string, unknown>;
    if (declaration.schemaVersion !== "trial-runner/setup/v1") fail("UNSUPPORTED_SETUP_VERSION");
    if (declaration.template !== "node-function/v1") fail("UNSUPPORTED_AGENT_TEMPLATE");
    const environment = declaration.environment as { template?: unknown } | undefined;
    if (!environment || environment.template !== "reference-inventory/v1") fail("UNSUPPORTED_ENVIRONMENT_TEMPLATE");
  }
  let setup: Setup;
  try { setup = contract<Setup>("setup", value); } catch (error) { return fail("INVALID_SETUP", setupIssue(error)); }
  // Apply policy to the whole inventory BEFORE reading or inspecting any candidate file.
  for (const name of setup.agent.files) publicPath(name);
  publicPath(setup.agent.entrypoint);
  if (!/\.(js|mjs)$/.test(setup.agent.entrypoint) || !setup.agent.files.includes(setup.agent.entrypoint)) fail("ENTRYPOINT_NOT_DECLARED");
  if (new Set(setup.agent.files.map(n => n.toLowerCase())).size !== setup.agent.files.length) fail("AMBIGUOUS_SOURCE_PATHS");
  if (setup.scenario.fixture !== undefined) fail("UNSUPPORTED_SCENARIO_FIXTURE");
  if (new Set(setup.scenario.messages.map(m => m.id)).size !== setup.scenario.messages.length || setup.scenario.messages.length > (setup.limits?.maxTurns ?? 20)) fail("INVALID_SCENARIO");
  if (!setup.agent.modelCaptureReason.trim()) fail("INVALID_SETUP");
  if (new Set(setup.scenario.externalCriterionRefs).size !== setup.scenario.externalCriterionRefs.length) fail("INVALID_SCENARIO");
  if (setup.agent.requireUsage && setup.agent.modelCapture === "not_applicable") fail("CONTRADICTORY_MODEL_CAPTURE");
  try { validateSecretBindings(setup.agent.secretBindings.map(name => ({ name, recipient: "agent" }))); }
  catch { return fail("UNSUPPORTED_SECRET_BINDING"); }
  return setup;
}
const messages: Record<string, string> = {
  PACKAGE_MISSING: "Add a public root package.json declaring type: module. No package commands are run.",
  PACKAGE_UNREADABLE: "Root package.json must be a bounded regular file with no symlink or hardlink.",
  PACKAGE_INVALID: "Root package.json must be bounded strict JSON with an object root.",
  NODE_ESM_REQUIRED: "This template supports self-contained Node ESM modules; declare type: module.",
  PACKAGE_IMPORTS_UNSUPPORTED: "Package import aliases require a different adapter; this template does not copy package resolution rules.",
  PACKAGE_FACT_LIMIT: "Reduce public script or dependency declarations to the documented discovery limits.",
  SETUP_MISSING: "Add trial-runner.setup.json declaring the agent files, function template, environment and scenario.",
  SETUP_UNREADABLE: "The setup declaration must be a bounded regular file with no symlink or hardlink.",
  SETUP_INVALID: "The setup declaration must be bounded strict JSON with an object root.",
  UNSUPPORTED_SETUP_VERSION: "Use the supported trial-runner/setup/v1 declaration version.",
  UNSUPPORTED_AGENT_TEMPLATE: "This release provides node-function/v1. Other function, HTTP, TypeScript and framework adapters require explicit integration work.",
  UNSUPPORTED_ENVIRONMENT_TEMPLATE: "Explicitly select reference-inventory/v1 only when its tools fit the candidate. Other services require their own environment adapter.",
  INVALID_SETUP: "Use the closed setup/v1 schema: node-function/v1 and explicit reference-inventory/v1 are the supported templates.",
  UNSAFE_SOURCE_PATH: "Declare bounded relative public paths without traversal or special characters.",
  EXCLUDED_SOURCE_PATH: "Remove hidden, credential, dependency or generated-runtime paths from the declared file inventory.",
  UNSUPPORTED_SOURCE_FILE: "Declare only public .js, .mjs and .json candidate files.",
  ENTRYPOINT_NOT_DECLARED: "Declare a .js or .mjs function entrypoint in the file inventory.",
  AMBIGUOUS_SOURCE_PATHS: "File paths must be distinct on case-insensitive filesystems.",
  UNSUPPORTED_SCENARIO_FIXTURE: "The selected environment supplies its own explicit fixture; scenario fixture overrides need another adapter.",
  INVALID_SCENARIO: "Use unique message IDs within the declared turn limit.",
  CONTRADICTORY_MODEL_CAPTURE: "Model usage cannot be required when model capture is not applicable.",
  UNSUPPORTED_SECRET_BINDING: "Declare only supported credential environment-variable names, never runtime-control variables or values.",
};
const exclusions = [
  "Inspection reads only root package.json and trial-runner.setup.json; both must contain public declarations only.",
  "All agent source, scripts, README and instruction files are excluded from inspection.",
  "Secret files, dotfiles, environment files, lockfiles, dependencies and generated output are excluded from inspection.",
  "Symlinks, hardlinks and special files are rejected; no repository tree traversal is performed.",
  "No repository execution, installation, environment-variable lookup, network access or upload occurs.",
  "Limits: 262144 bytes per manifest, JSON depth 24 and 10000 values, 64 scripts, 128 dependencies, 66 command candidates.",
];
export async function inspectRepository(directory: string): Promise<DiscoveryReport> {
  const root = await repositoryRoot(directory);
  const { identity } = await templateFiles();
  const report: DiscoveryReport = { schemaVersion: "trial-runner/discovery/v1", status: "blocked", sources: [], template: identity,
    findings: [], candidates: [], unresolved: [], exclusions: [...exclusions], execution: "not_run" };
  const unresolved = (code: string, detail?: string): void => { report.unresolved.push({ code, message: detail ?? messages[code] ?? "The declared setup is unsupported; consult the setup/v1 contract." }); };
  const read = async (name: string, prefix: string) => {
    let bytes: Buffer;
    try { bytes = await readPublic(root, name); }
    catch (error) { unresolved((error as NodeJS.ErrnoException).code === "ENOENT" ? `${prefix}_MISSING` : `${prefix}_UNREADABLE`); return; }
    const source = record(name, bytes); report.sources.push(source);
    try { return { source, value: publicJson(bytes) }; }
    catch { unresolved(`${prefix}_INVALID`); return; }
  };
  const pkg = await read("package.json", "PACKAGE");
  if (pkg) {
    report.findings.push({ kind: "module-type", source: pkg.source, fact: pkg.value.type === "module" ? "type: module" : "type: other or absent", interpretation: "Public package declaration; module exports and dependencies have not been loaded.", certainty: "observed" });
    if (pkg.value.type !== "module") unresolved("NODE_ESM_REQUIRED");
    if (pkg.value.imports !== undefined) unresolved("PACKAGE_IMPORTS_UNSUPPORTED");
    const candidate = (entry: unknown) => {
      if (typeof entry !== "string") return;
      try { publicPath(entry); } catch { return; }
      if (!/\.(js|mjs)$/.test(entry) || report.candidates.some(c => c.argv[1] === entry) || report.candidates.length >= 66) return;
      report.candidates.push({ argv: ["node", entry], source: pkg.source, certainty: "inferred" });
      report.findings.push({ kind: "command", source: pkg.source, fact: `node ${entry}`, interpretation: "Possible Node entrypoint from package metadata; not read, executed or verified to export createAgent.", certainty: "inferred" });
    };
    candidate(pkg.value.main);
    if (typeof pkg.value.bin === "string") candidate(pkg.value.bin);
    const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const scripts = Object.entries(object(pkg.value.scripts));
    const dependencies = [...Object.entries(object(pkg.value.dependencies)), ...Object.entries(object(pkg.value.devDependencies))];
    if (scripts.length > 64 || dependencies.length > 128) unresolved("PACKAGE_FACT_LIMIT");
    else {
      for (const [, command] of scripts) {
        if (typeof command !== "string") continue;
        const match = /^node ([a-zA-Z0-9_./-]+\.(?:js|mjs))$/.exec(command);
        if (match) candidate(match[1]);
      }
      for (const [name, spec] of dependencies) {
        // URL/git/local specs and arbitrary script bodies never enter diagnostics or reports.
        if (!/^(?:@[a-z0-9._-]{1,64}\/)?[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) continue;
        const range = typeof spec === "string" && spec.length <= 96 && /^[0-9xX*~^<>=| .+-]+$/.test(spec) ? spec : "[non-semver declaration omitted]";
        report.findings.push({ kind: "dependency", source: pkg.source, fact: `${name}: ${range}`, interpretation: "Declared range only; installed versions and candidate import coverage are unknown.", certainty: "observed" });
      }
    }
  }
  const declaration = await read("trial-runner.setup.json", "SETUP");
  if (declaration) {
    try {
      const setup = setupDeclaration(declaration.value);
      for (const fact of ["agent: node-function/v1", "environment: reference-inventory/v1", `model capture: ${setup.agent.modelCapture}`, "dependencies: declared-files-only"]) {
        report.findings.push({ kind: "connection", source: declaration.source, fact, interpretation: "Operator declaration; compatibility and capture coverage require an explicit run and review.", certainty: "user_declared" });
      }
    } catch (error) { unresolved(error instanceof DiscoveryError ? error.code : "INVALID_SETUP", error instanceof DiscoveryError && error.detail ? discoveryMessage(error) : undefined); }
  }
  report.status = report.unresolved.length ? "blocked" : "declared";
  return contract<DiscoveryReport>("discovery", report);
}
export function compareInspection(prior: unknown, current: DiscoveryReport): void {
  try { contract("discovery", prior); } catch { return fail("INVALID_INSPECTION_REPORT"); }
  if (!isDeepStrictEqual(prior, current)) fail("STALE_INSPECTION_REPORT");
}
