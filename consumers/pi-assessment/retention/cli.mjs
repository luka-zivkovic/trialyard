import { packArchive, verifyArchive } from './archive.mjs';
import { requireThat } from '../lib/io.mjs';
import { formatRetentionError } from './contracts.mjs';

const help = `Portable local assessment evidence (no execution or network)
  node retention/cli.mjs pack <assessment-id> --store <store> --sha256 <assessment-digest> --out <new-directory>
  node retention/cli.mjs verify <directory> --sha256 <retention-manifest-digest>

Pack retains a terminal attempt and its entire retry ancestry, exact source and mapping, and the matching consumer runtime. Verify reads only this package. The expected digest must come from a retained record. Exit 0 means verification completed; 1 means invalid input or retention failure. These are not assessment or release judgments.
`;
try {
  const [command, arg, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') process.stdout.write(help);
  else {
    requireThat(['pack', 'verify'].includes(command) && arg && !arg.startsWith('--') && rest.length % 2 === 0, 'INVALID_ARGUMENTS');
    const opts = {}, allowed = command === 'pack' ? ['--store', '--sha256', '--out'] : ['--sha256'];
    for (let i = 0; i < rest.length; i += 2) {
      requireThat(allowed.includes(rest[i]) && opts[rest[i]] === undefined && rest[i + 1] && !rest[i + 1].startsWith('--'), 'UNKNOWN_DUPLICATE_OR_MISSING_OPTION');
      opts[rest[i]] = rest[i + 1];
    }
    requireThat(allowed.every(key => opts[key]), 'MISSING_OPTION');
    const result = command === 'pack' ? await packArchive(opts['--store'], arg, opts['--sha256'], opts['--out']) : await verifyArchive(arg, opts['--sha256']);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
} catch (error) {
  process.stderr.write(formatRetentionError(error)); process.exitCode = 1;
}
