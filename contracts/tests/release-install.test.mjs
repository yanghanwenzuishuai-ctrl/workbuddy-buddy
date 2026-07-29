import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [installer, workflow, downloads] = await Promise.all([
  readFile(new URL("../../install.sh", import.meta.url), "utf8"),
  readFile(
    new URL("../../.github/workflows/release-macos.yml", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../../apps/control-plane/src/desktop-downloads.ts", import.meta.url),
    "utf8",
  ),
]);

for (const asset of [
  "workbuddy-buddy_macos_arm64.dmg",
  "workbuddy-buddy_macos_x64.dmg",
]) {
  test(`${asset} is stable across build, web redirect, and installer`, () => {
    assert.match(workflow, new RegExp(`asset: ${asset}`));
    assert.match(downloads, new RegExp(asset.replace(".", "\\.")));
    assert.match(installer, new RegExp(asset.replace(".", "\\.")));
  });
}

test("public installer verifies release integrity and never injects legacy hooks", () => {
  assert.match(installer, /shasum -a 256/);
  assert.match(installer, /codesign --verify --deep --strict/);
  assert.match(installer, /hdiutil attach/);
  assert.doesNotMatch(installer, /hooks\/install\.py|cargo build|sudo/);
});

test("public release is gated on Apple signing and notarization secrets", () => {
  for (const secret of [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    assert.match(workflow, new RegExp(`test -n "\\$${secret}"`));
  }
  assert.match(workflow, /releaseDraft: true/);
});
