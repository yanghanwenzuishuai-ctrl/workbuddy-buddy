import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const policy = JSON.parse(
  await readFile(
    path.join(ROOT, "contracts/protocol-policy.v1.json"),
    "utf8",
  ),
);
const edgeSource = await readFile(
  path.join(ROOT, "crates/edge/src/lib.rs"),
  "utf8",
);

test("official Edge boot rollover matches receipt-retention policy", () => {
  const match = edgeSource.match(
    /const MAX_EVENTS_PER_BOOT: u64 = ([0-9_]+);/,
  );
  assert.ok(match, "Rust Edge must declare MAX_EVENTS_PER_BOOT");
  const rustLimit = Number(match[1].replaceAll("_", ""));
  assert.equal(
    rustLimit,
    policy.batch.official_edge_max_events_per_boot,
  );
  assert.equal(
    policy.batch.fenced_boot_receipt_retention,
    "delete_receipts_and_event_fingerprints",
  );
  assert.equal(
    policy.boot_fencing.live_same_activity_successor_preserves_interval,
    true,
  );
});
