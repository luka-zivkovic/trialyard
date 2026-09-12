import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const cliPath = fileURLToPath(new URL("./main.js", import.meta.url));
export function printCommand(label: string, argv: string[]): void {
  // POSIX quoting prevents interpolation of $, backticks, spaces and single quotes.
  // Avoid rendering terminal controls from caller-supplied paths or request IDs.
  if (argv.some(s => /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s))) return;
  process.stderr.write(`${label}: ${argv.map(s => `'${s.replace(/'/g, "'\\''")}'`).join(" ")}\n`);
}
export function inspectionHint(request: string, store: string): void {
  printCommand("Inspect evidence", [process.execPath, cliPath, "show", "--request", request, "--store", path.resolve(store), "--format", "text"]);
}
export function connectionHints(recipe: string, plan: { path: string } | null): void {
  if (!plan) {
    const guide = path.join(path.dirname(recipe), path.basename(recipe) === "preparation.json" ? "GETTING_STARTED.md" : "prepared/GETTING_STARTED.md");
    process.stderr.write(`Setup is blocked. Review the returned requirements and ${JSON.stringify(guide)}.\n`);
    return;
  }
  const filename = path.resolve(path.dirname(recipe), plan.path), store = path.join(path.dirname(filename), ".trial-runs");
  process.stderr.write("Review the frozen plan, scenario, fixture and capture profile before execution.\n");
  printCommand("Run a first trial", [process.execPath, cliPath, "run", filename, "--request", "first-trial", "--store", store]);
  inspectionHint("first-trial", store);
}
