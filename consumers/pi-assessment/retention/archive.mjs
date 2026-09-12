import * as fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { identities, packageRoot } from '../lib/identity.mjs';
import { readAttempt } from '../lib/assessment.mjs';
import { readBundle, verifyFiles, identityFor, verifyMapping } from '../lib/native.mjs';
import { shape, same } from '../lib/contracts.mjs';
import { hash, encode, parseJson, readPath, readRegular, inventory, publish, requireThat } from '../lib/io.mjs';
import { validateManifest, expectedDigest, maximumBytes, retentionFailure } from './contracts.mjs';

const require = createRequire(import.meta.url);
const dependencies = ['ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string'];
const supportFiles = ['README.md', 'SCOPE.md', 'retention/README.md', 'retention/SCOPE.md', 'retention/manifest.schema.json', 'retention/contracts.mjs', 'retention/archive.mjs', 'retention/cli.mjs'];
const runtimePath = path => `consumer/${path.startsWith('dependency:') ? `node_modules/${path.slice('dependency:'.length)}` : path}`;

async function consumerSnapshot() {
  const pins = await identities(), files = new Map();
  for (const file of pins.files) {
    let root = packageRoot, path = file.path;
    if (path.startsWith('dependency:')) {
      const [name, ...rest] = path.slice('dependency:'.length).split('/');
      root = dirname(require.resolve(`${name}/package.json`)); path = rest.join('/');
    }
    const bytes = await readRegular(root, path);
    requireThat(hash(bytes) === file.sha256, 'CONSUMER_CHANGED_DURING_COPY');
    files.set(runtimePath(file.path), bytes);
  }
  for (const path of supportFiles) files.set(`consumer/${path}`, await readRegular(packageRoot, path));
  for (const name of dependencies) {
    const root = dirname(require.resolve(`${name}/package.json`));
    const licenses = (await inventory(root)).filter(path => !path.includes('/') && /^licen[sc]e(?:\..*)?$/iu.test(path));
    requireThat(licenses.length > 0, 'DEPENDENCY_LICENSE_MISSING');
    for (const path of licenses) files.set(`consumer/node_modules/${name}/${path}`, await readRegular(root, path));
  }
  return { pins, files };
}

// Never resolves a historical request's bundlePath or mappingPath here.
export async function verifyArchive(directory, digest) {
  expectedDigest(digest);
  const root = resolve(directory); let raw;
  try { raw = await readRegular(root, 'retention.json', 2 * 1024 * 1024); }
  catch (error) { error.retentionDetail = { path: 'retention.json' }; throw error; }
  requireThat(hash(raw) === digest, 'RETENTION_DIGEST_MISMATCH');
  const manifest = validateManifest(parseJson(raw));
  const actualPaths = await inventory(root), expectedPaths = [...manifest.files.map(f => f.path), 'retention.json'];
  const actualSet = new Set(actualPaths), expectedSet = new Set(expectedPaths);
  const missing = expectedPaths.find(path => !actualSet.has(path)), unlisted = actualPaths.find(path => !expectedSet.has(path));
  if (missing || unlisted) throw retentionFailure('RETENTION_FILE_INVENTORY_MISMATCH', { path: missing ?? unlisted, kind: missing ? 'missing' : 'unlisted' });
  const files = new Map(); let bytesRead = 0;
  for (const file of manifest.files) {
    let bytes;
    // Declared size is an equality check, not the safety ceiling: a bounded
    // appended byte should diagnose changed content, not an unsafe file type.
    try { bytes = await readRegular(root, file.path, Math.min(16 * 1024 * 1024, maximumBytes - bytesRead)); }
    catch (error) { error.retentionDetail = { path: file.path }; throw error; }
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) {
      throw retentionFailure('RETENTION_FILE_DIGEST_MISMATCH', { path: file.path, expectedBytes: file.bytes, actualBytes: bytes.length });
    }
    bytesRead += bytes.length;
    files.set(file.path, bytes);
  }
  const current = await consumerSnapshot();
  same(manifest.consumer, current.pins.consumer, 'RETENTION_CONSUMER_MISMATCH');
  same(manifest.criterion, current.pins.criterion, 'RETENTION_CRITERION_MISMATCH');
  same([...files.keys()].filter(p => p.startsWith('consumer/')).sort(), [...current.files.keys()].sort(), 'RETENTION_CONSUMER_FILES_MISMATCH');
  for (const file of current.pins.files) {
    requireThat(hash(files.get(runtimePath(file.path))) === file.sha256, 'RETENTION_CONSUMER_BYTES_MISMATCH');
  }
  const sourceFiles = new Map([...files].filter(([p]) => p.startsWith('source/')).map(([p, b]) => [p.slice('source/'.length), b]));
  const source = verifyFiles(sourceFiles, manifest.source.bundleSha256), m = source.manifest;
  requireThat(files.has('mapping.json') && hash(files.get('mapping.json')) === manifest.source.mappingSha256, 'RETENTION_MAPPING_MISMATCH');
  verifyMapping(parseJson(files.get('mapping.json')), source);
  const allowed = [...sourceFiles.keys()].map(p => `source/${p}`).concat([...current.files.keys()], 'mapping.json');
  const summaries = [];
  for (const attempt of manifest.attempts) {
    const prefix = `assessments/${attempt.requestId}`;
    for (const name of ['request.json', 'intent.json', 'assessment.json']) allowed.push(`${prefix}/${name}`);
    const retained = await readAttempt(join(root, 'assessments'), attempt.requestId, attempt.assessmentSha256);
    requireThat(retained.result !== null, 'RETENTION_ATTEMPT_UNFINISHED');
    const record = retained.result;
    requireThat(retained.requestSha256 === attempt.requestSha256 && record.retryOf === attempt.retryOf, 'RETENTION_ATTEMPT_MISMATCH');
    requireThat(record.verification === 'accepted', 'RETENTION_UNVERIFIED_SOURCE_UNSUPPORTED');
    same(record.source, { ...manifest.source, identity: identityFor(m) }, 'RETENTION_SOURCE_MISMATCH');
    same(record.consumer, manifest.consumer, 'RETENTION_CONSUMER_MISMATCH');
    same(record.criterion, manifest.criterion, 'RETENTION_CRITERION_MISMATCH');
    same(record.native, { execution: m.execution, evidence: m.evidence.state, cleanup: m.cleanup, gaps: m.evidence.gaps, boundary: m.fidelity.boundary, authenticity: m.identity.authenticity }, 'RETENTION_NATIVE_STATE_MISMATCH');
    for (const observation of record.result?.observations ?? []) {
      requireThat(m.files.some(f => f.path === observation.path && f.sha256 === observation.sha256), 'RETENTION_OBSERVATION_MISMATCH');
    }
    summaries.push({ requestId: attempt.requestId, assessmentSha256: attempt.assessmentSha256, retryOf: attempt.retryOf, execution: record.execution, native: record.native, judgment: record.result?.judgment ?? null, errorCode: record.errorCode });
  }
  same([...files.keys()].sort(), allowed.sort(), 'RETENTION_UNEXPECTED_PAYLOAD');
  return { schemaVersion: manifest.schemaVersion, directory: root, sha256: digest, source: manifest.source, consumer: manifest.consumer, criterion: manifest.criterion, head: manifest.head, attempts: summaries,
    files: manifest.files.length, bytes: manifest.files.reduce((n, f) => n + f.bytes, 0),
    paths: { bundle: join(root, 'source'), mapping: join(root, 'mapping.json'), consumer: join(root, 'consumer'), store: join(root, 'assessments') },
    verificationScope: 'retained-bytes-native-subset-and-assessment-links/v1', execution: 'not_run' };
}

