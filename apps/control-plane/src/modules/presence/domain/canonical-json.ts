import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        const child = (value as Record<string, unknown>)[key];
        return `${JSON.stringify(key)}:${canonicalJson(child)}`;
      })
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function sha256(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}
