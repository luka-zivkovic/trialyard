import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionToolResults, inspectNative, readFinalSnapshot } from './inspect-native.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Pi reader retains error content and its exact source line without treating assistant claims as results',()=>{
  const raw=[{type:'session'},{type:'message',message:{role:'assistant',content:'I wrote the file'}},{type:'message',message:{role:'toolResult',toolCallId:'write-1',toolName:'write',isError:true,content:[{type:'text',text:'Permission denied'}]}}].map(JSON.stringify).join('\n');
  assert.deepEqual(sessionToolResults(raw),[{sessionLine:3,toolCallId:'write-1',toolName:'write',isError:true,content:[{type:'text',text:'Permission denied'}]}]);
});
test('missing sessions remain unavailable while malformed retained sessions are rejected',()=>{
  assert.equal(sessionToolResults(null),null);assert.throws(()=>sessionToolResults('{"type":"message","type":"session"}'));assert.throws(()=>sessionToolResults({}));
});
test('inspection requires an expected digest before opening a bundle',async()=>{
  await assert.rejects(inspectNative('/not-opened',undefined),/DIGEST_REQUIRED/);
});
test('unlisted snapshots are not read and changed listed bytes are rejected',async t=>{
  const root=await mkdtemp(join(tmpdir(),'pi-reader-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'final-state.json'),'unlisted or changed payload');
  assert.equal(await readFinalSnapshot(root,[]),null);
  await assert.rejects(readFinalSnapshot(root,[{path:'final-state.json',bytes:0,sha256:'a'.repeat(64)}]),/PI_SNAPSHOT_CHANGED/);
});
