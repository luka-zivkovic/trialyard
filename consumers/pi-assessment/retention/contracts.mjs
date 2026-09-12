import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseJson, requireThat, safeRelative } from '../lib/io.mjs';
import { same, unique } from '../lib/contracts.mjs';

export const maximumBytes = 192 * 1024 * 1024;
export const expectedDigest = value => requireThat(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'EXPECTED_DIGEST_REQUIRED');
const validate = new Ajv2020({ strict: true }).compile(parseJson(readFileSync(new URL('./manifest.schema.json', import.meta.url))));

export function retentionFailure(code, detail) {
  return Object.assign(new Error(code), { retentionDetail: detail });
}

export function formatRetentionError(error) {
  const code = /^[A-Z][A-Z0-9_]{0,99}$/u.test(error?.message ?? '') ? error.message : error?.code === 'EEXIST' ? 'OUTPUT_ALREADY_EXISTS' : 'RETENTION_INPUT_UNAVAILABLE_OR_INVALID';
  const lines = [`Evidence retention: ${code}`];
  let detail;
  try { safeRelative(error?.retentionDetail?.path); detail = error.retentionDetail; } catch { /* Never print an unvalidated path or raw exception. */ }
  if (detail) {
    // JSON quoting plus ASCII escaping keeps paths inert in terminal output.
    const path = JSON.stringify(detail.path).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    lines.push(`File: ${path}`);
    if (detail.kind === 'missing') lines.push('Inventory: expected file is missing.');
    if (detail.kind === 'unlisted') lines.push('Inventory: file is not listed in the retained manifest.');
    if ([detail.expectedBytes, detail.actualBytes].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 16 * 1024 * 1024)) {
      lines.push(`Expected bytes: ${detail.expectedBytes}; observed bytes: ${detail.actualBytes}.`);
    }
  }
  if (code === 'RETENTION_FILE_DIGEST_MISMATCH' || code === 'RETENTION_FILE_INVENTORY_MISMATCH') {
    lines.push('Recover a package copy that verifies against the original archive digest, then verify again. Keep the expected digest unchanged.');
  } else if (detail) lines.push('Inspect the named file and recover a verified package copy if needed.');
  else lines.push('Use --help for syntax.');
  return lines.join('\n') + '\n';
}

export function validateManifest(value) {
  requireThat(validate(value), 'INVALID_RETENTION_MANIFEST');
  requireThat(Number.isFinite(Date.parse(value.createdAt)), 'INVALID_RETENTION_TIME');
  const paths = value.files.map(f => safeRelative(f.path));
  unique(paths, 'DUPLICATE_RETENTION_PATH');
  unique(paths.map(p => p.toLowerCase()), 'RETENTION_CASE_COLLISION');
  same(paths, [...paths].sort(), 'UNSORTED_RETENTION_FILES');
  requireThat(!paths.includes('retention.json'), 'SELF_RETENTION_INVENTORY');
  requireThat(value.files.reduce((total, f) => total + f.bytes, 0) <= maximumBytes, 'RETENTION_BYTE_LIMIT');
  unique(value.attempts.map(a => a.requestId), 'DUPLICATE_RETENTION_ATTEMPT');
  for (const [i, attempt] of value.attempts.entries()) {
    requireThat(attempt.retryOf === (i === 0 ? null : value.attempts[i - 1].requestId), 'BROKEN_RETENTION_ANCESTRY');
  }
  requireThat(value.head === value.attempts.at(-1).requestId, 'RETENTION_HEAD_MISMATCH');
  return value;
}
