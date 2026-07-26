import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config.js";
import { EDGE_REPORT_SIGNATURE_DOMAIN_V1 } from "../../src/modules/presence/domain/edge-signature.js";
import { ProtocolProblem } from "../../src/modules/presence/domain/problem.js";
import { createEdgeReportValidator } from "../../src/platform/contracts/edge-report-validator.js";

const baseReport = {
  protocol_version: 1,
  instance_id: "11111111-1111-4111-8111-111111111111",
  key_id: "33333333-3333-4333-8333-333333333333",
  boot_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  previous_boot_id: null,
  first_sequence: 1,
  events: [
    {
      sequence: 1,
      kind: "state_transition",
      observed_at: "2026-07-24T12:00:00Z",
      display_state: "idle",
      activity_state: "eligible_idle",
      pet_id: "sora-shiba",
    },
  ],
  sent_at: "2026-07-24T12:00:01Z",
  client_version: "0.1.0",
  signature: `${"A".repeat(86)}==`,
};

const validator = await createEdgeReportValidator(loadConfig().contractsDir);

test("validator prepares a schema-valid privacy-safe report", () => {
  const prepared = validator.prepare(structuredClone(baseReport), "batch");
  assert.equal(prepared.envelope.first_sequence, 1);
  assert.equal(prepared.canonicalEvents.length, 1);
  assert.equal(prepared.canonicalPayloadHash.length, 32);
  assert.equal(
    prepared.signingPayload
      .subarray(0, Buffer.byteLength(EDGE_REPORT_SIGNATURE_DOMAIN_V1))
      .toString("utf8"),
    EDGE_REPORT_SIGNATURE_DOMAIN_V1,
  );
});

test("signing bytes omit signature while stored canonical bytes retain it", () => {
  const left = validator.prepare(structuredClone(baseReport), "batch");
  const right = validator.prepare(
    {
      ...structuredClone(baseReport),
      signature: `${"B".repeat(86)}==`,
    },
    "batch",
  );

  assert.deepEqual(left.signingPayload, right.signingPayload);
  assert.notDeepEqual(left.canonicalPayload, right.canonicalPayload);
});

test("validator rejects client-authoritative or private fields", () => {
  const report = structuredClone(baseReport) as Record<string, unknown>;
  report.session_id = "private";
  assertProblem(() => validator.prepare(report, "batch"), "invalid_request");
});

test("validator distinguishes intra-batch gap and overlap", () => {
  const gap = structuredClone(baseReport);
  gap.events.push({
    sequence: 3,
    kind: "state_transition",
    observed_at: "2026-07-24T12:00:00Z",
    display_state: "idle",
    activity_state: "eligible_idle",
    pet_id: "sora-shiba",
  });
  assertProblem(() => validator.prepare(gap, "batch"), "sequence_gap");

  const overlap = structuredClone(baseReport);
  overlap.events.push({
    sequence: 1,
    kind: "state_transition",
    observed_at: "2026-07-24T12:00:00Z",
    display_state: "idle",
    activity_state: "eligible_idle",
    pet_id: "sora-shiba",
  });
  assertProblem(
    () => validator.prepare(overlap, "batch"),
    "sequence_overlap",
  );
});

test("heartbeat endpoint accepts exactly one heartbeat", () => {
  const heartbeat = {
    ...structuredClone(baseReport),
    events: [
      {
        sequence: 1,
        kind: "heartbeat",
        observed_at: "2026-07-24T12:00:00Z",
      },
    ],
  };
  assert.doesNotThrow(() => validator.prepare(heartbeat, "heartbeat"));
  assertProblem(
    () => validator.prepare(baseReport, "heartbeat"),
    "invalid_request",
  );
});

test("unsupported protocols get an actionable upgrade problem", () => {
  const report = { ...structuredClone(baseReport), protocol_version: 2 };
  assertProblem(
    () => validator.prepare(report, "batch"),
    "protocol_version_unsupported",
  );
});

function assertProblem(
  operation: () => unknown,
  expectedCode: ProtocolProblem["code"],
): void {
  assert.throws(operation, (error: unknown) => {
    return error instanceof ProtocolProblem && error.code === expectedCode;
  });
}
