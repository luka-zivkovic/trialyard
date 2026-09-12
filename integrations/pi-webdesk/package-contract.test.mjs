import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hash, validatePackage } from './package-contract.mjs';
const file = (path = 'pkg/a.js') => ({ kind: 'file', path, mode: 420, sha256: hash('hello'), data: Buffer.from('hello').toString('base64') });
test('package contract accepts exact bytes and contained dependency links', () => {
  assert.deepEqual(validatePackage([file(), { kind: 'link', path: 'deps/pkg', target: '../pkg' }]), { records: 2, files: 1, links: 1, bytes: 5 });
});
for (const [name, records] of [
  ['traversal', [file('../escape')]], ['absolute path', [file('/escape')]],
  ['duplicate path', [file(), file()]], ['changed bytes', [{ ...file(), data: 'YmFk' }]],
  ['absolute link', [file(), { kind: 'link', path: 'deps/pkg', target: '/tmp/pkg' }]],
  ['escaping link', [file(), { kind: 'link', path: 'deps/pkg', target: '../../pkg' }]],
  ['file below link', [file('dep/a'), { kind: 'link', path: 'dep', target: 'pkg' }, file()]],
  ['dangling link', [file(), { kind: 'link', path: 'deps/pkg', target: '../missing' }]],
  ['link cycle', [{ kind: 'link', path: 'a', target: 'b' }, { kind: 'link', path: 'b', target: 'a' }]],
]) test(`rejects ${name} before package extraction`, () => assert.throws(() => validatePackage(records)));
