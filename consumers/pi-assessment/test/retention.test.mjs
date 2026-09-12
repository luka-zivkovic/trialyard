import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packArchive, verifyArchive } from '../retention/archive.mjs';
import { prepareRequest, assessRequest, readAttempt } from '../lib/assessment.mjs';
import { encode, hash } from '../lib/io.mjs';
import { verifyFiles, mappingFor } from '../lib/native.mjs';
import { nativeFixture } from './native-fixture.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'consumer-retention-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const origin = join(root, 'origin'), bundle = join(origin, 'bundle'), files = nativeFixture();
  for (const [path, bytes] of files) { await fs.mkdir(dirname(join(bundle, path)), { recursive: true }); await fs.writeFile(join(bundle, path), bytes); }
  const digest = hash(files.get('manifest.json')), mapping = join(origin, 'mapping.json');
  await fs.writeFile(mapping, encode(mappingFor(verifyFiles(files, digest))));
  const request = await prepareRequest(bundle, digest, mapping, join(origin, 'request')), store = join(origin, 'store');
  const result = await assessRequest(request.request, store, 'first');
  return { root, origin, bundle, files, digest, request: request.request, store, result, out: join(root, 'archive') };
}
async function reseal(out, change) {
  const file = join(out, 'retention.json'), manifest = JSON.parse(await fs.readFile(file));
  await change(manifest);
  for (const entry of manifest.files) { const raw = await fs.readFile(join(out, entry.path)); entry.bytes = raw.length; entry.sha256 = hash(raw); }
  const bytes = encode(manifest); await fs.writeFile(file, bytes); return hash(bytes);
}

