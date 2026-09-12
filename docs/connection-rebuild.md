# Rebuild a connected Node candidate

**CURRENT — 2026-09-10:** `rebuild` refreshes a connection created by `connect` for the self-contained ESM `node-function/v1` template and its reference inventory environment. It copies the declared runtime files, regenerates their artifact manifests and validates a new connection against the retained parent. No manual inventory or digest editing is required.

```sh
trial rebuild /absolute/baseline/connection.json \
  --source /absolute/agent \
  --out /absolute/candidate-2 \
  --sha256 PARENT_RECIPE_SHA256
trial check-connection /absolute/candidate-2/connection.json
trial run /absolute/candidate-2/prepared/plan.json \
  --request candidate-2 --store /absolute/trial-store
trial show --request candidate-2 --store /absolute/trial-store --format text
```

`trial` means the built CLI, as in [connection setup](connection-setup.md). The optional `--sha256` pins the exact parent recipe bytes. Both `--source` and `--out` are required; the output directory must be new and outside the source and parent connection. Its parent directory must already exist. The source location can differ from the repository's original location.

## What changes and what stays fixed

Edit the files listed in `trial-runner.setup.json` under `agent.files`. Add or remove public `.js`, `.mjs` or `.json` runtime modules by updating that list. The current entrypoint must remain declared. Rebuild snapshots those selected bytes; removed modules are absent from the new candidate. Root package/setup declarations are hashed as provenance, and package metadata remains subject to the existing supported ESM restrictions.

The parent and revised connection must have byte-identical plan, scenario, environment artifact, fixture, evidence profile, settings schemas, function wrapper, SDK files and retained skill. This holds repetitions, limits, credential names, capture requirements, entrypoint and environment behavior fixed. Changes to retained wrapper, SDK, environment or skill files also fail this comparison. Deliberate configuration or template changes use a new `connect` operation; rebuild does not silently reset a customized connection to installed defaults. Updating the installed setup skill does not replace the parent skill snapshot during a rebuild; current readers support retained 0.1.0 through 0.3.2 snapshots.

The JSON result includes the new recipe path and digest, resolved plan digest and a versioned rebuild record. Changes identify old/new byte lengths and SHA-256 values for each source and derived connection file; `null` marks an addition or removal. `agentArtifact.before` and `.after` identify the artifact manifests. `preservedFiles` records the exact unchanged inputs. An unchanged source produces empty change lists and retains the same candidate/input identities. The new recipe still records its parent.

The old connection and existing runs remain unchanged. Reusing an accepted request ID with changed inputs fails with a conflict. Reusing that ID with unchanged inputs returns the existing run. An intentional execution uses a new request ID; rebuilding itself never starts a trial.

## Retained lineage and verification

The new recipe inventories `rebuild/parent.json` (the exact parent recipe) and `rebuild/record.json` (the closed [rebuild contract](../contracts/rebuild.schema.json)). `check-connection` recomputes the changes and preservation claims against both inventories. Repinning a false change record does not make it valid. Original connections without rebuild metadata retain their existing v1 behavior.

Each rebuild retains its immediate parent recipe only. It does not recursively copy prior connections or run evidence. Keep those separately when the full history matters. A rebuilt connection can be moved, checked and run without the source or parent directory. The parent inventory records earlier file identities; it does not contain or recover the earlier file contents. An external parent digest provides an exact identity reference, not authorship attestation.

Preparation uses the existing bounded public-file readers and source allowlist. Selected sources are checked again before publication. The final `connection.json` is written last; any earlier failure removes only the newly created output. Static preparation and later execution retain the existing operator-controlled, quiescent-filesystem assumption.

| Failure | Action |
| --- | --- |
| `CONNECTION_DIGEST_MISMATCH` or `CONNECTION_FILE_CHANGED` | Check the retained parent and expected digest before rebuilding |
| `REBUILD_CONFIGURATION_CHANGED` | Restore the prior trial configuration, or intentionally create a new connection with `connect` |
| `UNSUPPORTED_REBUILD_CONNECTION` | Use this command with a supported Node-function connection; use the integration's build procedure for other candidates |
| `REBUILD_SOURCE_UNSUPPORTED` | Run `trial inspect <repository>` for the current declaration requirements |
| `SOURCE_CHANGED` | Finish source edits, then repeat into a new output directory |
| `DESTINATION_EXISTS` or `DESTINATION_OVERLAP` | Select a fresh directory outside both source and parent connection |
| `REBUILD_LINEAGE_MISMATCH` | Restore the retained recipe/record bytes or produce a fresh rebuild; do not edit recorded deltas |

## Supported boundary

This is a files-only rebuild: it does not compile TypeScript, install dependencies, run package scripts, execute the candidate, provision services or invoke an assistant. It does not establish transitive import coverage or map compiled output back to source. An unlisted source edit is outside this snapshot and does not change the candidate. Compiled/framework applications, still use their explicit integration build and pinning procedures. Dependency provenance here is the selected file/package inventory, not a resolved dependency graph.

**CURRENT — validation:** the automated checks exercise an ordinary source edit that changes observed reservation state, unchanged rebuilds, added/removed modules, moved connections, request conflicts, configuration preservation, invalid parent/lineage, non-execution, file boundaries and failure cleanup. Run the rebuild contract and runtime tests in `npm test`; see [current support](current-preview.md) for remaining limits. This slice does not close human M3 onboarding, external M4 assessment or unrelated-application M5 reuse, and does not establish a performance improvement.
