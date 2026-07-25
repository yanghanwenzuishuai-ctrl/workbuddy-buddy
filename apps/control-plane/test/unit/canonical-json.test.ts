import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalBytes,
  canonicalJson,
  sha256,
} from "../../src/modules/presence/domain/canonical-json.js";

test("canonical JSON sorts object keys without reordering arrays", () => {
  const value = {
    z: 1,
    a: [{ b: true, a: null }, "fish"],
  };
  assert.equal(
    canonicalJson(value),
    '{"a":[{"a":null,"b":true},"fish"],"z":1}',
  );
});

test("canonical bytes and SHA-256 are deterministic", () => {
  const left = canonicalBytes({ b: 2, a: 1 });
  const right = canonicalBytes({ a: 1, b: 2 });
  assert.deepEqual(left, right);
  assert.equal(sha256(left).length, 32);
  assert.deepEqual(sha256(left), sha256(right));
});
