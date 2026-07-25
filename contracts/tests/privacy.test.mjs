import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  CONTRACTS_DIR,
  collectDeclaredPropertyNames,
  collectPayloadKeys,
  readJson,
  resolveManifestPath,
} from "./contract-helpers.mjs";

const POLICY_FILE = path.join(CONTRACTS_DIR, "protocol-policy.v1.json");
const ENVELOPE_FILE = path.join(
  CONTRACTS_DIR,
  "schemas",
  "edge-report-envelope.v1.schema.json",
);
const MANIFEST_FILE = path.join(
  CONTRACTS_DIR,
  "fixtures",
  "manifest.v1.json",
);
const FIXTURES_DIR = path.dirname(MANIFEST_FILE);

test("Edge request schema never declares privacy or server-authority fields", async () => {
  const policy = await readJson(POLICY_FILE);
  const schema = await readJson(ENVELOPE_FILE);
  const declared = collectDeclaredPropertyNames(schema);
  const forbidden = new Set([
    ...policy.privacy.forbidden_edge_keys,
    "received_at",
    "server_received_at",
    "idle_stage",
  ]);

  assert.deepEqual(
    [...declared].filter((name) => forbidden.has(name)),
    [],
    "forbidden fields must not become part of the Edge wire contract",
  );
  assertEveryObjectSchemaIsClosed(schema);
});

test("every schema-valid Edge fixture is recursively privacy-safe", async () => {
  const policy = await readJson(POLICY_FILE);
  const forbidden = new Set([
    ...policy.privacy.forbidden_edge_keys,
    "received_at",
    "server_received_at",
    "idle_stage",
  ]);
  const manifest = await readJson(MANIFEST_FILE);
  let checked = 0;

  for (const entry of manifest.schema_cases) {
    if (
      path.basename(entry.schema) !== "edge-report-envelope.v1.schema.json" ||
      entry.expect_schema_valid !== true
    ) {
      continue;
    }
    const fixture = await readJson(
      resolveManifestPath(entry.fixture, FIXTURES_DIR),
    );
    const leaked = [...collectPayloadKeys(fixture)].filter((name) =>
      forbidden.has(name),
    );
    assert.deepEqual(leaked, [], `${entry.fixture} leaks forbidden keys`);
    checked += 1;
  }
  assert.ok(checked > 0, "manifest must contain at least one valid Edge fixture");
});

test("invalid fixtures prove every forbidden Edge key is rejected recursively", async () => {
  const policy = await readJson(POLICY_FILE);
  const forbidden = new Set(policy.privacy.forbidden_edge_keys);
  const manifest = await readJson(MANIFEST_FILE);
  const covered = new Set();

  for (const entry of manifest.schema_cases) {
    if (path.basename(entry.schema) !== "edge-report-envelope.v1.schema.json") {
      continue;
    }
    const fixture = await readJson(
      resolveManifestPath(entry.fixture, FIXTURES_DIR),
    );
    const present = [...collectPayloadKeys(fixture)].filter((name) =>
      forbidden.has(name),
    );
    if (present.length === 0) continue;
    assert.equal(
      entry.expect_schema_valid,
      false,
      `${entry.fixture} contains a forbidden key but is marked valid`,
    );
    present.forEach((name) => covered.add(name));
  }

  assert.deepEqual(
    [...covered].sort(),
    [...forbidden].sort(),
    "fixtures must mutation-test every forbidden key from protocol policy",
  );
});

function assertEveryObjectSchemaIsClosed(schema, pointer = "#") {
  if (Array.isArray(schema)) {
    schema.forEach((child, index) =>
      assertEveryObjectSchemaIsClosed(child, `${pointer}/${index}`),
    );
    return;
  }
  if (schema === null || typeof schema !== "object") return;
  if (schema.type === "object") {
    assert.equal(
      schema.additionalProperties,
      false,
      `${pointer}: every Edge object schema must set additionalProperties=false`,
    );
  }
  for (const [key, child] of Object.entries(schema)) {
    assertEveryObjectSchemaIsClosed(child, `${pointer}/${key}`);
  }
}
