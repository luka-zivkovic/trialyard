import type { FileRecord, Limits, Profile, Scenario } from "../contracts/types.js";

export interface Setup {
  schemaVersion: "trial-runner/setup/v1";
  template: "node-function/v1";
  agent: { entrypoint: string; files: string[]; dependencyMode: "declared-files-only";
    modelCapture: Profile["modelCapture"]; modelCaptureReason: string; requireUsage: boolean; secretBindings: string[] };
  environment: { template: "reference-inventory/v1" };
  scenario: Scenario;
  repetitions: number;
  limits?: Limits;
}
export interface TemplateIdentity { id: "node-function/v1"; environment: "reference-inventory/v1"; sha256: string; }
export interface Finding {
  kind: "module-type" | "command" | "dependency" | "connection";
  source: FileRecord; fact: string; interpretation: string;
  certainty: "observed" | "inferred" | "user_declared" | "validated";
}
export interface DiscoveryReport {
  schemaVersion: "trial-runner/discovery/v1";
  status: "declared" | "blocked";
  sources: FileRecord[]; template: TemplateIdentity;
  findings: Finding[]; candidates: { argv: string[]; source: FileRecord; certainty: "inferred" }[];
  unresolved: { code: string; message: string }[];
  exclusions: string[];
  execution: "not_run";
}
export interface Preparation {
  schemaVersion: "trial-runner/preparation/v1";
  status: "prepared" | "blocked";
  template: TemplateIdentity;
  discoverySha256: string;
  sources: FileRecord[];
  outputs: FileRecord[];
  plan: { path: "plan.json"; inputSha256: string } | null;
  execution: "not_run";
  nextSteps: string[][];
}
