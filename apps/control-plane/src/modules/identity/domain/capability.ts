import { createHash, randomBytes } from "node:crypto";

export interface IssuedCapability {
  raw: string;
  digest: Buffer;
}

export function issueCapability(): IssuedCapability {
  const raw = randomBytes(32).toString("base64url");
  return { raw, digest: digestCapability(raw) };
}

export function digestCapability(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}
