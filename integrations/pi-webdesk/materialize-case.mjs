import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConnection, verifyConnectionContents } from '../../dist/src/connection/recipe.js';
import { recipeContract } from '../../dist/src/connection/contracts.js';
import { parseJson } from '../../dist/src/contracts/strict-json.js';
import { resolvePlan } from '../../dist/src/core/plan.js';
import { jsonBytes } from '../../dist/src/core/files.js';
import { newDestination, readPublic, record } from '../../dist/src/discovery/safe.js';
import { hash } from './package-contract.mjs';
import { caseContract, toDialogue } from './case-contract.mjs';

export async function materializeCase(connection, caseFile, destination, expectedDigest) {
  const parent = await loadConnection(connection, expectedDigest);
  if (parent.recipe.id !== 'pi-webdesk-native-scripted') throw new Error('UNSUPPORTED_PI_CASE_PARENT');
  const schema = parseJson(parent.files.get('fixture.schema.json'));
  if (!schema.anyOf?.some(s => s.properties?.case?.const === 'declared-v1')) throw new Error('PI_CASE_REQUIRES_UPDATED_NATIVE_BUILD');
  const bytes = await readPublic(dirname(resolve(caseFile)), basename(caseFile), 2 * 1024 * 1024), definition = caseContract(parseJson(bytes));
  const out = await newDestination(parent.root, destination);
  await newDestination(dirname(resolve(caseFile)), out);
  const entries = new Map(parent.files);
  entries.delete('connection.json');
  const add = (name, value) => { if (entries.has(name)) throw new Error('PI_CASE_OUTPUT_COLLISION'); entries.set(name, jsonBytes(value)); };
  add('case-source.json', definition);
  // Retain the original input bytes as well as the normalized definition.
  entries.set('case-input.json', bytes);
  add('case-dialogue.json', toDialogue(definition));
  add('case-lineage.json', { schemaVersion: 'pi-webdesk/case-lineage/v1', parentRecipeSha256: hash(parent.bytes), caseSha256: hash(bytes), execution: 'not_run' });
  entries.set('case-parent.json', parent.bytes);
  add('case-fixture.json', { case: 'declared-v1', definition, files: definition.initialFiles, session: null, observations: [], runtime: {} });
  add('case-scenario.json', { schemaVersion: 'trial-runner/scenario/v1', id: definition.id, description: definition.description, messages: definition.turns.map(t => ({ ...t, role: 'user' })), provenance: { ...definition.provenance, origin: `case-sha256:${hash(bytes)}` }, externalCriterionRefs: definition.externalCriterionRefs });
  const plan = parseJson(entries.get(parent.recipe.plan.path));
  plan.id = definition.id; plan.environment.initialState = 'case-fixture.json'; plan.scenarios = [{ path: 'case-scenario.json' }]; plan.repetitions = 2; plan.limits.maxTurns = definition.turns.length;
  add('case-plan.json', plan);
  for (const role of ['agent', 'environment']) {
    const artifact = parseJson(entries.get(`${role}-artifact.json`));
    artifact.files.push(...['case-input.json', 'case-dialogue.json', 'case-lineage.json'].map(name => record(name, entries.get(name))));
    artifact.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    entries.set(`${role}-artifact.json`, jsonBytes(artifact));
  }
  await mkdir(out, { mode: 0o700 });
  for (const [name, data] of entries) { await mkdir(dirname(join(out, name)), { recursive: true }); await writeFile(join(out, name), data, { flag: 'wx', mode: 0o600 }); }
  const resolved = await resolvePlan(join(out, 'case-plan.json'));
  const recipe = recipeContract({ schemaVersion: 'trial-runner/connection-recipe/v1', id: 'pi-webdesk-declared-case-v1', method: 'prepared-plan/v1', skill: null, sources: parent.recipe.sources,
    files: [...entries].map(([name, data]) => record(name, data)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    plan: { path: 'case-plan.json', inputSha256: resolved.inputSha256 }, requirements: [] });
  await verifyConnectionContents(out, recipe);
  // Recheck both inputs before publishing the new connection.
  await loadConnection(connection, hash(parent.bytes));
  if (hash(await readPublic(dirname(resolve(caseFile)), basename(caseFile), 2 * 1024 * 1024)) !== hash(bytes)) throw new Error('PI_CASE_CHANGED_DURING_MATERIALIZATION');
  const encoded = jsonBytes(recipe); await writeFile(join(out, 'connection.json'), encoded, { flag: 'wx', mode: 0o600 });
  return { connection: join(out, 'connection.json'), recipeSha256: hash(encoded), plan: join(out, 'case-plan.json'), caseSha256: hash(bytes), adapterSourceEdits: 0, applicationSourceEdits: 0, execution: 'not_run' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [connection, caseFile, out, digest] = process.argv.slice(2);
    if (!connection || !caseFile || !out || process.argv.length > 6) throw new Error('Usage: node materialize-case.mjs <connection.json> <case.json> <new-directory> [parent-sha256]');
    process.stdout.write(JSON.stringify(await materializeCase(connection, caseFile, out, digest), null, 2) + '\n');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
