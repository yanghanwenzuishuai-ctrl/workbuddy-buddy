import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config.js";
import {
  Ed25519EdgeVerifier,
  type DeviceCredentialResolver,
} from "../../src/modules/presence/application/edge-verifier.js";
import { ProtocolProblem } from "../../src/modules/presence/domain/problem.js";
import type {
  EdgeReportEnvelope,
  PreparedEdgeReport,
} from "../../src/modules/presence/domain/types.js";
import { createEdgeReportValidator } from "../../src/platform/contracts/edge-report-validator.js";

interface GoldenFixture {
  public_key_raw_hex: string;
  envelope: EdgeReportEnvelope;
}

const config = loadConfig();
const golden = JSON.parse(
  await readFile(
    path.join(
      config.contractsDir,
      "fixtures/edge-report-signature.v1.golden.json",
    ),
    "utf8",
  ),
) as GoldenFixture;
const validator = await createEdgeReportValidator(config.contractsDir);

test("real verifier accepts the frozen Ed25519 golden vector", async () => {
  const publicKey = Buffer.from(golden.public_key_raw_hex, "hex");
  const verifier = verifierFor(publicKey);
  const verified = await verifier.verify(prepareGolden());

  assert.deepEqual(verified, {
    instanceId: golden.envelope.instance_id,
    keyId: golden.envelope.key_id,
    verification: "ed25519",
    credentialPublicKeySha256: createHash("sha256")
      .update(publicKey)
      .digest(),
  });
});

test("real verifier rejects a valid signature under the wrong public key", async () => {
  const wrongRfc8032PublicKey = Buffer.from(
    "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    "hex",
  );
  await assertInvalidSignature(
    verifierFor(wrongRfc8032PublicKey).verify(prepareGolden()),
  );
});

test("real verifier rejects a report changed after signing", async () => {
  const tamperedEnvelope = structuredClone(golden.envelope);
  const firstEvent = tamperedEnvelope.events[0];
  assert.ok(firstEvent?.kind === "state_transition");
  firstEvent.pet_id =
    firstEvent.pet_id === "bloop" ? "sora-shiba" : "bloop";
  const tampered = validator.prepare(tamperedEnvelope, "batch");

  await assertInvalidSignature(
    verifierFor(Buffer.from(golden.public_key_raw_hex, "hex")).verify(
      tampered,
    ),
  );
});

test("real verifier strictly rejects malformed or wrong-length Base64", async () => {
  for (const signature of [
    `${"!".repeat(86)}==`,
    "A".repeat(86),
    `${"A".repeat(87)}=`,
  ]) {
    const prepared = prepareGolden();
    const malformed: PreparedEdgeReport = {
      ...prepared,
      envelope: {
        ...prepared.envelope,
        signature,
      },
    };

    await assertInvalidSignature(
      verifierFor(Buffer.from(golden.public_key_raw_hex, "hex")).verify(
        malformed,
      ),
    );
  }
});

test("real verifier requires an exact 32-byte raw Ed25519 public key", async () => {
  for (const bytes of [31, 33]) {
    await assertInvalidSignature(
      verifierFor(Buffer.alloc(bytes)).verify(prepareGolden()),
    );
  }
});

test("real verifier treats missing or inactive credentials as revoked", async () => {
  const resolver: DeviceCredentialResolver = {
    async findActive() {
      return undefined;
    },
  };
  await assert.rejects(
    new Ed25519EdgeVerifier(resolver).verify(prepareGolden()),
    isProblem("device_revoked"),
  );
});

function prepareGolden(): PreparedEdgeReport {
  return validator.prepare(structuredClone(golden.envelope), "batch");
}

function verifierFor(publicKey: Buffer): Ed25519EdgeVerifier {
  const resolver: DeviceCredentialResolver = {
    async findActive(instanceId, keyId) {
      return { instanceId, keyId, publicKey };
    },
  };
  return new Ed25519EdgeVerifier(resolver);
}

async function assertInvalidSignature(
  operation: Promise<unknown>,
): Promise<void> {
  await assert.rejects(operation, isProblem("invalid_signature"));
}

function isProblem(code: ProtocolProblem["code"]) {
  return (error: unknown): boolean =>
    error instanceof ProtocolProblem && error.code === code;
}
