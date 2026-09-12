import { parseJson, encode, requireThat } from './lib/io.mjs';
import { same, shape } from './lib/contracts.mjs';
import { identities } from './lib/identity.mjs';
import { assessApproval } from './integrations/pi/p1.mjs';

try {
  const chunks=[];let length=0;
  for await(const b of process.stdin){length+=b.length;requireThat(length<=24*1024*1024,'CHECKER_INPUT_LIMIT');chunks.push(b);}
  const {context,pins}=parseJson(Buffer.concat(chunks),24*1024*1024),current=await identities();
  same(current.consumer,pins.consumer,'CONSUMER_CHANGED');same(current.criterion,pins.criterion,'CRITERION_CHANGED');
  const result=shape('result',assessApproval(context));
  process.stdout.write(encode({consumerSha256:current.consumer.sha256,criterionSha256:current.criterion.sha256,result}));
} catch { process.stderr.write('ASSESSOR_FAILED\n');process.exitCode=2; }
