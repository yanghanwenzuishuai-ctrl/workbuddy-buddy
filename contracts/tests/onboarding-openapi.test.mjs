import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { CONTRACTS_DIR, readJson, resolveJsonPointer } from "./contract-helpers.mjs";

const OPENAPI_FILE = path.join(CONTRACTS_DIR, "openapi.json");
const PET_CATALOG_FILE = path.join(
  path.dirname(CONTRACTS_DIR),
  "apps/control-plane/src/modules/onboarding/domain/pet-catalog.ts",
);
const CAPABILITY = "A".repeat(43);
const PUBLIC_KEY = Buffer.alloc(32, 7).toString("base64");
const UUIDS = {
  server: "123e4567-e89b-12d3-a456-426614174000",
  instance: "11111111-1111-4111-8111-111111111111",
  key: "22222222-2222-4222-8222-222222222222",
  agent: "33333333-3333-4333-8333-333333333333",
};

test("OpenAPI exposes the three M2A operations with exact status sets", async () => {
  const api = await readJson(OPENAPI_FILE);
  const expected = {
    "/api/v1/onboarding/offices": {
      method: "post",
      operationId: "createOnboardingOfficeV1",
      statuses: ["201", "400", "429", "500"],
    },
    "/api/v1/onboarding/pairings/{status_token}": {
      method: "get",
      operationId: "getOnboardingPairingStatusV1",
      statuses: ["200", "400", "404", "429", "500"],
    },
    "/api/v1/edge/enrollment/claim": {
      method: "post",
      operationId: "claimEdgeEnrollmentPairingV1",
      statuses: ["200", "400", "404", "409", "410", "429", "500"],
    },
  };

  for (const [route, contract] of Object.entries(expected)) {
    const operation = api.paths[route]?.[contract.method];
    assert.ok(operation, `${contract.method.toUpperCase()} ${route} is missing`);
    assert.equal(operation.operationId, contract.operationId);
    assert.deepEqual(
      Object.keys(operation.responses).sort(),
      [...contract.statuses].sort(),
    );
  }
});

test("M2A request and success response schemas match the implemented wire shape", async () => {
  const api = await readJson(OPENAPI_FILE);
  const createRequest = validator(api.components.schemas.CreateOfficeOnboardingRequest);
  const createResponse = validator(api.components.schemas.CreateOfficeOnboardingResponse);
  const statusResponse = validator(api.components.schemas.PairingStatusResponse);
  const claimRequest = validator(api.components.schemas.ClaimPairingRequest);
  const claimResponse = validator(api.components.schemas.ClaimPairingResponse);

  const createInput = {
    office_name: "摸鱼研究所",
    alias: "Sora",
    pet_id: "sora-shiba",
    presence_visible: true,
    stats_opt_in: true,
    poster_opt_in: false,
  };
  assertValid(createRequest, createInput);
  assertInvalid(createRequest, { ...createInput, unexpected: true });
  assertInvalid(createRequest, { ...createInput, office_name: "bad\nname" });
  assertInvalid(createRequest, { ...createInput, alias: "mail@example" });
  assertInvalid(createRequest, { ...createInput, pet_id: "unknown-pet" });

  const created = {
    pairing_code: CAPABILITY,
    status_token: "B".repeat(43),
    expires_at: "2026-07-25T12:05:00.000Z",
    office_url: `/o/${"C".repeat(43)}`,
  };
  assertValid(createResponse, created);
  assertInvalid(createResponse, { ...created, pairing_code: "A".repeat(42) });
  assertInvalid(createResponse, { ...created, status_token: "B".repeat(44) });
  assertInvalid(createResponse, { ...created, office_url: `/o/${CAPABILITY}/` });

  for (const status of ["pending", "claimed", "expired"]) {
    assertValid(statusResponse, { status });
  }
  assertInvalid(statusResponse, { status: "unknown" });
  assertInvalid(statusResponse, { status: "pending", expires_at: created.expires_at });

  const claimInput = {
    pairing_code: CAPABILITY,
    public_key: PUBLIC_KEY,
    client_version: "0.1.0",
  };
  assertValid(claimRequest, claimInput);
  assertInvalid(claimRequest, { ...claimInput, pairing_code: "A".repeat(44) });
  assertInvalid(claimRequest, {
    ...claimInput,
    public_key: `${"A".repeat(42)}B=`,
  });
  assertInvalid(claimRequest, { ...claimInput, public_key: "A".repeat(44) });
  assertInvalid(claimRequest, { ...claimInput, client_version: "01.2.3" });
  assertInvalid(claimRequest, { ...claimInput, extra: true });

  const claimed = {
    server_id: UUIDS.server,
    instance_id: UUIDS.instance,
    key_id: UUIDS.key,
    logical_agent_id: UUIDS.agent,
    heartbeat_interval_seconds: 30,
    credential_valid_until: "2027-01-21T12:00:00.000Z",
  };
  assertValid(claimResponse, claimed);
  assertInvalid(claimResponse, { ...claimed, instance_id: "not-a-uuid" });
  assertInvalid(claimResponse, { ...claimed, heartbeat_interval_seconds: 31 });
  assertInvalid(claimResponse, { ...claimed, private_key: "forbidden" });
});

