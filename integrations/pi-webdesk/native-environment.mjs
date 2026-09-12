import { AdapterPeer } from '../../src/sdk/peer.ts';
import { createPiRpcRuntime } from 'pi-webdesk-runtime';
import { describeToolCall } from 'pi-webdesk-policy';
import { InvocationLedger, nativeToolSchemas } from './native-contract.mjs';
import { rpc, serve, deferred, bounded } from './native-rpc.mjs';
import { unpackRuntime } from './runtime-package.mjs';
import { expectedCalls, seed } from './scenario.mjs';
import { caseContract, admitCaseCall } from './case-contract.mjs';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

const source = process.cwd(), ledger = new InvocationLedger(), pending = new Map(), owned = new Map();
let lease, repo, fixture, runtime, server, environmentSocket, agentSocket, stopping = false, stopped, disposed, rootPid, observer, activeTurn = false, settled = 0, fault, sessionFile, sessionId;
const observations = [];
function observe(kind, data = {}) { if (observations.length >= 190) throw new Error('PI_OBSERVATION_LIMIT'); observations.push({ at: new Date().toISOString(), kind, ...data }); }
function table() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const [, pid, ppid, pgid, started] = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/); return { pid: +pid, ppid: +ppid, pgid: +pgid, started: started.trim() };
  });
}
function processReadback() {
  const rows = table(); let changed = true;
  while (changed) { changed = false; for (const row of rows) if (!owned.has(row.pid) && (row.pid === rootPid || owned.has(row.ppid))) { owned.set(row.pid, row); changed = true; } }
  return rows.filter(row => owned.get(row.pid)?.started === row.started);
}
function files() {
  return Object.fromEntries(readdirSync(repo).filter(n => n !== '.git').sort().map(name => {
    const path = join(repo, name); if (!lstatSync(path).isFile()) throw new Error('UNSUPPORTED_PI_FILE_STATE');
    const bytes = readFileSync(path); if (bytes.length > 65536) throw new Error('PI_FILE_STATE_LIMIT'); return [name, bytes.toString('utf8')];
  }));
}
function snapshot() {
  let session = null;
  if (sessionFile && existsSync(sessionFile)) {
    if (!sessionFile.startsWith(lease + '/')) throw new Error('FOREIGN_PI_SESSION');
    const bytes = readFileSync(sessionFile); if (bytes.length > 400000) throw new Error('PI_SESSION_CAPTURE_LIMIT');
    session = { sessionId, raw: bytes.toString('utf8') }; // Exact Pi-owned JSONL, not a UI projection.
  }
  const remaining = rootPid ? processReadback() : [];
  const open = [...ledger.calls.values()].filter(c => !['closed', 'stopped'].includes(c.phase)).map(c => c.operationId ?? c.invocationId);
  const stable = !activeTurn && !open.length && (!stopping || remaining.length === 0);
  return { state: { case: fixture.case, ...(fixture.definition ? { definition: fixture.definition } : {}), files: files(), session, observations: structuredClone(observations), runtime: { lease, sessionId: sessionId ?? null, status: runtime?.lifecycleState ?? 'not_started', owned: [...owned.values()], remaining, callbacks: [...ledger.calls.values()] } }, stable, pendingOperations: stable ? [] : [...open, ...(activeTurn ? ['pi-turn'] : []), ...remaining.filter(() => stopping).map(p => String(p.pid))], observedAt: new Date().toISOString() };
}
async function stopPi() {
  if (stopped) return stopped;
  stopping = true; ledger.stop();
  for (const call of pending.values()) { call.admit.reject(new Error('PI_STOPPED')); call.done.resolve({ outcome: 'outcome_unknown', value: null, error: 'Pi stopped with a pending callback' }); }
  stopped = (async () => {
    if (runtime) {
      try { await bounded(runtime.abort(), 3000); } catch { /* Dispose and readback remain required. */ }
      await bounded(runtime.dispose(), 6000);
    }
    activeTurn = false;
    const deadline = Date.now() + 2000; let remaining = rootPid ? processReadback() : [];
    while (remaining.length && Date.now() < deadline) { await delay(50); remaining = processReadback(); }
    if (observer) clearInterval(observer);
    observe('process.stopped', { owned: [...owned.values()], remaining });
    if (remaining.length) throw new Error('PI_PROCESSES_REMAIN');
    return null;
  })(); return stopped;
}
async function startPi() {
  const meta = JSON.parse(readFileSync(join(source, 'pi-runtime.json')));
  const env = { HOME: join(lease, 'home'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: join(lease, 'tmp'), LANG: 'en_US.UTF-8', TZ: 'UTC', PI_CODING_AGENT_DIR: join(lease, 'agent'), PI_CODING_AGENT_SESSION_DIR: join(lease, 'sessions'), PITA_POLICY_CONFIRM_TIMEOUT_MS: '10000', TRIAL_PI_SOCKET: environmentSocket, TRIAL_PI_CASE: fixture.case, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  if (fixture.definition) { env.TRIAL_PI_DEFINITION = join(lease, 'scripted-case.json'); writeFileSync(env.TRIAL_PI_DEFINITION, JSON.stringify(fixture.definition), { flag: 'wx', mode: 0o600 }); }
  runtime = createPiRpcRuntime({ executable: process.execPath, prependArgs: [join(lease, 'runtime', meta.entry)], cwd: repo, mode: 'supervised', sessionMode: 'persistent', policyExtensionPath: join(source, 'native-extension.mjs'), env,
    extraArgs: ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--offline', '--provider', 'trial-scripted', '--model', 'fixture', '--tools', 'read,write,edit,bash', '-e', join(source, 'policy.mjs')], startupTimeoutMs: 30000, requestTimeoutMs: 10000 });
  runtime.subscribe(event => {
    if (event.kind === 'agent-activity' && event.phase === 'agent-settled') settled++;
    if (event.kind === 'extension-error' || event.kind === 'protocol-issue') fault = new Error(JSON.stringify(event));
    if (event.kind === 'dialog-requested') {
      try {
        const request = event.request, call = ledger.get(request.toolCallId);
        const valid = request.kind === 'approval' && call.phase === 'admitted' && call.tool === request.toolName && request.summary === describeToolCall(call.tool, call.input);
        const confirmed = valid && !stopping && fixture.case !== 'denied-write';
        observe('approval', { invocationId: call.invocationId, operationId: call.operationId, valid, confirmed, summary: request.summary });
        runtime.respondToDialog({ requestId: request.requestId, kind: 'confirm', confirmed });
        if (!valid) throw new Error('UNEXPECTED_PI_APPROVAL');
        if (!confirmed) { ledger.finish(call.invocationId, 'not_dispatched'); pending.get(call.invocationId).done.resolve({ outcome: 'not_dispatched', value: null, error: 'Webdesk supervised policy: approval denied' }); }
      } catch (error) { fault = error; runtime.respondToDialog({ requestId: event.request.requestId, kind: 'confirm', confirmed: false }); }
    }
  });
  const handshake = await runtime.start({ onProcessStarted: async pid => { rootPid = pid; processReadback(); observe('process.started', { pid }); observer = setInterval(() => { try { processReadback(); } catch (error) { fault = error; } }, 50); } });
  const state = await runtime.getState(); sessionFile = state.sessionFile; sessionId = state.sessionId;
  if (handshake.mode !== 'supervised' || state.messageCount !== 0 || state.model?.provider !== 'trial-scripted' || state.model?.id !== 'fixture') throw new Error('PI_START_MISMATCH');
  observe('runtime.ready', { handshake, state });
}
async function request(message) {
  if (message.kind === 'stop') return stopPi();
  if (message.kind === 'bind') {
    if (agentSocket !== message.socket || runtime || stopping) throw new Error('INVALID_PI_BIND');
    await startPi(); return null;
  }
  if (message.kind === 'tool.result') {
    const call = ledger.get(message.invocationId);
    observe('callback.result', { invocationId: call.invocationId, operationId: call.operationId, result: message.result, error: message.error, late: stopping });
    if (call.phase !== 'stopped') {
      const outcome = message.error === null ? 'known_result' : 'known_failure'; ledger.finish(call.invocationId, outcome);
      pending.get(call.invocationId).done.resolve({ outcome, value: message.result, error: message.error });
    }
    return null;
  }
  if (stopping || !runtime || !agentSocket) throw new Error('PI_RUNTIME_STOPPED');
  if (message.kind === 'turn') {
    if (activeTurn) throw new Error('CONCURRENT_PI_TURN');
    activeTurn = true; const expected = settled + 1;
    try {
      await runtime.prompt(message.content);
      const deadline = Date.now() + 40000;
      while (settled < expected && !stopping) { if (fault) throw fault; if (Date.now() > deadline) throw new Error('PI_TURN_TIMEOUT'); await delay(20); }
      if (stopping) throw new Error('PI_TURN_STOPPED');
      if (fault) throw fault;
      const state = await runtime.getState(); sessionFile = state.sessionFile;
      const entries = await runtime.getEntries();
      const assistant = entries.entries.filter(e => e.role === 'assistant').at(-1);
      observe('turn.finished', { turnId: message.turnId, files: files() });
      return { output: assistant?.text ?? '' };
    } finally { activeTurn = false; }
  }
  if (!activeTurn) throw new Error('NO_ACTIVE_PI_TURN');
  if (message.kind.startsWith('model.')) return rpc(agentSocket, message);
  if (message.kind === 'tool.propose') {
    if (fixture.definition) admitCaseCall(fixture.definition, message.tool, message.input);
    else {
      const expected = expectedCalls(fixture.case).find(c => c.id === message.invocationId);
      if (!expected || expected.name !== message.tool || JSON.stringify(expected.arguments) !== JSON.stringify(message.input)) throw new Error('UNEXPECTED_SCRIPTED_TOOL');
    }
    ledger.propose(message.invocationId, message.tool, message.input);
    const call = { admit: deferred(), done: deferred() }; pending.set(message.invocationId, call);
    void rpc(agentSocket, message).catch(error => {
      // A dead agent must not poison the environment's native worker. Keep it
      // available for final snapshot/disposal and close the callback as unknown.
      call.admit.reject(error);
      if (!stopping) {
        observe('agent.bridge_lost', { invocationId: message.invocationId, error: String(error) });
        fault = error;
        void stopPi().catch(stopError => { fault = stopError; });
      }
    });
    return call.admit.promise;
  }
  if (message.kind === 'tool.dispatch') {
    await ledger.dispatch(message.invocationId, async operationId => {
      const ack = await peer.request('event', { kind: 'operation.dispatch_observed', operationId, logicalCallId: null, parentOperationId: null, data: {} });
      if (ack.kind !== 'event_ack' || stopping) throw new Error('UNCONFIRMED_PI_DISPATCH_ACK');
    });
    observe('callback.dispatch', { invocationId: message.invocationId, operationId: ledger.get(message.invocationId).operationId }); return null;
  }
  throw new Error('UNSUPPORTED_PI_ENV_REQUEST');
}
async function cleanup() {
  if (disposed) return disposed;
  const resources = [];
  try { await stopPi(); } catch (error) { resources.push(`pi-processes:${String(error)}`); }
  try { await server?.close(); } catch { resources.push('pi-bridge'); }
  if (!resources.length && lease) { rmSync(lease, { recursive: true }); if (existsSync(lease)) resources.push(lease); }
  else if (lease) resources.push(lease);
  disposed = { status: resources.length ? 'failed' : 'succeeded', resources }; return disposed;
}
const peer = new AdapterPeer(async frame => {
  try {
    if (frame.kind === 'describe') peer.reply(frame, 'described', { adapterId: 'pi-webdesk.environment', adapterVersion: '0.1.0', capabilities: ['fresh-lease', 'state-snapshot', 'routed-tools', 'verified-cleanup'], tools: nativeToolSchemas, faultModes: [] });
    else if (frame.kind === 'prepare') {
      if (lease) throw new Error('PI_ALREADY_PREPARED');
      fixture = frame.payload.state;
      if (fixture.case === 'declared-v1') {
        caseContract(fixture.definition);
        if (!isDeepStrictEqual(fixture.files, fixture.definition.initialFiles) || fixture.session !== null || fixture.observations.length || Object.keys(fixture.runtime).length) throw new Error('INVALID_PI_INITIAL_CASE_STATE');
      } else if (JSON.stringify(fixture.files) !== JSON.stringify({ 'README.md': seed })) throw new Error('UNSUPPORTED_PI_FIXTURE');
      lease = realpathSync(mkdtempSync('/tmp/trial-pi-native-')); repo = join(lease, 'repo'); environmentSocket = join(lease, 'environment.sock'); agentSocket = join(lease, 'agent.sock');
      for (const name of ['repo', 'home', 'tmp', 'agent', 'sessions']) mkdirSync(join(lease, name), { mode: 0o700 });
      for (const [name, content] of Object.entries(fixture.files)) writeFileSync(join(repo, name), content, { flag: 'wx', mode: 0o600 });
      execFileSync('/usr/bin/git', ['init', '-q', repo], { env: { HOME: join(lease, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', PATH: '/usr/bin:/bin' } });
      const unpacked = unpackRuntime(source, join(lease, 'runtime'));
      observe('runtime.unpacked', { archiveSha256: unpacked.metadata.archiveSha256, inventory: unpacked.metadata.inventory });
      server = await serve(environmentSocket, request);
      peer.reply(frame, 'prepared', { leaseId: randomUUID(), bindings: { environmentSocket, agentSocket }, snapshot: snapshot() });
    } else if (frame.kind === 'execute') {
      const { invocationId, input } = frame.payload.args;
      if (stopping) throw new Error('PI_STOPPED');
      ledger.admit(invocationId, frame.payload.tool, input, frame.payload.operationId);
      observe('callback.admitted', { invocationId, operationId: frame.payload.operationId, files: files() });
      pending.get(invocationId).admit.resolve(null);
      const result = await bounded(pending.get(invocationId).done.promise);
      peer.reply(frame, 'executed', { operationId: frame.payload.operationId, ...result });
    } else if (frame.kind === 'snapshot') {
      await stopPi(); peer.reply(frame, 'snapshotted', { snapshot: snapshot(), error: null });
    } else if (frame.kind === 'dispose') peer.reply(frame, 'disposed', await cleanup());
    else throw new Error('UNSUPPORTED_PI_ENV_FRAME');
  } catch (error) {
    process.stderr.write(`PI_ENVIRONMENT_FAILURE: ${String(error)}\n`);
    // Keep the environment worker available for the coordinator's disposal request.
    peer.notify('environment_error', { message: String(error).slice(0, 4000) });
  }
});
