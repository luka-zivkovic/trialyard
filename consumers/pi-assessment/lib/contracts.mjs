import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { isDeepStrictEqual } from 'node:util';
import { parseJson, hash, requireThat } from './io.mjs';

const ajv = new Ajv2020({ strict: true, validateFormats: false });
const rawNative = readFileSync(new URL('../vendor/trial-runner-v1.schema.json', import.meta.url));
requireThat(hash(rawNative) === 'f83736e3e5c5c5b5f963644889e699cc03e1f3c560da5ea94c15598e16cddf2b', 'PRODUCER_SCHEMA_CHANGED');
ajv.addSchema(parseJson(rawNative), 'native');
ajv.addSchema(parseJson(readFileSync(new URL('../contracts/assessment.schema.json', import.meta.url))), 'consumer');
const compiled = new Map();
export function shape(name, value, namespace = 'consumer') {
  const ref = `${namespace}#/$defs/${name}`;
  if (!compiled.has(ref)) compiled.set(ref, ajv.compile({ $ref: ref }));
  requireThat(compiled.get(ref)(value), `INVALID_${name.toUpperCase()}`);
  return value;
}
export function same(a, b, code) { requireThat(isDeepStrictEqual(a, b), code); }
export function unique(items, code) { requireThat(items.length === new Set(items).size, code); }
export function validateReceipt(record) {
  shape('receipt', record);
  requireThat(Number.isFinite(Date.parse(record.startedAt)) && Number.isFinite(Date.parse(record.finishedAt)) && Date.parse(record.finishedAt) >= Date.parse(record.startedAt), 'INVALID_ASSESSMENT_TIME');
  if (record.execution === 'completed') requireThat(record.verification === 'accepted' && record.native !== null && record.result !== null && record.errorCode === null, 'INVALID_COMPLETED_ASSESSMENT');
  else requireThat(record.result === null && record.errorCode !== null, 'FAILED_ASSESSMENT_HAS_JUDGMENT');
  if (record.execution === 'rejected') requireThat(record.verification === 'rejected', 'INVALID_REJECTION');
  if (record.verification !== 'accepted') requireThat(record.native === null, 'UNVERIFIED_NATIVE_STATUS');
  return record;
}
