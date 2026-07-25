import { readFile } from "node:fs/promises";
import path from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import type { FormatsPlugin } from "ajv-formats";

import {
  canonicalBytes,
  sha256,
} from "../../modules/presence/domain/canonical-json.js";
import { ProtocolProblem } from "../../modules/presence/domain/problem.js";
import {
  MAX_SAFE_SEQUENCE,
  type EdgeEndpoint,
  type EdgeReportEnvelope,
  type PreparedEdgeReport,
} from "../../modules/presence/domain/types.js";

export interface EdgeReportValidator {
  prepare(input: unknown, endpoint: EdgeEndpoint): PreparedEdgeReport;
}

export async function createEdgeReportValidator(
  contractsDirectory: string,
): Promise<EdgeReportValidator> {
  const schemaPath = path.join(
    contractsDirectory,
    "schemas/edge-report-envelope.v1.schema.json",
  );
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Record<
    string,
    unknown
  >;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true,
  });
  const addFormats = (
    "default" in formatsModule ? formatsModule.default : formatsModule
  ) as unknown as FormatsPlugin;
  addFormats(ajv);
  ajv.addSchema(schema);

  const schemaId = schema.$id;
  if (typeof schemaId !== "string") {
    throw new Error("Edge report contract must declare an $id");
  }
  const batchValidator = ajv.getSchema(schemaId);
  const heartbeatValidator = ajv.compile({
    $ref: `${schemaId}#/$defs/heartbeatEnvelope`,
  });
  if (batchValidator === undefined) {
    throw new Error("Failed to compile Edge report contract");
  }

  return {
    prepare(input: unknown, endpoint: EdgeEndpoint): PreparedEdgeReport {
      assertProtocolVersion(input);
      const validate =
        endpoint === "heartbeat" ? heartbeatValidator : batchValidator;
      assertSchemaValid(validate, input);

      const envelope = input as EdgeReportEnvelope;
      assertIntrinsicSemantics(envelope, endpoint);
      const canonicalPayload = canonicalBytes(envelope);
      return {
        envelope,
        endpoint,
        canonicalPayload,
        canonicalPayloadHash: sha256(canonicalPayload),
        canonicalEvents: envelope.events.map((event) => {
          const bytes = canonicalBytes(event);
          return { event, bytes, hash: sha256(bytes) };
        }),
      };
    },
  };
}

function assertProtocolVersion(input: unknown): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return;
  }
  const protocolVersion = (input as Record<string, unknown>).protocol_version;
  if (
    protocolVersion !== undefined &&
    protocolVersion !== 1
  ) {
    throw new ProtocolProblem(
      "protocol_version_unsupported",
      426,
      "This server accepts protocol version 1.",
    );
  }
}

function assertSchemaValid(
  validate: ValidateFunction,
  input: unknown,
): asserts input is EdgeReportEnvelope {
  if (!validate(input)) {
    throw new ProtocolProblem(
      "invalid_request",
      400,
      `The report does not match the protocol schema (${validate.errors?.length ?? 1} validation error).`,
    );
  }
}

function assertIntrinsicSemantics(
  envelope: EdgeReportEnvelope,
  endpoint: EdgeEndpoint,
): void {
  const firstEvent = envelope.events[0];
  if (firstEvent === undefined || firstEvent.sequence !== envelope.first_sequence) {
    throw new ProtocolProblem(
      "report_semantics_invalid",
      422,
      "first_sequence must equal the first event sequence.",
    );
  }

  for (let index = 0; index < envelope.events.length; index += 1) {
    const event = envelope.events[index];
    if (event === undefined) {
      throw new ProtocolProblem(
        "report_semantics_invalid",
        422,
        "The report contains a missing event.",
      );
    }
    const expected = BigInt(envelope.first_sequence) + BigInt(index);
    if (expected > BigInt(MAX_SAFE_SEQUENCE)) {
      throw new ProtocolProblem(
        "report_semantics_invalid",
        422,
        "The report exceeds the protocol sequence range.",
      );
    }
    const expectedNumber = Number(expected);
    if (event.sequence > expectedNumber) {
      throw new ProtocolProblem(
        "sequence_gap",
        409,
        "Event sequences must be contiguous within a batch.",
        expectedNumber,
      );
    }
    if (event.sequence < expectedNumber) {
      throw new ProtocolProblem(
        "sequence_overlap",
        409,
        "Event sequences must not repeat or move backwards within a batch.",
        expectedNumber,
      );
    }
  }

  if (
    endpoint === "heartbeat" &&
    (envelope.events.length !== 1 ||
      envelope.events[0]?.kind !== "heartbeat")
  ) {
    throw new ProtocolProblem(
      "report_semantics_invalid",
      422,
      "The heartbeat endpoint accepts exactly one heartbeat event.",
    );
  }
}
