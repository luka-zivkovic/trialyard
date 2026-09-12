import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { safeRelative } from "../contracts/validate.js";
import { parseJson } from "../contracts/strict-json.js";

export const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export const jsonBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + "\n");

export async function safeFile(root: string, relative: string, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  safeRelative(relative);
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Input root must be a real directory");
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Symlink input is not allowed");
  }
  const target = await fs.lstat(current);
  if (!target.isFile() || target.size > maxBytes) throw new Error("Input is not a bounded regular file");
  // Nonblocking open also covers replacement with a FIFO between lstat/open.
  // O_NONBLOCK does not change reads of regular files; fstat checks the handle.
  const file = await fs.open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Input is not a bounded regular file");
    const chunks: Buffer[] = [];
    let count = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65536, maxBytes + 1 - count));
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > maxBytes) throw new Error("Input grew beyond byte limit");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
  } finally { await file.close(); }
}

export async function readJson(root: string, relative: string): Promise<unknown> {
  return parseJson(await safeFile(root, relative, 2 * 1024 * 1024));
}

export async function writeAtomic(filePath: string, bytes: Uint8Array, replace = false): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.write-${randomUUID()}`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try {
    if (replace) await fs.rename(temporary, filePath);
    else { await fs.link(temporary, filePath); await fs.unlink(temporary); }
    const directory = await fs.open(path.dirname(filePath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

export async function fileInventory(root: string): Promise<string[]> {
  const result: string[] = [];
  let count = 0;
  const walk = async (prefix: string, depth: number): Promise<void> => {
    if (depth > 32) throw new Error("Evidence directory depth limit exceeded");
    const directory = await fs.opendir(path.join(root, prefix));
    for await (const entry of directory) {
      if (++count > 10000 || result.length >= 1001) throw new Error("Evidence inventory limit exceeded");
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      safeRelative(relative);
      if (entry.isSymbolicLink()) throw new Error("Symlink in evidence bundle");
      if (entry.isDirectory()) await walk(relative, depth + 1);
      else if (entry.isFile()) result.push(relative);
      else throw new Error("Non-regular evidence file");
    }
  };
  await walk("", 0);
  return result.sort();
}
