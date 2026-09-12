import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { hash, readRegular, inventory, encode, requireThat, parseJson } from './io.mjs';

export const packageRoot=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(import.meta.url);
export const implementationFiles=['package.json','package-lock.json','cli.mjs','worker.mjs','lib/io.mjs','lib/contracts.mjs','lib/native.mjs','lib/identity.mjs','lib/assessment.mjs','lib/worker.mjs','contracts/assessment.schema.json','vendor/trial-runner-v1.schema.json','vendor/pi-approval-p1.md','integrations/pi/criterion.json','integrations/pi/p1.mjs'];
export async function identities() {
  requireThat(process.versions.node==='24.15.0','UNSUPPORTED_NODE');
  const files=[];
  for(const path of [...implementationFiles].sort()){const bytes=await readRegular(packageRoot,path);files.push({path,sha256:hash(bytes)});}
  // Include installed executable dependency bytes, not just a lockfile claim.
  for(const name of ['ajv','fast-deep-equal','fast-uri','json-schema-traverse','require-from-string']) {
    const root=dirname(require.resolve(`${name}/package.json`));
    for(const path of (await inventory(root)).filter(p=>/\.(?:js|json)$/u.test(p)&&!p.startsWith('node_modules/'))) {
      files.push({path:`dependency:${name}/${path}`,sha256:hash(await readRegular(root,path))});
    }
  }
  const criterionBytes=await readFile(join(packageRoot,'integrations/pi/criterion.json')),criterion=parseJson(criterionBytes);
  const manifest=parseJson(await readFile(join(packageRoot,'package.json')));
  return {consumer:{id:'pi-observation-consumer',version:manifest.version,sha256:hash(encode({node:process.versions.node,files}))},criterion:{id:criterion.id,version:criterion.version,sha256:hash(criterionBytes)},files};
}
