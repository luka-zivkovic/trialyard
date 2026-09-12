# Runtime hardening and interruption inspection

The runtime behavior below is implemented in the local preview. See [current support](current-preview.md) for platform and integration boundaries.


## Accepted allocation and read-only inspection

Before an execution claim is published, the runner writes `accepted.json`: the initial run index with every trial ID, scenario, repetition and relative path allocated. The closed `trial-runner/request/v1` registry record pins its exact-byte SHA-256 alongside request ID, run ID and input digest. Acceptance first validates that allocation against the resolved plan and scenarios. `run.json` can subsequently update execution, bundle digests and terminal metadata; it cannot change the accepted allocation. Inspection rejects deleted, reordered, replaced or reassigned slots and changed acceptance bytes.

The input identity calculation remains unchanged. Older three-field preview request records still return their existing run without execution. Their original denominator cannot be proven from that mutable index alone: inspection reports `coverage: "unverified"`. No migration invents a historical allocation. Hashes establish internal consistency against the local registry, not host authenticity.

`trial show --request <id> --store <directory>` returns the stored index plus a closed `trial-runner/inspection/v1` object. Its coverage is `anchored` for a verified allocation and `unverified` for an older store. The run may still be active; `liveness` is explicitly `not_checked` and `executionResumed` is always false.

Each trial is `not_observed`, `unfinished`, `finalized` or `invalid`. Inspection reads only complete LF-terminated events, validates their identity/order/accounting, and reports any trailing bytes separately without modifying them. It carries recorded capture gaps and reports missing terminal or operation outcomes. A published bundle must pass native verification. If publication completed before the run-index update, inspection retains the verified terminal execution separately from the stale index and reports `index_update_missing`.

| Recorded evidence | Dispatch | Recorded outcome | Inspection outcome |
| --- | --- | --- | --- |
| Intent only | `unknown` | `null` | `outcome_unknown` |
| Intent and observed dispatch, no result | `observed` | `null` | `outcome_unknown` |
| Explicit closure before sending | `not_dispatched` | `not_dispatched` | `not_dispatched` |
| Observed dispatch and terminal result/error | `observed` | Recorded value | Same recorded value |

Finalized inspection requires a complete, closed journal and verified bundle. Symlinks beneath the selected store and at the run root are rejected. These checks do not defend against a hostile host racing filesystem operations. Inspection does not resume a conversation, infer a missing result, rerun an operation or claim exactly-once remote effects.

## Capture and transport bounds

The preview accepts `maxRecordedBytes` from 16 KiB through 64 MiB. Events, diagnostics, initial/final state and handshake/disposal observations share one serialized accounting path. Attachments are written and synced when observed, so a later overflow does not discard already captured state. Source/configuration inputs and manifest/index metadata are outside this payload allowance. Native bundle verification checks recorded bytes and event count against the pinned plan.

The journal reserves three records plus one per open operation, and 4,096 bytes plus 1,024 bytes per open operation, for gap/error/terminal/operation closure. Terminal error summaries are bounded to 1,024 JSON-encoded bytes. A shortened summary carries `[truncated]` and `error_message_truncated`; required capture is then incomplete. Filesystem failures that prevent trustworthy finalization preserve an unfinished accepted run.

Transport has separate finite guards: total inbound/outbound protocol and inbound diagnostic bytes across both workers are limited to `4 × maxRecordedBytes + 4 × maxFrameBytes`; each worker receives at most `4 × maxEvents + 100` frames and queues at most 128 callbacks across protocol and diagnostics. Frame length includes the final LF in both directions. Unterminated frames, invalid UTF-8/JSON, and overflow terminate capture with an explicit error/gap. Diagnostic UTF-8 decoding spans chunks, and queued diagnostic writes drain before terminal publication. These are capture/transport bounds, not CPU, process-memory, network or monetary isolation.

Stopping aborts pending business waiters. Actual process exit is reported independently of a callback waiting on another worker. Local process-group termination is idempotent and runs even if snapshot/disposal publication fails. Received observations and diagnostics drain before open operations are closed as unknown. This depends on a responsive host and filesystem; remote service cancellation and ownership-verified cleanup remain separate work.

## Verification scope

Synthetic process tests kill the coordinator before intent append, after durable append but before send, after environment receipt before observation, and after acknowledged observation before result. A test-owned external marker records physical receipt/mutation independently. Retained evidence stays conservative, later allocated slots remain visible, repeated requests do not replay, changed requests conflict, and inspection leaves journal bytes unchanged. A cooperative cancellation immediately after durable intent proves known non-dispatch. These are process-crash tests, not power-loss durability tests.

Capture tests exercise actual worker frame/unterminated-frame/stderr overflow; aggregate environment/agent diagnostics; shared wire exhaustion; exact frame boundaries including LF; callback bursts; malformed and split UTF-8; disposal-time diagnostics; and escaped errors near the terminal reserve. Shutdown regressions cover a dead agent with a pending hanging tool, an unresponsive `describe`, and a real snapshot publication failure while both workers exist. Existing contract, independent-consumer, CLI and runtime tests also run.

Recorded validation on macOS with Node 24.15.0: build passed, the full suite passed 104 tests, and the contract rerun passed 27 tests including two additional consumer-limit regressions (106 distinct passing tests). Independent review of the final runtime found no remaining correctness blockers. A delayed diagnostic filesystem failure after an observed agent exit was independently reproduced and verified to leave unfinished evidence.
