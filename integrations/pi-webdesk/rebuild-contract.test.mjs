import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from './package-contract.mjs';
import { rebuildContract, selectContract, sourceChanges, assertContinuity } from './rebuild-contract.mjs';

const source = (content='export const enabled = true;') => ({path:'packages/pi-bridge/src/runtime.ts',content,bytes:Buffer.byteLength(content),sha256:hash(content)});
const state = () => ({schemaVersion:'trial-runner/pi-build-state/v1',sources:[source()],fixedInputs:[{root:'runner',path:'package.json',sha256:hash('package')}],compiler:{nodeSha256:hash('node'),entrySha256:hash('entry'),binarySha256:hash('binary')},tooling:[{path:'build-native.mjs',sha256:hash('builder')}],runtimeSha256:hash('runtime'),graphSha256:hash('graph')});
const selection = (sources=[source('export const enabled = false;')]) => ({schemaVersion:'trial-runner/pi-source-selection/v1',parentRecipeSha256:hash('parent'),sources,execution:'not_run'});
test('source selection freezes ordinary bytes and permits no-op selection',()=>{
  const p=rebuildContract('state',state()), s=selectContract(selection(),p,hash('parent'));
  assert.equal(sourceChanges(p.sources,s.sources).length,1);
  assert.deepEqual(sourceChanges(p.sources,selectContract(selection(p.sources),p,hash('parent')).sources),[]);
  assertContinuity(p,{...p,sources:s.sources});
});
for(const [name,edit] of Object.entries({
  version:v=>{v.schemaVersion='future';}, extra:v=>{v.approved=true;}, content:v=>{v.sources[0].content='different';},
  traversal:v=>{v.sources[0].path='packages/pi-bridge/src/../runtime.ts';}, outside:v=>{v.sources[0].path='apps/daemon/src/runtime.ts';},
  dependency:v=>{v.sources[0].path='node_modules/pi/index.ts';}, duplicate:v=>{v.sources.push(v.sources[0]);},
  execution:v=>{v.execution='finished';},
}))test(`selection rejects ${name}`,()=>{const s=selection();edit(s);assert.throws(()=>rebuildContract('selection',s));});
test('selection rejects wrong parent and changed source inventory',()=>{
  assert.throws(()=>selectContract(selection(),state(),hash('other')),/PARENT_MISMATCH/);
  const s=selection();s.sources[0].path='packages/pi-bridge/src/other.ts';assert.throws(()=>selectContract(s,state(),hash('parent')),/INVENTORY_CHANGED/);
});
for(const key of ['compiler','tooling','fixedInputs','runtimeSha256','graphSha256'])test(`continuity rejects changed ${key}`,()=>{
  const p=state(),c=structuredClone(p);c[key]=key.endsWith('Sha256')?hash('changed'):[];assert.throws(()=>assertContinuity(p,c),/CHANGED/);
});
test('state rejects duplicate fixed inputs, absolute paths and mutable/fixed overlap',()=>{
  for(const edit of [s=>s.fixedInputs.push(s.fixedInputs[0]),s=>{s.fixedInputs[0].path='/outside';},s=>{s.fixedInputs=[{root:'webdesk',path:s.sources[0].path,sha256:s.sources[0].sha256}];}]){
    const s=state();edit(s);assert.throws(()=>rebuildContract('state',s));
  }
});
test('lineage rejects unchanged deltas and unsafe preserved files',()=>{
  const v={schemaVersion:'trial-runner/pi-rebuild/v1',parentRecipeSha256:hash('p'),parentStateSha256:hash('s'),parentInputSha256:hash('i'),inputSha256:hash('j'),sourceChanges:[{path:source().path,before:hash('a'),after:hash('b')}],preservedFiles:[{path:'profile.json',bytes:1,sha256:hash('x')}],execution:'not_run'};
  rebuildContract('lineage',v);v.sourceChanges[0].after=v.sourceChanges[0].before;assert.throws(()=>rebuildContract('lineage',v),/EMPTY/);
  v.sourceChanges=[];v.preservedFiles[0].path='../profile.json';assert.throws(()=>rebuildContract('lineage',v));
});
