export const MAX_SAFE_SEQUENCE = 9_007_199_254_740_991;

export type DisplayState = "idle" | "working" | "waiting" | "done" | "failed";
export type ActivityState =
  | "unknown"
  | "active"
  | "eligible_idle"
  | "waiting"
  | "failed";

export interface StateTransitionEvent {
  sequence: number;
  kind: "state_transition";
  observed_at: string;
  display_state: DisplayState;
  activity_state: ActivityState;
  pet_id: string;
}

export interface HeartbeatEvent {
  sequence: number;
  kind: "heartbeat";
  observed_at: string;
}

export type EdgeEvent = StateTransitionEvent | HeartbeatEvent;

export interface EdgeReportEnvelope {
  protocol_version: 1;
  instance_id: string;
  key_id: string;
  boot_id: string;
  previous_boot_id: string | null;
  first_sequence: number;
  events: EdgeEvent[];
  sent_at: string;
  client_version: string;
  signature: string;
}

export interface EdgeReportAck {
  current_protocol: number;
  min_supported_protocol: number;
  instance_id: string;
  boot_id: string;
  accepted_through_sequence: number;
  server_received_at: string;
  lease_expires_at: string;
}

export interface VerifiedEdgeContext {
  instanceId: string;
  keyId: string;
  verification: "ed25519" | "development_bypass";
  credentialPublicKeySha256?: Buffer;
}

export type EdgeEndpoint = "batch" | "heartbeat";

export interface PreparedEdgeReport {
  envelope: EdgeReportEnvelope;
  endpoint: EdgeEndpoint;
  signingPayload: Buffer;
  canonicalPayload: Buffer;
  canonicalPayloadHash: Buffer;
  canonicalEvents: Array<{
    event: EdgeEvent;
    bytes: Buffer;
    hash: Buffer;
  }>;
}
