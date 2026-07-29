import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ALLOWED_FIELDS,
  appendProjectedEvent,
  endsWithQuestion,
  parseHookInput,
  projectEvent,
  resolveSpoolPath
} from "../scripts/status-runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.dirname(HERE);
const STATUS_HOOK = path.join(PLUGIN_ROOT, "scripts", "status-hook.mjs");
const FORBIDDEN = [
  "SECRET",
  "leak me",
  "/etc/passwd",
  "tool_input",
  "last_assistant_message",
  "transcript_path"
];

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wb-plugin-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("projection preserves only the existing structural whitelist", () => {
  const safe = projectEvent("PreToolUse", {
    session_id: "s1",
    tool_name: "Read",
    permission_mode: "default",
    notification_type: "permission_prompt",
    prompt: "SECRET leak me",
    tool_input: { file: "/etc/passwd", content: "SECRET" },
    last_assistant_message: "SECRET?",
    transcript_path: "/private/transcript.jsonl"
  }, 42);

  assert.deepEqual(Object.keys(safe), ALLOWED_FIELDS);
  assert.equal(safe.ts, 42);
  assert.equal(safe.tool_name, "Read");
  assert.equal(safe.session_id, "s1");
  assert.equal(Object.hasOwn(safe, "prompt"), false);
  assert.equal(Object.hasOwn(safe, "tool_input"), false);
  assert.equal(Object.hasOwn(safe, "last_assistant_message"), false);
  assert.equal(Object.hasOwn(safe, "transcript_path"), false);
  const blob = JSON.stringify(safe);
  for (const forbidden of FORBIDDEN) {
    assert.equal(blob.includes(forbidden), false, `leaked ${forbidden}`);
  }
});

test("question flag is derived only for Stop and raw text is discarded", () => {
  assert.equal(endsWithQuestion("Ready?\n"), true);
  assert.equal(endsWithQuestion("继续吗？"), true);
  assert.equal(endsWithQuestion("Done."), false);
  assert.equal(endsWithQuestion(123), null);
  assert.equal(projectEvent("Stop", { last_assistant_message: "Ready?" }, 1).ends_with_question, true);
  assert.equal(projectEvent("PreToolUse", { last_assistant_message: "Ready?" }, 1).ends_with_question, null);
});

test("malformed and non-object input becomes an empty payload", () => {
  assert.deepEqual(parseHookInput("not json"), {});
  assert.deepEqual(parseHookInput("[]"), {});
  assert.deepEqual(parseHookInput(""), {});
});

test("spool path supports explicit absolute overrides and cross-platform home fallback", () => {
  assert.equal(
    resolveSpoolPath({
      env: { WB_BUDDY_SPOOL: "/tmp/custom.spool" },
      homedir: () => "/Users/ignored"
    }),
    path.normalize("/tmp/custom.spool")
  );
  assert.equal(
    resolveSpoolPath({
      env: { WB_BUDDY_DATA_DIR: "/tmp/custom-data" },
      homedir: () => "/Users/ignored"
    }),
    path.join("/tmp/custom-data", "events.spool")
  );
  assert.equal(
    resolveSpoolPath({ env: {}, homedir: () => "/Users/alice" }),
    path.join("/Users/alice", ".workbuddy-buddy", "events.spool")
  );
  assert.equal(
    resolveSpoolPath({ env: { WB_BUDDY_SPOOL: "relative.spool" }, homedir: () => "" }),
    null
  );
});

test("CLI writes one private JSONL record without content leakage", (t) => {
  const directory = temporaryDirectory(t);
  const spool = path.join(directory, "private", "events.spool");
  const payload = JSON.stringify({
    session_id: "s",
    prompt: "SECRET",
    tool_input: { path: "/etc/passwd" },
    last_assistant_message: "Continue?"
  });
  const result = spawnSync(process.execPath, [STATUS_HOOK, "Stop"], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, WB_BUDDY_SPOOL: spool }
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const data = fs.readFileSync(spool, "utf8");
  for (const forbidden of FORBIDDEN) {
    assert.equal(data.includes(forbidden), false, `leaked ${forbidden}`);
  }
  const line = JSON.parse(data.trim());
  assert.equal(line.event, "Stop");
  assert.equal(line.ends_with_question, true);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(spool).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(spool)).mode & 0o777, 0o700);
  }
});

test("concurrent hook processes append complete records", async (t) => {
  const directory = temporaryDirectory(t);
  const spool = path.join(directory, "events.spool");
  const count = 16;
  const children = Array.from({ length: count }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STATUS_HOOK, "PreToolUse"], {
      env: { ...process.env, WB_BUDDY_SPOOL: spool },
      stdio: ["pipe", "ignore", "ignore"]
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    child.stdin.end(JSON.stringify({ session_id: `s${index}`, tool_name: "Read" }));
  }));
  await Promise.all(children);

  const lines = fs.readFileSync(spool, "utf8").trim().split("\n");
  assert.equal(lines.length, count);
  const sessions = new Set(lines.map((line) => JSON.parse(line).session_id));
  assert.equal(sessions.size, count);
});

test("bounded spool rotates under the same lock", (t) => {
  const directory = temporaryDirectory(t);
  const spool = path.join(directory, "events.spool");
  const first = projectEvent("Stop", { session_id: "first" }, 1);
  const second = projectEvent("Stop", { session_id: "second" }, 2);

  assert.equal(appendProjectedEvent(spool, first, { maxBytes: 190 }), true);
  assert.equal(appendProjectedEvent(spool, second, { maxBytes: 190 }), true);
  assert.equal(fs.existsSync(`${spool}.1`), true);
  assert.equal(JSON.parse(fs.readFileSync(spool, "utf8")).session_id, "second");
});

test("symlink spool is rejected instead of following it", {
  skip: process.platform === "win32" ? "Windows symlink creation needs elevated permission" : false
}, (t) => {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, "target");
  const spool = path.join(directory, "events.spool");
  fs.writeFileSync(target, "do not touch");
  fs.symlinkSync(target, spool);

  assert.equal(appendProjectedEvent(spool, projectEvent("Stop", {}, 1)), false);
  assert.equal(fs.readFileSync(target, "utf8"), "do not touch");
});
