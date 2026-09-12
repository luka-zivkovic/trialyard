# Trialyard documentation

## Start and iterate

| Guide | Use it to |
| --- | --- |
| [Quickstart](../README.md#quickstart) | Run the independent local example. |
| [Node function setup](assisted-setup.md) | Connect a declared ESM agent to the reference environment. |
| [Connections and setup skill](connection-setup.md) | Retain a connection or guide a custom integration with an assistant. |
| [Source rebuilds](connection-rebuild.md) | Create a new source candidate while preserving trial configuration. |
| [Failure exercises](exercising-failures.md) | Try false claims, lost responses, timeouts, and missing state. |
| [Pi integration](../integrations/pi-webdesk/native-guide.md) | Run real Pi with controlled tools and a scripted provider. |

## Understand the evidence

| Guide | Covers |
| --- | --- |
| [Architecture and contracts](architecture-and-contracts.md) | Agent/environment boundaries, lifecycle, schemas, and identities. |
| [Runtime behavior](runtime-hardening.md) | Interruption, accounting, limits, and retained partial runs. |
| [Model accounting](model-accounting.md) | Capture modes, attempts, usage, and unknown observations. |
| [Credentials and exports](privacy-and-exports.md) | Explicit credential bindings, masking, and omission exports. |
| [Assessment handoff](evaluation-handoff.md) | Using execution evidence in a separate assessment. |

## Project direction

[Product charter](../PRODUCT.md) · [Decisions](decisions.md) · [Current support](current-preview.md) · [Implementation plan](implementation-plan.md) · [Contributing](../CONTRIBUTING.md)

The public repository starts from a curated snapshot of the earlier Trial Runner project. Private customer integrations, captured pilot evidence, and internal audit archives remain outside this checkout. The original `trial-runner/*/v1` identifiers are preserved for compatibility.
