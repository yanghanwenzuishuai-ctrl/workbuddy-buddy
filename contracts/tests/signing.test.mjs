import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACTS_DIR, readJson } from "./contract-helpers.mjs";

const GOLDEN_FILE = path.join(
  CONTRACTS_DIR,
  "fixtures/edge-report-signature.v1.golden.json",
);
const ED25519_PKCS8_SEED_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);

test("frozen Edge signature vector is reproducible and verifies", async () => {
  const vector = await readJson(GOLDEN_FILE);
  const { signature, ...unsignedEnvelope } = vector.envelope;
  const canonical = stableJson(unsignedEnvelope);
  assert.equal(canonical, vector.canonical_unsigned_json);

  const domain = Buffer.from(vector.domain_separator_hex, "hex");
  assert.equal(domain.length, 31);
  assert.equal(domain.toString("utf8"), vector.domain_separator_utf8);
  const payload = Buffer.concat([domain, Buffer.from(canonical, "utf8")]);
  assert.equal(
    createHash("sha256").update(payload).digest("hex"),
    vector.signing_payload_sha256_hex,
  );

  const privateKey = createPrivateKey({
    key: Buffer.concat([
      ED25519_PKCS8_SEED_PREFIX,
      Buffer.from(vector.private_key_seed_hex, "hex"),
    ]),
    format: "der",
    type: "pkcs8",
  });
  assert.equal(sign(null, payload, privateKey).toString("base64"), signature);

  const publicKey = createPublicKey({
    key: Buffer.concat([
      ED25519_SPKI_PREFIX,
      Buffer.from(vector.public_key_raw_hex, "hex"),
    ]),
    format: "der",
    type: "spki",
  });
  assert.equal(
    verify(null, payload, publicKey, Buffer.from(signature, "base64")),
    true,
  );

  const tampered = Buffer.concat([payload, Buffer.from(" ", "utf8")]);
  assert.equal(
    verify(null, tampered, publicKey, Buffer.from(signature, "base64")),
    false,
  );
});

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
