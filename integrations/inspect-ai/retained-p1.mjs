// Thin bridge to the existing frozen consumer. Never imports runner execution.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { verifyArchive } from '../../consumers/pi-assessment/retention/archive.mjs';
import { prepareRequest, assessRequest } from '../../consumers/pi-assessment/lib/assessment.mjs';
import { parseJson, hash } from '../../consumers/pi-assessment/lib/io.mjs';
if (process.version !== 'v24.15.0') throw new Error('Node 24.15.0 required for the frozen consumer');
try {
  const [command, descriptorFile, outArg] = process.argv.slice(2);
  if (!['read', 'assess'].includes(command) || !descriptorFile || (command === 'assess' && !outArg)) throw new Error('Usage: retained-p1.mjs read|assess <descriptor.json> [new-attempt-directory]');
  const descriptor = parseJson(await readFile(descriptorFile));
  if (Object.keys(descriptor).sort().join(',') !== 'directory,sha256' || typeof descriptor.directory !== 'string' || resolve(descriptor.directory) !== descriptor.directory) throw new Error('INVALID_RETAINED_DESCRIPTOR');
  const verified = await verifyArchive(descriptor.directory, descriptor.sha256);
  const original = parseJson(await readFile(join(verified.paths.store, verified.head, 'assessment.json')));
  const manifestBytes = await readFile(join(verified.paths.bundle, 'manifest.json'));
  if (hash(manifestBytes) !== verified.source.bundleSha256) throw new Error('SOURCE_CHANGED');
  const scenario = parseJson(await readFile(join(verified.paths.bundle, 'scenario.json')));
  const events = (await readFile(join(verified.paths.bundle, 'events.ndjson'), 'utf8')).trim().split('\n').map(line => parseJson(Buffer.from(line)));
  let attempt = null;
  if (command === 'assess') {
    const out = resolve(outArg); await mkdir(out, { mode: 0o700 });
    const prepared = await prepareRequest(verified.paths.bundle, verified.source.bundleSha256, verified.paths.mapping, join(out, 'request'));
    attempt = await assessRequest(prepared.request, join(out, 'attempts'), 'inspect-reassessment');
    await verifyArchive(descriptor.directory, descriptor.sha256);
  }
  process.stdout.write(JSON.stringify({ archiveSha256: descriptor.sha256, source: verified.source, criterion: verified.criterion, consumer: verified.consumer, native: original.native, originalAssessment: original, originalAssessmentSha256: hash(await readFile(join(verified.paths.store, verified.head, 'assessment.json'))), scenario, conversation: events.filter(e => ['user.turn', 'assistant.turn'].includes(e.kind)), attempt, candidateExecutions: 0 }) + '\n');
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
