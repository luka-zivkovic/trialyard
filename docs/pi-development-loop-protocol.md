# Pi development-loop qualification protocol

**TARGET — public qualification procedure:** demonstrate a source regression that final-output checking misses, diagnose it through retained native evidence, correct it, and reassess with an external consumer.

Use the Pi 0.84.2/Webdesk native scripted baseline scenario and fixture: read README, write notes as alpha, then read/edit/read it as beta. Supply an existing parent connection and the pinned installed Webdesk workspace to the [qualification driver](../integrations/pi-webdesk/development-loop-guide.md). The driver materializes captured source into owned copies; the installed workspace supplies fixed compiler inputs and dependencies.

| Stage | Source change | Expected P1 | Native expectation |
| --- | --- | --- | --- |
| Baseline | No-op rebuild of captured source | satisfied, twice | finished, complete, cleanup succeeded |
| Regression | Add edit to ROUTINE_READ_ONLY_TOOL_NAMES in copied pita-policy.ts | violated, twice | same; notes still beta |
| Correction | Remove that exact edit entry after diagnosis | satisfied, twice | same; notes still beta |
| Missing-final fixture | Omit final-state.json from a baseline-derived fixture and declare the missing evidence | not_evaluable | synthetic consumer fixture; no additional candidate execution |

The external [P1 definition](../consumers/pi-assessment/vendor/pi-approval-p1.md), criterion scope digests, and positive/negative tests precede execution. Freeze checker, criterion, protocol, candidate change and matrix identities before the first run. A later criterion amendment requires a new qualification attempt with old evidence retained.

Record full run denominators, source selections, rebuild lineage, native verification, export mappings and separate assessments. Diagnose retained regression evidence before creating the corrected copy. Package each result with source bytes and the matching consumer; relocate and reassess an owned package. Exercise duplicate/no-replay, input conflicts and tamper rejection. Check distinct sessions, removed leases, stable final files, source/configuration continuity and unchanged installed Webdesk sources.

**ASSUMPTION:** at this declared trusted observation boundary, an observed edit dispatch without prior approval establishes the P1 violation. It is not a security claim against a malicious observer or host. The provider is a local scripted fixture. Human onboarding, independent review and general model-quality qualification remain open.

This public procedure replaces an earlier private pilot protocol. It has no dependency on other customer-specific consumers. Each new qualification records its actual protocol and implementation digests; historical records are not rewritten.
