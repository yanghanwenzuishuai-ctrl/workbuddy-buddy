import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  approvalProjection,
  decisionOutput,
  requestDecision
} from "../scripts/approval-hook.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.dirname(HERE);
const APPROVAL_HOOK = path.join(PLUGIN_ROOT, "scripts", "approval-hook.mjs");

function fakeRequest(responseText, capture, statusCode = 200) {
  return (options, callback) => {
    capture.options = options;
    const request = new EventEmitter();
    request.setTimeout = (milliseconds, onTimeout) => {
      capture.timeout = milliseconds;
      capture.onTimeout = onTimeout;
      return request;
    };
    request.destroy = () => {};
    request.end = (body) => {
      capture.body = body;
      const response = Readable.from([Buffer.from(responseText)]);
      response.statusCode = statusCode;
      callback(response);
    };
    return request;
  };
}

test("approval projection sends only tool name and a bounded loopback detail", () => {
  const projection = approvalProjection({
    tool_name: "Bash",
    tool_input: {
      command: "x".repeat(200),
      secret: "MUST_NOT_LEAVE_PROCESS"
    },
    prompt: "MUST_NOT_LEAVE_PROCESS",
    transcript_path: "/private/transcript"
  });

  assert.deepEqual(Object.keys(projection), ["tool_name", "detail"]);
  assert.equal(projection.tool_name, "Bash");
  assert.equal(projection.detail.length, 160);
  assert.equal(JSON.stringify(projection).includes("MUST_NOT_LEAVE_PROCESS"), false);
});

test("allow and deny preserve the verified WorkBuddy decision shape", () => {
  const allow = decisionOutput("allow", { hook_event_name: "PermissionRequest" });
  assert.equal(allow.decision, "approve");
  assert.equal(allow.hookSpecificOutput.hookEventName, "PermissionRequest");
  assert.equal(allow.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(allow.hookSpecificOutput.decision.behavior, "allow");

  const deny = decisionOutput("deny", { hook_event_name: "PreToolUse" });
  assert.equal(deny.decision, "block");
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(deny.hookSpecificOutput.decision.behavior, "deny");
});

test("approval request is fixed to loopback and accepts exact allow", async () => {
  const capture = {};
  const payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "printf safe", secret: "DO_NOT_SEND" },
    prompt: "DO_NOT_SEND"
  };
  const decision = await requestDecision(payload, {
    env: {
      WB_BUDDY_APPROVAL_PORT: "9123",
      WB_BUDDY_APPROVAL_TIMEOUT_MS: "1000"
    },
    request: fakeRequest("allow", capture)
  });

  assert.equal(capture.options.protocol, "http:");
  assert.equal(capture.options.hostname, "127.0.0.1");
  assert.equal(capture.options.port, 9123);
  assert.equal(capture.options.path, "/approve");
  assert.equal(capture.options.method, "POST");
  assert.equal(capture.options.agent, false);
  assert.equal(capture.timeout, 1000);
  assert.deepEqual(JSON.parse(capture.body), { tool_name: "Bash", detail: "printf safe" });
  assert.equal(decision, "allow");
  assert.equal(decisionOutput(decision, payload).decision, "approve");
});

test("unreachable server is silent fail-open", () => {
  const result = spawnSync(process.execPath, [APPROVAL_HOOK], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "false" }
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      WB_BUDDY_APPROVAL_PORT: "1",
      WB_BUDDY_APPROVAL_TIMEOUT_MS: "50"
    },
    timeout: 2000
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("invalid and oversized responses resolve to fail-open", async () => {
  const capture = {};
  const decision = await requestDecision(
    { tool_name: "Bash", tool_input: {} },
    { request: fakeRequest("x".repeat(100), capture) }
  );
  assert.equal(decision, null);
  assert.equal(decisionOutput(decision, {}), null);
});
