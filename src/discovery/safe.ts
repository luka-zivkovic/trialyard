import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { parseJson } from "../contracts/strict-json.js";
import { hash } from "../core/files.js";
import type { FileRecord } from "../contracts/types.js";

export const MANIFEST_LIMIT = 262144;
export const FILE_LIMIT = 2 * 1024 * 1024;
export const TOTAL_LIMIT = 16 * 1024 * 1024;
export interface DiscoveryDetail { phase: "inspect" | "prepare" | "check-connection"; path: string; rule: string; action: string; }
export class DiscoveryError extends Error { constructor(readonly code: string, readonly detail?: DiscoveryDetail) { super(code); } }
export const fail = (code: string, detail?: DiscoveryDetail): never => { throw new DiscoveryError(code, detail); };
export function discoveryMessage(error: DiscoveryError): string {
  const d = error.detail;
  return d ? `${d.phase}: ${JSON.stringify(d.path)}; ${d.rule}. ${d.action}` : error.code;
}
/** Call only after the complete declared inventory passes its public path policy. */
export async function declaredFile<T>(name: string, phase: "prepare" | "check-connection", action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof DiscoveryError && error.detail) throw error;
    const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "SOURCE_FILE_MISSING"
      : error instanceof DiscoveryError ? error.code : "SOURCE_FILE_UNREADABLE";
    return fail(code, { phase, path: name, rule: code === "SOURCE_FILE_MISSING" ? "declared file is missing" : "declared file could not be read safely",
      action: "Restore this public file or correct the declared inventory, then use a new output directory for preparation." });
  }
}
export const record = (name: string, bytes: Buffer): FileRecord => ({ path: name, bytes: bytes.length, sha256: hash(bytes) });
export function publicPath(name: string): void {
  if (name.length > 256 || !/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(name) || name.split("/").length > 16) fail("UNSAFE_SOURCE_PATH");
  const parts = name.split("/");
  if (parts.some(p => !p || p.startsWith(".") || /^(node_modules|vendor|coverage|package\.json|trial-adapter\.js|trial-runner\.setup\.json)$/i.test(p)
    || /(^|[._-])(env|secrets?|credentials?|passwords?|tokens?|private|id_rsa|id_ed25519)([._-]|$)/i.test(p))) fail("EXCLUDED_SOURCE_PATH");
  if (!/\.(js|mjs|json)$/.test(name)) fail("UNSUPPORTED_SOURCE_FILE");
}
export async function repositoryRoot(directory: string): Promise<string> {
  try {
    const resolved = path.resolve(directory);
    if (!(await fs.lstat(resolved)).isDirectory()) fail("UNSAFE_REPOSITORY_ROOT");
    return await fs.realpath(resolved);
  } catch { return fail("UNSAFE_REPOSITORY_ROOT"); }
}
export async function metadata(root: string, name: string, maxBytes: number) {
  // Caller validates the relative path policy before this function, including ALL prepare paths.
  let parent = root;
  for (const part of name.split("/").slice(0, -1)) {
    parent = path.join(parent, part);
    if (!(await fs.lstat(parent)).isDirectory()) fail("UNSAFE_SOURCE_FILE");
  }
  const stat = await fs.lstat(path.join(root, name));
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) fail("UNSAFE_SOURCE_FILE");
  return stat;
}
export async function readPublic(root: string, name: string, maxBytes = MANIFEST_LIMIT): Promise<Buffer> {
  const before = await metadata(root, name, maxBytes);
  const handle = await fs.open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes || opened.dev !== before.dev || opened.ino !== before.ino) fail("SOURCE_CHANGED");
    const data = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < data.length) {
      const result = await handle.read(data, length, data.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    const current = await metadata(root, name, maxBytes);
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || current.ino !== opened.ino || current.dev !== opened.dev) fail("SOURCE_CHANGED");
    return data.subarray(0, length);
  } finally { await handle.close(); }
}
export function publicJson(bytes: Buffer): Record<string, unknown> {
  try {
    const value = parseJson(bytes, MANIFEST_LIMIT);
    let nodes = 0;
    const walk = (v: unknown, depth: number): void => {
      if (++nodes > 10000 || depth > 24) fail("MANIFEST_LIMIT");
      if (v && typeof v === "object") for (const child of Object.values(v)) walk(child, depth + 1);
    };
    walk(value, 0);
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_MANIFEST");
    return value as Record<string, unknown>;
  } catch { return fail("INVALID_MANIFEST"); }
}
export async function newDestination(root: string, directory: string): Promise<string> {
  try {
    const resolved = path.resolve(directory);
    const parent = await fs.realpath(path.dirname(resolved));
    const destination = path.join(parent, path.basename(resolved));
    if (destination === root || destination.startsWith(root + path.sep) || root.startsWith(destination + path.sep)) fail("DESTINATION_OVERLAP");
    try { await fs.lstat(destination); return fail("DESTINATION_EXISTS"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return destination;
  } catch (error) { if (error instanceof DiscoveryError) throw error; return fail("INVALID_DESTINATION"); }
}
