import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { captureInputs, compilerIdentity, toolingIdentity, verifyFixedInputs } from './build-state.mjs';
import { STATE, preserved, selectContract, assertContinuity, json, reject } from './rebuild-contract.mjs';
import { checkPiConnection, publishConnection } from './rebuild.mjs';
import { execFileSync } from 'node:child_process';
import { packRuntime } from './runtime-package.mjs';
import { hash, packageRecordSchema } from './package-contract.mjs';
import { object, bridgeSchema, fixtureSchema, nativeToolSchemas } from './native-contract.mjs';
import { seed, prompts } from './scenario.mjs';

if (process.version !== 'v24.15.0' || process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Native Pi slice requires macOS arm64 and Node 24.15.0');
const worker = process.argv[2] === '--rebuild-worker';
if (process.argv.length !== (worker ? 7 : 4)) throw new Error('Usage: node build-native.mjs <pi-webdesk-checkout> <new-output-directory>');
const integration = dirname(fileURLToPath(import.meta.url)), webdesk = resolve(process.argv[worker ? 3 : 2]), output = resolve(process.argv[worker ? 4 : 3]);
const parent = worker ? await checkPiConnection(process.argv[5], process.argv[6]) : null;
const selection = worker ? selectContract(json(readFileSync(join(output, 'selection-input.json'))), parent.state, hash(parent.bytes)) : null;
if (parent) verifyFixedInputs(parent.state, webdesk);
const compiler = compilerIdentity(webdesk), initialTooling = toolingIdentity();
const esbuild = createRequire(join(webdesk, 'package.json'))(compiler.entry);
const captured = captureInputs(webdesk, selection);
if (!worker) mkdirSync(output, { mode: 0o700 });
else unlinkSync(join(output, 'selection-input.json'));
const write = (path, value) => writeFileSync(join(output, path), JSON.stringify(value, null, 2) + '\n');
const startedAt = new Date().toISOString();
try {
  process.stdout.write('Packaging installed Pi dependency graph\n');
  const runtime = parent ? json(parent.files.get('pi-runtime.json')) : packRuntime(webdesk, output);
  if (parent) for (const name of ['pi-runtime.json', ...runtime.chunks.map(c => c.path)]) writeFileSync(join(output, name), parent.files.get(name));
  if (runtime.piVersion !== '0.84.2') throw new Error('Unsupported Pi version');
  const aliases = { 'pi-webdesk-runtime': join(webdesk, 'packages/pi-bridge/src/rpc/runtime.ts'), 'pi-webdesk-policy': join(webdesk, 'packages/pi-bridge/extensions/pita-policy.ts') };
  for (const [entry, outfile, external] of [
    [join(integration, 'native-agent.mjs'), 'agent.js', []],
    [join(integration, 'native-environment.mjs'), 'environment.js', []],
    [join(integration, 'native-extension.mjs'), 'native-extension.mjs', ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai']],
    [aliases['pi-webdesk-policy'], 'policy.mjs', []],
  ]) {
    const result = await esbuild.build({ entryPoints: [entry], outfile: join(output, outfile), bundle: true, format: 'esm', platform: 'node', target: 'node24', alias: aliases, external, metafile: true, plugins: [captured.plugin], tsconfigRaw: { compilerOptions: { target: 'ES2023', verbatimModuleSyntax: true, useDefineForClassFields: true } }, logLevel: 'silent', absWorkingDir: webdesk,
      banner: { js: "import { createRequire as __nativeCreateRequire } from 'node:module'; const require = __nativeCreateRequire(import.meta.url);" } });
    captured.graph(outfile, result.metafile);
  }
  const supervisor = join(webdesk, 'packages/pi-bridge/src/rpc/supervisor.mjs'); writeFileSync(join(output, 'supervisor.mjs'), await captured.load(supervisor));
  // The bundled bridge still launches its own sibling supervisor.mjs unchanged.
  write('package.json', { private: true, type: 'module' });
  write('bridge.schema.json', bridgeSchema); write('package-record.schema.json', packageRecordSchema);
  const source = { version: 1, scope: 'Pi Webdesk native scripted slice', startedAt, builtAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, esbuild: esbuild.version,
    webdesk: { head: execFileSync('/usr/bin/git', ['-C', webdesk, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: Boolean(execFileSync('/usr/bin/git', ['-C', webdesk, 'status', '--porcelain'], { encoding: 'utf8' }).trim()), lockSha256: hash(readFileSync(join(webdesk, 'pnpm-lock.yaml'))) },
    runtime, compiledInputs: captured.compiledInputs(), integrationInputs: readdirSync(integration).filter(p => /\.(mjs|json)$/.test(p)).sort().map(path => ({ path, sha256: hash(readFileSync(join(integration, path))) })),
    fidelity: 'Real Pi RPC loop and original tools, original Webdesk supervised policy and supervisor; pre-tool admission and dispatch acknowledgment instrumentation; local scripted model provider; disposable Git fixture; original Webdesk daemon/UI/worktree manager excluded. Full installed reachable pnpm package graph included. Host Node, macOS, ps, Git and bash are platform prerequisites; no authenticity claim.' };
  write('build.json', source);
  const state = captured.state(compiler.identity, hash(readFileSync(join(output, 'pi-runtime.json'))));
  if (parent) assertContinuity(parent.state, state);
  write(STATE, state);
  const runtimeFiles = readdirSync(output).sort();
  const required = { conversation: true, routedToolEvents: true, initialState: true, finalState: true, stableFinalState: true, localArtifactIdentity: true, terminalOperationAccounting: true, modelUsage: false };
  write('profile.json', { schemaVersion: 'trial-runner/evidence-profile/v1', id: 'pi-native-scripted-v1', captureBoundary: source.fidelity, required, modelCapture: 'accounted', modelCaptureReason: 'Durable intent, observed entry and result for each local scripted responder invocation. Raw Pi-bound context retained. No actual model provider, physical provider retries, token usage or quality claim.', terminalRules: { not_started: 'incomplete', finished: 'require_all_declared_observations', agent_error: 'require_error_event_and_all_declared_observations', timed_out: 'require_timeout_event_and_all_declared_observations', cancelled: 'require_cancellation_event_and_all_declared_observations', infrastructure_error: 'incomplete' } });
  write('fixture.schema.json', fixtureSchema); write('tools.json', nativeToolSchemas);
  write('agent-settings.schema.json', object({})); write('environment-settings.schema.json', object({}));
  const adapter = role => ({ adapterId: `pi-webdesk.${role}`, adapterVersion: '0.1.0', argv: ['node', `${role}.js`], cwd: '.', artifactManifest: `${role}-artifact.json`, capabilities: role === 'agent' ? ['scripted-turns', 'routed-tools', 'conversation-events', 'model-accounted'] : ['fresh-lease', 'state-snapshot', 'routed-tools', 'verified-cleanup'], settingsSchema: `${role}-settings.schema.json`, settings: {} });
  for (const [name, fixtureCase, messages, repetitions] of [
    ['baseline', 'baseline-a', [prompts.first, prompts.followup], 2],
    ['denied', 'denied-write', [prompts.denied], 1],
    ['interrupted', 'interrupted-write', [prompts.interrupted], 1],
  ]) {
    write(`${name}-fixture.json`, { case: fixtureCase, files: { 'README.md': seed }, session: null, observations: [], runtime: {} });
    write(`${name}-scenario.json`, { schemaVersion: 'trial-runner/scenario/v1', id: `pi-${name}`, description: `Pi Webdesk native ${name} scripted fixture`, messages: messages.map((content, i) => ({ id: `turn-${i + 1}`, role: 'user', content })), provenance: { origin: 'preregistered-synthetic-integration', exposure: 'development-qualification' }, externalCriterionRefs: [] });
    write(`${name}-plan.json`, { schemaVersion: 'trial-runner/plan/v1', id: `pi-${name}`, agent: adapter('agent'), environment: { ...adapter('environment'), initialState: `${name}-fixture.json`, fixtureSchema: 'fixture.schema.json', toolSchemas: 'tools.json', clock: { mode: 'real', instant: null }, faultPlan: [] }, scenarios: [{ path: `${name}-scenario.json` }], repetitions,
      limits: { prepareMs: 120000, trialMs: 60000, stopGraceMs: 10000, snapshotMs: 10000, cleanupMs: 30000, maxTurns: 2, maxFrameBytes: 1048576, maxEvents: 10000, maxRecordedBytes: 67108864 }, evidenceProfile: 'profile.json', capturePolicy: { content: 'local', externalExport: 'explicit' }, secretBindings: [] });
  }
  if (parent) for (const f of preserved(parent.recipe)) writeFileSync(join(output, f.path), parent.files.get(f.path));
  const artifact = { schemaVersion: 'trial-runner/artifact/v1', files: runtimeFiles.map(path => { const bytes = readFileSync(join(output, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }; }) };
  write('agent-artifact.json', artifact); write('environment-artifact.json', artifact);
  await captured.unchanged();
  if (!isDeepStrictEqual(initialTooling, toolingIdentity()) || !isDeepStrictEqual(compiler.identity, compilerIdentity(webdesk).identity)) reject('PI_TOOLCHAIN_CHANGED_DURING_BUILD');
  if (parent) { verifyFixedInputs(parent.state, webdesk); await checkPiConnection(process.argv[5], hash(parent.bytes)); }
  const connection = await publishConnection(output, state, parent, selection);
  process.stdout.write(JSON.stringify({ output, connection, artifactFiles: artifact.files.length, artifactBytes: artifact.files.reduce((n, f) => n + f.bytes, 0), runtime: runtime.inventory, archiveBytes: runtime.chunks.reduce((n, c) => n + c.bytes, 0) }) + '\n');
} catch (error) {
  write('build-failure.json', { error: String(error), at: new Date().toISOString() }); throw error;
} finally { esbuild.stop(); }
