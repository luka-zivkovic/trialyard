import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SecretContext, SecretMask, validateSecretBindings } from "../src/core/privacy.js";

test("bindings select only the named recipient and reject runtime controls or missing values", () => {
  const token = randomUUID(); const unrelated = randomUUID();
  const context = new SecretContext([{ name: "SERVICE_TOKEN", recipient: "agent" }], { SERVICE_TOKEN: token, UNRELATED: unrelated });
  assert.deepEqual(context.environment("agent"), { SERVICE_TOKEN: token }); assert.deepEqual(context.environment("environment"), {});
  assert.equal(context.mask.contains(unrelated), false);
  assert.throws(() => new SecretContext([{ name: "SERVICE_TOKEN", recipient: "agent" }], {}));
  for (const name of ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "HOME"]) assert.throws(() => validateSecretBindings([{ name, recipient: "agent" }]));
});

test("JSON masks strings and numeric literals; structural keys and public inputs fail closed", () => {
  const token = randomUUID() + '\\"\n☂'; const numeric = String(10000000 + Math.floor(Math.random() * 90000000));
  const mask = new SecretMask([token, numeric]);
  const result = mask.json({ nested: [token, { value: Number(numeric) }], safe: "ordinary text" });
  assert.equal(result.redacted, true); assert.deepEqual(result.value, { nested: ["REDACTED", { value: null }], safe: "ordinary text" });
  assert.throws(() => mask.json({ [token]: "value" }));
  assert.throws(() => mask.assertPublic({ text: token }));
  assert.throws(() => mask.assertPublicBytes(Buffer.from(JSON.stringify({ text: token }))));
});

test("diagnostic masking covers every split point, overlapping values and trailing ordinary text", () => {
  const token = randomUUID(); const long = token + randomUUID();
  for (let index = 0; index <= long.length; index++) {
    const stream = new SecretMask([token, long]).stream();
    const parts = [stream.write("before " + long.slice(0, index)), stream.write(long.slice(index) + " after"), stream.end()];
    assert.equal(parts.map(part => part.text).join(""), "before REDACTED after"); assert.ok(parts.some(part => part.redacted));
  }
  const stream = new SecretMask([token]).stream(); assert.equal(stream.write("ordinary ☂ text").text + stream.end().text, "ordinary ☂ text");
});
