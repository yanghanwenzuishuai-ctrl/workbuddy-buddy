import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { CONTRACTS_DIR, readJson } from "./contract-helpers.mjs";
import { ProtocolAcceptanceModel } from "./protocol-model.mjs";

const POLICY_FILE = path.join(CONTRACTS_DIR, "protocol-policy.v1.json");
const ACK_SCHEMA_FILE = path.join(
  CONTRACTS_DIR,
  "schemas/edge-report-ack.v1.schema.json",
);
const PROBLEM_SCHEMA_FILE = path.join(
  CONTRACTS_DIR,
  "schemas/problem.v1.schema.json",
);
const ACK_FIXTURE_FILE = path.join(
  CONTRACTS_DIR,
  "fixtures/edge-report-ack.valid.json",
);
const PROBLEM_FIXTURE_FILE = path.join(
  CONTRACTS_DIR,
  "fixtures/problem.valid.json",
);

test("compatibility policy exposes only current N and, once it exists, N-1", async () => {
  const policy = await readJson(POLICY_FILE);
  const { current, minimum_supported: minimum, support_window: window } =
    policy.protocol;

  assert.ok(Number.isSafeInteger(current) && current >= 1);
  assert.ok(Number.isSafeInteger(minimum) && minimum >= 1);
  assert.equal(window, 2);
  assert.equal(minimum, Math.max(1, current - 1));
  assert.ok(current - minimum + 1 <= window);
});

test("v1 accepts N, does not invent v0, and advertises the supported window", async () => {
  const policy = await readJson(POLICY_FILE);
  const model = new ProtocolAcceptanceModel(policy);
  const { current, minimum_supported: minimum } = policy.protocol;

  assert.deepEqual(model.protocolDecision(current), { ok: true });
  assert.deepEqual(model.protocolDecision(0), {
    ok: false,
    code: policy.compatibility.unsupported_protocol_problem_code,
    current_protocol: current,
    min_supported_protocol: minimum,
  });
  assert.deepEqual(model.protocolDecision(current + 1), {
    ok: false,
    code: policy.compatibility.unsupported_protocol_problem_code,
    current_protocol: current,
    min_supported_protocol: minimum,
  });
});

test("the generic compatibility rule automatically requires both N and N-1 at v2+", async () => {
  const v1 = await readJson(POLICY_FILE);
  const futurePolicy = structuredClone(v1);
  futurePolicy.protocol.current = 2;
  futurePolicy.protocol.minimum_supported = 1;
  const model = new ProtocolAcceptanceModel(futurePolicy);

  assert.deepEqual(model.protocolDecision(2), { ok: true });
  assert.deepEqual(model.protocolDecision(1), { ok: true });
  assert.equal(model.protocolDecision(0).ok, false);
  assert.equal(model.protocolDecision(3).ok, false);
  assert.equal(model.protocolAdvertisementValid(2, 1), true);
  assert.equal(model.protocolAdvertisementValid(2, 3), false);
  assert.equal(model.protocolAdvertisementValid(3, 1), false);
});

test("v1 response schemas can advertise a future N/N-1 server window", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const ackValidator = ajv.compile(await readJson(ACK_SCHEMA_FILE));
  const problemValidator = ajv.compile(await readJson(PROBLEM_SCHEMA_FILE));
  const futureAck = {
    ...(await readJson(ACK_FIXTURE_FILE)),
    current_protocol: 2,
    min_supported_protocol: 1,
  };
  const futureProblem = {
    ...(await readJson(PROBLEM_FIXTURE_FILE)),
    current_protocol: 2,
    min_supported_protocol: 1,
  };

  assert.equal(ackValidator(futureAck), true, JSON.stringify(ackValidator.errors));
  assert.equal(
    problemValidator(futureProblem),
    true,
    JSON.stringify(problemValidator.errors),
  );
});
