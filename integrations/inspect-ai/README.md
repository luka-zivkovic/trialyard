# Inspect AI retained-evidence experiment

**CURRENT:** a thin experimental bridge uses Inspect 0.3.263 to display retained P1 conversations and invoke the existing frozen Pi assessment consumer. The original execution bundles, mappings, criterion, consumer and historical assessment bytes remain unchanged. It creates new external assessment attempts and a separate scored Inspect log. It does not execute Pi, use an Inspect execution bridge or establish Inspect as a replacement runtime.

Use Python 3.12.14, an isolated virtual environment with `requirements.txt`, Node 24.15.0 and the existing local Pi retention corpus. The full resolved Python environment used in qualification is retained in the local evidence archive; the requirements file pins the direct dependency only.

```sh
/absolute/venv/bin/python integrations/inspect-ai/offline_spike.py /absolute/pi-development-loop-archive /absolute/new-inspect-output /absolute/node-24.15.0
```

The corpus must contain the retained `baseline-0`, `regression-0` and `missing-final-fixture` packages and their index. The Node bridge verifies each package with the existing consumer's retention verifier. It uses that same consumer for bounded reassessment and retains the original/native identities in each Inspect sample and score. No third consumer implementation is copied.

The experiment produces `imported.eval`, `scored.eval`, three source descriptors, new assessment attempts and `qualification.json`. Inspect is configured with an inert mock model because its evaluation schema has a model field; model generation is made an error. The actual candidate identity and capture limits remain in native metadata. The conversation is a display projection; callback/state evidence remains canonical in the retained bundle, with digest-bound observation references in score metadata.

The scorer preserves categorical values. Its explicit count metric reports satisfied, violated, not-evaluable, not-applicable, assessment-error, total and evaluable counts. Numeric epoch reduction is disabled. Results are joined by sample ID, not list order. Required source/descriptor mismatches fail the operation; assessor failures never become behavioral zeroes. A wrong archive digest is tested before checker dispatch.

Python outbound socket connections are disabled during this experiment, and the Node assessment subprocess receives only PATH/LANG/TZ. This is a bounded local execution check, not an OS-level security sandbox. Package installation requires network access separately.

Outputs and descriptors contain absolute local locators. Moving them requires a new import/reassessment request; this exporter is not a portable assessment-package format. Original P1 packages retain their existing portable retention contract. No Rubrist or Dailies integration is implied.
