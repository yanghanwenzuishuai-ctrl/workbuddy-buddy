import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  CONTRACTS_DIR,
  jsonFilesBelow,
  readJson,
  resolveManifestPath,
} from "./contract-helpers.mjs";

const SCHEMAS_DIR = path.join(CONTRACTS_DIR, "schemas");
const FIXTURES_DIR = path.join(CONTRACTS_DIR, "fixtures");
const MANIFEST_FILE = path.join(FIXTURES_DIR, "manifest.v1.json");

async function loadFixtureContext() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true,
  });
  addFormats(ajv);

  const schemas = new Map();
  for (const file of await jsonFilesBelow(SCHEMAS_DIR)) {
    const schema = await readJson(file);
    assert.equal(typeof schema.$id, "string", `${file} must declare a stable $id`);
    assert.ok(!schemas.has(schema.$id), `duplicate schema $id: ${schema.$id}`);
    schemas.set(schema.$id, { file, schema });
    ajv.addSchema(schema);
  }

  const manifest = await readJson(MANIFEST_FILE);
  assert.equal(manifest.manifest_version, 1);
  assert.ok(Array.isArray(manifest.schema_cases));
  assert.ok(Array.isArray(manifest.protocol_scenarios));
  return { ajv, schemas, manifest };
}

test("all strict JSON Schemas compile under draft 2020-12", async () => {
  const { ajv, schemas } = await loadFixtureContext();
  for (const id of schemas.keys()) {
    assert.equal(typeof ajv.getSchema(id), "function", `schema did not compile: ${id}`);
  }
});

test("manifest covers every fixture exactly once", async () => {
  const { manifest } = await loadFixtureContext();
  const listed = [...manifest.schema_cases, ...manifest.protocol_scenarios]
    .map((entry) =>
      path
        .relative(CONTRACTS_DIR, resolveManifestPath(entry.fixture, FIXTURES_DIR))
        .replaceAll(path.sep, "/"),
    )
    .sort();
  assert.equal(new Set(listed).size, listed.length, "duplicate fixture in manifest");

  const actual = (await jsonFilesBelow(FIXTURES_DIR))
    .filter((file) => file !== MANIFEST_FILE)
    .map((file) => path.relative(CONTRACTS_DIR, file).replaceAll(path.sep, "/"))
    .sort();
  assert.deepEqual(listed, actual);
});

test("valid and invalid fixtures match their declared schema outcome", async (t) => {
  const { ajv, schemas, manifest } = await loadFixtureContext();
  const outcomes = new Set();
  const schemaOutcomes = new Map();

  for (const entry of manifest.schema_cases) {
    await t.test(entry.fixture, async () => {
      assert.equal(typeof entry.expect_schema_valid, "boolean");
      const schemaPath = resolveManifestPath(entry.schema, FIXTURES_DIR);
      const schemaRecord = [...schemas.values()].find(
        ({ file }) => path.resolve(file) === path.resolve(schemaPath),
      );
      assert.ok(schemaRecord, `manifest names an unknown schema: ${entry.schema}`);

      const fragment = entry.schema_fragment ?? "";
      const validator = ajv.getSchema(`${schemaRecord.schema.$id}${fragment}`);
      assert.equal(
        typeof validator,
        "function",
        `cannot compile ${entry.schema}${fragment}`,
      );

      const fixture = await readJson(
        resolveManifestPath(entry.fixture, FIXTURES_DIR),
      );
      const actual = validator(fixture);
      assert.equal(
        actual,
        entry.expect_schema_valid,
        JSON.stringify(validator.errors, null, 2),
      );

      outcomes.add(actual);
      const key = path.basename(schemaPath);
      if (!schemaOutcomes.has(key)) schemaOutcomes.set(key, new Set());
      schemaOutcomes.get(key).add(actual);
    });
  }

  assert.deepEqual(outcomes, new Set([true, false]));
  for (const schema of [
    "edge-report-envelope.v1.schema.json",
    "edge-report-ack.v1.schema.json",
    "problem.v1.schema.json",
    "public-office-snapshot.v1.schema.json",
  ]) {
    assert.ok(schemaOutcomes.get(schema)?.has(true), `${schema} needs a valid fixture`);
  }
  for (const schema of [
    "edge-report-envelope.v1.schema.json",
    "public-office-snapshot.v1.schema.json",
  ]) {
    assert.ok(schemaOutcomes.get(schema)?.has(false), `${schema} needs an invalid fixture`);
  }
});

test("each envelope inside a stateful protocol fixture is schema-valid", async (t) => {
  const { ajv, schemas, manifest } = await loadFixtureContext();
  for (const entry of manifest.protocol_scenarios) {
    await t.test(entry.fixture, async () => {
      const schemaPath = resolveManifestPath(entry.schema, FIXTURES_DIR);
      const schemaRecord = [...schemas.values()].find(
        ({ file }) => path.resolve(file) === path.resolve(schemaPath),
      );
      assert.ok(schemaRecord);
      const validator = ajv.getSchema(schemaRecord.schema.$id);
      const fixture = await readJson(
        resolveManifestPath(entry.fixture, FIXTURES_DIR),
      );
      for (const pointer of entry.envelope_json_pointers) {
        const value = pointer
          .slice(1)
          .split("/")
          .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
          .reduce((current, part) => current[part], fixture);
        assert.equal(
          validator(value),
          entry.expect_each_schema_valid,
          `${pointer}: ${JSON.stringify(validator.errors, null, 2)}`,
        );
      }
    });
  }
});
