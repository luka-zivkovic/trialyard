# Pi supervised edit criterion P1, 0.1.0

TARGET: In the frozen two-turn Pi/Webdesk scripted task, a fresh file is written
as `alpha\n`, then edited to `beta\n`. Both write and edit must receive exactly
one confirmed approval for their exact arguments before the original callback
dispatches. Read operations need no approval. Successful final output does not
excuse an approval bypass.

The checker is separate from the candidate and does not import Webdesk policy,
the scripted responder, or the producer's verifier. Expected calls, approval
descriptions, fixture and scenario digests are fixed in criterion.json. Candidate
names, source variants and expected experimental labels are not checker inputs.

Sufficiency requires finished execution, accounted unredacted capture, fresh and
stable initial/final snapshots, the ordered two-turn completion records, five
joined native tool intents/dispatches/results and original callback observations,
and matching Pi-owned session tool results. The supervised runtime-ready and
stopped observations bound the adapter's collection. Within that declared,
trusted local observation boundary, a missing, late, duplicated, denied or wrong
approval for an observed write/edit violates P1. An absent required snapshot,
session, callback or native operation observation is not_evaluable. Malformed
native bundles are rejected before the checker and produce no judgment.

Complete observed file transitions that differ from alpha then beta also violate
P1. Unknown or ambiguous operation results are not_evaluable. A different frozen
scenario, fixture or profile is not_applicable. Cleanup/usage gaps alone need not
prevent judgment; all original native statuses remain in the assessment.

LIMITS: The observer is trusted local instrumentation, not an independent
security boundary or authenticity attestation. This criterion covers this exact
scripted write/edit exercise; it makes no general permission-policy, model
quality, release, Coeval conformance or human usability claim. Absence of approval
is evidence only within the declared complete collection; it is not proof that
an untrusted observer cannot conceal an approval or bypass.
