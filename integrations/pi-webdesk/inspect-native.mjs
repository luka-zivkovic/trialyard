import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle } from '../../dist/src/contracts/verify.js';
import { parseJson } from '../../dist/src/contracts/strict-json.js';
import { readPublic } from '../../dist/src/discovery/safe.js';
import { hash } from '../../dist/src/core/files.js';

export function sessionToolResults(raw) {
  if(raw===undefined||raw===null)return null;
  if(typeof raw!=='string')throw new Error('INVALID_PI_SESSION');
  return raw.split('\n').flatMap((line,i)=>{
    if(!line.trim())return [];
    const entry=parseJson(Buffer.from(line),2*1024*1024);
    if(entry?.type!=='message'||entry.message?.role!=='toolResult')return [];
    return [{sessionLine:i+1,toolCallId:entry.message.toolCallId??null,toolName:entry.message.toolName??null,isError:entry.message.isError??null,content:entry.message.content??null}];
  });
}
export async function readFinalSnapshot(root,files) {
  const item=files.find(f=>f.path==='final-state.json');
  if(!item)return null;
  const bytes=await readPublic(root,item.path,16*1024*1024);
  if(bytes.length!==item.bytes||hash(bytes)!==item.sha256)throw new Error('PI_SNAPSHOT_CHANGED');
  return parseJson(bytes,16*1024*1024);
}
export async function inspectNative(bundle,digest) {
  if(!/^[a-f0-9]{64}$/.test(digest??''))throw new Error('EXPECTED_BUNDLE_DIGEST_REQUIRED');
  const root=resolve(bundle),verified=await verifyBundle(root,digest),m=verified.manifest;
  const final=await readFinalSnapshot(root,m.files);
  return {kind:'pi-native-session-inspection',bundle:root,sha256:verified.digest,execution:m.execution,evidence:m.evidence,cleanup:m.cleanup,
    source:'final-state.json /state/session/raw, independently read from the Pi-owned session',
    files:final?.state?.files??null,toolResults:sessionToolResults(final?.state?.session?.raw),notice:'Recorded tool results and state; no agent-quality judgment. Null means unavailable.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{
    if(process.argv.includes('--help'))process.stdout.write('node integrations/pi-webdesk/inspect-native.mjs <bundle-directory> --sha256 <printed-bundle-digest>\nVerify a native bundle, then show exact Pi session tool results and independent file state. No execution.\n');
    else{if(process.argv.length!==5||process.argv[3]!=='--sha256')throw new Error('Use --help for Pi inspection syntax');process.stdout.write(JSON.stringify(await inspectNative(process.argv[2],process.argv[4]),null,2)+'\n');}
  }catch(error){process.stderr.write(`Pi inspection: ${error.message}\n`);process.exitCode=1;}
}
