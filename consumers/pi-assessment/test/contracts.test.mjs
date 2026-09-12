import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJson } from '../lib/io.mjs';
import { shape, validateReceipt } from '../lib/contracts.mjs';

const h = 'a'.repeat(64);
export const identity = { runId:'run',trialId:'trial',scenarioId:'scenario',repetition:0,candidateArtifactSha256:h,environmentArtifactSha256:h,planSha256:h,scenarioSha256:h,fixtureSha256:h };
export const component = {id:'test-checker',version:'0.1.0',sha256:h};
export const request = {schemaVersion:'observation-consumer/request/v1',bundlePath:'/bundle',bundleSha256:h,mappingPath:'/mapping.json',mappingSha256:h,identity,criterion:component,consumer:component,timeoutMs:1000};
const receipt = () => ({schemaVersion:'observation-consumer/assessment/v1',requestId:'assessment',requestSha256:h,retryOf:null,startedAt:'2026-09-11T00:00:00Z',finishedAt:'2026-09-11T00:00:01Z',consumer:component,criterion:component,source:{bundleSha256:h,mappingSha256:h,identity},verification:'accepted',verificationScope:'native-bytes-mapping-and-observation-links/v1',native:{execution:'finished',evidence:'incomplete',cleanup:'failed',gaps:['model_usage_missing'],boundary:'test',authenticity:'not_attested'},execution:'completed',result:{judgment:'satisfied',reasonCode:'RULE_OBSERVED',reason:'Required observations are present.',observations:[]},errorCode:null});
test('request pins each identity and rejects unknown fields, missing pins and unsupported versions', () => {
  shape('request',request);
  for(const changed of [{...request,score:1},{...request,schemaVersion:'observation-consumer/request/v2'},{...request,bundleSha256:'short'},{...request,timeoutMs:0}])assert.throws(()=>shape('request',changed));
  const missing=structuredClone(request);delete missing.identity.trialId;assert.throws(()=>shape('request',missing));
});
test('criterion outcomes remain separate from native incompleteness and cleanup', () => {
  for(const judgment of ['satisfied','violated','not_evaluable','not_applicable']) {const r=receipt();r.result.judgment=judgment;validateReceipt(r);}
});
test('assessor failure and rejected evidence cannot carry a judgment', () => {
  for(const execution of ['failed','rejected']) {
    const r=receipt();r.execution=execution;r.errorCode='WORKER_FAILED';if(execution==='rejected'){r.verification='rejected';r.native=null;}
    assert.throws(()=>validateReceipt(r));r.result=null;validateReceipt(r);
  }
  const r=receipt();r.verification='not_completed';assert.throws(()=>validateReceipt(r));
});
test('strict JSON rejects duplicate escaped keys, invalid UTF-8, nonfinite and trailing values', () => {
  for(const s of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"x":{"a":0,"a":1}}','[1e999]','{} true','{"a":1,}','\ufeff{}'])assert.throws(()=>parseJson(Buffer.from(s)));
  assert.throws(()=>parseJson(Buffer.from([0xff])));
  assert.deepEqual(parseJson(Buffer.from('{"x":["a\\\"b",true,null,-1.2e3]}')),{x:['a"b',true,null,-1200]});
});
test('criterion definition rejects unversioned behavior and unknown fields',async()=>{
 const {criterion}=await import('../integrations/pi/p1.mjs');shape('criterion',criterion);assert.throws(()=>shape('criterion',{...criterion,threshold:0.9}));assert.throws(()=>shape('criterion',{...criterion,version:'0.2.0'}));
});
