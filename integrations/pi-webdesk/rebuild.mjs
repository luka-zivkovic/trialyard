import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { loadConnection, verifyConnectionContents } from '../../dist/src/connection/recipe.js';
import { recipeContract, connectionPath } from '../../dist/src/connection/contracts.js';
import { resolvePlan } from '../../dist/src/core/plan.js';
import { jsonBytes, writeAtomic } from '../../dist/src/core/files.js';
import { readPublic, metadata, repositoryRoot, newDestination, record } from '../../dist/src/discovery/safe.js';
import { hash } from './package-contract.mjs';
import { STATE, SELECTION, LINEAGE, PARENT, PARENT_STATE, rebuildContract, selectContract, sourceChanges, assertContinuity, preserved, sorted, json, reject } from './rebuild-contract.mjs';
import { verifyFixedInputs, integration, runner } from './build-state.mjs';

const history=[SELECTION,LINEAGE,PARENT,PARENT_STATE];
function describe(parentBytes,parentStateBytes,selectionBytes,current) {
  const parent=recipeContract(json(parentBytes)),state=rebuildContract('state',json(parentStateBytes));
  const recordedState=parent.files.find(f=>f.path===STATE);
  if(recordedState?.sha256!==hash(parentStateBytes)||recordedState.bytes!==parentStateBytes.length)reject('PI_PARENT_STATE_MISMATCH');
  if(parent.id!=='pi-webdesk-native-scripted'||parent.plan?.path!=='baseline-plan.json'||!isDeepStrictEqual(parent.sources,state.sources.map(({content,...f})=>f)))reject('PI_PARENT_SOURCE_MISMATCH');
  const selection=selectContract(json(selectionBytes),state,hash(parentBytes));
  assertContinuity(state,current.state);
  if(!isDeepStrictEqual(selection.sources,current.state.sources))reject('PI_SELECTION_NOT_BUILT');
  if(!isDeepStrictEqual(preserved(parent),preserved(current.recipe)))reject('PI_TRIAL_CONFIGURATION_CHANGED');
  return rebuildContract('lineage',{schemaVersion:'trial-runner/pi-rebuild/v1',parentRecipeSha256:hash(parentBytes),parentStateSha256:hash(parentStateBytes),parentInputSha256:parent.plan.inputSha256,inputSha256:current.recipe.plan.inputSha256,
    sourceChanges:sourceChanges(state.sources,current.state.sources),preservedFiles:preserved(parent),execution:'not_run'});
}
export async function checkPiConnection(filename,expectedDigest) {
  const current=await loadConnection(filename,expectedDigest);
  if(current.recipe.id!=='pi-webdesk-native-scripted'||current.recipe.plan?.path!=='baseline-plan.json'||!current.files.has(STATE))reject('UNSUPPORTED_PI_REBUILD_PARENT');
  const state=rebuildContract('state',json(current.files.get(STATE)));
  if(!isDeepStrictEqual(current.recipe.sources,state.sources.map(({content,...f})=>f)))reject('PI_SOURCE_IDENTITY_MISMATCH');
  if(state.runtimeSha256!==hash(current.files.get('pi-runtime.json')))reject('PI_RUNTIME_IDENTITY_MISMATCH');
  for(const role of ['agent','environment'])if(json(current.files.get(`${role}-artifact.json`)).files.find(f=>f.path===STATE)?.sha256!==hash(current.files.get(STATE)))reject('PI_UNPINNED_SOURCE_STATE');
  const allowed=new Set(current.files.keys());
  for(const name of ['denied','interrupted'])await resolvePlan(join(current.root,`${name}-plan.json`),allowed);
  current.state=state;
  if(history.some(n=>current.files.has(n))){
    if(history.some(n=>!current.files.has(n)))reject('MISSING_PI_REBUILD_LINEAGE');
    const expected=describe(current.files.get(PARENT),current.files.get(PARENT_STATE),current.files.get(SELECTION),current);
    if(!isDeepStrictEqual(rebuildContract('lineage',json(current.files.get(LINEAGE))),expected))reject('PI_REBUILD_LINEAGE_MISMATCH');
  }
  return current;
}
export async function publishConnection(output,state,parent=null,selection=null) {
  const inventory=async()=>sorted(await Promise.all((await readdir(output)).filter(n=>n!=='connection.json').map(async name=>record(name,await readFile(join(output,name))))));
  const plan=await resolvePlan(join(output,'baseline-plan.json'));
  const recipe=recipeContract({schemaVersion:'trial-runner/connection-recipe/v1',id:'pi-webdesk-native-scripted',method:'prepared-plan/v1',skill:null,sources:state.sources.map(({content,...f})=>f),files:await inventory(),plan:{path:'baseline-plan.json',inputSha256:plan.inputSha256},requirements:[]});
  if(parent){
    const selectionBytes=jsonBytes(selection),lineage=describe(parent.bytes,parent.files.get(STATE),selectionBytes,{recipe,state});
    for(const [name,bytes] of [[SELECTION,selectionBytes],[PARENT,parent.bytes],[PARENT_STATE,parent.files.get(STATE)],[LINEAGE,jsonBytes(lineage)]])await writeFile(join(output,name),bytes,{flag:'wx',mode:0o600});
    recipe.files=await inventory();
  }
  await verifyConnectionContents(output,recipe);
  const bytes=jsonBytes(recipe);await writeAtomic(join(output,'connection.json'),bytes);
  return {recipe:join(output,'connection.json'),recipeSha256:hash(bytes),plan:recipe.plan,sourceChanges:parent?sourceChanges(parent.state.sources,state.sources):[],execution:'not_run'};
}
export async function selectPiSource(parentFile,sourceArg,outArg,expectedDigest) {
  const parent=await checkPiConnection(parentFile,expectedDigest),source=await repositoryRoot(sourceArg);
  const out=await newDestination(source,outArg);await newDestination(parent.root,out);
  for(const f of parent.state.sources)await metadata(source,f.path,1024*1024);
  const sources=[];
  for(const f of parent.state.sources){const bytes=await readPublic(source,f.path,1024*1024);sources.push({...record(f.path,bytes),content:new TextDecoder('utf-8',{fatal:true}).decode(bytes)});}
  const selection=selectContract({schemaVersion:'trial-runner/pi-source-selection/v1',parentRecipeSha256:hash(parent.bytes),sources,execution:'not_run'},parent.state,hash(parent.bytes));
  for(const f of sources)if(hash(await readPublic(source,f.path,1024*1024))!==f.sha256)reject('PI_SOURCE_CHANGED_DURING_SELECTION');
  await checkPiConnection(parentFile,hash(parent.bytes));await writeAtomic(out,jsonBytes(selection));
  return {selection:out,sha256:hash(jsonBytes(selection)),selectedSources:sources.map(f=>f.path),unlistedSource:'not_inspected',sourceChanges:sourceChanges(parent.state.sources,sources),execution:'not_run'};
}
export async function buildWorker(argv,output,{signal,timeoutMs=120000}={}) {
  if(signal?.aborted)reject('PI_BUILD_CANCELLED');
  return new Promise((done,fail)=>{
    const child=spawn(process.execPath,argv,{cwd:runner,env:{PATH:dirname(process.execPath),LANG:'C.UTF-8',TZ:'UTC'},detached:true,stdio:['ignore','pipe','pipe']});
    let reason=null,bytes=0;const chunks=[];
    const stop=code=>{reason??=code;try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')fail(error);}};
    const timer=setTimeout(()=>stop('PI_BUILD_TIMEOUT'),timeoutMs),cancel=()=>stop('PI_BUILD_CANCELLED');
    signal?.addEventListener('abort',cancel,{once:true});
    const data=b=>{bytes+=b.length;if(bytes<=1024*1024)chunks.push(b);else stop('PI_BUILD_OUTPUT_LIMIT');};
    child.stdout.on('data',data);child.stderr.on('data',data);
    child.once('error',error=>{reason=error.code??'PI_BUILD_SPAWN_FAILED';});
    child.once('close',async(code,killed)=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);
      try{await writeFile(join(output,'build-worker.log'),Buffer.concat(chunks),{flag:'wx'});if(reason||code!==0)fail(new Error(reason??`PI_BUILD_FAILED_${code??killed}`));else done({exitCode:code});}catch(error){fail(error);}
    });
  });
}
export async function rebuildPi(parentFile,selectionFile,runtimeArg,outArg,{expectedDigest,signal}={}) {
  const parent=await checkPiConnection(parentFile,expectedDigest),runtime=await repositoryRoot(runtimeArg);
  const selectionRoot=await repositoryRoot(dirname(resolve(selectionFile)));connectionPath(basename(selectionFile));
  const bytes=await readPublic(selectionRoot,basename(selectionFile),2*1024*1024),selection=selectContract(json(bytes),parent.state,hash(parent.bytes));
  verifyFixedInputs(parent.state,runtime);
  const out=await newDestination(runtime,outArg);await newDestination(parent.root,out);await mkdir(out,{mode:0o700});
  try{
    await writeFile(join(out,'selection-input.json'),jsonBytes(selection),{flag:'wx',mode:0o600});
    await buildWorker([join(integration,'build-native.mjs'),'--rebuild-worker',runtime,out,resolve(parentFile),hash(parent.bytes)],out,{signal});
    // The worker log is diagnostic, deliberately outside the published connection inventory.
    const current=await checkPiConnection(join(out,'connection.json'));
    return {recipe:join(out,'connection.json'),recipeSha256:hash(current.bytes),record:json(current.files.get(LINEAGE)),execution:'not_run'};
  }catch(error){try{await rename(join(out,'connection.json'),join(out,'unpublished-connection.json'));}catch(missing){if(missing.code!=='ENOENT')throw missing;}await writeFile(join(out,'rebuild-failure.json'),jsonBytes({stage:'build',code:String(error.message),execution:'not_run'}),{mode:0o600});throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const help='Pi source iteration\n  node integrations/pi-webdesk/rebuild.mjs select <connection.json> --source <source-checkout> --out <new-selection.json> [--sha256 <parent digest>]\n  node integrations/pi-webdesk/rebuild.mjs build <connection.json> --selection <selection.json> --runtime <installed-webdesk> --out <new-directory> [--sha256 <parent digest>]\n  node integrations/pi-webdesk/rebuild.mjs check <connection.json> [--sha256 <digest>]\nselect/check never execute candidate code; build runs a bounded compiler worker. Trial execution is a separate run command.\n';
  const abort=new AbortController(),cancel=()=>abort.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  try{
    if(process.argv.includes('--help'))process.stdout.write(help);
    else {
      const [command,target,...args]=process.argv.slice(2),allowed={select:['--source','--out','--sha256'],build:['--selection','--runtime','--out','--sha256'],check:['--sha256']}[command]??reject('INVALID_PI_REBUILD_COMMAND'),options=new Map();
      if(!target)reject('MISSING_PI_REBUILD_ARGUMENT');
      for(let i=0;i<args.length;i+=2){if(!allowed.includes(args[i])||!args[i+1]||args[i+1].startsWith('--')||options.has(args[i]))reject('INVALID_PI_REBUILD_ARGUMENT');options.set(args[i],args[i+1]);}
      const need=n=>options.get(n)??reject('MISSING_PI_REBUILD_ARGUMENT');
      const result=command==='select'?await selectPiSource(target,need('--source'),need('--out'),options.get('--sha256')):command==='build'?await rebuildPi(target,need('--selection'),need('--runtime'),need('--out'),{expectedDigest:options.get('--sha256'),signal:abort.signal}):(await checkPiConnection(target,options.get('--sha256'))).check;
      process.stdout.write(JSON.stringify(result,null,2)+'\n');
    }
  }catch(error){process.stderr.write(`Pi rebuild: ${error.message}\n`);process.exitCode=abort.signal.aborted?130:1;}
  finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
}
