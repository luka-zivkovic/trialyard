import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ValidateFunction } from "ajv";
import { contract, assertUnique, dataValidator, safeRelative } from "../contracts/validate.js";
import { parseJson } from "../contracts/strict-json.js";
import type { Adapter, Artifact, Json, Plan, Profile, Scenario, ToolDefinition } from "../contracts/types.js";
import { hash, jsonBytes, safeFile } from "./files.js";
import { validateSecretBindings } from "./privacy.js";

export interface ResolvedPlan {
  root: string; plan: Plan; profile: Profile; files: Map<string, Buffer>; inputSha256: string;
  planBytes: Buffer; scenarios: { scenario: Scenario; bytes: Buffer; fixture: Json; fixtureBytes: Buffer }[];
  artifacts: Record<"agent" | "environment", { value: Artifact; bytes: Buffer }>;
  tools: ToolDefinition[]; toolInputs: Map<string, ValidateFunction>; toolOutputs: Map<string, ValidateFunction>;
  fixtureValidator: ValidateFunction;
}

export const AGENT_CAPABILITIES = ["scripted-turns", "routed-tools", "conversation-events"];
export const ENV_CAPABILITIES = ["fresh-lease", "state-snapshot", "routed-tools", "verified-cleanup"];

export function capabilities(actual: string[], required: string[], label: string): void {
  assertUnique(actual, `${label} capability`);
  for (const capability of required) if (!actual.includes(capability)) throw new Error(`${label} missing capability: ${capability}`);
}

/** Static declaration checks only. No adapter is imported or executed here. */
export async function resolvePlan(filename: string, allowedFiles?: ReadonlySet<string>): Promise<ResolvedPlan> {
  const root = path.dirname(path.resolve(filename));
  const files = new Map<string, Buffer>();
  let total = 0;
  const read = async (name: string, max = 2 * 1024 * 1024): Promise<Buffer> => {
    if (allowedFiles && !allowedFiles.has(name)) throw new Error("Plan references a file outside the connection inventory");
    const previous = files.get(name);
    if (previous) return previous;
    const bytes = await safeFile(root, name, max);
    total += bytes.length;
    if (files.size >= 900 || total > 64 * 1024 * 1024) throw new Error("Resolved input limit exceeded");
    files.set(name, bytes); return bytes;
  };
  const planBytes = await read(path.basename(filename));
  const validated = await validatePlanInputs(planBytes, read);
  const inventory = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
  return { root, files, inputSha256: hash(jsonBytes(inventory)), ...validated };
}

/** The same declaration invariants apply before execution and to retained evidence.
 * Callers supply bounded, root-confined reads; this never loads an adapter. */
