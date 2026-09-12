import * as fs from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { hash, parseJson, encode, readPath, readRegular, publish, requireThat } from './io.mjs';
import { shape, same, validateReceipt } from './contracts.mjs';
import { readBundle, identityFor, verifyMapping } from './native.mjs';
import { identities } from './identity.mjs';
import { runWorker } from './worker.mjs';

const idOk=id=>requireThat(typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(id),'INVALID_ASSESSMENT_ID');
const allowedError=error=>/^[A-Z][A-Z0-9_]{0,99}$/u.test(error?.message??'')?error.message:'INPUT_UNAVAILABLE_OR_INVALID';
export async function prepareRequest(bundle,bundleDigest,mappingFile,out,{timeoutMs=10000}={}) {
  const source=await readBundle(resolve(bundle),bundleDigest),mappingBytes=await readPath(mappingFile),mapping=verifyMapping(parseJson(mappingBytes),source),pins=await identities();
  const request=shape('request',{schemaVersion:'observation-consumer/request/v1',bundlePath:resolve(bundle),bundleSha256:source.digest,mappingPath:join(resolve(out),'mapping.json'),mappingSha256:hash(mappingBytes),identity:identityFor(source.manifest),criterion:pins.criterion,consumer:pins.consumer,timeoutMs});
  await fs.mkdir(out,{mode:0o700});await publish(join(out,'mapping.json'),mappingBytes);await publish(join(out,'request.json'),encode(request));
  return {request:join(resolve(out),'request.json'),requestSha256:hash(encode(request)),criterion:request.criterion,consumer:request.consumer,source:mapping.bundleSha256,execution:'not_run'};
}
async function requestAt(file) {const raw=await readPath(file);const request=shape('request',parseJson(raw));requireThat(resolve(request.bundlePath)===request.bundlePath&&resolve(request.mappingPath)===request.mappingPath,'ABSOLUTE_SOURCE_PATH_REQUIRED');return {raw,request,digest:hash(raw)};}
export async function readAttempt(store,id,expectedDigest) {
  idOk(id);const dir=join(resolve(store),id);
  let intent;
  try{intent=shape('intent',parseJson(await readRegular(dir,'intent.json')));}catch(e){if(e.code==='ENOENT'){await fs.stat(dir);return {requestId:id,status:'running_or_interrupted',result:null};}throw e;}
  requireThat(intent.requestId===id,'ATTEMPT_ID_MISMATCH');
  const raw=await readRegular(dir,'request.json'),request=shape('request',parseJson(raw));requireThat(hash(raw)===intent.requestSha256,'STORED_REQUEST_CHANGED');
  let bytes;try{bytes=await readRegular(dir,'assessment.json',2*1024*1024);}catch(e){if(e.code==='ENOENT')return {requestId:id,status:'running_or_interrupted',requestSha256:intent.requestSha256,result:null};throw e;}
  const digest=hash(bytes);if(expectedDigest)requireThat(digest===expectedDigest,'ASSESSMENT_DIGEST_MISMATCH');
  const record=validateReceipt(parseJson(bytes));
  for(const key of ['requestId','requestSha256','retryOf','startedAt'])same(record[key],intent[key],'ASSESSMENT_ATTEMPT_MISMATCH');
  same(record.source,{bundleSha256:request.bundleSha256,mappingSha256:request.mappingSha256,identity:request.identity},'ASSESSMENT_SOURCE_MISMATCH');same(record.consumer,request.consumer,'ASSESSMENT_CONSUMER_MISMATCH');same(record.criterion,request.criterion,'ASSESSMENT_CRITERION_MISMATCH');
  return {requestId:id,status:record.execution,requestSha256:intent.requestSha256,path:join(dir,'assessment.json'),sha256:digest,result:record};
}
export async function assessRequest(file,store,id,{retryOf=null,workerOptions}={}) {
  idOk(id);if(retryOf)idOk(retryOf);requireThat(retryOf!==id,'SELF_RETRY');
  const {raw,request,digest}=await requestAt(file),base=resolve(store),dir=join(base,id);
  await fs.mkdir(base,{recursive:true,mode:0o700});
  if(retryOf){const previous=await readAttempt(base,retryOf);requireThat(previous.result!==null,'RETRY_SOURCE_UNFINISHED');const old=previous.result;for(const [a,b]of [[old.source.bundleSha256,request.bundleSha256],[old.source.mappingSha256,request.mappingSha256],[old.source.identity,request.identity],[old.criterion,request.criterion],[old.consumer,request.consumer]])same(a,b,'RETRY_SOURCE_CONFLICT');}
  try{await fs.mkdir(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;const previous=await readAttempt(base,id);if(previous.requestSha256)requireThat(previous.requestSha256===digest,'ASSESSMENT_REQUEST_CONFLICT');return {...previous,duplicate:true};}
  const intent={schemaVersion:'observation-consumer/attempt/v1',requestId:id,requestSha256:digest,retryOf,startedAt:new Date().toISOString()};shape('intent',intent);
  await publish(join(dir,'request.json'),raw);await publish(join(dir,'intent.json'),encode(intent));
  const record={schemaVersion:'observation-consumer/assessment/v1',...Object.fromEntries(['requestId','requestSha256','retryOf','startedAt'].map(k=>[k,intent[k]])),finishedAt:intent.startedAt,consumer:request.consumer,criterion:request.criterion,source:{bundleSha256:request.bundleSha256,mappingSha256:request.mappingSha256,identity:request.identity},verification:'not_completed',verificationScope:'native-bytes-mapping-and-observation-links/v1',native:null,execution:'failed',result:null,errorCode:null};
  let source;
  try {
    const current=await identities();same(request.consumer,current.consumer,'CONSUMER_IDENTITY_MISMATCH');same(request.criterion,current.criterion,'CRITERION_IDENTITY_MISMATCH');
    source=await readBundle(request.bundlePath,request.bundleSha256);same(identityFor(source.manifest),request.identity,'REQUEST_SOURCE_IDENTITY_MISMATCH');
    const mapping=await readPath(request.mappingPath);requireThat(hash(mapping)===request.mappingSha256,'MAPPING_DIGEST_MISMATCH');verifyMapping(parseJson(mapping),source);
    record.verification='accepted';const m=source.manifest;record.native={execution:m.execution,evidence:m.evidence.state,cleanup:m.cleanup,gaps:[...m.evidence.gaps],boundary:m.fidelity.boundary,authenticity:m.identity.authenticity};
  } catch(error) {record.verification='rejected';record.execution='rejected';record.errorCode=allowedError(error);}
  if(source&&record.verification==='accepted') {
    try {
      const context={manifest:source.manifest,scenario:source.scenario,initial:source.initial,final:source.final,events:source.events};
      record.result=await runWorker(context,{consumer:request.consumer,criterion:request.criterion},request.timeoutMs,workerOptions);
      for(const obs of record.result.observations)requireThat(source.manifest.files.some(f=>f.path===obs.path&&f.sha256===obs.sha256),'ASSESSOR_REFERENCE_MISMATCH');
      record.execution='completed';
    } catch(error) {record.execution='failed';record.result=null;record.errorCode=allowedError(error);}
  }
  record.finishedAt=new Date().toISOString();validateReceipt(record);await publish(join(dir,'assessment.json'),encode(record));
  return {...await readAttempt(base,id),duplicate:false};
}
export function formatAttempt(attempt) {
  const r=attempt.result;if(!r)return `Assessment ${attempt.requestId}: accepted; running or interrupted. No terminal assessment is retained. Reusing this ID never dispatches the checker again.\n`;
  const lines=[`Assessment ${attempt.requestId}: ${r.execution}`,`Criterion: ${r.criterion.id} ${r.criterion.version}`,`Source trial: ${r.source.identity.trialId}, scenario ${r.source.identity.scenarioId}, repetition ${r.source.identity.repetition}`,`Bundle: ${r.source.bundleSha256}`];
  if(r.native)lines.push(`Native execution: ${r.native.execution}; evidence: ${r.native.evidence}; cleanup: ${r.native.cleanup}`,`Native gaps: ${r.native.gaps.join(', ')||'none'}`);
  if(r.result) {lines.push(`Judgment: ${r.result.judgment}`,r.result.reason);for(const o of r.result.observations)lines.push(`  ${o.path}#${o.location} (${o.source}) — ${o.description}`);}
  else lines.push(`No judgment: ${r.errorCode}`);
  lines.push(`Assessment SHA-256: ${attempt.sha256}`,'Source authenticity is not attested. No release decision.');return lines.join('\n')+'\n';
}
