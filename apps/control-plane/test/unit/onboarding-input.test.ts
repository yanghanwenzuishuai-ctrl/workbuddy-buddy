import assert from "node:assert/strict";
import test from "node:test";

import {
  parseClaimPairingInput,
  parseCreateOfficeOnboardingInput,
  parseStatusCapability,
} from "../../src/modules/onboarding/domain/input.js";

const validOfficeInput = {
  office_name: "摸鱼研究所",
  alias: "Sora",
  pet_id: "sora-shiba",
  presence_visible: true,
  stats_opt_in: true,
  poster_opt_in: false,
};

test("Office onboarding accepts only the six explicit public fields", () => {
  assert.deepEqual(
    parseCreateOfficeOnboardingInput(structuredClone(validOfficeInput)),
    validOfficeInput,
  );

  assert.throws(() =>
    parseCreateOfficeOnboardingInput({
      ...validOfficeInput,
      public_view_token: "must-not-authorize-writes",
    }),
  );
  assert.throws(() =>
    parseCreateOfficeOnboardingInput({
      ...validOfficeInput,
      email: "private@example.com",
    }),
  );
});

test("Office onboarding validates names, booleans, and the 15-pet catalog", () => {
  assert.throws(() =>
    parseCreateOfficeOnboardingInput({
      ...validOfficeInput,
      office_name: "bad\nname",
    }),
  );
  assert.throws(() =>
    parseCreateOfficeOnboardingInput({
      ...validOfficeInput,
      office_name: " 摸鱼研究所 ",
    }),
  );
  assert.throws(() =>
    parseCreateOfficeOnboardingInput({
      ...validOfficeInput,
      alias: "bad\talias",
    }),
  );
  assert.throws(() =>
    parseCreateOfficeOnboardingInput({
      ...validOfficeInput,
      alias: "mail@example.com",
    }),
  );
  assert.throws(() =>
    parseCreateOfficeOnboardingInput({
      ...validOfficeInput,
      pet_id: "not-a-real-pet",
    }),
  );
  assert.throws(() =>
    parseCreateOfficeOnboardingInput({
      ...validOfficeInput,
      stats_opt_in: "yes",
    }),
  );
});

test("Edge claim requires a canonical 32-byte Ed25519 key and semver", () => {
  const input = {
    pairing_code: "A".repeat(43),
    public_key: Buffer.alloc(32, 7).toString("base64"),
    client_version: "0.1.0",
  };
  const parsed = parseClaimPairingInput(input);
  assert.equal(parsed.pairingCode, input.pairing_code);
  assert.deepEqual(parsed.publicKey, Buffer.alloc(32, 7));
  assert.equal(parsed.clientVersion, "0.1.0");

  assert.throws(() =>
    parseClaimPairingInput({ ...input, public_key: "A".repeat(44) }),
  );
  assert.throws(() =>
    parseClaimPairingInput({ ...input, client_version: "latest" }),
  );
  assert.throws(() =>
    parseClaimPairingInput({ ...input, instance_id: crypto.randomUUID() }),
  );
});

test("status capabilities are canonical high-entropy base64url values", () => {
  assert.equal(parseStatusCapability("z".repeat(43)), "z".repeat(43));
  assert.throws(() => parseStatusCapability("short"));
  assert.throws(() => parseStatusCapability(`${"z".repeat(42)}+`));
});
