import { ProtocolProblem } from "../domain/problem.js";
import type {
  PreparedEdgeReport,
  VerifiedEdgeContext,
} from "../domain/types.js";

export interface EdgeVerifier {
  verify(report: PreparedEdgeReport): Promise<VerifiedEdgeContext>;
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
