import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, lstatSync } from 'node:fs';
import { dirname, join, relative, resolve, extname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readPublic } from '../../dist/src/discovery/safe.js';
import { hash } from './package-contract.mjs';
import { rebuildContract, relativePath, sorted, reject } from './rebuild-contract.mjs';

export const integration = dirname(fileURLToPath(import.meta.url)), runner = resolve(integration, '../..');
const tools = ['build-native.mjs','build-state.mjs','rebuild.mjs','rebuild-contract.mjs','rebuild.schema.json','runtime-package.mjs','package-contract.mjs','native-contract.mjs'];
export function toolingIdentity() { return sorted(tools.map(path=>({path,sha256:hash(readFileSync(join(integration,path)))}))); }
export function compilerIdentity(webdesk) {
  if (process.env.ESBUILD_BINARY_PATH) reject('UNSUPPORTED_ESBUILD_OVERRIDE');
  const request=createRequire(join(webdesk,'package.json')),entry=request.resolve('esbuild'), binary=createRequire(entry).resolve('@esbuild/darwin-arm64/bin/esbuild');
  return {entry,identity:{nodeSha256:hash(readFileSync(process.execPath)),entrySha256:hash(readFileSync(entry)),binarySha256:hash(readFileSync(binary))}};
}
function inputHash(root,name) {
  relativePath(name);
  try { if(!lstatSync(join(root,name)).isFile())reject('UNSAFE_PI_FIXED_INPUT');return hash(readFileSync(join(root,name))); }
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export function verifyFixedInputs(state,webdesk) {
  for(const f of state.fixedInputs) if(inputHash(f.root==='runner'?runner:webdesk,f.path)!==f.sha256)reject('PI_FIXED_INPUT_CHANGED');
  if(!isDeepStrictEqual(toolingIdentity(),state.tooling))reject('PI_BUILD_TOOLING_CHANGED');
  if(!isDeepStrictEqual(compilerIdentity(webdesk).identity,state.compiler))reject('PI_COMPILER_CHANGED');
}
export function captureInputs(webdesk,selection) {
  const roots={webdesk,runner},seen=new Map(),probes=new Map(),graphs=new Map();
  function identify(filename) {
    const absolute=resolve(filename);
    for(const [root,base] of Object.entries(roots))if(absolute.startsWith(base+'/')){const path=relative(base,absolute);relativePath(path);return {root,path};}
    return reject('PI_COMPILER_INPUT_OUTSIDE_ROOTS');
  }
  const mutable=f=>f.root==='webdesk'&&/^packages\/pi-bridge\/(src|extensions)\/.+\.ts$/.test(f.path);
  const allowed=new Map(selection?.sources.map(s=>[s.path,s]));
  async function load(filename) {
    const f=identify(filename),key=`${f.root}/${f.path}`;
    if(seen.has(key))return seen.get(key).bytes;
    let bytes;
    if(mutable(f)) {
      if(selection&&!allowed.has(f.path))reject('PI_SOURCE_INVENTORY_CHANGED');
      bytes=selection?Buffer.from(allowed.get(f.path).content):await readPublic(webdesk,f.path,1024*1024);
    } else bytes=readFileSync(filename);
    seen.set(key,{...f,bytes,sha256:hash(bytes)});
    let directory=dirname(f.path);
    while(true){const name=join(directory,'package.json');probes.set(`${f.root}/${name}`,{root:f.root,path:name,sha256:inputHash(roots[f.root],name)});if(directory==='.')break;directory=dirname(directory);}
    return bytes;
  }
  // These affect resolution/tooling even when esbuild does not list them as inputs.
  for(const [root,names]of [['webdesk',['pnpm-lock.yaml','package.json','tsconfig.base.json','packages/pi-bridge/tsconfig.json']],['runner',['package-lock.json','package.json','tsconfig.json']]])for(const name of names)probes.set(`${root}/${name}`,{root,path:name,sha256:inputHash(roots[root],name)});
  return {load, graph(label,meta){graphs.set(label,Object.entries(meta.inputs).map(([name,input])=>{const f=identify(resolve(webdesk,name));return {path:`${f.root}/${f.path}`,imports:input.imports.map(i=>{const target=i.external?i.path:identify(resolve(webdesk,i.path));return {path:typeof target==='string'?target:`${target.root}/${target.path}`,kind:i.kind,external:Boolean(i.external)};}).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en'))};}).sort((a,b)=>a.path.localeCompare(b.path,'en')));}, plugin:{name:'pin-pi-inputs',setup(build){build.onLoad({filter:/\.(?:[cm]?js|ts|json)$/},async args=>({contents:await load(args.path),resolveDir:dirname(args.path),loader:extname(args.path)==='.ts'?'ts':extname(args.path)==='.json'?'json':'js'}));}},
    state(compiler,runtimeSha256) {
      const sources=sorted([...seen.values()].filter(mutable).map(f=>({path:f.path,bytes:f.bytes.length,sha256:f.sha256,content:new TextDecoder('utf-8',{fatal:true}).decode(f.bytes)})));
      const fixed=new Map(probes);
      for(const f of seen.values())if(!mutable(f))fixed.set(`${f.root}/${f.path}`,{root:f.root,path:f.path,sha256:f.sha256});
      const fixedInputs=[...fixed.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,f])=>f);
      return rebuildContract('state',{schemaVersion:'trial-runner/pi-build-state/v1',sources,fixedInputs,compiler,tooling:toolingIdentity(),runtimeSha256,graphSha256:hash(JSON.stringify([...graphs.entries()].sort(([a],[b])=>a.localeCompare(b,'en'))))});
    },
    compiledInputs(){return [...seen.values()].map(f=>({path:join(roots[f.root],f.path),sha256:f.sha256}));},
    async unchanged(){for(const f of seen.values()){if(mutable(f)){if(!selection&&!(await readPublic(webdesk,f.path,1024*1024)).equals(f.bytes))reject('PI_SOURCE_CHANGED_DURING_BUILD');}else if(hash(readFileSync(join(roots[f.root],f.path)))!==f.sha256)reject('PI_FIXED_INPUT_CHANGED');}for(const f of probes.values())if(inputHash(roots[f.root],f.path)!==f.sha256)reject('PI_RESOLUTION_CHANGED');},
  };
}