test("status capability and onboarding pet catalog stay exact", async () => {
  const api = await readJson(OPENAPI_FILE);
  const parameter = dereferenceInternal(
    api,
    api.paths["/api/v1/onboarding/pairings/{status_token}"].get.parameters[0]
      .$ref,
  );
  const validateStatusToken = validator(parameter.schema);
  assertValid(validateStatusToken, CAPABILITY);
  assertInvalid(validateStatusToken, "A".repeat(42));
  assertInvalid(validateStatusToken, "A".repeat(44));
  assertInvalid(validateStatusToken, `${"A".repeat(42)}+`);

  const petCatalogSource = await readFile(PET_CATALOG_FILE, "utf8");
  const implementationPetIds = [
    ...petCatalogSource.matchAll(/^\s+"([a-z0-9-]+)",$/gm),
  ].map((match) => match[1]);
  assert.deepEqual(
    api.components.schemas.CreateOfficeOnboardingRequest.properties.pet_id.enum,
    implementationPetIds,
  );
});

test("every M2A problem response has a strict status and problem-code pairing", async () => {
  const api = await readJson(OPENAPI_FILE);
  const cases = [
    {
      response: "OnboardingBadRequest",
      status: 400,
      code: "invalid_request",
      title: "Invalid request",
      detail: "The onboarding request is invalid.",
    },
    {
      response: "OnboardingPairingNotFound",
      status: 404,
      code: "pairing_not_found",
      title: "Pairing not found",
      detail: "The pairing is unavailable.",
    },
    {
      response: "OnboardingPairingConflict",
      status: 409,
      code: "pairing_conflict",
      title: "Pairing conflict",
      detail: "The pairing was claimed by another device key.",
    },
    {
      response: "OnboardingPairingExpired",
      status: 410,
      code: "pairing_expired",
      title: "Pairing expired",
      detail: "The pairing has expired.",
    },
    {
      response: "OnboardingRateLimited",
      status: 429,
      code: "rate_limited",
      title: "Rate limit exceeded",
      detail: "Too many onboarding requests.",
      retry_after_seconds: 300,
    },
    {
      response: "OnboardingInternalError",
      status: 500,
      code: "internal_error",
      title: "Internal server error",
      detail: "The request could not be completed.",
    },
  ];

  for (const item of cases) {
    const response = api.components.responses[item.response];
    assert.deepEqual(response["x-problem-codes"], [item.code]);
    const schema = expandInternalRefs(
      api,
      response.content["application/problem+json"].schema,
    );
    const validate = validator(schema);
    const body = {
      type: `https://workbuddy-buddy.invalid/problems/${item.code}`,
      title: item.title,
      status: item.status,
      code: item.code,
      detail: item.detail,
      ...(item.retry_after_seconds === undefined
        ? {}
        : { retry_after_seconds: item.retry_after_seconds }),
    };
    assertValid(validate, body);
    assertInvalid(validate, { ...body, status: 418 });
    assertInvalid(validate, {
      ...body,
      code:
        item.code === "invalid_request"
          ? "pairing_not_found"
          : "invalid_request",
    });
    assertInvalid(validate, { ...body, credential: "forbidden" });
  }
});

test("M2A operation schemas and capability headers are connected by refs", async () => {
  const api = await readJson(OPENAPI_FILE);
  const create = api.paths["/api/v1/onboarding/offices"].post;
  const status =
    api.paths["/api/v1/onboarding/pairings/{status_token}"].get;
  const claim = api.paths["/api/v1/edge/enrollment/claim"].post;

  assert.equal(
    create.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/CreateOfficeOnboardingRequest",
  );
  assert.equal(
    claim.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ClaimPairingRequest",
  );
  assert.equal(
    dereferenceInternal(api, create.responses["201"].$ref).content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/CreateOfficeOnboardingResponse",
  );
  assert.equal(
    dereferenceInternal(api, status.responses["200"].$ref).content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/PairingStatusResponse",
  );
  assert.equal(
    dereferenceInternal(api, claim.responses["200"].$ref).content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/ClaimPairingResponse",
  );

  for (const responseName of [
    "OnboardingOfficeCreated",
    "OnboardingPairingStatus",
    "EdgeEnrollmentClaimed",
  ]) {
    assert.deepEqual(Object.keys(api.components.responses[responseName].headers), [
      "Cache-Control",
      "Referrer-Policy",
      "X-Content-Type-Options",
    ]);
  }
  assert.ok(api.components.responses.OnboardingRateLimited.headers["Retry-After"]);
});

function validator(schema) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true,
  });
  addFormats(ajv);
  return ajv.compile(schema);
}

function assertValid(validate, value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
}

function assertInvalid(validate, value) {
  assert.equal(validate(value), false, JSON.stringify(value));
}

function dereferenceInternal(document, ref) {
  assert.match(ref, /^#\//);
  return resolveJsonPointer(document, ref, ref);
}

function expandInternalRefs(document, value) {
  if (Array.isArray(value)) {
    return value.map((item) => expandInternalRefs(document, item));
  }
  if (value === null || typeof value !== "object") return value;
  if (typeof value.$ref === "string") {
    assert.match(value.$ref, /^#\//);
    return expandInternalRefs(
      document,
      resolveJsonPointer(document, value.$ref, value.$ref),
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      expandInternalRefs(document, child),
    ]),
  );
}
