import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { attemptIds, checkIds, exercisePassed, validateReport } from './contract.mjs';
import { expectedCalls, prompts, seed } from './scenario.mjs';

const integration = dirname(fileURLToPath(import.meta.url));
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node run-feasibility.mjs <pi-webdesk-source> <new-output-directory>');
const webdesk = realpathSync(resolve(process.argv[2]));
if (process.version !== 'v24.15.0') throw new Error('Use the Trialyard pinned Node v24.15.0');
const out = resolve(process.argv[3]);
mkdirSync(out, { mode: 0o700 }); // Exclusive: retain every previous invocation.
const started = Date.now();
const startedAt = new Date(started).toISOString();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = file => digest(readFileSync(file));
function write(file, value) { writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
function journal(file, value) {
  const fd = openSync(file, 'a', 0o600);
  try { appendFileSync(fd, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
}
function jsonl(file) {
  if (!existsSync(file)) return [];
  // Concurrent writer may have appended only part of the final record.
  const text = readFileSync(file, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function files(root) {
  return readdirSync(root).sort().flatMap(name => {
    const file = join(root, name), stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Unexpected artifact symlink: ${file}`);
    return stat.isDirectory() ? files(file) : [file];
  });
}
function artifact(file) { return { path: relative(out, file), sha256: sha(file) }; }
function snapshot(worktree) {
  return Object.fromEntries(readdirSync(worktree).filter(name => name !== '.git').sort().map(name => {
    const file = join(worktree, name);
    if (!lstatSync(file).isFile()) throw new Error('Unexpected fixture state');
    return [name, readFileSync(file, 'utf8')];
  }));
}
function processTable() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => {
    const [, pid, ppid, pgid, start] = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), start: start.trim() };
  });
}

const attempts = [], errors = [];
let identity;
try {
  const requireWebdesk = createRequire(join(webdesk, 'package.json'));
  const esbuild = requireWebdesk('esbuild');
  // Pi exports only the ESM import condition; require.resolve rejects its root.
  const piRoot = realpathSync(join(webdesk, 'node_modules/@earendil-works/pi-coding-agent'));
  const piEntry = join(piRoot, 'dist/cli.js');
  const piVersion = JSON.parse(readFileSync(join(piRoot, 'package.json'), 'utf8')).version;
  assert.equal(piVersion, '0.84.2');
  const buildRoot = join(out, 'build'); mkdirSync(buildRoot);
  const copied = join(out, 'source'); mkdirSync(copied);
  const buildInputs = new Map();
  for (const [entry, output, external] of [
    [join(webdesk, 'packages/pi-bridge/src/rpc/runtime.ts'), 'runtime.mjs', []],
    [join(webdesk, 'packages/pi-bridge/extensions/pita-policy.ts'), 'policy.mjs', []],
    [join(integration, 'probe-extension.mjs'), 'probe.mjs', ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent']],
  ]) {
    const result = await esbuild.build({ entryPoints: [entry], outfile: join(buildRoot, output), bundle: true, format: 'esm', platform: 'node', target: 'node24', external, metafile: true, logLevel: 'silent', absWorkingDir: webdesk });
    for (const input of Object.keys(result.metafile.inputs)) {
      const absolute = resolve(webdesk, input);
      buildInputs.set(absolute, { path: absolute, sha256: sha(absolute) });
      // Preserve selected application/integration sources; dependencies stay identified, not vendored.
      if (absolute.startsWith(join(webdesk, 'packages/pi-bridge/') ) || absolute.startsWith(integration + '/')) {
        const target = join(copied, absolute.startsWith(integration + '/') ? 'integration' : 'webdesk', relative(absolute.startsWith(integration + '/') ? integration : webdesk, absolute));
        mkdirSync(dirname(target), { recursive: true }); copyFileSync(absolute, target);
      }
    }
  }
  const supervisor = join(webdesk, 'packages/pi-bridge/src/rpc/supervisor.mjs');
  copyFileSync(supervisor, join(buildRoot, 'supervisor.mjs'));
  buildInputs.set(supervisor, { path: supervisor, sha256: sha(supervisor) });
  for (const entry of buildInputs.values()) assert.equal(sha(entry.path), entry.sha256, 'Selected source changed during preparation');
  const git = args => execFileSync('/usr/bin/git', ['-C', webdesk, ...args], { encoding: 'utf8' }).trim();
  identity = {
    scope: 'Selected-source and build hashes; external installed Pi dependency closure is not vendored or fully attested.',
    webdesk: { root: webdesk, head: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']).length > 0 },
    node: { version: process.version, executable: process.execPath, sha256: sha(process.execPath) },
    pi: { version: piVersion, entry: piEntry, entrySha256: sha(piEntry), packageSha256: sha(join(piRoot, 'package.json')) },
    esbuild: { version: esbuild.version },
    lock: { path: join(webdesk, 'pnpm-lock.yaml'), sha256: sha(join(webdesk, 'pnpm-lock.yaml')) },
    buildInputs: [...buildInputs.values()],
    integrationInputs: files(integration).map(file => ({ path: relative(integration, file), sha256: sha(file) })),
    outputs: files(buildRoot).map(artifact),
  };
  write(join(out, 'identity.json'), identity);
  const { createPiRpcRuntime } = await import(pathToFileURL(join(buildRoot, 'runtime.mjs')).href);
  const { describeToolCall } = await import(pathToFileURL(join(buildRoot, 'policy.mjs')).href);

  for (const id of attemptIds) {
    process.stdout.write(`Starting ${id}\n`);
    const attemptStarted = Date.now();
    const recordRoot = join(out, id); mkdirSync(recordRoot);
    const lease = realpathSync(mkdtempSync(join(tmpdir(), 'trial-pi-')));
    const worktree = join(lease, 'repo');
    for (const dir of ['repo', 'home', 'agent', 'sessions', 'tmp', 'probe']) mkdirSync(join(lease, dir), { mode: 0o700 });
    write(join(worktree, 'README.md'), seed);
    const env = {
      HOME: join(lease, 'home'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: join(lease, 'tmp'), LANG: 'en_US.UTF-8', TZ: 'UTC',
      PI_CODING_AGENT_DIR: join(lease, 'agent'), PI_CODING_AGENT_SESSION_DIR: join(lease, 'sessions'),
      PITA_POLICY_CONFIRM_TIMEOUT_MS: '10000', TRIAL_PROBE_DIR: join(lease, 'probe'), TRIAL_PROBE_CASE: id,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    };
    execFileSync('/usr/bin/git', ['init', '-q', worktree], { env });
    const checks = Object.fromEntries(checkIds.map(key => [key, false]));
    const result = { id, execution: 'failed', evidence: 'incomplete', operationOutcome: 'unknown', cleanup: 'unverified', durationMs: 0, sessionId: null, checks, artifacts: [], errors: [] };
    const hostLog = join(recordRoot, 'host.jsonl'), eventsLog = join(recordRoot, 'bridge.jsonl');
    const rawFile = join(lease, 'probe/raw.jsonl');
    const gateSeen = new Map(), released = new Set(), approvals = [], owned = new Map();
    let rootPid, sessionFile, settled = 0, fault = null, abortRequested = false;
    const runtime = createPiRpcRuntime({
      executable: process.execPath, prependArgs: [piEntry], cwd: worktree, mode: 'supervised', sessionMode: 'persistent',
      policyExtensionPath: join(buildRoot, 'policy.mjs'),
      extraArgs: ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--offline', '--provider', 'trial-scripted', '--model', 'fixture', '--tools', 'read,write,edit,bash', '-e', join(buildRoot, 'probe.mjs')],
      env, startupTimeoutMs: 45000, requestTimeoutMs: 10000,
    });
    const calls = expectedCalls(id);
    runtime.subscribe(event => {
      journal(eventsLog, event);
      if (event.kind === 'agent-activity' && event.phase === 'agent-settled') settled++;
      if (event.kind === 'extension-error' || event.kind === 'protocol-issue') fault = new Error(JSON.stringify(event));
      if (event.kind === 'dialog-requested') {
        const request = event.request, call = calls.find(c => c.id === request.toolCallId);
        const exact = request.kind === 'approval' && call && request.toolName === call.name && request.summary === describeToolCall(call.name, call.arguments) && !approvals.some(a => a.toolCallId === call.id);
        const confirmed = Boolean(exact && id !== 'denied-write');
        approvals.push({ toolCallId: request.toolCallId ?? null, confirmed });
        journal(hostLog, { kind: 'policy.reply', exact: Boolean(exact), toolCallId: request.toolCallId, confirmed });
        if (!exact) fault = new Error('Unexpected approval dialog; denied');
        runtime.respondToDialog({ requestId: request.requestId, kind: 'confirm', confirmed });
      }
    });
    function observeProcesses() {
      const table = processTable();
      let changed = true;
      while (changed) {
        changed = false;
        for (const proc of table) if (!owned.has(proc.pid) && (proc.pid === rootPid || owned.has(proc.ppid))) { owned.set(proc.pid, proc); changed = true; }
      }
      return table;
    }
    async function tick() {
      if (fault) throw fault;
      observeProcesses();
      for (const event of jsonl(rawFile).filter(e => e.kind === 'intercept.before')) {
        if (released.has(event.toolCallId)) continue;
        const call = calls.find(c => c.id === event.toolCallId);
        assert.ok(call && call.name === event.tool && JSON.stringify(call.arguments) === JSON.stringify(event.input), 'Unexpected gate');
        assert.notEqual(id, 'denied-write', 'Denied operation reached dispatch wrapper');
        if (!gateSeen.has(call.id)) gateSeen.set(call.id, { at: Date.now(), state: snapshot(worktree) });
        if (Date.now() - gateSeen.get(call.id).at < 100) continue;
        const state = snapshot(worktree);
        assert.deepEqual(state, gateSeen.get(call.id).state, 'State changed while original callback was held');
        if (call.name === 'write') assert.equal(state['notes.txt'], undefined);
        if (call.name === 'edit') assert.equal(state['notes.txt'], 'alpha\n');
        if (call.name === 'bash') assert.equal(state['interrupted.txt'], undefined);
        assert.ok(!jsonl(rawFile).some(e => e.kind === 'intercept.dispatch' && e.toolCallId === call.id));
        journal(hostLog, { kind: 'gate.release', toolCallId: call.id, heldMs: Date.now() - gateSeen.get(call.id).at, state });
        const fd = openSync(join(lease, 'probe', `${call.id}.permit`), 'wx', 0o600); fsyncSync(fd); closeSync(fd);
        released.add(call.id);
      }
      if (id === 'interrupted-write' && !abortRequested && existsSync(join(worktree, 'interrupted.txt'))) {
        const state = snapshot(worktree);
        assert.equal(state['interrupted.txt'], 'started\n');
        observeProcesses();
        journal(hostLog, { kind: 'abort.request', state, owned: [...owned.values()] });
        abortRequested = true;
        await runtime.abort();
      }
    }
    async function prompt(message) {
      const expectedSettled = settled + 1;
      await runtime.prompt(message);
      const deadline = Date.now() + 25000;
      while (settled < expectedSettled) {
        if (Date.now() > deadline) throw new Error('Agent did not settle before deadline');
        await tick(); await delay(30);
      }
      await tick();
    }
    try {
      const initial = snapshot(worktree); write(join(recordRoot, 'initial-state.json'), initial);
      checks.freshState = JSON.stringify(initial) === JSON.stringify({ 'README.md': seed });
      const handshake = await runtime.start({ onProcessStarted: async pid => { rootPid = pid; journal(hostLog, { kind: 'process.owned', pid, lease }); observeProcesses(); } });
      checks.supervised = handshake.mode === 'supervised';
      const state = await runtime.getState(); write(join(recordRoot, 'initial-session.json'), state);
      result.sessionId = state.sessionId; sessionFile = state.sessionFile;
      checks.freshState &&= state.messageCount === 0;
      assert.equal(state.model?.provider, 'trial-scripted'); assert.equal(state.model?.id, 'fixture');
      if (id.startsWith('baseline-')) {
        await prompt(prompts.first);
        const between = snapshot(worktree); write(join(recordRoot, 'between-turns.json'), between);
        assert.equal(between['notes.txt'], 'alpha\n');
        await prompt(prompts.followup);
      } else await prompt(id === 'denied-write' ? prompts.denied : prompts.interrupted);
      const final = snapshot(worktree); write(join(recordRoot, 'final-state.json'), final);
      const raw = jsonl(rawFile), actualDispatches = raw.filter(e => e.kind === 'intercept.dispatch').map(e => e.toolCallId);
      const expectedDispatches = id === 'denied-write' ? [] : calls.map(c => c.id);
      const expectedApprovalIds = calls.filter(c => c.name !== 'read').map(c => c.id);
      checks.gateBeforeEffect = released.size === expectedDispatches.length && actualDispatches.every(callId => released.has(callId));
      checks.expectedTrace = JSON.stringify(actualDispatches) === JSON.stringify(expectedDispatches) &&
        JSON.stringify(approvals.map(a => a.toolCallId)) === JSON.stringify(expectedApprovalIds) &&
        approvals.every(a => a.confirmed === (id !== 'denied-write')) && !raw.some(e => e.kind === 'scripted.error');
      if (id.startsWith('baseline-')) {
        checks.expectedState = JSON.stringify(final) === JSON.stringify({ 'README.md': seed, 'notes.txt': 'beta\n' });
        checks.expectedTrace &&= raw.filter(e => e.kind === 'intercept.result').length === 5 && raw.filter(e => e.kind === 'scripted.request').length === 7;
        result.execution = 'completed'; result.operationOutcome = 'known_result';
      } else if (id === 'denied-write') {
        checks.expectedState = JSON.stringify(final) === JSON.stringify({ 'README.md': seed });
        checks.expectedTrace &&= raw.some(e => e.kind === 'scripted.request' && e.context.messages.some(m => m.role === 'toolResult' && m.toolCallId === 'denied-write' && m.isError));
        result.execution = 'completed'; result.operationOutcome = 'blocked_before_dispatch';
      } else {
        checks.expectedState = JSON.stringify(final) === JSON.stringify({ 'README.md': seed, 'interrupted.txt': 'started\n' });
        checks.expectedTrace &&= abortRequested && raw.some(e => e.kind === 'intercept.error' && e.aborted) && !raw.some(e => e.kind === 'intercept.result');
        result.execution = 'interrupted'; result.operationOutcome = checks.expectedState ? 'partial_effect_observed' : 'unknown';
      }
      write(join(recordRoot, 'final-session.json'), await runtime.getState());
      write(join(recordRoot, 'entries.json'), await runtime.getEntries());
    } catch (error) {
      result.execution = 'failed'; result.operationOutcome = 'unknown'; result.errors.push(String(error));
      journal(hostLog, { kind: 'attempt.error', error: String(error) });
    } finally {
      try { await runtime.abort(); } catch { /* A failed startup may not have a ready RPC channel. */ }
      try { journal(hostLog, { kind: 'process.dispose', result: await runtime.dispose() }); }
      catch (error) { result.errors.push(`dispose: ${String(error)}`); }
      try {
        let remaining = [];
        const deadline = Date.now() + 5000;
        do {
          remaining = observeProcesses().filter(p => owned.get(p.pid)?.start === p.start);
          if (!remaining.length) break;
          await delay(100);
        } while (Date.now() < deadline);
        checks.ownedProcessesGone = owned.size > 0 && remaining.length === 0;
        journal(hostLog, { kind: 'process.readback', owned: [...owned.values()], remaining });
        const afterDispose = snapshot(worktree);
        write(join(recordRoot, 'state-after-dispose.json'), afterDispose);
        if (existsSync(join(recordRoot, 'final-state.json'))) {
          checks.expectedState &&= JSON.stringify(afterDispose) === JSON.stringify(JSON.parse(readFileSync(join(recordRoot, 'final-state.json'), 'utf8')));
          if (!checks.expectedState && result.operationOutcome === 'partial_effect_observed') result.operationOutcome = 'unknown';
        }
        if (existsSync(rawFile)) copyFileSync(rawFile, join(recordRoot, 'raw.jsonl'));
        if (sessionFile && sessionFile.startsWith(lease + '/') && existsSync(sessionFile)) {
          copyFileSync(sessionFile, join(recordRoot, 'pi-session.jsonl'));
          const session = jsonl(join(recordRoot, 'pi-session.jsonl'));
          checks.sessionRetained = session.some(e => e.type === 'session' && e.id === result.sessionId);
        }
        if (checks.ownedProcessesGone) { rmSync(lease, { recursive: true }); checks.leaseRemoved = !existsSync(lease); }
        else result.errors.push(`Owned process cleanup unverified; retained lease at ${lease}`);
      } catch (error) { result.errors.push(`readback/cleanup: ${String(error)}`); }
      result.cleanup = checks.ownedProcessesGone && checks.leaseRemoved ? 'verified' : 'unverified';
      result.evidence = checks.sessionRetained && result.errors.length === 0 ? 'complete' : 'incomplete';
      result.durationMs = Date.now() - attemptStarted;
      result.artifacts = files(recordRoot).map(artifact);
      attempts.push(result);
      write(join(recordRoot, 'attempt.json'), result);
      process.stdout.write(`${id}: ${result.execution}, ${result.operationOutcome}, cleanup=${result.cleanup}, checks=${Object.values(checks).filter(Boolean).length}/${checkIds.length}\n`);
    }
    // A harness defect is not a reason to launch further cases under broken assumptions.
    if (result.errors.length) break;
  }
} catch (error) {
  errors.push(String(error));
  if (!existsSync(join(out, 'identity.json'))) write(join(out, 'identity.json'), { preparationError: String(error), webdesk });
}
const report = validateReport({ version: 1, kind: 'pi-webdesk-feasibility', nativeBundle: false, model: 'local-scripted-no-provider-request', startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started, identity: artifact(join(out, 'identity.json')), attempts, errors });
write(join(out, 'report.json'), report);
const passed = exercisePassed(report);
process.stdout.write(`Feasibility ${passed ? 'checks passed' : 'incomplete or checks failed'}: ${join(out, 'report.json')}\n`);
process.exitCode = passed ? 0 : 1;
