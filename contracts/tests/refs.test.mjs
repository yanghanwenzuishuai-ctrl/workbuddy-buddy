import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  CONTRACTS_DIR,
  assertAllLocalRefsResolve,
  readJson,
} from "./contract-helpers.mjs";

const OPENAPI_FILE = path.join(CONTRACTS_DIR, "openapi.json");

test("OpenAPI and every reachable JSON Schema reference resolve locally", async () => {
  const documents = await assertAllLocalRefsResolve(OPENAPI_FILE);
  const relative = documents.map((file) =>
    path.relative(CONTRACTS_DIR, file).replaceAll(path.sep, "/"),
  );
  assert.deepEqual(relative, [
    "openapi.json",
    "schemas/edge-report-ack.v1.schema.json",
    "schemas/edge-report-envelope.v1.schema.json",
    "schemas/problem.v1.schema.json",
    "schemas/public-office-snapshot.v1.schema.json",
  ]);
});

test("OpenAPI 3.1 binds each endpoint to the intended versioned contract", async () => {
  const api = await readJson(OPENAPI_FILE);
  assert.equal(api.openapi, "3.1.0");
  assert.equal(
    api.jsonSchemaDialect,
    "https://json-schema.org/draft/2020-12/schema",
  );

  const batch =
    api.paths["/api/v1/edge/events:batch"].post.requestBody.content[
      "application/json"
    ].schema.$ref;
  assert.equal(batch, "./schemas/edge-report-envelope.v1.schema.json");

  const heartbeat =
    api.paths["/api/v1/edge/heartbeat"].post.requestBody.content[
      "application/json"
    ].schema.$ref;
  assert.equal(
    heartbeat,
    "./schemas/edge-report-envelope.v1.schema.json#/$defs/heartbeatEnvelope",
    "the heartbeat endpoint must enforce exactly one heartbeat event",
  );

  const snapshot =
    api.paths["/api/v1/offices/{public_view_token}/snapshot"].get.responses[
      "200"
    ].content["application/json"].schema.$ref;
  assert.equal(snapshot, "./schemas/public-office-snapshot.v1.schema.json");
});

test("operation ids are present and unique", async () => {
  const api = await readJson(OPENAPI_FILE);
  const operationIds = [];
  for (const pathItem of Object.values(api.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = pathItem[method];
      if (!operation) continue;
      assert.equal(
        typeof operation.operationId,
        "string",
        `${method.toUpperCase()} operation is missing operationId`,
      );
      operationIds.push(operation.operationId);
    }
  }
  assert.equal(new Set(operationIds).size, operationIds.length);
});

test("Edge responses advertise protocol compatibility and use strict schemas", async () => {
  const api = await readJson(OPENAPI_FILE);
  for (const endpoint of [
    "/api/v1/edge/events:batch",
    "/api/v1/edge/heartbeat",
  ]) {
    const responses = api.paths[endpoint].post.responses;
    const accepted = dereferenceInternal(api, responses["200"].$ref);
    assert.equal(
      accepted.content["application/json"].schema.$ref,
      "./schemas/edge-report-ack.v1.schema.json",
    );
    for (const header of [
      "X-Protocol-Version",
      "X-Min-Supported-Protocol",
      "X-Supported-Protocols",
    ]) {
      assert.ok(accepted.headers[header], `${endpoint} 200 is missing ${header}`);
    }

    for (const status of ["400", "401", "409", "413", "422", "426", "503"]) {
      const response = dereferenceInternal(api, responses[status].$ref);
      assert.equal(
        response.content["application/problem+json"].schema.$ref,
        "./schemas/problem.v1.schema.json",
        `${endpoint} ${status} must use Problem v1`,
      );
    }

    const rateLimited = dereferenceInternal(api, responses["429"].$ref);
    assert.deepEqual(rateLimited["x-problem-codes"], ["rate_limited"]);
    assert.equal(
      rateLimited.content["application/problem+json"].schema.allOf[0].$ref,
      "./schemas/problem.v1.schema.json",
    );
    assert.equal(rateLimited.headers["Retry-After"].required, true);
    assert.deepEqual(rateLimited.headers["Retry-After"].schema, {
      type: "integer",
      minimum: 1,
      maximum: 86400,
    });
  }
});

test("Edge 429 is a strict rate_limited Problem response", async () => {
  const api = await readJson(OPENAPI_FILE);
  const baseProblem = await readJson(
    path.join(CONTRACTS_DIR, "schemas/problem.v1.schema.json"),
  );
  const response = dereferenceInternal(
    api,
    api.paths["/api/v1/edge/events:batch"].post.responses["429"].$ref,
  );
  const inlineConstraint =
    response.content["application/problem+json"].schema.allOf[1];
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true,
  });
  addFormats(ajv);
  const validate = ajv.compile({
    allOf: [baseProblem, inlineConstraint],
  });
  const body = {
    type: "https://workbuddy-buddy.invalid/problems/rate_limited",
    title: "Rate limit exceeded",
    status: 429,
    code: "rate_limited",
    detail: "Too many Edge reports.",
    retry_after_seconds: 30,
  };
  assert.equal(validate(body), true, JSON.stringify(validate.errors, null, 2));
  for (const invalid of [
    { ...body, status: 503 },
    { ...body, code: "temporarily_unavailable" },
    { ...body, title: "Temporarily unavailable" },
    { ...body, retry_after_seconds: 0 },
  ]) {
    assert.equal(validate(invalid), false, JSON.stringify(invalid));
  }
});

test("sequence conflicts map to 409 while semantic shape errors map to 422", async () => {
  const api = await readJson(OPENAPI_FILE);
  assert.deepEqual(api.components.responses.EdgeFenceConflict["x-problem-codes"], [
    "stale_boot",
    "sequence_gap",
    "sequence_overlap",
    "sequence_conflict",
  ]);
  assert.deepEqual(
    api.components.responses.UnprocessableEdgeReport["x-problem-codes"],
    ["report_semantics_invalid"],
  );
});

function dereferenceInternal(document, ref) {
  assert.match(ref, /^#\//);
  return ref
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, part) => value[part], document);
}
