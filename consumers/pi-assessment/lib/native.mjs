import Ajv from 'ajv';
import { hash, parseJson, readRegular, inventory, safeRelative, requireThat } from './io.mjs';
import { shape, same, unique } from './contracts.mjs';

const MB=1024*1024;
const keywords=new Set(['$schema','title','description','type','properties','required','additionalProperties','items','minItems','maxItems','minLength','maxLength','minimum','maximum','enum','const','anyOf','oneOf']);
function dataValidator(schema) {
  let nodes=0;
  function visit(s,depth=0) {
    requireThat(s && typeof s==='object' && !Array.isArray(s) && ++nodes<=2000 && depth<=24,'UNSUPPORTED_DATA_SCHEMA');
    for(const key of Object.keys(s))requireThat(keywords.has(key),'UNSUPPORTED_DATA_SCHEMA');
    for(const child of Object.values(s.properties??{}))visit(child,depth+1);
    if(s.items)visit(s.items,depth+1);
    if(typeof s.additionalProperties==='object')visit(s.additionalProperties,depth+1);
    for(const child of [...(s.anyOf??[]),...(s.oneOf??[])])visit(child,depth+1);
  }
  visit(schema);return new Ajv({strict:true,validateFormats:false}).compile(schema);
}
export const identityFor=m=>({runId:m.runId,trialId:m.trialId,scenarioId:m.scenarioId,repetition:m.repetition,candidateArtifactSha256:m.identity.agentArtifactSha256,environmentArtifactSha256:m.identity.environmentArtifactSha256,planSha256:m.planSha256,scenarioSha256:m.scenarioSha256,fixtureSha256:m.fixtureSha256});
export function verifyFiles(files, expectedDigest) {
  requireThat(/^[a-f0-9]{64}$/u.test(expectedDigest??''),'EXPECTED_BUNDLE_DIGEST_REQUIRED');
  const bytes=name=>{safeRelative(name);requireThat(files.has(name),'MISSING_FILE');return files.get(name);};
  const json=(name,max=2*MB)=>parseJson(bytes(name),max);
  requireThat(hash(bytes('manifest.json'))===expectedDigest,'BUNDLE_DIGEST_MISMATCH');
  const manifest=shape('manifest',json('manifest.json',8*MB),'native'),m=manifest;
  requireThat(m.parentBundleSha256===null,'UNSUPPORTED_DERIVATIVE');
  requireThat(m.evidence.redactedPaths.length===0,'UNSUPPORTED_REDACTION');
  const paths=m.files.map(f=>safeRelative(f.path));unique(paths,'DUPLICATE_FILE');unique(paths.map(p=>p.toLowerCase()),'CASE_COLLISION');
  same(paths,[...paths].sort(),'UNSORTED_INVENTORY');requireThat(!paths.includes('manifest.json'),'SELF_INVENTORY');
  same([...files.keys()].sort(),[...paths,'manifest.json'].sort(),'FILE_INVENTORY_MISMATCH');
  requireThat(paths.length<=1200 && m.files.reduce((n,f)=>n+f.bytes,0)<=128*MB,'BUNDLE_LIMIT');
  for(const f of m.files)requireThat(bytes(f.path).length===f.bytes&&hash(bytes(f.path))===f.sha256,'FILE_DIGEST_MISMATCH');
  for(const [file,expected]of [['plan.json',m.planSha256],['scenario.json',m.scenarioSha256],['fixture.json',m.fixtureSha256]])requireThat(hash(bytes(file))===expected,'INPUT_IDENTITY_MISMATCH');
  const input=n=>bytes(`inputs/${safeRelative(n)}`),inputJson=(n,max=2*MB)=>parseJson(input(n),max);
  const plan=shape('plan',json('plan.json'),'native'),scenario=shape('scenario',json('scenario.json'),'native'),profile=shape('profile',json('profile.json'),'native');
  requireThat(m.repetition<plan.repetitions,'REPETITION_OUT_OF_RANGE');
  unique(plan.scenarios.map(s=>s.path),'DUPLICATE_SCENARIO');
  unique(scenario.messages.map(s=>s.id),'DUPLICATE_TURN');
  requireThat(scenario.messages.length<=plan.limits.maxTurns,'TURN_LIMIT');
  const declaredScenarios=plan.scenarios.map(s=>({raw:input(s.path),value:shape('scenario',inputJson(s.path),'native')}));
  unique(declaredScenarios.map(s=>s.value.id),'DUPLICATE_SCENARIO_ID');
  requireThat(declaredScenarios.some(s=>s.raw.equals(bytes('scenario.json'))),'SCENARIO_NOT_IN_PLAN');
  requireThat(input(scenario.fixture??plan.environment.initialState).equals(bytes('fixture.json')),'FIXTURE_REFERENCE_MISMATCH');
  requireThat(input(plan.evidenceProfile).equals(bytes('profile.json')),'PROFILE_REFERENCE_MISMATCH');
  same(profile,m.evidence.profile,'PROFILE_MISMATCH');requireThat(scenario.id===m.scenarioId,'SCENARIO_ID_MISMATCH');
  requireThat(m.fidelity.boundary===profile.captureBoundary&&m.fidelity.modelCoverage===profile.modelCapture,'BOUNDARY_MISMATCH');
  const validators={};
  for(const role of ['agent','environment']) {
    const desc=plan[role];requireThat(desc.cwd==='.'&&desc.argv.length===2&&desc.argv[0]==='node','UNSUPPORTED_LAUNCH_DECLARATION');safeRelative(desc.argv[1]);
    unique(desc.capabilities,'DUPLICATE_CAPABILITY');
    const raw=input(desc.artifactManifest),art=shape('artifact',parseJson(raw),'native');
    requireThat(raw.equals(bytes(`${role}-artifact.json`))&&hash(raw)===m.identity[`${role}ArtifactSha256`],'ARTIFACT_IDENTITY_MISMATCH');
    const selected=art.files.map(f=>safeRelative(f.path));unique(selected,'DUPLICATE_ARTIFACT_FILE');same(selected,[...selected].sort(),'UNSORTED_ARTIFACT');
    requireThat(selected.includes(desc.argv[1]),'ENTRYPOINT_NOT_PINNED');
    for(const f of art.files)requireThat(input(f.path).length===f.bytes&&hash(input(f.path))===f.sha256,'ARTIFACT_FILE_MISMATCH');
    validators[role]=dataValidator(inputJson(desc.settingsSchema,64*1024));requireThat(validators[role](desc.settings),'SETTINGS_SCHEMA_MISMATCH');
  }
  const fixtureValidator=dataValidator(inputJson(plan.environment.fixtureSchema,64*1024));requireThat(fixtureValidator(json('fixture.json')),'FIXTURE_SCHEMA_MISMATCH');
  const tools=shape('tools',inputJson(plan.environment.toolSchemas),'native');unique(tools.map(t=>t.name),'DUPLICATE_TOOL');
  const toolValidators=new Map(tools.map(t=>[t.name,{input:dataValidator(t.input),output:dataValidator(t.output)}]));
  const initial=files.has('initial-state.json')?shape('snapshot',json('initial-state.json',16*MB),'native'):null;
  const final=files.has('final-state.json')?shape('snapshot',json('final-state.json',16*MB),'native'):null;
  for(const s of [initial,final])if(s){requireThat(Number.isFinite(Date.parse(s.observedAt)),'INVALID_SNAPSHOT_TIME');requireThat(fixtureValidator(s.state),'SNAPSHOT_SCHEMA_MISMATCH');}
  const log=new TextDecoder('utf-8',{fatal:true}).decode(bytes('events.ndjson'));requireThat(log.endsWith('\n'),'TRUNCATED_JOURNAL');
  const lines=log.slice(0,-1).split('\n');requireThat(lines.length<=plan.limits.maxEvents,'EVENT_LIMIT');
  const events=lines.map(line=>shape('event',parseJson(Buffer.from(line),2*MB),'native'));
  requireThat(events.length>=2 && events[0].kind==='trial.started'&&events.at(-1).kind==='trial.terminal','INVALID_JOURNAL_BOUNDARY');
  same(events[0].payload,{scenarioId:m.scenarioId,repetition:m.repetition},'TRIAL_START_MISMATCH');same(events.at(-1).payload,{execution:m.execution,reason:m.reason},'TRIAL_END_MISMATCH');
  const operations=new Map();let active=null,userCount=0,assistantCount=0;
  const gaps=new Set();
  for(const [i,e]of events.entries()) {
    requireThat(e.sequence===i&&e.runId===m.runId&&e.trialId===m.trialId,'EVENT_IDENTITY_OR_ORDER');
    requireThat(Number.isFinite(Date.parse(e.recordedAt)),'INVALID_EVENT_TIME');
    requireThat(e.kind!=='trial.started'||i===0,'DUPLICATE_START');requireThat(e.kind!=='trial.terminal'||i===events.length-1,'EARLY_TERMINAL');
    if(e.kind==='user.turn') {requireThat(e.source==='runner_observed'&&active===null,'USER_TURN_ORDER');const turn=scenario.messages[userCount++];requireThat(turn&&turn.id===e.turnId&&turn.content===e.payload.content,'USER_TURN_MISMATCH');active=e.turnId;}
    if(e.kind==='assistant.turn') {
      requireThat(e.source==='candidate_claim'&&e.turnId===active&&active!==null,'ASSISTANT_TURN_ORDER');assistantCount++;
      if(profile.modelCapture==='accounted') {
        const modelIds=[...operations].filter(([,o])=>o.turnId===active&&o.summary.boundary==='model').map(([id])=>id).sort();
        if(e.payload.modelOperations===undefined||e.payload.modelOperations===null)gaps.add('model_turn_coverage_missing');
        else same([...e.payload.modelOperations].sort(),modelIds,'MODEL_TURN_COVERAGE_MISMATCH');
      }
      active=null;
    }
    if(e.kind==='capture.gap') {requireThat(e.source!=='candidate_claim','UNTRUSTED_CAPTURE_GAP');gaps.add(e.payload.reason);}
    if(!e.kind.startsWith('operation.'))continue;
    requireThat(e.operationId!==null&&e.source!=='candidate_claim','INVALID_OPERATION_SOURCE');
    if(e.kind==='operation.dispatch_intent') {
      requireThat(!operations.has(e.operationId)&&e.turnId===active&&active!==null,'INVALID_OPERATION_INTENT');
      const p=e.payload;
      requireThat(['tool','model'].includes(p.boundary),'UNSUPPORTED_OPERATION_BOUNDARY');
      requireThat(p.boundary==='tool'?p.owner==='runner'&&e.source==='runner_observed':['agent','environment'].includes(p.owner)&&e.source===(p.owner==='agent'?'adapter_reported':'environment_observed'),'OPERATION_OWNER_MISMATCH');
      if(e.parentOperationId!==null)requireThat(operations.has(e.parentOperationId),'UNKNOWN_PARENT_OPERATION');
      if(p.boundary==='model')shape('modelRequest',p.args,'native');
      else requireThat(toolValidators.get(p.name)?.input(p.args),'TOOL_ARGUMENTS_MISMATCH');
      operations.set(e.operationId,{summary:{id:e.operationId,logicalCallId:e.logicalCallId,boundary:p.boundary,owner:p.owner,observed:false,outcome:null},turnId:e.turnId,parent:e.parentOperationId,intent:e,dispatch:null,finish:null});
    } else {
      const op=operations.get(e.operationId);requireThat(op&&op.summary.outcome===null,'UNKNOWN_OR_CLOSED_OPERATION');
      requireThat(e.turnId===op.turnId&&e.logicalCallId===op.summary.logicalCallId&&e.parentOperationId===op.parent,'OPERATION_CORRELATION_MISMATCH');
      const observedSource=op.summary.boundary==='tool'||op.summary.owner==='environment'?'environment_observed':'adapter_reported';
      if(e.kind==='operation.dispatch_observed') {requireThat(e.source===observedSource,'DISPATCH_SOURCE_MISMATCH');requireThat(!op.summary.observed,'DUPLICATE_DISPATCH');op.summary.observed=true;op.dispatch=e;}
      else {
        const outcome=e.payload.outcome;requireThat(!['known_result','known_failure'].includes(outcome)||op.summary.observed,'UNOBSERVED_RESULT');requireThat(outcome!=='not_dispatched'||!op.summary.observed,'FALSE_NONDISPATCH');
        requireThat(e.source===observedSource||(['not_dispatched','outcome_unknown'].includes(outcome)&&e.source==='runner_observed'),'OUTCOME_SOURCE_MISMATCH');
        if(op.summary.boundary==='tool'&&outcome==='known_result')requireThat(toolValidators.get(op.intent.payload.name).output(e.payload.value),'TOOL_RESULT_MISMATCH');
        if(op.summary.boundary==='model'&&profile.required.modelUsage&&outcome!=='not_dispatched'&&(e.payload.model?.usage?.source!=='provider_reported'||e.payload.model?.usage?.inputTokens==null||e.payload.model?.usage?.outputTokens==null))gaps.add('model_usage_missing');
        op.summary.outcome=outcome;op.finish=e;
      }
    }
  }
  requireThat([...operations.values()].every(o=>o.summary.outcome!==null),'OPEN_OPERATION');same([...operations.values()].map(o=>o.summary),m.operations,'OPERATION_SUMMARY_MISMATCH');
  const frame=(name,kind)=>{
    if(!files.has(name))return null;const value=shape('frame',json(name,16*MB),'native');requireThat(value.trialId===m.trialId&&value.kind===kind,'OBSERVATION_IDENTITY_MISMATCH');return value.payload;
  };
  const described=frame('environment-described.json','described'),prepared=frame('environment-prepared.json','prepared'),ready=frame('agent-ready.json','ready'),disposed=frame('environment-disposed.json','disposed');frame('agent-stopped.json','stopped');
  for(const [role,payload]of [['agent',ready],['environment',described]])if(payload){requireThat(payload.adapterId===plan[role].adapterId&&payload.adapterVersion===plan[role].adapterVersion,'OBSERVED_ADAPTER_MISMATCH');same(payload.capabilities,plan[role].capabilities,'OBSERVED_CAPABILITIES_MISMATCH');}
  if(ready)requireThat(ready.artifactSha256===m.identity.agentArtifactSha256&&ready.modelCapture===profile.modelCapture,'OBSERVED_ARTIFACT_MISMATCH');
  if(described)same(described.tools,tools,'OBSERVED_TOOLS_MISMATCH');
  if(prepared)same(prepared.snapshot,initial,'INITIAL_SNAPSHOT_MISMATCH');
  requireThat(m.cleanup===(disposed?.status??'unknown'),'CLEANUP_MISMATCH');if(disposed?.status==='succeeded')requireThat(disposed.resources.length===0,'CLEANUP_RESOURCES_REMAIN');
  if(userCount)requireThat(ready&&prepared&&described,'MISSING_PREWORK_OBSERVATIONS');
  if(m.execution==='not_started')gaps.add('candidate_not_started');
  if(['environment_error','adapter_error','protocol_error','runner_error'].includes(m.execution))gaps.add('infrastructure_error');
  if(profile.required.initialState&&!initial)gaps.add('initial_state_missing');if(profile.required.finalState&&!final)gaps.add('final_state_missing');
  if(profile.required.stableFinalState&&(!final?.stable||final.pendingOperations.length))gaps.add('final_state_not_stable');
  if(profile.required.conversation&&m.execution==='finished'&&(userCount!==scenario.messages.length||assistantCount!==scenario.messages.length))gaps.add('conversation_incomplete');
  if(profile.modelCapture==='accounted'&&active!==null)gaps.add('model_turn_coverage_missing');
  if(m.execution==='agent_error')requireThat(events.some(e=>e.kind==='agent.error'),'MISSING_AGENT_ERROR');
  if(['timed_out','cancelled'].includes(m.execution))requireThat(events.some(e=>e.kind==='runtime.error'&&e.payload.execution===m.execution),'MISSING_INTERRUPTION');
  for(const gap of gaps)requireThat(m.evidence.gaps.includes(gap),'UNDECLARED_EVIDENCE_GAP');
  unique(m.evidence.gaps,'DUPLICATE_GAP');requireThat((m.evidence.gaps.length===0)===(m.evidence.state==='complete'),'EVIDENCE_STATE_MISMATCH');
  const payloadPaths=['events.ndjson','initial-state.json','final-state.json','environment-described.json','environment-prepared.json','agent-ready.json','agent-stopped.json','environment-disposed.json'];
  requireThat(m.files.filter(f=>payloadPaths.includes(f.path)).reduce((n,f)=>n+f.bytes,0)<=plan.limits.maxRecordedBytes,'CAPTURE_LIMIT');
  return {manifest,plan,scenario,profile,initial,final,events,operations,files,digest:expectedDigest};
}
export async function readBundle(root,digest) {
  const paths=await inventory(root),files=new Map();let total=0;
  for(const path of paths){const bytes=await readRegular(root,path,path==='events.ndjson'?64*MB:16*MB);total+=bytes.length;requireThat(total<=136*MB,'BUNDLE_LIMIT');files.set(path,bytes);}
  return verifyFiles(files,digest);
}
export function mappingFor(v) {
  const m=v.manifest,roles=[['conversation','events.ndjson'],['tool-trajectory','events.ndjson'],['runtime-events','events.ndjson'],['initial-state','initial-state.json'],['final-state','final-state.json']];
  return {schemaVersion:'trial-runner/assessment-input/v1',bundleSha256:v.digest,trialId:m.trialId,scenarioId:m.scenarioId,repetition:m.repetition,candidateArtifactSha256:m.identity.agentArtifactSha256,evidenceState:m.evidence.state,boundary:m.fidelity.boundary,authenticity:'not_attested',inputs:roles.flatMap(([role,path])=>{const f=m.files.find(f=>f.path===path);return f?[{role,path,sha256:f.sha256}]:[];}),gaps:[...m.evidence.gaps],externalCriterionRefs:[...v.scenario.externalCriterionRefs]};
}
export function verifyMapping(mapping,v) {shape('assessment',mapping,'native');same(mapping,mappingFor(v),'MAPPING_MISMATCH');return mapping;}
