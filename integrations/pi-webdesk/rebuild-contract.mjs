import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { Ajv } from 'ajv';
import { parseJson } from '../../dist/src/contracts/strict-json.js';
import { connectionPath } from '../../dist/src/connection/contracts.js';
import { hash } from './package-contract.mjs';

export const STATE = 'pi-build-state.json', SELECTION = 'pi-selection.json', LINEAGE = 'pi-rebuild.json', PARENT = 'pi-parent-connection.json', PARENT_STATE = 'pi-parent-state.json';
export const runtimeOutputs = ['agent.js', 'environment.js', 'native-extension.mjs', 'policy.mjs', 'supervisor.mjs'];
const mutable = new Set([...runtimeOutputs, 'build.json', STATE, 'agent-artifact.json', 'environment-artifact.json', SELECTION, LINEAGE, PARENT, PARENT_STATE]);
export const sorted = rows => rows.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
export const json = bytes => parseJson(bytes, 2 * 1024 * 1024);
export const reject = code => { throw new Error(code); };
export function ordered(rows) {
  const keys = rows.map(r => r.path);
  if (new Set(keys.map(k => k.toLowerCase())).size !== keys.length || !isDeepStrictEqual(keys, [...keys].sort())) reject('INVALID_PI_INVENTORY');
}
export function relativePath(name) {
  if (name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').some(p => !p || p === '.' || p === '..')) reject('UNSAFE_PI_INPUT_PATH');
}
export function editableSource(name) {
  connectionPath(name);
  if (!/^packages\/pi-bridge\/(src|extensions)\/.+\.ts$/.test(name)) reject('UNSUPPORTED_PI_SOURCE');
}
export function sourceSnapshot(sources) {
  ordered(sources); let total = 0;
  for (const source of sources) {
    editableSource(source.path); const bytes = Buffer.from(source.content);
    if (bytes.length !== source.bytes || hash(bytes) !== source.sha256) reject('PI_SOURCE_CONTENT_MISMATCH');
    total += bytes.length;
  }
  if (total > 1024 * 1024) reject('PI_SOURCE_LIMIT');
  return sources;
}
const ajv = new Ajv({ strict: true }); ajv.addSchema(json(readFileSync(new URL('./rebuild.schema.json', import.meta.url))), 'pi-rebuild');
const validators = Object.fromEntries(['state','selection','lineage'].map(name => [name,ajv.compile({ $ref: `pi-rebuild#/$defs/${name}` })]));
export function rebuildContract(name, value) {
  if (!validators[name]?.(value)) reject('INVALID_PI_REBUILD_RECORD');
  if (value.sources) sourceSnapshot(value.sources);
  if (name === 'state') {
    ordered(value.tooling); value.tooling.forEach(f => connectionPath(f.path));
    ordered(value.fixedInputs.map(f => ({path:`${f.root}/${f.path}`})));
    value.fixedInputs.forEach(f => relativePath(f.path));
    if (value.fixedInputs.some(f => f.root === 'webdesk' && value.sources.some(s => s.path === f.path))) reject('PI_SOURCE_IS_FIXED_INPUT');
  }
  if (name === 'lineage') {
    ordered(value.sourceChanges); ordered(value.preservedFiles);
    value.preservedFiles.forEach(f => connectionPath(f.path));
    value.sourceChanges.forEach(f => { editableSource(f.path); if (f.before === f.after) reject('EMPTY_PI_SOURCE_CHANGE'); });
  }
  return value;
}
export function sourceChanges(before, after) {
  if (!isDeepStrictEqual(before.map(f => f.path), after.map(f => f.path))) reject('PI_SOURCE_INVENTORY_CHANGED');
  return after.flatMap((f,i) => f.sha256 === before[i].sha256 ? [] : [{path:f.path,before:before[i].sha256,after:f.sha256}]);
}
export function selectContract(value, parent, digest) {
  const selection = rebuildContract('selection', value);
  if (selection.parentRecipeSha256 !== digest) reject('PI_REBUILD_PARENT_MISMATCH');
  sourceChanges(parent.sources, selection.sources); return selection;
}
export const preserved = recipe => recipe.files.filter(f => !mutable.has(f.path));
export function assertContinuity(parent, current) {
  sourceChanges(parent.sources, current.sources);
  for (const key of ['compiler','tooling','fixedInputs','runtimeSha256','graphSha256']) if (!isDeepStrictEqual(parent[key],current[key])) reject(`PI_REBUILD_${key.toUpperCase()}_CHANGED`);
}
