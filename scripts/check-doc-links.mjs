import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const skipped = new Set(['.git', 'node_modules', 'dist', '.trial-runs', '.evidence-archives', '.venv', '__pycache__']);
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile() && extname(path) === '.md') files.push(path);
  }
  return files;
}

const files = await walk(root), errors = [];
let checked = 0;
for (const file of files) {
  const text = (await readFile(file, 'utf8')).replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  const targets = [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(m => m[1]);
  targets.push(...[...text.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1]));
  for (const raw of targets) {
    const link = raw.replace(/^<|>$/g, '');
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)) continue;
    const [pathname, fragment] = link.split('#');
    const target = resolve(dirname(file), decodeURIComponent(pathname || ''));
    const destination = pathname ? target : file;
    checked++;
    try {
      const info = await stat(destination);
      if (!info.isFile() && !info.isDirectory()) throw new Error('not a file or directory');
      if (fragment && info.isFile() && extname(destination) === '.md') {
        const content = await readFile(destination, 'utf8');
        const anchors = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => m[1].toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/ /g, '-'));
        if (!anchors.includes(decodeURIComponent(fragment))) throw new Error('missing heading anchor');
      }
    } catch (error) {
      errors.push(`${relative(root, file)}: ${link} (${error.code === 'ENOENT' ? 'missing target' : error.message})`);
    }
  }
}
if (errors.length) {
  process.stderr.write(errors.join('\n') + '\n');
  process.exitCode = 1;
} else process.stdout.write(`Checked ${checked} local links across ${files.length} Markdown files.\n`);
