import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,dirname } from 'node:path';
import { prepareRequest,assessRequest,readAttempt,formatAttempt } from '../lib/assessment.mjs';
import { runWorker } from '../lib/worker.mjs';
import { encode,hash } from '../lib/io.mjs';
import { verifyFiles,mappingFor } from '../lib/native.mjs';
import { nativeFixture } from './native-fixture.mjs';

async function fixture(t) {
 const root=await fs.mkdtemp(join(tmpdir(),'consumer-lifecycle-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const bundle=join(root,'bundle'),files=nativeFixture();for(const [p,b]of files){await fs.mkdir(dirname(join(bundle,p)),{recursive:true});await fs.writeFile(join(bundle,p),b);}
 const digest=hash(files.get('manifest.json')),mapping=join(root,'mapping.json');await fs.writeFile(mapping,encode(mappingFor(verifyFiles(files,digest))));
 const prepared=await prepareRequest(bundle,digest,mapping,join(root,'request'));
 return {root,bundle,files,request:prepared.request,store:join(root,'store')};
}
test('assessment, duplicate and intentional retry keep source bytes intact and never execute its trap entrypoint',async t=>{
 const f=await fixture(t),result=await assessRequest(f.request,f.store,'first');assert.equal(result.status,'completed');assert.equal(result.result.result.judgment,'not_applicable');
 const duplicate=await assessRequest(f.request,f.store,'first');assert.equal(duplicate.duplicate,true);assert.equal(duplicate.sha256,result.sha256);
 const retry=await assessRequest(f.request,f.store,'second',{retryOf:'first'});assert.equal(retry.result.retryOf,'first');assert.equal(retry.result.source.bundleSha256,result.result.source.bundleSha256);
 await assert.rejects(()=>readAttempt(f.store,'first','f'.repeat(64)),/ASSESSMENT_DIGEST_MISMATCH/);
 for(const[p,b]of f.files)assert.deepEqual(await fs.readFile(join(f.bundle,p)),b);
 assert.match(formatAttempt(result),/Native execution: finished; evidence: complete; cleanup: succeeded/);
});
test('changed request under one ID conflicts; simultaneous duplicates execute at most once',async t=>{
 const f=await fixture(t);const outcomes=await Promise.all([assessRequest(f.request,f.store,'same'),assessRequest(f.request,f.store,'same')]);assert.equal(outcomes.filter(r=>!r.duplicate).length,1);
 const request=JSON.parse(await fs.readFile(f.request));request.timeoutMs=500;await fs.writeFile(f.request,encode(request));await assert.rejects(()=>assessRequest(f.request,f.store,'same'),/ASSESSMENT_REQUEST_CONFLICT/);
});
test('rejected source and changed pins retain an immutable rejection without a judgment',async t=>{
 const f=await fixture(t);await fs.writeFile(join(f.bundle,'final-state.json'),'{}');const r=await assessRequest(f.request,f.store,'bad-source');assert.equal(r.status,'rejected');assert.equal(r.result.result,null);assert.equal(r.result.native,null);
 const req=JSON.parse(await fs.readFile(f.request));req.criterion.sha256='f'.repeat(64);await fs.writeFile(f.request,encode(req));const c=await assessRequest(f.request,f.store,'bad-pin');assert.equal(c.result.errorCode,'CRITERION_IDENTITY_MISMATCH');
});
test('assessor crash is distinct from candidate failure and can be retried against the same evidence',async t=>{
 const f=await fixture(t),worker=join(f.root,'crash.mjs');await fs.writeFile(worker,'process.exit(7);');
 const failed=await assessRequest(f.request,f.store,'failed',{workerOptions:{workerFile:worker}});assert.equal(failed.status,'failed');assert.equal(failed.result.result,null);assert.equal(failed.result.native.execution,'finished');
 const duplicate=await assessRequest(f.request,f.store,'failed');assert.equal(duplicate.sha256,failed.sha256);
 const retry=await assessRequest(f.request,f.store,'recovered',{retryOf:'failed'});assert.equal(retry.status,'completed');assert.equal(retry.result.source.bundleSha256,failed.result.source.bundleSha256);
});
test('accepted attempt lacking a terminal record remains inspectable and does not replay',async t=>{
 const f=await fixture(t);const completed=await assessRequest(f.request,f.store,'interrupted');await fs.rename(join(f.store,'interrupted','assessment.json'),join(f.root,'retained-assessment.json'));
 const duplicate=await assessRequest(f.request,f.store,'interrupted');assert.equal(duplicate.status,'running_or_interrupted');assert.equal(duplicate.result,null);assert.equal(duplicate.requestSha256,completed.requestSha256);await assert.rejects(()=>fs.stat(join(f.store,'interrupted','assessment.json')));
});
test('worker deadline, output overflow, malformed output and cancellation preserve explicit failure',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'consumer-workers-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const pins={consumer:{sha256:'a'.repeat(64)},criterion:{sha256:'b'.repeat(64)}};
 for(const [name,code,expected]of [['timeout','setInterval(()=>{},1000);','ASSESSOR_TIMEOUT'],['overflow','process.stdout.write("x".repeat(2*1024*1024));','ASSESSOR_OUTPUT_LIMIT'],['malformed','process.stdout.write("{}");','INVALID_ASSESSOR_OUTPUT']]){const worker=join(root,`${name}.mjs`);await fs.writeFile(worker,code);await assert.rejects(()=>runWorker({},pins,200,{workerFile:worker}),new RegExp(expected));}
 const controller=new AbortController();controller.abort();await assert.rejects(()=>runWorker({},pins,1000,{signal:controller.signal}),/ASSESSOR_CANCELLED/);
});
