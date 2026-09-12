import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureInputs } from './build-state.mjs';
import { buildWorker } from './rebuild.mjs';

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'pi-rebuild-test-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'packages/pi-bridge/src'),{recursive:true});return root;}
test('capture retains source bytes and rejects a later mutation',async t=>{
  const root=await fixture(t),file=join(root,'packages/pi-bridge/src/a.ts');await writeFile(file,'export const a = 1;');
  const capture=captureInputs(root);assert.equal((await capture.load(file)).toString(),'export const a = 1;');await writeFile(file,'export const a = 2;');
  await assert.rejects(capture.unchanged(),/SOURCE_CHANGED/);
});
test('selected source bytes are used without reading edited source again',async t=>{
  const root=await fixture(t),file=join(root,'packages/pi-bridge/src/a.ts');await writeFile(file,'throw new Error("must not execute")');
  const capture=captureInputs(root,{sources:[{path:'packages/pi-bridge/src/a.ts',content:'export const a = 2;'}]});
  assert.equal((await capture.load(file)).toString(),'export const a = 2;');await capture.unchanged();
  await assert.rejects(capture.load(join(root,'packages/pi-bridge/src/new.ts')),/INVENTORY_CHANGED/);
});
test('capture rejects source symlinks and detects new resolution metadata',async t=>{
  const root=await fixture(t),file=join(root,'packages/pi-bridge/src/a.ts'),outside=join(root,'outside.ts');await writeFile(outside,'export {};');await symlink(outside,file);
  await assert.rejects(captureInputs(root).load(file),/UNSAFE_SOURCE_FILE/);await rm(file);await writeFile(file,'export {};');
  const capture=captureInputs(root);await capture.load(file);await writeFile(join(root,'packages/pi-bridge/src/package.json'),'{}');await assert.rejects(capture.unchanged(),/RESOLUTION_CHANGED/);
});
test('bounded worker retains compiler failure output',async t=>{
  const root=await fixture(t);await assert.rejects(buildWorker(['-e','process.stderr.write("compiler failure"); process.exit(3)'],root),/PI_BUILD_FAILED_3/);
  assert.equal((await readFile(join(root,'build-worker.log'),'utf8')),'compiler failure');
});
test('bounded worker stops on deadline and retains diagnostics',async t=>{
  const root=await fixture(t);await assert.rejects(buildWorker(['-e','setInterval(()=>{},1000)'],root,{timeoutMs:100}),/PI_BUILD_TIMEOUT/);
});
test('bounded worker obeys cancellation before and during work',async t=>{
  const root=await fixture(t),abort=new AbortController();abort.abort();await assert.rejects(buildWorker(['-e','process.exit(0)'],root,{signal:abort.signal}),/PI_BUILD_CANCELLED/);
  const active=new AbortController(),timer=setTimeout(()=>active.abort(),100);t.after(()=>clearTimeout(timer));
  await assert.rejects(buildWorker(['-e','setInterval(()=>{},1000)'],root,{signal:active.signal}),/PI_BUILD_CANCELLED/);
});
