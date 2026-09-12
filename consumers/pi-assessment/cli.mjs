import { identities } from './lib/identity.mjs';
import { prepareRequest,assessRequest,readAttempt,formatAttempt } from './lib/assessment.mjs';
import { requireThat } from './lib/io.mjs';

const help=`Local observation consumer (no candidate or provider execution)
  node cli.mjs identity
  node cli.mjs prepare <bundle> --sha256 <bundle-digest> --mapping <native-export.json> --out <new-request-directory> [--timeout-ms 10000]
  node cli.mjs assess <request.json> --request <new-id> --store <assessment-store> [--retry-of <prior-id>]
  node cli.mjs show <id> --store <assessment-store> [--sha256 <assessment-digest>] [--format text|json]

Every criterion result is separate from native execution/evidence/cleanup. Exit 0 means a completed assessment (including violated/not_evaluable/not_applicable); 1 means invalid command/preparation; 2 means rejected evidence or failed/interrupted assessment. Same-ID duplicates never rerun the checker.
`;
try {
 const [command,arg,...rest]=process.argv.slice(2);
 if(!command||command==='--help'||command==='help'){process.stdout.write(help);}
 else if(command==='identity'){requireThat(arg===undefined,'UNEXPECTED_ARGUMENT');const value=await identities();process.stdout.write(JSON.stringify(value,null,2)+'\n');}
 else {
  requireThat(arg&&!arg.startsWith('--')&&rest.length%2===0,'INVALID_ARGUMENTS');const opts={};
  const allowed=command==='prepare'?['--sha256','--mapping','--out','--timeout-ms']:command==='assess'?['--request','--store','--retry-of']:command==='show'?['--store','--sha256','--format']:[];
  for(let i=0;i<rest.length;i+=2){requireThat(allowed.includes(rest[i])&&opts[rest[i]]===undefined,'UNKNOWN_OR_DUPLICATE_OPTION');opts[rest[i]]=rest[i+1];}
  let value;
  if(command==='prepare'){requireThat(opts['--sha256']&&opts['--mapping']&&opts['--out'],'MISSING_OPTION');value=await prepareRequest(arg,opts['--sha256'],opts['--mapping'],opts['--out'],{timeoutMs:opts['--timeout-ms']===undefined?10000:Number(opts['--timeout-ms'])});}
  else if(command==='assess'){requireThat(opts['--request']&&opts['--store'],'MISSING_OPTION');const controller=new AbortController();const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);try{value=await assessRequest(arg,opts['--store'],opts['--request'],{retryOf:opts['--retry-of']??null,workerOptions:{signal:controller.signal}});}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}}
  else if(command==='show'){requireThat(opts['--store']&&['text','json'].includes(opts['--format']??'json'),'MISSING_OR_INVALID_OPTION');value=await readAttempt(opts['--store'],arg,opts['--sha256']);}
  else throw new Error('UNKNOWN_COMMAND');
  process.stdout.write(opts['--format']==='text'?formatAttempt(value):JSON.stringify(value,null,2)+'\n');
  if(value.status&&value.status!=='completed')process.exitCode=2;
 }
}catch(error){process.stderr.write(`Observation consumer: ${error.message}\nUse --help for syntax.\n`);process.exitCode=1;}
