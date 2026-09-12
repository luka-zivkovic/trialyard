import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { hash } from '../lib/io.mjs';
import { verifyFiles, readBundle, mappingFor, verifyMapping } from '../lib/native.mjs';
import { nativeFixture, reseal, changeJson } from './native-fixture.mjs';

test('independent native fixture verifies and exports exactly the declared mapping',()=>{
  const f=nativeFixture(),v=verifyFiles(f,hash(f.get('manifest.json')));verifyMapping(mappingFor(v),v);
  for(const prop of ['bundleSha256','candidateArtifactSha256','trialId','scenarioId','repetition','boundary','gaps']){const m=mappingFor(v);m[prop]=prop==='repetition'?1:prop==='gaps'?['invented']:'swapped';assert.throws(()=>verifyMapping(m,v),prop);}
});
const mutations={
  'altered state':f=>f.set('final-state.json',Buffer.from('{}')),
  'missing file':f=>f.delete('final-state.json'),
  'unlisted file':f=>f.set('extra',Buffer.from('extra')),
  'unsafe inventory':f=>changeJson(f,'manifest.json',m=>m.files[0].path='../outside'),
  'changed scenario identity':f=>{changeJson(f,'manifest.json',m=>m.scenarioId='swapped');},
  'changed cleanup':f=>changeJson(f,'manifest.json',m=>m.cleanup='failed'),
  'changed declared profile':f=>changeJson(f,'manifest.json',m=>m.evidence.profile.captureBoundary='elsewhere'),
  'changed repetition':f=>changeJson(f,'manifest.json',m=>m.repetition=1),
  'changed observed adapter':f=>{changeJson(f,'agent-ready.json',r=>r.payload.artifactSha256='f'.repeat(64));reseal(f);},
  'duplicate event':f=>{const e=f.get('events.ndjson').toString().trim().split('\n');e.splice(2,0,e[1]);f.set('events.ndjson',Buffer.from(e.join('\n')+'\n'));reseal(f);},
  'swapped event identity':f=>{const e=f.get('events.ndjson').toString().trim().split('\n').map(JSON.parse);e[1].trialId='elsewhere';f.set('events.ndjson',Buffer.from(e.map(JSON.stringify).join('\n')+'\n'));reseal(f);},
  'candidate claim replaces independent snapshot':f=>{changeJson(f,'final-state.json',s=>{s.source='candidate_claim';});reseal(f);},
  'invalid final-state shape':f=>{changeJson(f,'final-state.json',s=>s.state.acknowledged='true');reseal(f);},
  'missing conversation concealed as complete':f=>{const e=f.get('events.ndjson').toString().trim().split('\n').map(JSON.parse).filter(e=>e.kind!=='assistant.turn').map((e,sequence)=>({...e,sequence}));f.set('events.ndjson',Buffer.from(e.map(JSON.stringify).join('\n')+'\n'));reseal(f);},
  'unsupported redacted derivative':f=>changeJson(f,'manifest.json',m=>m.parentBundleSha256='a'.repeat(64)),
};
for(const [name,mutate]of Object.entries(mutations))test(`reject ${name} even with a newly supplied outer digest`,()=>{const f=nativeFixture();mutate(f);assert.throws(()=>verifyFiles(f,hash(f.get('manifest.json'))));});
test('a different valid repetition retains a distinct source identity',()=>{
 const f=nativeFixture();changeJson(f,'manifest.json',m=>m.repetition=1);const e=f.get('events.ndjson').toString().trim().split('\n').map(JSON.parse);e[0].payload.repetition=1;f.set('events.ndjson',Buffer.from(e.map(JSON.stringify).join('\n')+'\n'));reseal(f);const v=verifyFiles(f,hash(f.get('manifest.json')));assert.equal(mappingFor(v).repetition,1);
});
test('filesystem loader rejects symlink and hard-linked evidence before reading it',async t=>{
 const root=await mkdtemp(join(tmpdir(),'consumer-files-'));t.after(()=>rm(root,{recursive:true,force:true}));const f=nativeFixture();for(const [p,b]of f){await mkdir(dirname(join(root,p)),{recursive:true});await writeFile(join(root,p),b);}
 const digest=hash(f.get('manifest.json'));await readBundle(root,digest);await rm(join(root,'final-state.json'));await symlink('initial-state.json',join(root,'final-state.json'));await assert.rejects(()=>readBundle(root,digest));await rm(join(root,'final-state.json'));await link(join(root,'initial-state.json'),join(root,'final-state.json'));await assert.rejects(()=>readBundle(root,digest));
});
