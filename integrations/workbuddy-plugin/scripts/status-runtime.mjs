import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_SPOOL_BYTES = 512 * 1024;
export const MAX_EVENT_BYTES = 16 * 1024;
export const LOCK_WAIT_MS = 150;
export const LOCK_STALE_MS = 10_000;

export const ALLOWED_FIELDS = Object.freeze([
  "event",
  "ts",
  "session_id",
  "tool_name",
  "permission_mode",
  "notification_type",
  "ends_with_question"
]);

const STRING_LIMITS = Object.freeze({
  event: 64,
  session_id: 256,
  tool_name: 128,
  permission_mode: 64,
  notification_type: 128
});

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function boundedString(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

export function endsWithQuestion(message) {
  if (typeof message !== "string") {
    return null;
  }
  const trimmed = message.trimEnd();
  return trimmed.endsWith("?") || trimmed.endsWith("？");
}

export function projectEvent(event, payload, now = Date.now()) {
  const input = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
  const eventName = boundedString(event, STRING_LIMITS.event) ?? "?";

  return {
    event: eventName,
    ts: Number.isFinite(now) ? Math.max(0, Math.trunc(now)) : Date.now(),
    session_id: boundedString(input.session_id, STRING_LIMITS.session_id),
    tool_name: boundedString(input.tool_name, STRING_LIMITS.tool_name),
    permission_mode: boundedString(input.permission_mode, STRING_LIMITS.permission_mode),
    notification_type: boundedString(input.notification_type, STRING_LIMITS.notification_type),
    ends_with_question: eventName === "Stop"
      ? endsWithQuestion(input.last_assistant_message)
      : null
  };
}

export function readStdinLimited(maxBytes = MAX_INPUT_BYTES) {
  const chunks = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(16 * 1024);

  while (total <= maxBytes) {
    const bytesRead = fs.readSync(0, buffer, 0, Math.min(buffer.length, maxBytes + 1 - total), null);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    total += bytesRead;
  }

  if (total > maxBytes) {
    return "";
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export function parseHookInput(raw) {
  try {
    if (typeof raw !== "string" || raw.trim() === "") {
      return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function absoluteOverride(value) {
  return typeof value === "string" && value !== "" && path.isAbsolute(value)
    ? path.normalize(value)
    : null;
}

export function resolveSpoolPath({
  env = process.env,
  homedir = os.homedir
} = {}) {
  const explicitSpool = absoluteOverride(env.WB_BUDDY_SPOOL);
  if (explicitSpool) {
    return explicitSpool;
  }

  const explicitDataDir = absoluteOverride(env.WB_BUDDY_DATA_DIR);
  if (explicitDataDir) {
    return path.join(explicitDataDir, "events.spool");
  }

  const userHome = absoluteOverride(homedir());
  if (!userHome) {
    return null;
  }
  return path.join(userHome, ".workbuddy-buddy", "events.spool");
}

function sleep(milliseconds) {
  Atomics.wait(sleepBuffer, 0, 0, milliseconds);
}

function writeAll(descriptor, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      null
    );
    if (written <= 0) {
      throw new Error("short spool write");
    }
    offset += written;
  }
}

function safeLstat(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = safeLstat(directory);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("spool directory must be a real directory");
  }
  if (process.platform !== "win32") {
    fs.chmodSync(directory, 0o700);
  }
}

function removeStaleLock(lockPath, now) {
  const metadata = safeLstat(lockPath);
  if (
    metadata
    && metadata.isFile()
    && !metadata.isSymbolicLink()
    && now - metadata.mtimeMs > LOCK_STALE_MS
  ) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // A competing hook may already have replaced or removed the lock.
    }
  }
}

function acquireLock(lockPath, now = Date.now()) {
  const deadline = now + LOCK_WAIT_MS;
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0);

  while (Date.now() <= deadline) {
    try {
      const descriptor = fs.openSync(lockPath, flags, 0o600);
      const token = `${process.pid}:${randomUUID()}\n`;
      writeAll(descriptor, token);
      return { descriptor, token };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      removeStaleLock(lockPath, Date.now());
      sleep(5);
    }
  }
  return null;
}

function releaseLock(lockPath, lock) {
  try {
    fs.closeSync(lock.descriptor);
  } catch {
    // Best effort: hooks must never break WorkBuddy.
  }
  try {
    const metadata = safeLstat(lockPath);
    if (
      metadata?.isFile()
      && !metadata.isSymbolicLink()
      && fs.readFileSync(lockPath, "utf8") === lock.token
    ) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Best effort: a stale lock is removed on the next invocation.
  }
}

function rejectUnsafeExistingFile(filePath) {
  const metadata = safeLstat(filePath);
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw new Error("spool path must be a regular file");
  }
  return metadata;
}

function rotateIfNeeded(spoolPath, additionalBytes, maxBytes) {
  const metadata = rejectUnsafeExistingFile(spoolPath);
  if (!metadata || metadata.size + additionalBytes <= maxBytes) {
    return;
  }

  const previousPath = `${spoolPath}.1`;
  const previous = safeLstat(previousPath);
  if (previous) {
    if (!previous.isFile() || previous.isSymbolicLink()) {
      throw new Error("rotated spool path must be a regular file");
    }
    fs.unlinkSync(previousPath);
  }
  fs.renameSync(spoolPath, previousPath);
  if (process.platform !== "win32") {
    fs.chmodSync(previousPath, 0o600);
  }
}

export function appendProjectedEvent(
  spoolPath,
  event,
  { maxBytes = MAX_SPOOL_BYTES } = {}
) {
  if (typeof spoolPath !== "string" || !path.isAbsolute(spoolPath)) {
    return false;
  }

  const serialized = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  const serializedBytes = serialized.length;
  if (serializedBytes > MAX_EVENT_BYTES || serializedBytes > maxBytes) {
    return false;
  }

  const directory = path.dirname(spoolPath);
  const lockPath = `${spoolPath}.lock`;
  let lockDescriptor = null;
  let spoolDescriptor = null;

  try {
    ensurePrivateDirectory(directory);
    lockDescriptor = acquireLock(lockPath);
    if (lockDescriptor === null) {
      return false;
    }
    rotateIfNeeded(spoolPath, serializedBytes, maxBytes);

    const flags = fs.constants.O_WRONLY
      | fs.constants.O_CREAT
      | fs.constants.O_APPEND
      | (fs.constants.O_NOFOLLOW ?? 0);
    spoolDescriptor = fs.openSync(spoolPath, flags, 0o600);
    const metadata = fs.fstatSync(spoolDescriptor);
    if (!metadata.isFile()) {
      return false;
    }
    writeAll(spoolDescriptor, serialized);
    if (process.platform !== "win32") {
      fs.fchmodSync(spoolDescriptor, 0o600);
    }
    return true;
  } catch {
    return false;
  } finally {
    if (spoolDescriptor !== null) {
      try {
        fs.closeSync(spoolDescriptor);
      } catch {
        // Status hooks are deliberately fail-open.
      }
    }
    if (lockDescriptor !== null) {
      releaseLock(lockPath, lockDescriptor);
    }
  }
}
