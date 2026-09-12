# Retain and move an assessment

**CURRENT:** this local maintenance tool creates a portable directory containing a native bundle, its exact assessment-input export, the selected terminal assessment and retry ancestors, and the matching consumer runtime with installed dependencies and licenses. [Contract and limits](SCOPE.md). It copies and verifies evidence without executing an assessor, candidate, environment or provider. The consumer's 0.1.0 runtime identity is unchanged.

Use Node **24.15.0** and a matching trusted consumer installation. Select the assessment ID, store and expected assessment digest from the original recorded result. From the consumer package directory:

```sh
node retention/cli.mjs pack ASSESSMENT_ID --store /absolute/assessment-store --sha256 ASSESSMENT_SHA256 --out /absolute/new-retained-package
node retention/cli.mjs verify /absolute/new-retained-package --sha256 PRINTED_RETENTION_SHA256
```

Keep the printed retention digest in a separate record. The full directory may now be copied or moved; verify at its destination with that same digest. `verify` reads only retained locations. Absolute paths inside the original requests remain unchanged and need not exist. Output gives the relocated bundle, mapping, consumer and read-only assessment store paths, native execution/evidence/cleanup, and each assessment status. Verification checks bytes and links; it does not repeat the criterion or prove source authenticity. It uses the same native verification subset as the [consumer](../README.md).

The verifier uses code from the trusted installation, checks retained runtime files against the selected consumer identity, and does not load retained executable code. After verification, the retained consumer can inspect the original assessment without installation or network access:

```sh
node /absolute/moved-package/consumer/cli.mjs show ASSESSMENT_ID --store /absolute/moved-package/assessments --sha256 ASSESSMENT_SHA256 --format text
```

For an intentional new assessment from these retained observations, prepare a new request and a separate writable store. Use `source.bundleSha256` from the verified retention result:

```sh
node /absolute/moved-package/consumer/cli.mjs prepare /absolute/moved-package/source --sha256 SOURCE_BUNDLE_SHA256 --mapping /absolute/moved-package/mapping.json --out /absolute/new-request
node /absolute/moved-package/consumer/cli.mjs assess /absolute/new-request/request.json --request reassessment-1 --store /absolute/new-assessment-store
```

Record the prior archive and assessment digests alongside the new request/result. The source, criterion and consumer identities remain pinned; new absolute locators change the request bytes. This is explicit reassessment in a new store. Never edit the archived requests or use the archive's `assessments` directory as a writable store. If the package moves after preparation, prepare another new request at the new location.

Packing requires all source files and a full terminal retry ancestry. Missing evidence, interrupted attempts and rejected-source records error; the original store is unchanged. Preserve unsupported diagnostic records separately. An existing output directory is never overwritten. A partial directory after interruption is retained and cannot pass verification without a complete, digest-matching manifest. Choose a new output directory after resolving the failure.

Verification errors name the first missing, unlisted or byte-mismatched file when that location is available. A content change within the read limits reports `RETENTION_FILE_DIGEST_MISMATCH`, with a quoted archive-relative path and expected/observed byte lengths. Unsafe file types, links and over-limit reads still fail the file-boundary checks. Recover a copy that verifies against the original archive digest; do not change the expected digest to accept damaged evidence. Diagnostics contain paths and lengths, not file contents. The [Pi development-loop procedure](../../../integrations/pi-webdesk/development-loop-guide.md) records the failure that prompted this refinement.

Storage and backup remain operator-managed. Prefer a retention location outside disposable `.trial-runs` directories. The project uses ignored `.evidence-archives/` for local retained copies; this is still on the same device. Off-device backup, access policy, retention periods and deletion are not automated. Node itself must remain available at the pinned version. No raw content is uploaded, and no provider rerun can recover the identity of lost original evidence.
