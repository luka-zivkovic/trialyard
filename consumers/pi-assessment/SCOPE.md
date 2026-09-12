# Pi assessment scope

TARGET: the bounded engineering qualification in
`docs/pi-development-loop-protocol-20260911.md`. The exact P1 definition and
positive/negative fixtures precede execution. Candidate implementation names,
expected variant judgments and application policy functions are not checker
inputs. The independent verifier is a snapshot of local-assessment 0.1.0;
verification scope is native-bytes-mapping-and-observation-links/v1, not the full
producer verifier. The runner additionally verifies every qualification bundle.

CURRENT: same immutable request/attempt/receipt, worker bounds and retention
contracts as local-assessment, with a separate pi-observation-consumer identity
and fixed pi-supervised-edit-p1 criterion. Worker input is bounded to 24 MiB,
output to 1 MiB and deadline to 50–30000 ms. Unsupported native data is rejected
before assessment. P1 sufficiency and limitations live in the frozen definition.

The verifier's input support is unredacted native bundles with exact inventory,
safe regular files, strict JSON, fixed schema, exact mapping/identity and linked
native observations. It never imports or executes producer/candidate code. The
qualification's missing-final fixture is explicitly synthetic, with a declared
gap and a separate lineage record. It is not an observed capture failure.

LIMITS: no human validation, governed criterion authority, Coeval integration,
general Pi policy coverage, model reasoning assessment, release decision or
hostile-process isolation. The observer is trusted local instrumentation; hashes
establish identity and integrity, not authenticity. Local archives are portable
copies, not off-device backups.
