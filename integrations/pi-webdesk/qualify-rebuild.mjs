import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access, cp } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { checkPiConnection, selectPiSource, rebuildPi } from './rebuild.mjs';
import { STATE, LINEAGE, preserved, json } from './rebuild-contract.mjs';
import { verifyFixedInputs } from './build-state.mjs';
import { hash } from './package-contract.mjs';
import { jsonBytes } from '../../dist/src/core/files.js';
import { runPlan } from '../../dist/src/core/run.js';
import { resolvePlan } from '../../dist/src/core/plan.js';
import { verifyBundle } from '../../dist/src/contracts/verify.js';

if(process.argv.length!==5)throw new Error('Usage: qualify-rebuild.mjs <parent-connection.json> <installed-webdesk> <new-output>');
const parentFile=resolve(process.argv[2]),runtime=resolve(process.argv[3]),out=resolve(process.argv[4]);
await mkdir(out,{mode:0o700});
const startedAt=new Date().toISOString(),timings={},checks={},runs=[],errors=[];
const marker='The operator must approve a new attempt.';
const step=async(name,fn)=>{process.stdout.write(`${name}\n`);const at=Date.now();try{return await fn();}finally{timings[name]=Date.now()-at;}};
const controller=new AbortController(),cancel=()=>controller.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
async function execute(name,plan,changed){
  const result=await runPlan(plan,{requestId:name,store:join(out,'store'),signal:controller.signal,...(name.startsWith('candidate-')?{rerunOf:name.replace('candidate-','parent-')}:{})});
  await writeFile(join(out,`${name}-run.json`),jsonBytes(result));
  const trials=[];runs.push({name,root:result.root,index:result.index,trials});
  assert.equal(result.index.exitCode,0);
  for(const slot of result.index.trials){
    const root=join(result.root,slot.path),verified=await verifyBundle(root,slot.bundleSha256),m=verified.manifest;
    const initial=json(await readFile(join(root,'initial-state.json'))),final=json(await readFile(join(root,'final-state.json')));
    const events=(await readFile(join(root,'events.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(m.execution,'finished');assert.equal(m.evidence.state,'complete');assert.equal(m.cleanup,'succeeded');
    assert.deepEqual(Object.keys(initial.state.files),['README.md']);assert.equal(final.stable,true);assert.deepEqual(final.state.runtime.remaining,[]);await assert.rejects(access(final.state.runtime.lease),{code:'ENOENT'});
    const tools=m.operations.filter(o=>o.boundary==='tool');
    if(name.endsWith('denied')){
      assert.deepEqual(final.state.files,initial.state.files);assert.equal(tools.length,1);assert.equal(tools[0].observed,false);assert.equal(tools[0].outcome,'not_dispatched');
      assert.equal(final.state.session.raw.includes(marker),changed);
      const requests=events.filter(e=>e.kind==='operation.dispatch_intent'&&e.payload.boundary==='model');
      assert.equal(JSON.stringify(requests.at(-1).payload.args.input).includes(marker),changed);
    }else{assert.equal(final.state.files['notes.txt'],'beta\n');assert.equal(tools.length,5);assert.ok(tools.every(o=>o.observed&&o.outcome==='known_result'));}
    trials.push({path:root,sha256:slot.bundleSha256,execution:m.execution,evidence:m.evidence.state,cleanup:m.cleanup,sessionId:final.state.session.sessionId,files:final.state.files,changedExplanationObserved:final.state.session.raw.includes(marker)});
  }
  return result;
}
try{
  const parent=await step('check-parent',()=>checkPiConnection(parentFile));
  await step('parent-baseline',()=>execute('parent-baseline',join(parent.root,'baseline-plan.json'),false));
  await step('parent-denied',()=>execute('parent-denied',join(parent.root,'denied-plan.json'),false));
  const source=join(out,'edited-source');await mkdir(source);
  for(const s of parent.state.sources){await mkdir(dirname(join(source,s.path)),{recursive:true});await writeFile(join(source,s.path),s.content);}
  const policy=join(source,'packages/pi-bridge/extensions/pita-policy.ts'),before=await readFile(policy,'utf8');
  const needle='approval was denied, cancelled, or timed out';assert.equal(before.split(needle).length,2);
  await writeFile(policy,before.replace(needle,`${needle}. ${marker}`));
  await writeFile(join(out,'source-edit.json'),jsonBytes({path:'packages/pi-bridge/extensions/pita-policy.ts',before:hash(before),after:hash(await readFile(policy)),change:`Append "${marker}" to the original policy's denial explanation.`,scope:'Owned selected-source copy only'}));
  const selection=await step('select-source',()=>selectPiSource(parentFile,source,join(out,'selection.json'),hash(parent.bytes)));
  // Prove a later edit in the working source cannot change the frozen selection.
  await writeFile(policy,before.replace(needle,`${needle}. This later unsaved selection is excluded.`));
  const built=await step('build-candidate',()=>rebuildPi(parentFile,selection.selection,runtime,join(out,'candidate'),{expectedDigest:hash(parent.bytes),signal:controller.signal}));
  const candidate=await checkPiConnection(built.recipe,built.recipeSha256);await writeFile(join(out,'rebuild-result.json'),jsonBytes(built));
  assert.deepEqual(built.record.sourceChanges.map(f=>f.path),['packages/pi-bridge/extensions/pita-policy.ts']);
  assert.ok(candidate.state.sources.find(f=>f.path.endsWith('pita-policy.ts')).content.includes(marker));checks.frozenSelectionUsed=true;
  assert.deepEqual(preserved(parent.recipe),preserved(candidate.recipe));checks.trialConfigurationPreserved=true;
  for(const f of preserved(parent.recipe))assert.deepEqual(candidate.files.get(f.path),parent.files.get(f.path));
  assert.notEqual(hash(parent.files.get('policy.mjs')),hash(candidate.files.get('policy.mjs')));checks.candidatePolicyChanged=true;
  await step('candidate-baseline',()=>execute('candidate-baseline',join(candidate.root,'baseline-plan.json'),false));
  await step('candidate-denied',()=>execute('candidate-denied',join(candidate.root,'denied-plan.json'),true));
  assert.equal(new Set(runs.flatMap(r=>r.trials.map(t=>t.sessionId))).size,6);checks.distinctSessions=true;
  await assert.rejects(runPlan(join(candidate.root,'baseline-plan.json'),{requestId:'parent-baseline',store:join(out,'store')}),/conflicts/);checks.changedInputsConflict=true;
  const duplicate=await runPlan(join(parent.root,'baseline-plan.json'),{requestId:'parent-baseline',store:join(out,'store')});assert.equal(duplicate.duplicate,true);assert.equal(duplicate.root,runs[0].root);checks.duplicateDoesNotReplay=true;
  assert.deepEqual(await readFile(parentFile),parent.bytes);checks.parentPreserved=true;
  // Continuation starts from the retained current source snapshot, not the original checkout.
  for(const s of candidate.state.sources)await writeFile(join(source,s.path),s.content);
  const noop=await selectPiSource(built.recipe,source,join(out,'noop-selection.json'),built.recipeSha256);assert.deepEqual(noop.sourceChanges,[]);
  const next=await step('build-noop-descendant',()=>rebuildPi(built.recipe,noop.selection,runtime,join(out,'descendant'),{signal:controller.signal}));
  const descendant=await checkPiConnection(next.recipe,next.recipeSha256);assert.deepEqual(next.record.sourceChanges,[]);assert.deepEqual(descendant.files.get('policy.mjs'),candidate.files.get('policy.mjs'));checks.chainedNoopRebuild=true;
  const bad=structuredClone(json(await readFile(selection.selection)));bad.sources[0].content='export const = ;';bad.sources[0].bytes=Buffer.byteLength(bad.sources[0].content);bad.sources[0].sha256=hash(bad.sources[0].content);
  await writeFile(join(out,'invalid-syntax-selection.json'),jsonBytes(bad));
  await step('reject-invalid-syntax',()=>assert.rejects(rebuildPi(parentFile,join(out,'invalid-syntax-selection.json'),runtime,join(out,'invalid-syntax'),{signal:controller.signal}),/PI_BUILD_FAILED/));
  await assert.rejects(access(join(out,'invalid-syntax/connection.json')),{code:'ENOENT'});checks.invalidSyntaxUnpublished=true;
  const graph=structuredClone(json(await readFile(selection.selection)));graph.sources[0].content="import 'node:net';\n"+graph.sources[0].content;graph.sources[0].bytes=Buffer.byteLength(graph.sources[0].content);graph.sources[0].sha256=hash(graph.sources[0].content);
  await writeFile(join(out,'changed-graph-selection.json'),jsonBytes(graph));
  await step('reject-new-import',()=>assert.rejects(rebuildPi(parentFile,join(out,'changed-graph-selection.json'),runtime,join(out,'changed-graph'),{signal:controller.signal}),/PI_BUILD_FAILED/));
  assert.match(await readFile(join(out,'changed-graph/build-worker.log'),'utf8'),/GRAPHSHA256_CHANGED/);await assert.rejects(access(join(out,'changed-graph/connection.json')),{code:'ENOENT'});checks.newImportRejected=true;
  const fixed=structuredClone(parent.state);fixed.fixedInputs.find(f=>f.sha256!==null).sha256='0'.repeat(64);assert.throws(()=>verifyFixedInputs(fixed,runtime),/PI_FIXED_INPUT_CHANGED/);checks.fixedDriftRejected=true;
  const tampered=join(out,'tampered-copy');await cp(candidate.root,tampered,{recursive:true});
  const lineage=json(await readFile(join(tampered,LINEAGE)));lineage.sourceChanges=[];await writeFile(join(tampered,LINEAGE),jsonBytes(lineage));
  const recipe=json(await readFile(join(tampered,'connection.json'))),item=recipe.files.find(f=>f.path===LINEAGE);const raw=await readFile(join(tampered,LINEAGE));item.sha256=hash(raw);item.bytes=raw.length;await writeFile(join(tampered,'connection.json'),jsonBytes(recipe));
  await assert.rejects(checkPiConnection(join(tampered,'connection.json')),/LINEAGE_MISMATCH/);checks.rehashedFalseLineageRejected=true;
  async function repin(directory,names,editRecipe=()=>{}) {
    const r=json(await readFile(join(directory,'connection.json')));
    for(const name of names){const b=await readFile(join(directory,name)),f=r.files.find(f=>f.path===name);f.bytes=b.length;f.sha256=hash(b);}
    editRecipe(r);await writeFile(join(directory,'connection.json'),jsonBytes(r));
  }
  const falseParent=join(out,'false-parent-copy');await cp(candidate.root,falseParent,{recursive:true});
  const p=json(await readFile(join(falseParent,'pi-parent-connection.json')));p.sources[0].sha256='0'.repeat(64);await writeFile(join(falseParent,'pi-parent-connection.json'),jsonBytes(p));
  const parentDigest=hash(jsonBytes(p));
  for(const name of ['pi-selection.json',LINEAGE]){const v=json(await readFile(join(falseParent,name)));v.parentRecipeSha256=parentDigest;await writeFile(join(falseParent,name),jsonBytes(v));}
  await repin(falseParent,['pi-parent-connection.json','pi-selection.json',LINEAGE]);await assert.rejects(checkPiConnection(join(falseParent,'connection.json')),/PARENT_SOURCE_MISMATCH/);checks.parentSourceContradictionRejected=true;
  const drift=join(out,'configuration-drift-copy');await cp(candidate.root,drift,{recursive:true});
  const changedPlan=json(await readFile(join(drift,'baseline-plan.json')));changedPlan.repetitions=1;await writeFile(join(drift,'baseline-plan.json'),jsonBytes(changedPlan));
  const resolved=await resolvePlan(join(drift,'baseline-plan.json')),l=json(await readFile(join(drift,LINEAGE)));l.inputSha256=resolved.inputSha256;await writeFile(join(drift,LINEAGE),jsonBytes(l));
  await repin(drift,['baseline-plan.json',LINEAGE],r=>{r.plan.inputSha256=resolved.inputSha256;});await assert.rejects(checkPiConnection(join(drift,'connection.json')),/TRIAL_CONFIGURATION_CHANGED/);checks.rehashedConfigurationDriftRejected=true;
  assert.ok(isDeepStrictEqual(json(parent.files.get(STATE)).sources,parent.state.sources));
}catch(error){errors.push(String(error.stack));process.stderr.write(String(error.stack)+'\n');process.exitCode=controller.signal.aborted?130:1;}
finally{
  process.off('SIGINT',cancel);process.off('SIGTERM',cancel);
  await writeFile(join(out,'qualification.json'),jsonBytes({version:1,kind:'pi-source-rebuild-qualification',startedAt,finishedAt:new Date().toISOString(),parentFile,runtime,timings,checks,runs,errors,providerRequests:0,effortScope:'Automated durations; one intentional source edit in an owned copy; existing installed dependencies. No human effort or agent-quality claim.'}));
}
