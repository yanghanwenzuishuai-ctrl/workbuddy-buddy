import { canonicalBytes } from "./canonical-json.js";
import type { EdgeReportEnvelope } from "./types.js";

/**
 * The trailing NUL is part of the protocol. It makes the boundary between the
 * ASCII domain and the canonical JSON payload unambiguous across runtimes.
 */
export const EDGE_REPORT_SIGNATURE_DOMAIN_V1 =
  "workbuddy-buddy/edge-report/v1\u0000";

export function createEdgeReportSigningPayload(
  envelope: EdgeReportEnvelope,
): Buffer {
  const { signature: _signature, ...unsignedEnvelope } = envelope;
  return Buffer.concat([
    Buffer.from(EDGE_REPORT_SIGNATURE_DOMAIN_V1, "utf8"),
    canonicalBytes(unsignedEnvelope),
  ]);
}
