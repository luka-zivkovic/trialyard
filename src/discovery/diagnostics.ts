import { ContractValidationError } from "../contracts/validate.js";
import type { DiscoveryDetail } from "./safe.js";

// Only schema-owned setup names and array indices may enter public diagnostics.
// AJV messages/unknown property names can contain repository values; never echo them.
const names = new Set("schemaVersion template agent entrypoint files dependencyMode modelCapture modelCaptureReason requireUsage secretBindings environment scenario id description messages role content provenance origin exposure externalCriterionRefs repetitions limits prepareMs trialMs stopMs snapshotMs cleanupMs maxTurns maxFrameBytes maxEvents maxRecordedBytes".split(" "));
export function setupIssue(error: unknown): DiscoveryDetail | undefined {
  if (!(error instanceof ContractValidationError) || !error.issue) return;
  const issue = error.issue, segments = issue.instancePath.split("/").slice(1);
  if (segments.some(s => !names.has(s) && !/^\d{1,5}$/.test(s))) return;
  if (issue.keyword === "required" && names.has(issue.params.missingProperty)) segments.push(issue.params.missingProperty);
  const rules: Record<string, string> = { required: "required field is missing", additionalProperties: "unknown fields are not supported", enum: "value must be one of the setup/v1 choices", const: "value must match the setup/v1 constant", type: "value has the wrong JSON type", minItems: "array has too few items", maxItems: "array has too many items", minLength: "text is too short", maxLength: "text is too long", minimum: "value is below the minimum", maximum: "value exceeds the maximum" };
  let rule = rules[issue.keyword] ?? "field does not satisfy setup/v1";
  if (["minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"].includes(issue.keyword) && Number.isSafeInteger(issue.params.limit)) rule += ` ${issue.params.limit}`;
  if (issue.keyword === "type" && ["object", "array", "string", "number", "integer", "boolean", "null"].includes(issue.params.type)) rule += `; expected ${issue.params.type}`;
  return { phase: "inspect", path: "/" + segments.join("/"), rule,
    action: "Correct this field in trial-runner.setup.json and inspect again." };
}
