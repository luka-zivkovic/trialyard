import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { derivativeManifest, redactionPolicy, verifyDerivativeManifest } from "../contracts/redaction.js";
import { verifyBundle } from "../contracts/verify.js";
import { contract } from "../contracts/validate.js";
import { parseJson } from "../contracts/strict-json.js";
import { fileInventory, hash, jsonBytes, safeFile, writeAtomic } from "../core/files.js";
import type { RedactedManifest } from "../contracts/types.js";

/** Verification requires the local source; a parent hash alone proves no ancestry. */
export async function verifyRedactedBundle(root: string, sourceRoot: string, expectedDigest?: string): Promise<{ manifest: RedactedManifest; digest: string }> {
  const bytes = await safeFile(root, "manifest.json", 8 * 1024 * 1024); const digest = hash(bytes);
  if (expectedDigest && digest !== expectedDigest) throw new Error("Redacted bundle identity mismatch");
  const claimed = contract<RedactedManifest>("derivative", parseJson(bytes, 8 * 1024 * 1024));
  const source = await verifyBundle(sourceRoot, claimed.parentBundleSha256);
  const manifest = verifyDerivativeManifest(claimed, source.manifest, source.digest);
  if (!isDeepStrictEqual(await fileInventory(root), [...manifest.files.map(file => file.path), "manifest.json"].sort())) throw new Error("Unlisted or missing derivative file");
  for (const file of manifest.files) {
    const content = await safeFile(root, file.path);
    if (content.length !== file.bytes || hash(content) !== file.sha256) throw new Error("Derivative file digest mismatch");
  }
  return { manifest, digest };
}

export async function exportRedactedBundle(sourceRoot: string, destination: string, input: unknown): Promise<{ root: string; manifest: RedactedManifest; digest: string }> {
  const policy = redactionPolicy(input);
  const source = await verifyBundle(sourceRoot);
  const manifest = derivativeManifest(source.manifest, source.digest, policy);
  if (manifest.files.reduce((sum, file) => sum + file.bytes, 0) > 192 * 1024 * 1024) throw new Error("Derivative export exceeds the 192 MiB file allowance");
  const root = path.resolve(destination); const original = await fs.realpath(sourceRoot);
  const parent = await fs.realpath(path.dirname(root));
  const actual = path.join(parent, path.basename(root));
  if (actual === original || actual.startsWith(original + path.sep)) throw new Error("Derivative destination must be outside the source bundle");
  await fs.mkdir(root, { mode: 0o700 }); // Existing destinations are never changed.
  try {
    for (const file of manifest.files) {
      const bytes = await safeFile(sourceRoot, file.path);
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error("Source changed during export");
      await writeAtomic(path.join(root, file.path), bytes);
    }
    await writeAtomic(path.join(root, "manifest.json"), jsonBytes(manifest));
    return { root, ...await verifyRedactedBundle(root, sourceRoot) };
  } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
}
