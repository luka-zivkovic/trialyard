import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hash, jsonBytes } from "../core/files.js";
import { fail, publicJson, readPublic, record, repositoryRoot } from "../discovery/safe.js";
import { connectionContract, connectionPath, distinct, type SkillIdentity, type SkillManifest } from "./contracts.js";

const bundledRoot = fileURLToPath(new URL("../../../skills/connect-agent/", import.meta.url));
export async function loadSetupSkill(directory = bundledRoot) {
  const root = await repositoryRoot(directory);
  const bytes = await readPublic(root, "package.json");
  const manifest = connectionContract<SkillManifest>("skillManifest", publicJson(bytes));
  const names = ["package.json", manifest.entrypoint, ...manifest.references.map(r => r.path)];
  names.forEach(connectionPath); distinct(names); distinct(manifest.references.map(r => r.id));
  const files = new Map<string, Buffer>([["package.json", bytes]]);
  for (const name of names.slice(1)) {
    const content = await readPublic(root, name);
    try { new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { fail("INVALID_SKILL_TEXT"); }
    files.set(name, content);
  }
  const inventory = [...files].map(([name, content]) => record(name, content)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const identity: SkillIdentity = { id: manifest.id, version: manifest.version, sha256: hash(jsonBytes(inventory)) };
  return { manifest, identity, files, inventory };
}

// Metadata for a host's explicit tool dispatcher, not executable shell instructions.
export const setupTools = [
  { command: "inspect", effect: "read_public_manifests" },
  { command: "connect", effect: "write_new_connection" },
  { command: "rebuild", effect: "write_new_connection" },
  { command: "check-connection", effect: "read_connection" },
  { command: "check-integration", effect: "read_integration_records" },
  { command: "validate", effect: "read_plan" },
  { command: "run", effect: "execute_candidate_and_environment" },
  { command: "show", effect: "read_run" },
  { command: "verify", effect: "read_evidence" },
  { command: "export", effect: "write_export" },
] as const;

export async function setupSkillContext(referenceId?: string) {
  const skill = await loadSetupSkill();
  const selected = referenceId === undefined ? undefined : skill.manifest.references.find(r => r.id === referenceId);
  if (referenceId !== undefined && !selected) fail("UNKNOWN_SKILL_REFERENCE");
  const context = { schemaVersion: "trial-runner/skill-context/v1", identity: skill.identity,
    recipeSchemaVersion: skill.manifest.recipeSchemaVersion,
    instructions: skill.files.get(skill.manifest.entrypoint)!.toString("utf8"),
    availableReferences: skill.manifest.references,
    references: selected ? [{ id: selected.id, path: path.posix.join("skills/connect-agent", selected.path), content: skill.files.get(selected.path)!.toString("utf8") }] : [],
    tools: setupTools, execution: "not_run", assistant: "not_invoked" };
  return connectionContract<typeof context>("context", context);
}