test('portable runtime inspects and reassesses after the disposable original source disappears', async t => {
  const f = await fixture(t), packed = await packArchive(f.store, 'first', f.result.sha256, f.out);
  assert.equal(packed.execution, 'not_run');
  const originalRequest = await fs.readFile(f.request), originalAssessment = await fs.readFile(f.result.path);
  const moved = join(f.root, 'moved'); await fs.rename(f.out, moved);
  await fs.rm(f.origin, { recursive: true }); // Only test-owned input; never application evidence.
  const verified = await verifyArchive(moved, packed.sha256);
  assert.equal(verified.source.bundleSha256, f.digest);
  assert.deepEqual(await fs.readFile(join(moved, 'assessments/first/request.json')), originalRequest);
  assert.deepEqual(await fs.readFile(join(moved, 'assessments/first/assessment.json')), originalAssessment);
  const cli = join(moved, 'consumer/cli.mjs'), opts = { cwd: f.root, timeout: 20000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' } };
  const identity = JSON.parse((await exec(process.execPath, [cli, 'identity'], opts)).stdout);
  assert.deepEqual(identity.consumer, packed.consumer);
  const shown = JSON.parse((await exec(process.execPath, [cli, 'show', 'first', '--store', verified.paths.store, '--sha256', f.result.sha256], opts)).stdout);
  assert.equal(shown.result.result.judgment, 'not_applicable');
  const prepared = JSON.parse((await exec(process.execPath, [cli, 'prepare', verified.paths.bundle, '--sha256', f.digest, '--mapping', verified.paths.mapping, '--out', join(f.root, 'new-request')], opts)).stdout);
  const assessed = JSON.parse((await exec(process.execPath, [cli, 'assess', prepared.request, '--request', 'new', '--store', join(f.root, 'new-store')], opts)).stdout);
  assert.equal(assessed.result.result.judgment, 'not_applicable');
  assert.deepEqual(assessed.result.source, f.result.result.source);
  assert.notEqual(assessed.requestSha256, f.result.requestSha256);
  assert.equal(assessed.result.retryOf, null);
  assert.equal((await verifyArchive(moved, packed.sha256)).sha256, packed.sha256);
});

test('archive retains the complete failed-assessor retry ancestry without changing either attempt', async t => {
  const f = await fixture(t), crash = join(f.root, 'crash.mjs'); await fs.writeFile(crash, 'process.exit(7);');
  const failed = await assessRequest(f.request, f.store, 'failed', { workerOptions: { workerFile: crash } });
  const retry = await assessRequest(f.request, f.store, 'retry', { retryOf: 'failed' });
  const packed = await packArchive(f.store, 'retry', retry.sha256, f.out);
  assert.deepEqual(packed.attempts.map(a => [a.requestId, a.execution, a.judgment]), [['failed', 'failed', null], ['retry', 'completed', 'not_applicable']]);
  assert.equal((await readAttempt(packed.paths.store, 'failed')).sha256, failed.sha256);
  const digest = await reseal(f.out, m => { m.attempts.shift(); });
  await assert.rejects(() => verifyArchive(f.out, digest), /BROKEN_RETENTION_ANCESTRY/);
});

test('packing requires external expected identity, retained source and a new output directory', async t => {
  const f = await fixture(t);
  await assert.rejects(() => packArchive(f.store, 'first', undefined, f.out), /EXPECTED_DIGEST_REQUIRED/);
  await assert.rejects(() => packArchive(f.store, 'first', 'f'.repeat(64), f.out), /ASSESSMENT_DIGEST_MISMATCH/);
  await fs.mkdir(f.out); await fs.writeFile(join(f.out, 'owned.txt'), 'keep');
  await assert.rejects(() => packArchive(f.store, 'first', f.result.sha256, f.out), { code: 'EEXIST' });
  assert.equal(await fs.readFile(join(f.out, 'owned.txt'), 'utf8'), 'keep');
  await fs.rm(f.bundle, { recursive: true });
  await assert.rejects(() => packArchive(f.store, 'first', f.result.sha256, join(f.root, 'absent-source')));
  await assert.rejects(() => fs.stat(join(f.root, 'absent-source')), { code: 'ENOENT' });
});

test('interrupted and rejected-source attempts are not represented as replayable archives', async t => {
  const f = await fixture(t);
  await fs.rename(f.result.path, join(f.origin, 'retained-assessment.json'));
  await assert.rejects(() => packArchive(f.store, 'first', f.result.sha256, f.out), /RETENTION_ATTEMPT_UNFINISHED/);
  await fs.writeFile(join(f.bundle, 'final-state.json'), '{}');
  const rejected = await assessRequest(f.request, f.store, 'rejected');
  await assert.rejects(() => packArchive(f.store, 'rejected', rejected.sha256, f.out), /RETENTION_UNVERIFIED_SOURCE_UNSUPPORTED/);
  await assert.rejects(() => fs.stat(f.out), { code: 'ENOENT' });
});

test('verification rejects wrong digest, altered, missing, extra, symlinked and hardlinked files', async t => {
  const f = await fixture(t), packed = await packArchive(f.store, 'first', f.result.sha256, f.out);
  await assert.rejects(() => verifyArchive(f.out, 'f'.repeat(64)), /RETENTION_DIGEST_MISMATCH/);
  const mapping = join(f.out, 'mapping.json'), raw = await fs.readFile(mapping);
  await fs.writeFile(mapping, Buffer.from(raw).fill(32));
  await assert.rejects(() => verifyArchive(f.out, packed.sha256), /RETENTION_FILE_DIGEST_MISMATCH/);
  await fs.unlink(mapping);
  await assert.rejects(() => verifyArchive(f.out, packed.sha256), /RETENTION_FILE_INVENTORY_MISMATCH/);
  const outside = join(f.root, 'mapping.json'); await fs.writeFile(outside, raw); await fs.symlink(outside, mapping);
  await assert.rejects(() => verifyArchive(f.out, packed.sha256), /UNSAFE_FILE/);
  await fs.unlink(mapping); await fs.link(outside, mapping);
  await assert.rejects(() => verifyArchive(f.out, packed.sha256), /UNSAFE_FILE/);
  await fs.unlink(mapping); await fs.writeFile(mapping, raw);
  await fs.writeFile(join(f.out, 'extra'), 'unexpected');
  await assert.rejects(() => verifyArchive(f.out, packed.sha256), /RETENTION_FILE_INVENTORY_MISMATCH/);
  await fs.unlink(join(f.out, 'extra'));
  await fs.rename(join(f.out, 'source'), join(f.root, 'source')); await fs.symlink(join(f.root, 'source'), join(f.out, 'source'));
  await assert.rejects(() => verifyArchive(f.out, packed.sha256), /UNSAFE_FILE/);
});

test('re-inventorying altered consumer code does not make it the pinned implementation', async t => {
  const f = await fixture(t); await packArchive(f.store, 'first', f.result.sha256, f.out);
  const digest = await reseal(f.out, async () => { await fs.appendFile(join(f.out, 'consumer/worker.mjs'), '\nthrow new Error("must not execute");\n'); });
  await assert.rejects(() => verifyArchive(f.out, digest), /RETENTION_CONSUMER_BYTES_MISMATCH/);
});

test('matching outer digests cannot silently upgrade the original native state', async t => {
  const f = await fixture(t); await packArchive(f.store, 'first', f.result.sha256, f.out);
  const digest = await reseal(f.out, async m => {
    const path = join(f.out, 'assessments/first/assessment.json'), record = JSON.parse(await fs.readFile(path));
    record.native.evidence = 'incomplete'; const bytes = encode(record); await fs.writeFile(path, bytes); m.attempts[0].assessmentSha256 = hash(bytes);
  });
  await assert.rejects(() => verifyArchive(f.out, digest), /RETENTION_NATIVE_STATE_MISMATCH/);
});

test('retention rejects detached mapping and assessment observation references even after outer resealing', async t => {
  const f = await fixture(t); await packArchive(f.store, 'first', f.result.sha256, f.out);
  const mappingPath = join(f.out, 'mapping.json'), mappingBytes = await fs.readFile(mappingPath);
  let digest = await reseal(f.out, async m => {
    const mapping = JSON.parse(mappingBytes); mapping.trialId = 'swapped'; const bytes = encode(mapping);
    await fs.writeFile(mappingPath, bytes); m.source.mappingSha256 = hash(bytes);
  });
  await assert.rejects(() => verifyArchive(f.out, digest), /MAPPING_MISMATCH/);
  digest = await reseal(f.out, async m => {
    await fs.writeFile(mappingPath, mappingBytes); m.source.mappingSha256 = hash(mappingBytes);
    const path = join(f.out, 'assessments/first/assessment.json'), record = JSON.parse(await fs.readFile(path));
    record.result.observations = [{path: 'events.ndjson', sha256: 'f'.repeat(64), location: '/0', source: 'runner_observed', description: 'Invalid reference fixture'}];
    const bytes = encode(record); await fs.writeFile(path, bytes); m.attempts[0].assessmentSha256 = hash(bytes);
  });
  await assert.rejects(() => verifyArchive(f.out, digest), /RETENTION_OBSERVATION_MISMATCH/);
});

test('retention rejects unsupported consumer pins and unrecognized payload roles', async t => {
  const f = await fixture(t), packed = await packArchive(f.store, 'first', f.result.sha256, f.out);
  let digest = await reseal(f.out, m => { m.consumer.sha256 = 'f'.repeat(64); });
  await assert.rejects(() => verifyArchive(f.out, digest), /RETENTION_CONSUMER_MISMATCH/);
  digest = await reseal(f.out, async m => {
    m.consumer = packed.consumer;
    await fs.writeFile(join(f.out, 'unrelated.json'), '{}');
    m.files.push({path: 'unrelated.json', bytes: 2, sha256: hash(Buffer.from('{}'))});
    m.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });
  await assert.rejects(() => verifyArchive(f.out, digest), /RETENTION_UNEXPECTED_PAYLOAD/);
});

test('a partial copy without the last-published manifest cannot verify', async t => {
  const f = await fixture(t), packed = await packArchive(f.store, 'first', f.result.sha256, f.out);
  await fs.rename(join(f.out, 'retention.json'), join(f.root, 'retained-manifest.json'));
  await assert.rejects(() => verifyArchive(f.out, packed.sha256), e => {
    assert.equal(e.code, 'ENOENT'); assert.deepEqual(e.retentionDetail, { path: 'retention.json' }); return true;
  });
  await assert.rejects(() => packArchive(f.store, 'first', f.result.sha256, f.out), { code: 'EEXIST' });
  for (const [path, raw] of f.files) assert.deepEqual(await fs.readFile(join(f.bundle, path)), raw);
});

test('changed file lengths and same-size tampering identify the file without exposing contents', async t => {
  const f = await fixture(t), packed = await packArchive(f.store, 'first', f.result.sha256, f.out);
  const path = join(f.out, 'mapping.json'), raw = await fs.readFile(path);
  for (const bytes of [Buffer.concat([raw, Buffer.from('\n')]), raw.subarray(0, raw.length - 1), Buffer.from(raw).fill(32)]) {
    await fs.writeFile(path, bytes);
    await assert.rejects(() => verifyArchive(f.out, packed.sha256), e => {
      assert.equal(e.message, 'RETENTION_FILE_DIGEST_MISMATCH');
      assert.deepEqual(e.retentionDetail, { path: 'mapping.json', expectedBytes: raw.length, actualBytes: bytes.length });
      return true;
    });
  }
  await fs.writeFile(path, Buffer.concat([raw, Buffer.from('\nPRIVATE_CONTENT_MARKER')]));
  await assert.rejects(() => exec(process.execPath, [join(f.out, 'consumer/retention/cli.mjs'), 'verify', f.out, '--sha256', packed.sha256]), e => {
    assert.equal(e.code, 1); assert.equal(e.stdout, '');
    assert.match(e.stderr, /RETENTION_FILE_DIGEST_MISMATCH/); assert.match(e.stderr, /File: "mapping\.json"/);
    assert.match(e.stderr, new RegExp(`Expected bytes: ${raw.length}; observed bytes:`));
    assert.match(e.stderr, /Keep the expected digest unchanged/); assert.doesNotMatch(e.stderr, /PRIVATE_CONTENT_MARKER/);
    return true;
  });
});

test('missing and unlisted files identify the inventory discrepancy', async t => {
  const f = await fixture(t), packed = await packArchive(f.store, 'first', f.result.sha256, f.out);
  const mapping = join(f.out, 'mapping.json'), raw = await fs.readFile(mapping);
  await fs.unlink(mapping);
  await assert.rejects(() => verifyArchive(f.out, packed.sha256), e => {
    assert.equal(e.message, 'RETENTION_FILE_INVENTORY_MISMATCH');
    assert.deepEqual(e.retentionDetail, { path: 'mapping.json', kind: 'missing' }); return true;
  });
  await fs.writeFile(mapping, raw); await fs.writeFile(join(f.out, 'unexpected.txt'), 'not evidence');
  await assert.rejects(() => verifyArchive(f.out, packed.sha256), e => {
    assert.equal(e.message, 'RETENTION_FILE_INVENTORY_MISMATCH');
    assert.deepEqual(e.retentionDetail, { path: 'unexpected.txt', kind: 'unlisted' }); return true;
  });
});
