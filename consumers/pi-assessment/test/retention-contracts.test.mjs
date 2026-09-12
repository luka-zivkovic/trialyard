import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, expectedDigest, retentionFailure, formatRetentionError } from '../retention/contracts.mjs';

function fixture() {
  const sha = 'a'.repeat(64), component = { id: 'example', version: '0.1.0', sha256: sha };
  return { schemaVersion: 'observation-consumer/retention/v1', createdAt: '2026-09-11T00:00:00.000Z', node: '24.15.0', consumer: component, criterion: component,
    source: { bundleSha256: sha, mappingSha256: sha }, head: 'second',
    attempts: [{ requestId: 'first', requestSha256: sha, assessmentSha256: sha, retryOf: null }, { requestId: 'second', requestSha256: sha, assessmentSha256: sha, retryOf: 'first' }],
    files: [{ path: 'mapping.json', bytes: 10, sha256: sha }] };
}
test('closed retention manifest accepts a complete linear ancestry', () => {
  assert.equal(validateManifest(fixture()).head, 'second');
  expectedDigest('a'.repeat(64));
});
test('retention contract rejects changed versions, unsafe paths and ambiguous ancestry', () => {
  const mutations = [
    v => { v.extra = true; }, v => { v.schemaVersion = 'observation-consumer/retention/v2'; },
    v => { v.files[0].path = '../outside'; }, v => { v.files[0].path = '/absolute'; },
    v => { v.files[0].path = 'source\\outside'; }, v => { v.files[0].path = 'retention.json'; },
    v => { v.files.push({ ...v.files[0] }); }, v => { v.files.unshift({ ...v.files[0], path: 'MAPPING.json' }); },
    v => { v.attempts.shift(); }, v => { v.attempts[1].requestId = 'first'; },
    v => { v.head = 'first'; }, v => { v.files[0].bytes = 16 * 1024 * 1024 + 1; },
    v => { v.createdAt = '2026-this-is-invalid-time'; }, v => { v.source.bundleSha256 = 'unknown'; },
    v => { v.files = Array.from({length: 13}, (_, i) => ({ ...v.files[0], path: `p${String(i).padStart(2, '0')}`, bytes: 16 * 1024 * 1024 })); }
  ];
  for (const mutate of mutations) { const value = fixture(); mutate(value); assert.throws(() => validateManifest(value)); }
  for (const value of [undefined, '', 'f'.repeat(63), 'F'.repeat(64), 123]) assert.throws(() => expectedDigest(value), /EXPECTED_DIGEST_REQUIRED/);
});

test('diagnostics quote valid paths and suppress unsafe paths, raw exceptions and content', () => {
  const output = formatRetentionError(retentionFailure('RETENTION_FILE_INVENTORY_MISMATCH', { path: 'source/a"b\u202e.json', kind: 'unlisted', contents: 'PRIVATE_CONTENT_MARKER' }));
  assert.match(output, /File: "source\/a\\"b\\u202e\.json"/);
  assert.doesNotMatch(output, /\u202e|PRIVATE_CONTENT_MARKER/u);
  for (const path of ['../escape', '/absolute', 'source/\x1b[31mhidden', 'source/line\nbreak']) {
    const diagnostic = formatRetentionError(retentionFailure('UNSAFE_PATH', { path }));
    assert.doesNotMatch(diagnostic, /File:/); assert.doesNotMatch(diagnostic, /\x1b/u);
  }
  assert.doesNotMatch(formatRetentionError(new Error('PRIVATE_CONTENT_MARKER /some/path')), /PRIVATE_CONTENT_MARKER|some\/path/);
});
