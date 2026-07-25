import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { CONTRACTS_DIR, readJson } from "./contract-helpers.mjs";
import { planOfficeStream } from "./sse-model.mjs";

const POLICY_FILE = path.join(CONTRACTS_DIR, "protocol-policy.v1.json");
const OPENAPI_FILE = path.join(CONTRACTS_DIR, "openapi.json");

test("Last-Event-ID and after_revision must agree", async () => {
  const policy = await readJson(POLICY_FILE);
  assert.equal(policy.sse.last_event_id_and_after_revision_must_match, true);
  assert.deepEqual(
    planOfficeStream({
      lastEventId: 10,
      afterRevision: 9,
      currentRevision: 11,
      minimumReplayCursor: 10,
      retainedRevisions: [11],
    }),
    { opened: false, problem: "invalid_request", events: [] },
  );
});

test("snapshot-to-connect revisions replay contiguously and duplicates are idempotent", async () => {
  const policy = await readJson(POLICY_FILE);
  assert.equal(policy.sse.duplicate_revision, "ignore_idempotently");
  assert.deepEqual(
    planOfficeStream({
      lastEventId: 10,
      currentRevision: 12,
      minimumReplayCursor: 10,
      retainedRevisions: [11, 11, 12],
    }),
    {
      opened: true,
      closed: false,
      problem: null,
      events: [
        { event: "office.snapshot", id: 11 },
        { event: "office.snapshot", id: 12 },
      ],
    },
  );
});

test("retention gaps fail before streaming; in-stream gaps demand resync and close", async () => {
  const policy = await readJson(POLICY_FILE);
  assert.equal(policy.sse.pre_stream_retention_gap_problem_code, "revision_gap");
  assert.equal(policy.sse.in_stream_gap, "emit_resync_required_then_close");

  assert.deepEqual(
    planOfficeStream({
      afterRevision: 8,
      currentRevision: 11,
      minimumReplayCursor: 9,
      retainedRevisions: [10, 11],
    }),
    { opened: false, problem: "revision_gap", events: [] },
  );
  assert.deepEqual(
    planOfficeStream({
      afterRevision: 10,
      currentRevision: 13,
      minimumReplayCursor: 10,
      retainedRevisions: [11, 13],
    }),
    {
      opened: true,
      closed: true,
      problem: null,
      events: [
        { event: "office.snapshot", id: 11 },
        { event: "resync.required", reason: "revision_gap" },
      ],
    },
  );
});

test("future cursors and empty expired replay windows fail before streaming", async () => {
  const policy = await readJson(POLICY_FILE);
  assert.equal(policy.sse.future_cursor_problem_code, "invalid_request");
  assert.equal(policy.sse.minimum_replay_cursor_is_explicit, true);

  assert.deepEqual(
    planOfficeStream({
      afterRevision: 99,
      currentRevision: 11,
      minimumReplayCursor: 9,
      retainedRevisions: [10, 11],
    }),
    { opened: false, problem: "invalid_request", events: [] },
  );
  assert.deepEqual(
    planOfficeStream({
      afterRevision: 10,
      currentRevision: 11,
      minimumReplayCursor: 11,
      retainedRevisions: [],
    }),
    { opened: false, problem: "revision_gap", events: [] },
  );
  assert.deepEqual(
    planOfficeStream({
      afterRevision: 11,
      currentRevision: 11,
      minimumReplayCursor: 11,
      retainedRevisions: [],
    }),
    { opened: true, closed: false, problem: null, events: [] },
  );
});

test("SSE examples terminate each event with a blank line", async () => {
  const api = await readJson(OPENAPI_FILE);
  const examples =
    api.paths["/api/v1/offices/{public_view_token}/events"].get.responses[
      "200"
    ].content["text/event-stream"].examples;
  for (const example of Object.values(examples)) {
    assert.match(example.value, /\n\n$/);
  }
});