export async function packArchive(store, id, assessmentDigest, destination) {
  expectedDigest(assessmentDigest);
  const snapshot = await consumerSnapshot(), files = snapshot.files, attempts = [], visited = new Set();
  let currentId = id, selectedRequest;
  while (currentId !== null) {
    requireThat(!visited.has(currentId) && visited.size < 32, 'RETENTION_ANCESTRY_LIMIT'); visited.add(currentId);
    const result = await readAttempt(store, currentId, currentId === id ? assessmentDigest : undefined);
    requireThat(result.result !== null, 'RETENTION_ATTEMPT_UNFINISHED');
    requireThat(result.result.verification === 'accepted', 'RETENTION_UNVERIFIED_SOURCE_UNSUPPORTED');
    const requestBytes = await readRegular(join(store, currentId), 'request.json');
    requireThat(hash(requestBytes) === result.requestSha256, 'STORED_REQUEST_CHANGED');
    const request = shape('request', parseJson(requestBytes));
    if (!selectedRequest) selectedRequest = request;
    for (const key of ['bundleSha256', 'mappingSha256', 'identity', 'consumer', 'criterion']) same(request[key], selectedRequest[key], 'RETENTION_ANCESTOR_IDENTITY_MISMATCH');
    same(request.consumer, snapshot.pins.consumer, 'RETENTION_CONSUMER_MISMATCH');
    same(request.criterion, snapshot.pins.criterion, 'RETENTION_CRITERION_MISMATCH');
    for (const name of ['request.json', 'intent.json', 'assessment.json']) files.set(`assessments/${currentId}/${name}`, name === 'request.json' ? requestBytes : await readRegular(join(store, currentId), name));
    requireThat(hash(files.get(`assessments/${currentId}/assessment.json`)) === result.sha256, 'ASSESSMENT_CHANGED_DURING_COPY');
    attempts.unshift({ requestId: currentId, requestSha256: result.requestSha256, assessmentSha256: result.sha256, retryOf: result.result.retryOf });
    currentId = result.result.retryOf;
  }
  const source = await readBundle(selectedRequest.bundlePath, selectedRequest.bundleSha256);
  same(identityFor(source.manifest), selectedRequest.identity, 'RETENTION_SOURCE_MISMATCH');
  const mapping = await readPath(selectedRequest.mappingPath);
  requireThat(hash(mapping) === selectedRequest.mappingSha256, 'RETENTION_MAPPING_MISMATCH');
  verifyMapping(parseJson(mapping), source);
  for (const [path, bytes] of source.files) files.set(`source/${path}`, bytes);
  files.set('mapping.json', mapping);
  const manifest = validateManifest({ schemaVersion: 'observation-consumer/retention/v1', createdAt: new Date().toISOString(), node: process.versions.node, consumer: snapshot.pins.consumer, criterion: snapshot.pins.criterion,
    source: { bundleSha256: source.digest, mappingSha256: hash(mapping) }, head: id, attempts,
    files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) });
  const out = resolve(destination);
  await fs.mkdir(out, { mode: 0o700 }); // Existing or interrupted directories are never overwritten.
  for (const [path, bytes] of files) {
    await fs.mkdir(dirname(join(out, path)), { recursive: true, mode: 0o700 });
    await publish(join(out, path), bytes);
  }
  const manifestBytes = encode(manifest), digest = hash(manifestBytes);
  await publish(join(out, 'retention.json'), manifestBytes);
  return verifyArchive(out, digest);
}
