import { readFileSync, writeFileSync, lstatSync, readlinkSync, readdirSync, realpathSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { hash, safePackagePath, validatePackage } from './package-contract.mjs';

export function packRuntime(webdesk, output) {
  const base = realpathSync(join(webdesk, 'node_modules/.pnpm'));
  const pi = realpathSync(join(webdesk, 'node_modules/@earendil-works/pi-coding-agent'));
  const queue = [relative(base, pi).split('/')[0]], seen = new Set(), records = [];
  function walk(path) {
    const stat = lstatSync(path), name = relative(base, path);
    if (stat.isDirectory()) for (const child of readdirSync(path).sort()) walk(join(path, child));
    else if (stat.isSymbolicLink()) {
      const target = readlinkSync(path), actual = realpathSync(path), rel = relative(base, actual);
      safePackagePath(rel); queue.push(rel.split('/')[0]); records.push({ kind: 'link', path: name, target });
    } else if (stat.isFile()) {
      const bytes = readFileSync(path); records.push({ kind: 'file', path: name, mode: stat.mode & 0o111 ? 493 : 420, sha256: hash(bytes), data: bytes.toString('base64') });
    } else throw new Error('UNSUPPORTED_PACKAGE_FILE');
  }
  while (queue.length) { const next = queue.shift(); if (!seen.has(next)) { seen.add(next); walk(join(base, next)); } }
  records.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const inventory = validatePackage(records), expanded = Buffer.from(records.map(r => JSON.stringify(r)).join('\n'));
  if (expanded.length > 210 * 1024 * 1024) throw new Error('PACKAGE_EXPANSION_LIMIT');
  const archive = gzipSync(expanded, { level: 6 }), chunks = [];
  for (let offset = 0; offset < archive.length; offset += 8 * 1024 * 1024) {
    const bytes = archive.subarray(offset, offset + 8 * 1024 * 1024), path = `pi-runtime-${chunks.length}.gzpart`;
    writeFileSync(join(output, path), bytes); chunks.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  const metadata = { version: 1, format: 'pi-package-jsonl-gzip-v1', piVersion: JSON.parse(readFileSync(join(pi, 'package.json'))).version, entry: relative(base, join(pi, 'dist/cli.js')), contexts: seen.size, inventory, expandedBytes: expanded.length, expandedSha256: hash(expanded), archiveSha256: hash(archive), chunks };
  writeFileSync(join(output, 'pi-runtime.json'), JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}
export function unpackRuntime(source, destination) {
  const meta = JSON.parse(readFileSync(join(source, 'pi-runtime.json')));
  if (meta.version !== 1 || meta.format !== 'pi-package-jsonl-gzip-v1' || meta.piVersion !== '0.84.2' || !Number.isSafeInteger(meta.expandedBytes) || meta.expandedBytes < 1 || meta.expandedBytes > 210 * 1024 * 1024 || !Array.isArray(meta.chunks) || meta.chunks.length < 1 || meta.chunks.length > 8) throw new Error('INVALID_RUNTIME_PACKAGE');
  const archive = Buffer.concat(meta.chunks.map((chunk, index) => {
    if (chunk.path !== `pi-runtime-${index}.gzpart` || chunk.bytes > 8 * 1024 * 1024) throw new Error('INVALID_PACKAGE_CHUNK');
    const bytes = readFileSync(join(source, chunk.path));
    if (bytes.length !== chunk.bytes || hash(bytes) !== chunk.sha256) throw new Error('PACKAGE_CHUNK_CHANGED'); return bytes;
  }));
  if (hash(archive) !== meta.archiveSha256) throw new Error('PACKAGE_ARCHIVE_CHANGED');
  const expanded = gunzipSync(archive, { maxOutputLength: meta.expandedBytes });
  if (expanded.length !== meta.expandedBytes || hash(expanded) !== meta.expandedSha256) throw new Error('PACKAGE_EXPANSION_CHANGED');
  const records = expanded.toString('utf8').split('\n').map(JSON.parse), actual = validatePackage(records);
  if (JSON.stringify(actual) !== JSON.stringify(meta.inventory)) throw new Error('PACKAGE_INVENTORY_CHANGED');
  safePackagePath(meta.entry);
  if (!records.some(r => r.kind === 'file' && r.path === meta.entry)) throw new Error('MISSING_PI_ENTRY');
  mkdirSync(destination); // Never overlay an existing runtime.
  for (const record of records) if (record.kind === 'file') {
    const target = join(destination, record.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, Buffer.from(record.data, 'base64'), { flag: 'wx', mode: record.mode });
  }
  for (const record of records) if (record.kind === 'link') {
    const target = join(destination, record.path); mkdirSync(dirname(target), { recursive: true }); symlinkSync(record.target, target);
    if (!realpathSync(target).startsWith(resolve(destination) + '/')) throw new Error('EXTRACTED_LINK_ESCAPED');
  }
  return { entry: join(destination, meta.entry), metadata: meta };
}
