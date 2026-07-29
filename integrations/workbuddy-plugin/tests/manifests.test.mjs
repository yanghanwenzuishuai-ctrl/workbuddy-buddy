import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const REPOSITORY_ROOT = path.resolve(ROOT, "..", "..");
const readJson = (relativePath) => JSON.parse(
  fs.readFileSync(path.join(ROOT, relativePath), "utf8").replace(/^\uFEFF/, "")
);

test("WorkBuddy plugin manifest points at the packaged hooks file", () => {
  const manifest = readJson(".codebuddy-plugin/plugin.json");
  assert.equal(manifest.name, "workbuddy-buddy");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.hooks, "./hooks/hooks.json");
  assert.equal(fs.existsSync(path.join(ROOT, manifest.hooks)), true);
});

test("hook manifest uses the WorkBuddy plugin wrapper and portable Node commands", () => {
  const manifest = readJson("hooks/hooks.json");
  const expectedEvents = [
    "Notification",
    "PermissionRequest",
    "PostToolUse",
    "PreToolUse",
    "SessionStart",
    "Stop",
    "UserPromptSubmit"
  ];
  assert.deepEqual(Object.keys(manifest.hooks).sort(), expectedEvents);

  const commands = Object.values(manifest.hooks)
    .flatMap((groups) => groups)
    .flatMap((group) => group.hooks)
    .map((hook) => hook.command);
  assert.equal(commands.length, 9);
  for (const command of commands) {
    assert.match(command, /^node "\$\{CODEBUDDY_PLUGIN_ROOT\}\/scripts\/.+\.mjs"/);
    assert.doesNotMatch(command, /python|\.sh\b|\/Users\/|~\//i);
  }
});

test("installer manifest is complete, version-aligned, and self-contained", () => {
  const plugin = readJson(".codebuddy-plugin/plugin.json");
  const installer = readJson("install-manifest.json");
  assert.equal(installer.schemaVersion, 1);
  assert.equal(installer.id, plugin.name);
  assert.equal(installer.version, plugin.version);
  assert.equal(installer.runtime.networkDependencies, false);
  assert.deepEqual(installer.platforms, ["darwin-arm64", "darwin-x64", "win32-x64"]);
  for (const file of installer.requiredFiles) {
    assert.equal(path.isAbsolute(file), false);
    assert.equal(fs.existsSync(path.join(ROOT, file)), true, `missing ${file}`);
  }
});

test("repository marketplace publishes this exact plugin", () => {
  const plugin = readJson(".codebuddy-plugin/plugin.json");
  const marketplacePath = path.join(
    REPOSITORY_ROOT,
    ".codebuddy-plugin",
    "marketplace.json"
  );
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  const entry = marketplace.plugins.find((item) => item.name === plugin.name);

  assert.equal(marketplace.name, "workbuddy-buddy");
  assert.ok(entry);
  assert.equal(entry.version, plugin.version);
  assert.equal(entry.source, "./integrations/workbuddy-plugin");
  assert.equal(
    fs.existsSync(path.resolve(REPOSITORY_ROOT, entry.source)),
    true
  );
});
