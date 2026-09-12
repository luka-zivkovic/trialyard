# Contributor context

Before implementation, read README.md, PRODUCT.md, docs/decisions.md, docs/architecture-and-contracts.md, docs/evaluation-handoff.md, docs/implementation-plan.md and docs/current-preview.md. The public snapshot includes the independent core, Node setup, Pi integration and separate assessment experiments. Private customer pilots and historical run archives are outside this checkout.

Human onboarding observation and broader integration/consumer acceptance remain open. An assistant replay is not a human usability study. Label material direction/support claims TARGET, CURRENT or ASSUMPTION as defined in docs/decisions.md.

Preserve the confirmed product boundary and distinguish specified targets from current behavior. The user completed specification and authorized starting implementation. Follow the milestone order and report remaining qualification honestly.

Keep the core, reference fixtures and conformance tests independent of customer applications and traces. Customer-specific adapters belong in integrations. Do not copy customer data, credentials, prompts or business expectations into core fixtures.

Implement schemas, semantic invariants and positive/negative fixtures before runtime behavior. Keep execution state, evidence completeness, operation outcome and cleanup separate. Test failure boundaries and duplicate requests, not only successful transcripts.

Do not introduce release policy, evaluator calibration, static admission or a production serving proxy. Do not claim a child process is a hostile-code sandbox, a hash proves authenticity, or a scripted reference test establishes real-agent quality.

No credentials in source, configuration examples or captured artifacts. Preserve unrelated changes and report exactly what was tested and what remains unqualified.
