import { encode, hash } from '../lib/io.mjs';

// Independently constructed protocol fixture. No producer implementation or
// application code is imported or executed.
export function nativeFixture() {
  const code=Buffer.from('throw new Error("Candidate code must never execute during assessment");\n');
  const artifact={schemaVersion:'trial-runner/artifact/v1',files:['agent.js','environment.js'].map(path=>({path,bytes:code.length,sha256:hash(code)}))};
  const profile={schemaVersion:'trial-runner/evidence-profile/v1',id:'consumer-fixture',captureBoundary:'independent fixture',required:{conversation:true,routedToolEvents:true,initialState:true,finalState:true,stableFinalState:true,localArtifactIdentity:true,terminalOperationAccounting:true},modelCapture:'not_applicable',modelCaptureReason:'No model',terminalRules:{not_started:'incomplete',finished:'require_all_declared_observations',agent_error:'require_error_event_and_all_declared_observations',timed_out:'require_timeout_event_and_all_declared_observations',cancelled:'require_cancellation_event_and_all_declared_observations',infrastructure_error:'incomplete'}};
  const adapter=role=>({adapterId:role,adapterVersion:'0.1.0',argv:['node',`${role}.js`],cwd:'.',artifactManifest:`${role}-artifact.json`,capabilities:role==='agent'?['scripted-turns','conversation-events','routed-tools']:['fresh-lease','state-snapshot','routed-tools','verified-cleanup'],settingsSchema:'settings.json',settings:{}});
  const plan={schemaVersion:'trial-runner/plan/v1',id:'consumer-fixture',agent:adapter('agent'),environment:{...adapter('environment'),initialState:'fixture.json',fixtureSchema:'state.schema.json',toolSchemas:'tools.json',clock:{mode:'real',instant:null},faultPlan:[]},scenarios:[{path:'scenario.json'}],repetitions:2,limits:{prepareMs:1000,trialMs:1000,stopGraceMs:1000,snapshotMs:1000,cleanupMs:1000,maxTurns:2,maxFrameBytes:1048576,maxEvents:100,maxRecordedBytes:1048576},evidenceProfile:'profile.json',capturePolicy:{content:'local',externalExport:'explicit'},secretBindings:[]};
  const scenario={schemaVersion:'trial-runner/scenario/v1',id:'acknowledge',description:'Consumer fixture',messages:[{id:'one',role:'user',content:'Acknowledge'}],provenance:{origin:'independent-consumer-fixture',exposure:'development'},externalCriterionRefs:[]};
  const snapshot={state:{acknowledged:true},stable:true,pendingOperations:[],observedAt:'2026-09-11T00:00:00Z'};
  const initial={...snapshot,state:{acknowledged:false}};
  const event=(kind,payload,rest={})=>({schemaVersion:'trial-runner/event/v1',sequence:0,recordedAt:'2026-09-11T00:00:00Z',producerTimestamp:null,runId:'run',trialId:'trial',turnId:null,operationId:null,logicalCallId:null,parentOperationId:null,source:'runner_observed',kind,payload,...rest});
  const events=[event('trial.started',{scenarioId:scenario.id,repetition:0}),event('user.turn',{content:'Acknowledge'},{turnId:'one'}),event('assistant.turn',{content:'Acknowledged'},{turnId:'one',source:'candidate_claim'}),event('trial.terminal',{execution:'finished',reason:null})].map((e,sequence)=>({...e,sequence}));
  const frame=(kind,payload)=>({protocol:'trial-runner/process/v1',trialId:'trial',messageId:`${kind}-reply`,replyTo:`${kind}-request`,kind,payload});
  const files=new Map();
  const put=(name,value)=>files.set(name,encode(value));
  for(const [name,value] of Object.entries({'plan.json':plan,'scenario.json':scenario,'fixture.json':initial.state,'profile.json':profile,'agent-artifact.json':artifact,'environment-artifact.json':artifact})) {put(name,value);put(`inputs/${name}`,value);}
  files.set('inputs/agent.js',code);files.set('inputs/environment.js',code);
  put('inputs/settings.json',{type:'object',additionalProperties:false});put('inputs/state.schema.json',{type:'object',properties:{acknowledged:{type:'boolean'}},required:['acknowledged'],additionalProperties:false});put('inputs/tools.json',[]);
  put('initial-state.json',initial);put('final-state.json',snapshot);
  put('environment-described.json',frame('described',{adapterId:'environment',adapterVersion:'0.1.0',capabilities:plan.environment.capabilities,tools:[],faultModes:[]}));
  put('environment-prepared.json',frame('prepared',{leaseId:'lease',snapshot:initial,bindings:{}}));
  put('agent-ready.json',frame('ready',{adapterId:'agent',adapterVersion:'0.1.0',capabilities:plan.agent.capabilities,artifactSha256:hash(encode(artifact)),modelCapture:'not_applicable'}));
  put('environment-disposed.json',frame('disposed',{status:'succeeded',resources:[]}));
  files.set('events.ndjson',Buffer.from(events.map(JSON.stringify).join('\n')+'\n'));
  const manifest={schemaVersion:'trial-runner/evidence/v1',runId:'run',requestId:'request',trialId:'trial',scenarioId:scenario.id,repetition:0,planSha256:hash(files.get('plan.json')),scenarioSha256:hash(files.get('scenario.json')),fixtureSha256:hash(files.get('fixture.json')),execution:'finished',reason:null,cleanup:'succeeded',evidence:{state:'complete',gaps:[],profile,redactedPaths:[]},identity:{runnerVersion:'0.1.0',nodeVersion:'24.15.0',agentArtifactSha256:hash(encode(artifact)),environmentArtifactSha256:hash(encode(artifact)),strength:'observed_local_artifacts',authenticity:'not_attested'},fidelity:{boundary:profile.captureBoundary,mode:'operator_trusted_local',modelCoverage:'not_applicable'},provider:{requested:null,observed:null,usage:null,cost:null},operations:[],files:[],parentBundleSha256:null};
  reseal(files,manifest);return files;
}
export function reseal(files,manifest=JSON.parse(files.get('manifest.json'))) {
  manifest.files=[...files].filter(([path])=>path!=='manifest.json').sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,b])=>({path,bytes:b.length,sha256:hash(b)}));
  files.set('manifest.json',encode(manifest));return hash(files.get('manifest.json'));
}
export function changeJson(files,path,change) {const v=JSON.parse(files.get(path));change(v);files.set(path,encode(v));}
