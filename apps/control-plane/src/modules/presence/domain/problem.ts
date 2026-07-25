export type ProblemCode =
  | "invalid_request"
  | "protocol_version_unsupported"
  | "invalid_signature"
  | "instance_not_found"
  | "device_revoked"
  | "stale_boot"
  | "sequence_gap"
  | "sequence_overlap"
  | "sequence_conflict"
  | "report_semantics_invalid"
  | "payload_too_large"
  | "temporarily_unavailable"
  | "internal_error";

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  detail?: string;
  expected_sequence?: number;
  current_protocol?: number;
  min_supported_protocol?: number;
}

export class ProtocolProblem extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly expectedSequence: number | undefined;

  constructor(
    code: ProblemCode,
    status: number,
    detail: string,
    expectedSequence?: number,
  ) {
    super(detail);
    this.name = "ProtocolProblem";
    this.code = code;
    this.status = status;
    this.expectedSequence = expectedSequence;
  }

  toBody(): ProblemBody {
    const body: ProblemBody = {
      type: `https://workbuddy-buddy.invalid/problems/${this.code}`,
      title: titleFor(this.code),
      status: this.status,
      code: this.code,
      detail: this.message,
    };
    if (this.expectedSequence !== undefined) {
      body.expected_sequence = this.expectedSequence;
    }
    if (this.code === "protocol_version_unsupported") {
      body.current_protocol = 1;
      body.min_supported_protocol = 1;
    }
    return body;
  }
}

function titleFor(code: ProblemCode): string {
  switch (code) {
    case "invalid_request":
      return "Invalid request";
    case "protocol_version_unsupported":
      return "Protocol upgrade required";
    case "invalid_signature":
      return "Invalid device signature";
    case "instance_not_found":
      return "Agent instance not found";
    case "device_revoked":
      return "Device credential is unavailable";
    case "stale_boot":
      return "Agent boot has been fenced";
    case "sequence_gap":
      return "Sequence gap";
    case "sequence_overlap":
      return "Sequence overlap";
    case "sequence_conflict":
      return "Sequence conflict";
    case "report_semantics_invalid":
      return "Report semantics are invalid";
    case "payload_too_large":
      return "Payload too large";
    case "temporarily_unavailable":
      return "Temporarily unavailable";
    case "internal_error":
      return "Internal server error";
  }
}
