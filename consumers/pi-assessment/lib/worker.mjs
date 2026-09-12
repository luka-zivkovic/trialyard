import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encode, parseJson, requireThat } from './io.mjs';
import { shape } from './contracts.mjs';

// Only the bundled worker is selected by the public CLI. workerFile exists for
// process-failure qualification; requests cannot supply executable paths.
export function runWorker(context,pins,timeoutMs,{workerFile=fileURLToPath(new URL('../worker.mjs',import.meta.url)),signal}={}) {
  const input=encode({context,pins});requireThat(input.length<=24*1024*1024,'CHECKER_INPUT_LIMIT');
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(new Error('ASSESSOR_CANCELLED'));return;}
    const child=spawn(process.execPath,['--max-old-space-size=256',workerFile],{stdio:['pipe','pipe','pipe'],detached:true,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC'}});
    let output=[],used=0,errorCode=null;
    const stop=code=>{if(errorCode)return;errorCode=code;try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
    const timer=setTimeout(()=>stop('ASSESSOR_TIMEOUT'),timeoutMs);const abort=()=>stop('ASSESSOR_CANCELLED');signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',b=>{used+=b.length;if(used>1024*1024)stop('ASSESSOR_OUTPUT_LIMIT');else output.push(b);});
    child.stderr.on('data',b=>{used+=b.length;if(used>1024*1024)stop('ASSESSOR_OUTPUT_LIMIT');});
    child.stdin.on('error',()=>{});child.stdin.end(input);
    child.on('error',()=>{errorCode='ASSESSOR_START_FAILED';});
    child.on('close',code=>{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(errorCode||code!==0){reject(new Error(errorCode??'ASSESSOR_FAILED'));return;}
      try {const response=parseJson(Buffer.concat(output),1024*1024);requireThat(response&&Object.keys(response).sort().join(',')==='consumerSha256,criterionSha256,result','INVALID_ASSESSOR_OUTPUT');requireThat(response.consumerSha256===pins.consumer.sha256&&response.criterionSha256===pins.criterion.sha256,'ASSESSOR_IDENTITY_MISMATCH');shape('result',response.result);resolve(response.result);}catch{reject(new Error('INVALID_ASSESSOR_OUTPUT'));}
    });
  });
}
