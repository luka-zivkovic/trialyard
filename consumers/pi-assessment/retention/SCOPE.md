# Portable local assessment evidence

**TARGET — bounded continuation:** keep an existing assessment usable when its original working directories disappear. This maintenance tool packages one verified native bundle, its exact export mapping, one terminal assessment and its complete retry ancestry, and the matching local consumer runtime. It never runs candidate, environment, provider or assessor code. The assessment consumer remains version 0.1.0 with unchanged runtime identity.

## Frozen v1 invariants

- The operator supplies an expected head assessment SHA-256 when packing and an expected retention-manifest SHA-256 when verifying. Digests establish byte consistency, not source authenticity.
- A closed `observation-consumer/retention/v1` manifest inventories every payload file by safe relative path, size and digest. Unknown versions/fields, duplicate or case-colliding paths, missing/extra files, traversal, descendant symlinks, hardlinked files and special files fail closed. Bounds: 2,200 filesystem entries, 2,000 payload files, 192 MiB total and 16 MiB per file; 32 terminal attempts per linear ancestry.
- Source bytes, mapping bytes and original request/intent/assessment bytes are copied unchanged. Absolute paths inside old requests are historical locators; verification joins the retained relative locations using their pinned identities and never follows the old locators.
- Every ancestor must exist, be terminal, have verified source, and agree on source, mapping, criterion and consumer identities. Failed assessor execution remains failed with no judgment. Interrupted or rejected-source attempts are outside this replayable-package format; packing them errors without replacing their original records.
- Native verification uses the consumer's existing declared subset. Retention does not upgrade that scope or redo the assessment. Native execution, completeness, cleanup, gaps and assessment observation references must agree with retained source bytes.
- Package all fingerprinted consumer code/schema/dependency JS/JSON files, plus dependency license files and usage documentation. A trusted, matching consumer installation checks archived runtime bytes without importing or executing them. Node itself is a declared prerequisite, not bundled. Verification makes no network request.
- Allocate only a new output directory, copy with restrictive modes, and publish the manifest last. A crash may leave a partial directory without a usable manifest; never overwrite, resume or delete an earlier attempt automatically. Reread the finished directory before returning its digest. This is not power-loss or hostile-host qualification.
- Reassessment uses the existing `prepare` command with the retained relative source/mapping resolved at their new location, a new request directory and a new writable assessment store. Never rewrite old requests or write into an archived assessment store. Keep the prior assessment/archive digests as provenance; this new request is not an identical-byte retry.

**ASSUMPTION — delivery:** a local directory is sufficient for the first handoff. No tar extraction, general backup service, retention policy, scheduler, remote upload, automatic deletion or provider rerun is introduced. A local copy does not protect against device loss. Off-device backup remains operator-managed.

## Qualification before delivery

Positive fixtures: strict manifest; terminal ancestry; relocated package inspection with source unavailable; fresh preparation/assessment from the retained bundle using the exact archived consumer. Negative fixtures: malformed or unsupported manifest, digest mismatch, unsafe file boundaries, omitted ancestor, swapped source/status/reference/consumer pins, missing source, interrupted publication and preexisting output. The public consumer tests use synthetic fixtures; the Pi development-loop driver adds native bundle retention and relocation checks. Historical pilot archives are outside this checkout. Human replay remains an open gate.

## Diagnostic refinement after assistant replay

**TARGET — observed failure, 2026-09-11:** a bounded file-length change must be reported as a retained-byte mismatch, with its archive-relative path and expected/observed length. Missing and unlisted files should name the first offending relative path. Existing rejection codes and exit 1 remain; no evidence is repaired or its digest rewritten. Reads retain the 16 MiB file and 192 MiB aggregate ceilings, regular-file/link checks and strict inventories. CLI diagnostics may show validated relative paths and numeric lengths, never file contents or raw filesystem exception text. Paths must be quoted/escaped for terminal display. These are diagnostic changes, not changes to the retention wire or assessor identity.
