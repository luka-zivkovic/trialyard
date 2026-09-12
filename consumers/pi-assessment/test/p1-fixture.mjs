import { criterion } from '../integrations/pi/p1.mjs';

// Hand-authored observation fixture, no candidate or producer runtime imports.
export function p1Fixture() {
  const specifications = [
    ['first-read', 'read', 'turn-1', {path:'README.md'}, '# Disposable Pi feasibility fixture\n'],
    ['first-write', 'write', 'turn-1', {path:'notes.txt',content:'alpha\n'}, 'Wrote file'],
    ['followup-read', 'read', 'turn-2', {path:'notes.txt'}, 'alpha\n'],
    ['followup-edit', 'edit', 'turn-2', {path:'notes.txt',edits:[{oldText:'alpha',newText:'beta'}]}, 'Edited file'],
    ['followup-readback', 'read', 'turn-2', {path:'notes.txt'}, 'beta\n'],
  ];
  const manifest = {scenarioId:'pi-baseline',scenarioSha256:criterion.scenarioSha256,fixtureSha256:criterion.fixtureSha256,execution:'finished',evidence:{profile:{id:'pi-native-scripted-v1',modelCapture:'accounted'},gaps:[],redactedPaths:[]},files:['scenario.json','initial-state.json','final-state.json','events.ndjson'].map(path=>({path,sha256:'a'.repeat(64)}))};
  manifest.files.push({path:'profile.json',sha256:criterion.profileSha256});
  const initial = {stable:true,pendingOperations:[],state:{files:{'README.md':'# Disposable Pi feasibility fixture\n'},session:null,observations:[{kind:'runtime.unpacked'}],runtime:{}}};
  const final = {stable:true,pendingOperations:[],state:{files:{...initial.state.files,'notes.txt':'beta\n'},session:{sessionId:'session',raw:''},runtime:{sessionId:'session',callbacks:[]},observations:[{kind:'runtime.ready',handshake:{mode:'supervised'},state:{messageCount:0,sessionId:'session'}}]}};
  const events = [], raw = [{type:'session',id:'session'}];
  for(const [id,tool,turnId,input,text] of specifications) {
    const operationId=`op-${id}`, value={content:[{type:'text',text}]};
    events.push({kind:'operation.dispatch_intent',operationId,turnId,source:'runner_observed',payload:{boundary:'tool',name:tool,args:{invocationId:id,input}}},
      {kind:'operation.dispatch_observed',operationId,turnId,source:'environment_observed',payload:{}},
      {kind:'operation.finished',operationId,turnId,source:'environment_observed',payload:{outcome:'known_result',value,error:null}});
    final.state.runtime.callbacks.push({invocationId:id,tool,input,operationId,phase:'closed',outcome:'known_result'});
    final.state.observations.push({kind:'callback.admitted',invocationId:id,operationId});
    if(tool==='write')final.state.observations.push({kind:'approval',invocationId:id,operationId,valid:true,confirmed:true,summary:'Write file:\nnotes.txt\n\nProposed file contents:\n+ alpha\n+ '});
    if(tool==='edit')final.state.observations.push({kind:'approval',invocationId:id,operationId,valid:true,confirmed:true,summary:'Edit file:\nnotes.txt\n\nProposed replacements (− before, + after):\n- alpha\n+ beta'});
    final.state.observations.push({kind:'callback.dispatch',invocationId:id,operationId},{kind:'callback.result',invocationId:id,operationId,result:value,error:null,late:false});
    raw.push({type:'message',message:{role:'toolResult',toolCallId:id,toolName:tool,content:value.content,isError:false}});
    if(id==='first-write'||id==='followup-readback')final.state.observations.push({kind:'turn.finished',turnId,files:{...initial.state.files,'notes.txt':id==='first-write'?'alpha\n':'beta\n'}});
  }
  final.state.observations.push({kind:'process.stopped',remaining:[]});
  final.state.session.raw=raw.map(JSON.stringify).join('\n')+'\n';
  return {manifest,initial,final,events:events.map((e,sequence)=>({...e,sequence})),scenario:{messages:criterion.messages.map((content,i)=>({id:`turn-${i+1}`,content}))}};
}
