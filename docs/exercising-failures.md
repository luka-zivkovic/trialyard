# Exercise failure boundaries

Start with the [independent example](../README.md#quickstart). Edit its generated `plan.json`, then run with a new request ID and inspect the result. Keep the compiled artifact files unchanged unless you also deliberately update their manifests.

| Edit | Observation |
| --- | --- |
| `agent.settings.variant = "duplicate"` | Two reservations under different keys; every attempt is retained. |
| `agent.settings.variant = "false-claim"` | The assistant claims a reservation; independently read state has none. |
| `agent.settings.variant = "crash"` | Unclassified adapter exit, incomplete evidence, available state, and cleanup. |
| `agent.settings.variant = "candidate-error"` | Explicit candidate failure; the captured failure can have complete evidence. |
| `agent.settings.variant = "hang"` | The configured trial deadline ends waiting. |
| `environment.settings.missingSnapshot = true` | Finished agent with incomplete evidence. |
| `environment.settings.cleanupFailure = true` | Cleanup diagnostics retained; later trials are not started. |

For example, after selecting `false-claim` in the plan:

```sh
npm run trial -- run .trial-runs/example/plan.json --request false-claim --store .trial-runs/store
npm run trial -- show --request false-claim --store .trial-runs/store --format text
```

This run can exit `0`: all required execution observations were captured, even though the claimed reservation does not exist. An external criterion decides whether that observed behavior is acceptable.

## Lose a response after a write

Add this entry to `environment.faultPlan`:

```json
{"tool": "reserve", "invocation": 1, "mode": "lost_after"}
```

The environment commits the fixture write and loses its response. Trialyard records an unknown operation outcome and reads available final state. It does not retry the operation. Supported reference fault modes are `error_before`, `lost_after`, and `hang`.

## Exit codes

| Exit | Meaning |
| --- | --- |
| `0` | All planned trials finished with complete evidence and successful cleanup. |
| `1` | Invalid input before acceptance. |
| `2` | Accepted execution failed, remained unfinished, missed evidence, or failed cleanup. |
| `130` | User cancellation. |

An interrupted accepted request is never replayed automatically. `show` reads retained coverage and observed operations without deciding executor liveness. Intent without a dispatch observation leaves dispatch unknown; observed dispatch without a result leaves the outcome unknown. See [runtime behavior](runtime-hardening.md).
