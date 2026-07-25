import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { CONTRACTS_DIR, readJson } from "./contract-helpers.mjs";

const REPOSITORY_ROOT = path.dirname(CONTRACTS_DIR);
const CORE_FILE = path.join(REPOSITORY_ROOT, "crates", "core", "src", "lib.rs");
const EDGE_SCHEMA_FILE = path.join(
  CONTRACTS_DIR,
  "schemas",
  "edge-report-envelope.v1.schema.json",
);
const PUBLIC_SCHEMA_FILE = path.join(
  CONTRACTS_DIR,
  "schemas",
  "public-office-snapshot.v1.schema.json",
);
const POLICY_FILE = path.join(CONTRACTS_DIR, "protocol-policy.v1.json");

function rustEnumVariants(source, enumName) {
  const match = source.match(
    new RegExp(`pub enum ${enumName}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  assert.ok(match, `missing Rust enum ${enumName}`);
  return [...match[1].matchAll(/^\s*([A-Z][A-Za-z0-9]*),\s*$/gm)].map(
    (entry) => entry[1],
  );
}

function snakeCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

test("Edge display and activity enums stay aligned with Rust core", async () => {
  const [source, schema] = await Promise.all([
    readFile(CORE_FILE, "utf8"),
    readJson(EDGE_SCHEMA_FILE),
  ]);

  assert.deepEqual(
    schema.$defs.displayState.enum,
    rustEnumVariants(source, "DisplayState").map(snakeCase),
  );
  assert.deepEqual(
    schema.$defs.activityState.enum,
    rustEnumVariants(source, "ActivityState").map(snakeCase),
  );
});

test("public idle stages stay aligned with Rust core", async () => {
  const [source, schema] = await Promise.all([
    readFile(CORE_FILE, "utf8"),
    readJson(PUBLIC_SCHEMA_FILE),
  ]);
  assert.deepEqual(
    schema.$defs.idleStage.enum,
    rustEnumVariants(source, "IdleStage").map(snakeCase),
  );
});

test("policy stage thresholds stay aligned with Rust core constants", async () => {
  const [source, policy] = await Promise.all([
    readFile(CORE_FILE, "utf8"),
    readJson(POLICY_FILE),
  ]);
  const thresholds = Object.fromEntries(
    [...source.matchAll(
      /^const SLACKING_(FRESH|SALTED|COSTUME|FISH)_MS: u64 = (\d+) \* 60 \* 1000;$/gm,
    )].map((match) => [match[1].toLowerCase(), Number(match[2]) * 60]),
  );

  assert.deepEqual(thresholds, policy.slacking.stage_boundaries_seconds);
  assert.equal(policy.slacking.grace_seconds, thresholds.fresh);
  assert.equal(policy.slacking.grace_counts_toward_score, false);
});

test("policy admits the multi-session waiting plus active aggregate", async () => {
  const policy = await readJson(POLICY_FILE);
  assert.ok(
    policy.state_transition.allowed_display_activity_pairs.some(
      ([display, activity]) =>
        display === "waiting" && activity === "active",
    ),
  );
});
