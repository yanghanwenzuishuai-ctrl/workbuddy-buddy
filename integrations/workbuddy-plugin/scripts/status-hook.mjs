#!/usr/bin/env node

import {
  appendProjectedEvent,
  parseHookInput,
  projectEvent,
  readStdinLimited,
  resolveSpoolPath
} from "./status-runtime.mjs";

function main() {
  try {
    const event = process.argv[2] ?? "?";
    const payload = parseHookInput(readStdinLimited());
    const spoolPath = resolveSpoolPath();
    if (spoolPath) {
      appendProjectedEvent(spoolPath, projectEvent(event, payload));
    }
  } catch {
    // Fail-open: a desktop status indicator must never interrupt WorkBuddy.
  }
}

main();
