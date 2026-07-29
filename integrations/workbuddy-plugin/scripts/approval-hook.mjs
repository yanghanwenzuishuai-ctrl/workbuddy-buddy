#!/usr/bin/env node

import http from "node:http";
import { pathToFileURL } from "node:url";
import {
  parseHookInput,
  readStdinLimited
} from "./status-runtime.mjs";

const DEFAULT_PORT = 8792;
const DEFAULT_TIMEOUT_MS = 55_000;
const MAX_RESPONSE_BYTES = 64;
const MAX_DETAIL_LENGTH = 160;
const MAX_TOOL_NAME_LENGTH = 128;

function boundedString(value, maxLength, fallback = "") {
  return typeof value === "string" ? value.slice(0, maxLength) : fallback;
}

export function approvalProjection(payload) {
  const input = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
  const toolName = boundedString(
    input.tool_name ?? input.hook_event_name,
    MAX_TOOL_NAME_LENGTH,
    "?"
  );
  const toolInput = input.tool_input && typeof input.tool_input === "object"
    && !Array.isArray(input.tool_input)
    ? input.tool_input
    : {};
  const rawDetail = toolInput.command ?? toolInput.file_path ?? toolInput.path ?? "";

  return {
    tool_name: toolName || "?",
    detail: boundedString(
      typeof rawDetail === "string" ? rawDetail : String(rawDetail),
      MAX_DETAIL_LENGTH
    )
  };
}

function configuredPort(env) {
  const value = String(env.WB_BUDDY_APPROVAL_PORT ?? DEFAULT_PORT);
  if (!/^\d{1,5}$/.test(value)) {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : DEFAULT_PORT;
}

function configuredTimeout(env) {
  const timeout = Number(env.WB_BUDDY_APPROVAL_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(timeout) && timeout >= 50 && timeout <= 60_000
    ? Math.trunc(timeout)
    : DEFAULT_TIMEOUT_MS;
}

export function requestDecision(payload, {
  env = process.env,
  request = http.request
} = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify(approvalProjection(payload));
    let settled = false;
    const finish = (decision = null) => {
      if (!settled) {
        settled = true;
        resolve(decision);
      }
    };

    let req;
    try {
      req = request({
        protocol: "http:",
        hostname: "127.0.0.1",
        port: configuredPort(env),
        path: "/approve",
        method: "POST",
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish();
          return;
        }

        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const decision = Buffer.concat(chunks).toString("utf8").trim();
          finish(decision === "allow" || decision === "deny" ? decision : null);
        });
        response.on("error", () => finish());
      });
      req.setTimeout(configuredTimeout(env), () => {
        req.destroy();
        finish();
      });
      req.on("error", () => finish());
      req.end(body);
    } catch {
      req?.destroy();
      finish();
    }
  });
}

export function decisionOutput(decision, payload) {
  if (decision !== "allow" && decision !== "deny") {
    return null;
  }
  const input = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
  const hookEventName = boundedString(input.hook_event_name, 64, "PreToolUse");
  const marker = "decided via workbuddy-buddy pet";

  if (decision === "deny") {
    return {
      decision: "block",
      reason: `denied (${marker})`,
      hookSpecificOutput: {
        hookEventName,
        permissionDecision: "deny",
        permissionDecisionReason: `denied (${marker})`,
        decision: {
          behavior: "deny",
          message: `denied (${marker})`
        }
      }
    };
  }

  return {
    decision: "approve",
    reason: `allowed (${marker})`,
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: "allow",
      permissionDecisionReason: `allowed (${marker})`,
      decision: {
        behavior: "allow"
      }
    }
  };
}

async function main() {
  try {
    const payload = parseHookInput(readStdinLimited());
    const decision = await requestDecision(payload);
    const output = decisionOutput(decision, payload);
    if (output) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch {
    // Fail-open: no stdout and exit 0 restores WorkBuddy's native flow.
  }
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  await main();
}
