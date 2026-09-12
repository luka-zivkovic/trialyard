import { isDeepStrictEqual } from "node:util";
import { contract, safeRelative } from "./validate.js";
import type { Manifest, RedactedManifest, RedactionPolicy } from "./types.js";

export function redactionPolicy(value: unknown): RedactionPolicy {
  const policy = contract<RedactionPolicy>("redaction", value);
  policy.omitFiles.forEach(name => { safeRelative(name); if (name === "manifest.json") throw new Error("Select source content files, not the source manifest"); });
  return policy;
}

export function derivativeManifest(source: Manifest, digest: string, input: unknown): RedactedManifest {
  const policy = redactionPolicy(input);
  for (const name of policy.omitFiles) if (!source.files.some(file => file.path === name)) throw new Error("Redaction selects a file absent from the source");
  return contract<RedactedManifest>("derivative", {
    schemaVersion: "trial-runner/redacted-evidence/v1", parentBundleSha256: digest,
    runId: source.runId, requestId: source.requestId, trialId: source.trialId, scenarioId: source.scenarioId, repetition: source.repetition,
    execution: source.execution, cleanup: source.cleanup, authenticity: "not_attested",
    evidence: { state: "incomplete", gaps: [...new Set([...source.evidence.gaps, "redacted_export"])].sort(),
      redactedPaths: [...new Set([...source.evidence.redactedPaths, ...policy.omitFiles])].sort() },
    files: source.files.filter(file => !policy.omitFiles.includes(file.path)),
  });
}

/** Source must first pass native verification. No derivative may upgrade it. */
export function verifyDerivativeManifest(value: unknown, source: Manifest, digest: string): RedactedManifest {
  const manifest = contract<RedactedManifest>("derivative", value);
  const omitted = source.files.filter(file => !manifest.files.some(kept => kept.path === file.path)).map(file => file.path);
  const expected = derivativeManifest(source, digest, { schemaVersion: "trial-runner/redaction/v1", omitFiles: omitted });
  if (!isDeepStrictEqual(manifest, expected)) throw new Error("Redacted evidence differs from verified source or upgrades its coverage");
  return manifest;
}
