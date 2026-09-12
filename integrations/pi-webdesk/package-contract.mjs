import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { Ajv } from 'ajv';
import { object } from './native-contract.mjs';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const path = { type: 'string', minLength: 1, maxLength: 4096 };
export const packageRecordSchema = { anyOf: [
  object({ kind: { const: 'file' }, path, mode: { enum: [420, 493] }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, data: { type: 'string', maxLength: 33554432 } }),
  object({ kind: { const: 'link' }, path, target: path }),
] };
const valid = new Ajv({ strict: true }).compile(packageRecordSchema);
export function safePackagePath(path) {
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(s => !s || s === '.' || s === '..')) throw new Error('UNSAFE_PACKAGE_PATH');
  return path;
}
export function validatePackage(records) {
  if (!Array.isArray(records) || !records.length || records.length > 25000) throw new Error('PACKAGE_RECORD_LIMIT');
  const paths = new Map(), links = new Map(); let bytes = 0;
  for (const record of records) {
    if (!valid(record)) throw new Error('INVALID_PACKAGE_RECORD');
    safePackagePath(record.path);
    if (paths.has(record.path)) throw new Error('DUPLICATE_PACKAGE_PATH');
    paths.set(record.path, record.kind);
    if (record.kind === 'file') {
      const data = Buffer.from(record.data, 'base64'); bytes += data.length;
      if (data.toString('base64') !== record.data || hash(data) !== record.sha256 || bytes > 150 * 1024 * 1024) throw new Error('INVALID_PACKAGE_CONTENT');
    } else {
      if (record.target.startsWith('/') || record.target.includes('\\') || record.target.includes('\0')) throw new Error('UNSAFE_PACKAGE_LINK');
      const target = posix.normalize(posix.join(posix.dirname(record.path), record.target));
      safePackagePath(target); links.set(record.path, target);
    }
  }
  for (const path of paths.keys()) {
    let parent = posix.dirname(path);
    while (parent !== '.') { if (paths.has(parent)) throw new Error('PACKAGE_FILE_OR_LINK_ANCESTOR'); parent = posix.dirname(parent); }
  }
  for (const [path, target] of links) {
    if (links.has(target) || (!paths.has(target) && ![...paths.keys()].some(p => p.startsWith(target + '/')))) throw new Error('UNRESOLVED_PACKAGE_LINK');
    if (path === target || target.startsWith(path + '/')) throw new Error('CYCLIC_PACKAGE_LINK');
  }
  return { records: records.length, files: records.filter(r => r.kind === 'file').length, links: links.size, bytes };
}
