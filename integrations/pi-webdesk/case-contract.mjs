import { Ajv } from 'ajv';
import { isDeepStrictEqual } from 'node:util';
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const text = { type: 'string', minLength: 1, maxLength: 4096 }, id = { type: 'string', minLength: 1, maxLength: 80 };
const tool = { enum: ['read', 'write', 'edit'] };
export const caseSchema = object({
  schemaVersion: { const: 'pi-webdesk/case/v1' }, id, description: text,
  initialFiles: { type: 'object' }, allowedFiles: { type: 'array', items: id, minItems: 1, maxItems: 16 },
  allowedTools: { type: 'array', items: tool, minItems: 1, maxItems: 3 },
  turns: { type: 'array', minItems: 1, maxItems: 10, items: object({ id, content: text }) },
  provenance: object({ origin: text, exposure: text }),
  externalCriterionRefs: { type: 'array', maxItems: 8, items: text },
  provider: object({ kind: { const: 'scripted-v1' }, turns: { type: 'array', minItems: 1, maxItems: 10, items: object({
    id, steps: { type: 'array', maxItems: 20, items: object({ id, name: tool, arguments: { type: 'object' }, expectError: { type: 'boolean' } }) }, finalText: text,
  }) } }),
});
const check = new Ajv({ strict: true }).compile(caseSchema);
const fail = code => { throw new Error(code); };
const unique = values => new Set(values).size === values.length;
const filename = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value);
const exact = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value) && required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k));

// Capability admission deliberately does not consult the scripted trajectory.
export function admitCaseCall(definition, name, input) {
  if (!definition.allowedTools.includes(name) || !definition.allowedFiles.includes(input?.path) || !filename(input?.path)) fail('PI_CASE_TOOL_OUTSIDE_CAPABILITY');
  const content = x => typeof x === 'string' && Buffer.byteLength(x) <= 65536;
  let valid = false;
  if (name === 'read') valid = exact(input, ['path'], ['offset', 'limit']) && ['offset', 'limit'].every(k => input[k] === undefined || (Number.isInteger(input[k]) && input[k] > 0 && input[k] <= 10000));
  if (name === 'write') valid = exact(input, ['path', 'content']) && content(input.content);
  if (name === 'edit') valid = exact(input, ['path', 'edits']) && Array.isArray(input.edits) && input.edits.length > 0 && input.edits.length <= 8 && input.edits.every(e => exact(e, ['oldText', 'newText']) && content(e.oldText) && e.oldText.length > 0 && content(e.newText));
  if (!valid) fail('PI_CASE_TOOL_ARGUMENTS');
}
export function caseContract(value) {
  if (!check(value)) fail('INVALID_PI_CASE');
  const nativeId = v => typeof v === 'string' && v.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(v);
  if (!filename(value.id) || !unique(value.allowedFiles) || !value.allowedFiles.every(filename) || !unique(value.allowedTools) || !unique(value.turns.map(t => t.id))) fail('INVALID_PI_CASE_IDENTITIES');
  if (!value.turns.every(t => nativeId(t.id)) || !nativeId(value.provenance.origin) || !nativeId(value.provenance.exposure) || !unique(value.externalCriterionRefs)) fail('INVALID_PI_CASE_NATIVE_MAPPING');
  if (!isDeepStrictEqual(value.turns.map(t => t.id), value.provider.turns.map(t => t.id))) fail('PI_CASE_TURN_MISMATCH');
  if (Object.keys(value.initialFiles).length > 16 || Object.entries(value.initialFiles).some(([name, content]) => !value.allowedFiles.includes(name) || !filename(name) || typeof content !== 'string' || Buffer.byteLength(content) > 65536)) fail('INVALID_PI_CASE_FILES');
  const calls = value.provider.turns.flatMap(t => t.steps);
  if (calls.length > 40 || !unique(calls.map(c => c.id))) fail('INVALID_PI_CASE_CALL_IDENTITIES');
  for (const call of calls) admitCaseCall(value, call.name, call.arguments);
  return value;
}

// An interchange owned by this integration, NOT a native Scenario JSON format.
export function toDialogue(definition) {
  caseContract(definition);
  return { schemaVersion: 'trial-runner/static-dialogue/v1', id: definition.id, description: definition.description,
    steps: definition.turns.flatMap(t => [{ kind: 'user', id: t.id, content: t.content }, { kind: 'agent' }]) };
}
export function fromDialogue(value) {
  if (!exact(value, ['schemaVersion', 'id', 'description', 'steps']) || value.schemaVersion !== 'trial-runner/static-dialogue/v1' || !filename(value.id) || typeof value.description !== 'string' || !value.description.length || !Array.isArray(value.steps) || value.steps.length < 2 || value.steps.length > 20 || value.steps.length % 2) fail('UNSUPPORTED_STATIC_DIALOGUE');
  const turns = [];
  for (let i = 0; i < value.steps.length; i += 2) {
    const user = value.steps[i], agent = value.steps[i + 1];
    if (!exact(user, ['kind', 'id', 'content']) || user.kind !== 'user' || typeof user.id !== 'string' || !user.id.length || typeof user.content !== 'string' || !user.content.length || user.content.length > 4096 || !exact(agent, ['kind']) || agent.kind !== 'agent') fail('UNSUPPORTED_STATIC_DIALOGUE_STEP');
    turns.push({ id: user.id, content: user.content });
  }
  if (!unique(turns.map(t => t.id))) fail('DUPLICATE_STATIC_TURN');
  return turns;
}