export async function validatePlanInputs(planBytes: Buffer, read: (name: string, max?: number) => Promise<Buffer>):
Promise<Omit<ResolvedPlan, "root" | "files" | "inputSha256">> {
  const json = async (name: string): Promise<unknown> => parseJson(await read(name));
  const plan = contract<Plan>("plan", parseJson(planBytes));
  const profile = contract<Profile>("profile", await json(plan.evidenceProfile));
  if (profile.required.stableFinalState && !profile.required.finalState) throw new Error("Stable final state requires final-state capture");
  if (profile.required.modelUsage && profile.modelCapture === "not_applicable") throw new Error("Model usage requires model capture");
  if (profile.modelCapture !== "not_applicable") capabilities(plan.agent.capabilities, [`model-${profile.modelCapture}`], "agent model capture");
  if (!profile.modelCaptureReason.trim()) throw new Error("Model capture declaration needs a reason");
  assertUnique(plan.scenarios.map(item => item.path), "scenario path");
  assertUnique(plan.secretBindings.map(item => item.name), "secret binding name");
  validateSecretBindings(plan.secretBindings);
  const artifacts = {} as ResolvedPlan["artifacts"];
  for (const role of ["agent", "environment"] as const) {
    const adapter = plan[role];
    safeRelative(adapter.cwd, true);
    capabilities(adapter.capabilities, role === "agent" ? AGENT_CAPABILITIES : ENV_CAPABILITIES, role);
    validateCommand(adapter);
    const settingsValidator = dataValidator(await json(adapter.settingsSchema));
    if (!settingsValidator(adapter.settings)) throw new Error(`Invalid ${role} settings`);
    const bytes = await read(adapter.artifactManifest);
    const artifact = contract<Artifact>("artifact", parseJson(bytes));
    assertUnique(artifact.files.map(file => file.path), `${role} artifact path`);
    for (const file of artifact.files) {
      const content = await read(file.path, 16 * 1024 * 1024);
      if (content.length !== file.bytes || hash(content) !== file.sha256) throw new Error(`${role} artifact digest mismatch`);
    }
    const entry = adapter.cwd === "." ? adapter.argv[1]! : `${adapter.cwd}/${adapter.argv[1]!}`;
    if (!artifact.files.some(file => file.path === entry)) throw new Error(`${role} entrypoint is not pinned`);
    artifacts[role] = { value: artifact, bytes };
  }
  const fixtureValidator = dataValidator(await json(plan.environment.fixtureSchema));
  const tools = contract<ToolDefinition[]>("tools", await json(plan.environment.toolSchemas));
  assertUnique(tools.map(tool => tool.name), "tool name");
  const toolInputs = new Map<string, ValidateFunction>();
  const toolOutputs = new Map<string, ValidateFunction>();
  for (const tool of tools) { toolInputs.set(tool.name, dataValidator(tool.input)); toolOutputs.set(tool.name, dataValidator(tool.output)); }
  const env = plan.environment;
  if ((env.clock.mode === "frozen") !== (env.clock.instant !== null) || (env.clock.instant !== null && !Number.isFinite(Date.parse(env.clock.instant)))) throw new Error("Invalid clock declaration");
  assertUnique(env.faultPlan.map(fault => `${fault.tool}:${fault.invocation}`), "fault location");
  for (const fault of env.faultPlan) if (!toolInputs.has(fault.tool)) throw new Error("Fault targets undeclared tool");
  // Validate the default even if every scenario overrides it: no latent malformed references.
  if (!fixtureValidator(await json(env.initialState))) throw new Error("Invalid default fixture");
  const scenarios: ResolvedPlan["scenarios"] = [];
  for (const ref of plan.scenarios) {
    const bytes = await read(ref.path);
    const scenario = contract<Scenario>("scenario", parseJson(bytes));
    assertUnique(scenario.messages.map(message => message.id), "turn ID");
    assertUnique(scenario.externalCriterionRefs, "criterion reference");
    if (scenario.messages.length > plan.limits.maxTurns) throw new Error("Scenario exceeds turn limit");
    const fixtureBytes = await read(scenario.fixture ?? env.initialState);
    const fixture = parseJson(fixtureBytes) as Json;
    if (!fixtureValidator(fixture)) throw new Error("Invalid scenario fixture");
    scenarios.push({ scenario, bytes, fixture, fixtureBytes });
  }
  assertUnique(scenarios.map(item => item.scenario.id), "scenario ID");
  return { plan, profile, planBytes, scenarios, artifacts, tools, toolInputs, toolOutputs, fixtureValidator };
}

function validateCommand(adapter: Adapter): void {
  if (adapter.argv.length !== 2 || adapter.argv[0] !== "node") throw new Error("Preview adapters require argv [node, relative-entrypoint.js]");
  safeRelative(adapter.argv[1]!);
  if (!adapter.argv[1]!.endsWith(".js")) throw new Error("Adapter entrypoint must be JavaScript");
}

export function sameTools(actual: unknown, expected: ToolDefinition[]): void {
  contract("tools", actual);
  if (!isDeepStrictEqual(actual, expected)) throw new Error("Effective tool schemas differ from pinned declaration");
}
