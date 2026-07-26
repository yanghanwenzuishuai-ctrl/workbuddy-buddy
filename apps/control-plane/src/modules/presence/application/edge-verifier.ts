import {
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

import type { DatabasePool } from "../../../platform/db/pool.js";
import { sha256 } from "../domain/canonical-json.js";
import { ProtocolProblem } from "../domain/problem.js";
import type {
  PreparedEdgeReport,
  VerifiedEdgeContext,
} from "../domain/types.js";

const ED25519_RAW_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_SIGNATURE_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);

export interface EdgeVerifier {
  verify(report: PreparedEdgeReport): Promise<VerifiedEdgeContext>;
}

export interface ActiveDeviceCredential {
  instanceId: string;
  keyId: string;
  publicKey: Buffer;
}

export interface DeviceCredentialResolver {
  findActive(
    instanceId: string,
    keyId: string,
  ): Promise<ActiveDeviceCredential | undefined>;
}

interface CredentialRow {
  instance_id: string;
  key_id: string;
  public_key: Buffer;
}

export function createDatabaseDeviceCredentialResolver(
  pool: DatabasePool,
): DeviceCredentialResolver {
  return {
    async findActive(
      instanceId: string,
      keyId: string,
    ): Promise<ActiveDeviceCredential | undefined> {
      const result = await pool.query<CredentialRow>(
        `SELECT instance_id, key_id, public_key
           FROM control_plane.device_credentials
          WHERE instance_id = $1
            AND key_id = $2
            AND algorithm = 'ed25519'
            AND revoked_at IS NULL
            AND valid_until > clock_timestamp()`,
        [instanceId, keyId],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            instanceId: row.instance_id,
            keyId: row.key_id,
            publicKey: row.public_key,
          };
    },
  };
}

export function createEd25519EdgeVerifier(
  pool: DatabasePool,
): Ed25519EdgeVerifier {
  return new Ed25519EdgeVerifier(
    createDatabaseDeviceCredentialResolver(pool),
  );
}

export class Ed25519EdgeVerifier implements EdgeVerifier {
  constructor(private readonly credentials: DeviceCredentialResolver) {}

  async verify(report: PreparedEdgeReport): Promise<VerifiedEdgeContext> {
    const credential = await this.credentials.findActive(
      report.envelope.instance_id,
      report.envelope.key_id,
    );
    if (credential === undefined) {
      throw new ProtocolProblem(
        "device_revoked",
        401,
        "The Agent instance or device credential is unavailable.",
      );
    }

    const publicKey = createEd25519PublicKey(credential.publicKey);
    const signature = decodeEd25519Signature(report.envelope.signature);
    if (
      !verifySignature(
        null,
        report.signingPayload,
        publicKey,
        signature,
      )
    ) {
      throw invalidSignatureProblem();
    }

    return {
      instanceId: credential.instanceId,
      keyId: credential.keyId,
      verification: "ed25519",
      credentialPublicKeySha256: sha256(credential.publicKey),
    };
  }
}

export class DisabledEdgeVerifier implements EdgeVerifier {
  async verify(_report: PreparedEdgeReport): Promise<VerifiedEdgeContext> {
    throw new ProtocolProblem(
      "temporarily_unavailable",
      503,
      "Edge reporting is disabled until a device verifier is configured.",
    );
  }
}

export class DevelopmentBypassEdgeVerifier implements EdgeVerifier {
  async verify(report: PreparedEdgeReport): Promise<VerifiedEdgeContext> {
    return {
      instanceId: report.envelope.instance_id,
      keyId: report.envelope.key_id,
      verification: "development_bypass",
    };
  }
}

function createEd25519PublicKey(rawPublicKey: Buffer) {
  if (rawPublicKey.length !== ED25519_RAW_PUBLIC_KEY_BYTES) {
    throw invalidSignatureProblem();
  }

  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
      format: "der",
      type: "spki",
    });
  } catch {
    throw invalidSignatureProblem();
  }
}

function decodeEd25519Signature(encoded: string): Buffer {
  if (!ED25519_SIGNATURE_BASE64_PATTERN.test(encoded)) {
    throw invalidSignatureProblem();
  }
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.length !== ED25519_SIGNATURE_BYTES ||
    decoded.toString("base64") !== encoded
  ) {
    throw invalidSignatureProblem();
  }
  return decoded;
}

function invalidSignatureProblem(): ProtocolProblem {
  return new ProtocolProblem(
    "invalid_signature",
    401,
    "The device signature is invalid.",
  );
}
