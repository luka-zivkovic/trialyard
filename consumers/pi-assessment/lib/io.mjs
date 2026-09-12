import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, dirname, parse as parsePath } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function requireThat(ok, code) { if (!ok) throw new Error(code); }
export function safeRelative(name) {
  requireThat(typeof name === 'string' && name.length <= 4096 && !/[\\:\x00-\x1f]/u.test(name) && name.split('/').every(p => p && p !== '.' && p !== '..'), 'UNSAFE_PATH');
  return name;
}
export function parseJson(bytes, maximum = 2 * 1024 * 1024) {
  requireThat(bytes.length <= maximum, 'JSON_LIMIT');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let i = 0;
  const ws = () => { while (/[ \t\r\n]/u.test(text[i] ?? 'x')) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '\\') i++;
      else if (c === '"') return JSON.parse(text.slice(start, i));
    }
    throw new Error('INVALID_JSON');
  };
  const value = depth => {
    requireThat(depth <= 64, 'JSON_DEPTH'); ws();
    if (text[i] === '"') { string(); return; }
    if (text[i] === '{') {
      i++; ws(); const keys = new Set();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws(); requireThat(text[i] === '"', 'INVALID_JSON'); const key = string();
        requireThat(!keys.has(key), 'DUPLICATE_JSON_KEY'); keys.add(key);
        ws(); requireThat(text[i++] === ':', 'INVALID_JSON'); value(depth + 1); ws();
        if (text[i] === '}') { i++; return; }
        requireThat(text[i++] === ',', 'INVALID_JSON');
      }
    }
    if (text[i] === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      for (;;) { value(depth + 1); ws(); if (text[i] === ']') { i++; return; } requireThat(text[i++] === ',', 'INVALID_JSON'); }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(text.slice(i));
    requireThat(token, 'INVALID_JSON');
    requireThat(!/^[0-9-]/u.test(token[0]) || Number.isFinite(Number(token[0])), 'NONFINITE_JSON');
    i += token[0].length;
  };
  value(0); ws(); requireThat(i === text.length, 'INVALID_JSON');
  return JSON.parse(text);
}

// Resolve the operator-selected root once (e.g. /tmp on macOS); descendants
// are checked without following symlinks. This is not a hostile-host defense.
export async function readRegular(root, name, maximum = 16 * 1024 * 1024) {
  safeRelative(name); const base = await fs.realpath(root);
  const parts = name.split('/'); let current = base;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part); const stat = await fs.lstat(current);
    requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_DIRECTORY');
  }
  const file = join(base, name), before = await fs.lstat(file);
  requireThat(before.isFile() && before.nlink === 1 && before.size <= maximum, 'UNSAFE_FILE');
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fd.stat(); requireThat(st.isFile() && st.nlink === 1 && st.size <= maximum && st.ino === before.ino && st.dev === before.dev, 'FILE_CHANGED');
    const bytes = await fd.readFile(); const after = await fd.stat();
    requireThat(bytes.length === st.size && after.size === st.size && after.mtimeMs === st.mtimeMs && after.ctimeMs === st.ctimeMs, 'FILE_CHANGED');
    return bytes;
  } finally { await fd.close(); }
}
export const readPath = (file, max) => readRegular(dirname(resolve(file)), parsePath(file).base, max);
export async function inventory(root, prefix = '', state = { entries: 0 }) {
  const names = [];
  for (const entry of await fs.readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name; safeRelative(name);
    requireThat(++state.entries <= 2200 && name.split('/').length <= 32, 'INVENTORY_LIMIT');
    if (entry.isDirectory()) names.push(...await inventory(root, name, state));
    else { requireThat(entry.isFile(), 'UNSAFE_FILE'); names.push(name); }
  }
  return names.sort();
}
export async function publish(file, bytes) {
  const temp = join(dirname(file), `.writing-${randomUUID()}`);
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await fs.link(temp, file); } finally { await fs.unlink(temp); }
  const directory=await fs.open(dirname(file),constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
export const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
