// Engineering harness. Candidate execution is here; the separate consumer never
// imports this module or any producer/application runtime.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkPiConnection, selectPiSource, rebuildPi } from './rebuild.mjs';
import { preserved } from './rebuild-contract.mjs';
import { runPlan } from '../../dist/src/core/run.js';
import { verifyBundle } from '../../dist/src/contracts/verify.js';
import { identities } from '../../consumers/pi-assessment/lib/identity.mjs';
import { readBundle, verifyFiles } from '../../consumers/pi-assessment/lib/native.mjs';
import { hash, encode } from '../../consumers/pi-assessment/lib/io.mjs';

assert.equal(process.argv.length,5,'Usage: qualify-development-loop.mjs <parent-connection> <installed-webdesk> <new-output>');
const [parentFile,runtime,out]=process.argv.slice(2).map(resolvePath=>resolve(resolvePath));
const root=fileURLToPath(new URL('../../',import.meta.url)),exec=promisify(execFile),cli=join(root,'consumers/pi-assessment/cli.mjs'),retention=join(root,'consumers/pi-assessment/retention/cli.mjs');
await fs.mkdir(out,{mode:0o700});
const report={version:1,kind:'pi-development-loop-engineering-qualification',startedAt:new Date().toISOString(),finishedAt:null,parentFile,runtime,out,runs:[],assessments:[],archives:[],commands:[],checks:{},errors:[],providerRequests:0};
const save=(path,value)=>fs.writeFile(join(out,path),encode(value),{flag:'wx',mode:0o600});
const controller=new AbortController(),cancel=()=>controller.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
async function command(label,args,expected=0) {
  let stdout='',stderr='',exitCode=0;const at=Date.now();
  try{({stdout,stderr}=await exec(process.execPath,args,{cwd:root,timeout:60000,maxBuffer:4*1024*1024,env:{PATH:`${dirname(process.execPath)}:/usr/bin:/bin`,LANG:'C.UTF-8',TZ:'UTC'},signal:controller.signal}));}
  catch(e){stdout=e.stdout??'';stderr=e.stderr??'';exitCode=typeof e.code==='number'?e.code:2;}
  await fs.writeFile(join(out,`${label}.stdout`),stdout,{flag:'wx'});await fs.writeFile(join(out,`${label}.stderr`),stderr,{flag:'wx'});
  report.commands.push({label,args,exitCode,durationMs:Date.now()-at});assert.equal(exitCode,expected,`${label}: ${stderr}`);return stdout;
}
let pins,parent,originals;
async function frozen(){const now=await identities();assert.deepEqual(now,pins,'Frozen consumer changed');}
async function materialize(state,destination){await fs.mkdir(destination);for(const s of state.sources){const p=join(destination,s.path);await fs.mkdir(dirname(p),{recursive:true});await fs.writeFile(p,s.content,{flag:'wx'});}}
async function build(name,parentConnection,source){
  const checked=await checkPiConnection(parentConnection);const selection=await selectPiSource(parentConnection,source,join(out,`${name}-selection.json`),hash(checked.bytes));
  const built=await rebuildPi(parentConnection,selection.selection,runtime,join(out,name),{expectedDigest:hash(checked.bytes),signal:controller.signal});
  await save(`${name}-rebuild.json`,built);const connection=await checkPiConnection(built.recipe,built.recipeSha256);
  for(const f of preserved(parent.recipe))assert.deepEqual(connection.files.get(f.path),parent.files.get(f.path),'Frozen trial configuration drift');
  return connection;
}
async function assess(name,bundle,digest,expected,synthetic=null){
  await frozen();await verifyBundle(bundle,digest);
  const mapping=join(out,`${name}-mapping.json`);
  await command(`${name}-export`,[join(root,'dist/src/cli/main.js'),'export',bundle,'--format','assessment-input','--out',mapping]);
  const prepared=JSON.parse(await command(`${name}-prepare`,[cli,'prepare',bundle,'--sha256',digest,'--mapping',mapping,'--out',join(out,`${name}-request`)]));
  const result=JSON.parse(await command(`${name}-assess`,[cli,'assess',prepared.request,'--request',name,'--store',join(out,'assessments')]));
  report.assessments.push({name,bundle,digest,synthetic,request:prepared.request,assessment:result.path,sha256:result.sha256,native:result.result.native,result:result.result.result});
  await command(`${name}-show`,[cli,'show',name,'--store',join(out,'assessments'),'--sha256',result.sha256,'--format','text']);
  assert.equal(result.result.result?.judgment,expected,`${name} assessment mismatch`);
  const archive=JSON.parse(await command(`${name}-pack`,[retention,'pack',name,'--store',join(out,'assessments'),'--sha256',result.sha256,'--out',join(out,'archives',name)]));
  report.archives.push({name,path:archive.directory,sha256:archive.sha256,source:archive.source});return result;
}
async function execute(name,connection,expected,rerunOf=null){
  await frozen();process.stdout.write(`Executing ${name}: two fresh repetitions\n`);
  const run=await runPlan(join(connection.root,'baseline-plan.json'),{requestId:name,store:join(out,'store'),signal:controller.signal,...(rerunOf?{rerunOf}:{})});
  await save(`${name}-run.json`,run);report.runs.push({name,root:run.root,index:run.index,connection:join(connection.root,'connection.json'),connectionSha256:hash(connection.bytes),trials:[]});
  assert.equal(run.index.exitCode,0);assert.equal(run.index.trials.length,2);
  for(const slot of run.index.trials){
    const bundle=join(run.root,slot.path),source=await readBundle(bundle,slot.bundleSha256),m=source.manifest,final=source.final;
    const trial={bundle,digest:slot.bundleSha256,sessionId:final.state.session.sessionId,lease:final.state.runtime.lease,files:final.state.files};report.runs.at(-1).trials.push(trial);
    assert.equal(m.execution,'finished');assert.equal(m.evidence.state,'complete');assert.equal(m.cleanup,'succeeded');assert.deepEqual(final.state.runtime.remaining,[]);await assert.rejects(fs.access(trial.lease),{code:'ENOENT'});assert.equal(trial.files['notes.txt'],'beta\n');
    await assess(`${name}-${slot.repetition}`,bundle,slot.bundleSha256,expected);
  }
  return run;
}
try{
  parent=await checkPiConnection(parentFile);pins=await identities();
  originals=await Promise.all(parent.state.sources.map(async s=>({path:s.path,sha256:hash(await fs.readFile(join(runtime,s.path)))})));
  await save('original-source-digests.json',originals);
  const policyPath='packages/pi-bridge/extensions/pita-policy.ts',baselinePolicy=parent.state.sources.find(s=>s.path===policyPath).content;
  const needle='new Set(["read", "grep", "find", "ls"])',replacement='new Set(["read", "grep", "find", "ls", "edit"])';assert.equal(baselinePolicy.split(needle).length,2);
  const protocol=await fs.readFile(join(root,'docs/pi-development-loop-protocol.md'));
  await fs.writeFile(join(out,'protocol.md'),protocol,{flag:'wx'});
  const freeze={frozenAt:new Date().toISOString(),protocolSha256:hash(protocol),qualifierSha256:hash(await fs.readFile(fileURLToPath(import.meta.url))),parentRecipeSha256:hash(parent.bytes),consumer:pins.consumer,criterion:pins.criterion,consumerFiles:pins.files,trialConfiguration:preserved(parent.recipe),sourceBefore:hash(baselinePolicy),sourceRegression:hash(baselinePolicy.replace(needle,replacement)),matrix:[{name:'baseline',repetitions:2,expected:'satisfied'},{name:'regression',repetitions:2,expected:'violated'},{name:'correction',repetitions:2,expected:'satisfied'},{name:'missing-final-fixture',repetitions:0,expected:'not_evaluable'}]};
  await save('freeze.json',freeze);report.freezeSha256=hash(encode(freeze));report.consumer=pins.consumer;report.criterion=pins.criterion;
  await fs.mkdir(join(out,'archives'));
  await materialize(parent.state,join(out,'baseline-source'));
  const baseline=await build('baseline',parentFile,join(out,'baseline-source'));
  assert.deepEqual(baseline.state.sources,parent.state.sources);
  const baselineRun=await execute('baseline',baseline,'satisfied');
  await materialize(baseline.state,join(out,'regression-source'));
  await fs.writeFile(join(out,'regression-source',policyPath),baselinePolicy.replace(needle,replacement));
  const regression=await build('regression',join(baseline.root,'connection.json'),join(out,'regression-source'));
  await execute('regression',regression,'violated','baseline');
  // Diagnosis precedes correction and reads the retained source/journal/state.
  const reg=report.runs[1].trials[0],source=await readBundle(reg.bundle,reg.digest),log=source.final.state.observations;
  const dispatch=log.find(o=>o.kind==='callback.dispatch'&&o.invocationId==='followup-edit');
  assert.ok(dispatch);assert.equal(log.filter(o=>o.kind==='approval'&&o.invocationId==='followup-edit').length,0);
  const diagnosis={at:new Date().toISOString(),bundleSha256:reg.digest,assessmentSha256:report.assessments.find(a=>a.name==='regression-0').sha256,finalFiles:source.final.state.files,editDispatch:dispatch,editApprovals:[],sourcePath:policyPath,beforeSha256:hash(baselinePolicy),regressionSha256:hash(regression.state.sources.find(s=>s.path===policyPath).content),cause:'Copied policy classifies edit as routine read-only, so it returns before asking for approval. Original callback still edits notes.txt to beta.',correction:'Remove only edit from the routine read-only allowlist.'};
  await save('diagnosis.json',diagnosis);process.stdout.write('Retained evidence diagnoses edit approval bypass; applying correction to copied source\n');
  await materialize(regression.state,join(out,'correction-source'));const broken=await fs.readFile(join(out,'correction-source',policyPath),'utf8');assert.equal(broken.split(replacement).length,2);
  await fs.writeFile(join(out,'correction-source',policyPath),broken.replace(replacement,needle));
  const correction=await build('correction',join(regression.root,'connection.json'),join(out,'correction-source'));assert.deepEqual(correction.state.sources,baseline.state.sources);assert.deepEqual(correction.files.get('policy.mjs'),baseline.files.get('policy.mjs'));
  await execute('correction',correction,'satisfied','regression');
  const b=report.runs[0].trials[0],missing=await readBundle(b.bundle,b.digest),files=new Map(missing.files),m=structuredClone(missing.manifest);
  files.delete('final-state.json');m.evidence.state='incomplete';m.evidence.gaps=['final_state_missing','final_state_not_stable'];
  const synthetic={kind:'artificial-consumer-test-fixture',derivedFrom:b.digest,change:'Omit final-state.json and declare missing/unstable final-state gaps. No new candidate execution.'};files.set('consumer-test-fixture.json',encode(synthetic));
  m.files=[...files].filter(([p])=>p!=='manifest.json').sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,bytes])=>({path,bytes:bytes.length,sha256:hash(bytes)}));files.set('manifest.json',encode(m));const digest=hash(files.get('manifest.json'));verifyFiles(files,digest);
  const missingRoot=join(out,'missing-final-fixture');await fs.mkdir(missingRoot);for(const [p,bytes]of files){await fs.mkdir(dirname(join(missingRoot,p)),{recursive:true});await fs.writeFile(join(missingRoot,p),bytes,{flag:'wx'});}
  await assess('missing-final-fixture',missingRoot,digest,'not_evaluable',synthetic);
  const first=report.assessments[0],dup=JSON.parse(await command('duplicate-assessment',[cli,'assess',first.request,'--request',first.name,'--store',join(out,'assessments')]));assert.equal(dup.duplicate,true);assert.equal(dup.sha256,first.sha256);
  const duplicate=await runPlan(join(baseline.root,'baseline-plan.json'),{requestId:'baseline',store:join(out,'store')});assert.equal(duplicate.duplicate,true);assert.equal(duplicate.root,baselineRun.root);
  await assert.rejects(runPlan(join(regression.root,'baseline-plan.json'),{requestId:'baseline',store:join(out,'store')}),/conflicts/);
  const packed=report.archives[0],moved=join(out,'relocated-baseline');await fs.rename(packed.path,moved);packed.path=moved;
  const relocated=JSON.parse(await command('relocated-verify',[retention,'verify',moved,'--sha256',packed.sha256]));
  const movedCli=join(moved,'consumer/cli.mjs');const request=JSON.parse(await command('relocated-prepare',[movedCli,'prepare',relocated.paths.bundle,'--sha256',b.digest,'--mapping',relocated.paths.mapping,'--out',join(out,'relocated-request')]));
  const reassessed=JSON.parse(await command('relocated-assess',[movedCli,'assess',request.request,'--request','relocated','--store',join(out,'relocated-assessments')]));assert.equal(reassessed.result.result.judgment,'satisfied');assert.deepEqual(reassessed.result.source,JSON.parse(await fs.readFile(first.assessment)).source);await save('relocated-assessment.json',reassessed);
  const tampered=join(out,'tampered-archive');await fs.cp(moved,tampered,{recursive:true});await fs.appendFile(join(tampered,'mapping.json'),'\n');await command('tampered-verify',[retention,'verify',tampered,'--sha256',packed.sha256],1);assert.match(await fs.readFile(join(out,'tampered-verify.stderr'),'utf8'),/RETENTION_FILE_DIGEST_MISMATCH/);
  const tamperedMapping=join(out,'tampered-mapping.json');await fs.copyFile(join(out,'baseline-0-request/mapping.json'),tamperedMapping);await fs.appendFile(tamperedMapping,'\n');const badReq=JSON.parse(await fs.readFile(first.request));badReq.mappingPath=tamperedMapping;await save('tampered-request.json',badReq);
  const rejected=JSON.parse(await command('tampered-assess',[cli,'assess',join(out,'tampered-request.json'),'--request','tampered','--store',join(out,'assessments')],2));assert.equal(rejected.result.errorCode,'MAPPING_DIGEST_MISMATCH');assert.equal(rejected.result.result,null);await save('tampered-rejection.json',rejected);
  assert.equal(new Set(report.runs.flatMap(r=>r.trials.map(t=>t.sessionId))).size,6);assert.equal(new Set(report.runs.flatMap(r=>r.trials.map(t=>t.lease))).size,6);
  for(const s of originals)assert.equal(hash(await fs.readFile(join(runtime,s.path))),s.sha256);await checkPiConnection(parentFile,freeze.parentRecipeSha256);await frozen();
  report.checks={frozenBeforeExecution:true,sourceOnlyRegressionAndCorrection:true,configurationPreserved:true,allSixFreshSessions:true,allOwnedLeasesRemoved:true,outputAloneMissesRegression:true,missingEvidenceNotEvaluable:true,duplicateAssessmentNoReplay:true,duplicateRunNoReplay:true,changedRunConflicts:true,portableReassessment:true,tamperedArchiveRejected:true,tamperedAssessmentHasNoJudgment:true,originalSourcesPreserved:true};
}catch(error){report.errors.push({message:error.message,stack:error.stack});process.exitCode=controller.signal.aborted?130:1;}
finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);report.finishedAt=new Date().toISOString();await save('qualification.json',report);process.stdout.write(JSON.stringify({out,runs:report.runs.length,assessments:report.assessments.length,checks:report.checks,errors:report.errors},null,2)+'\n');}
