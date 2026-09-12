import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { bundleFixture } from "./fixtures.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

for (const name of ["plan.json", "state.json", "agent.js"]) {
  test(`static validation rejects a FIFO at ${name} without blocking on open`, async t => {
    const { root } = await bundleFixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const filename = path.join(root, "inputs", name);
    await fs.rm(filename);
    await execFileAsync("mkfifo", [filename], { env: { PATH: "/usr/bin:/bin" } });
    // A subprocess timeout bounds the regression even if open() blocks a libuv
    // worker indefinitely. The expected failure is validation exit 1, not a kill.
    await assert.rejects(execFileAsync(process.execPath, [cli, "validate", path.join(root, "inputs/plan.json")],
      { timeout: 3000, killSignal: "SIGKILL" }), (error: Error & { code?: number; killed?: boolean; stderr?: string }) => {
        assert.equal(error.killed, false);
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? "", /bounded regular file/);
        return true;
      });
  });
}
