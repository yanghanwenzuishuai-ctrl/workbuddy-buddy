import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  stableInstaller,
  stableWorkflow,
  communityInstaller,
  communityWorkflow,
  downloads,
] = await Promise.all([
  readFile(new URL("../../install.sh", import.meta.url), "utf8"),
  readFile(
    new URL("../../.github/workflows/release-macos.yml", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../../install-community.sh", import.meta.url), "utf8"),
  readFile(
    new URL(
      "../../.github/workflows/release-macos-community.yml",
      import.meta.url,
    ),
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
  test(`${asset} is stable across both release channels`, () => {
    assert.match(stableWorkflow, new RegExp(`asset: ${asset}`));
    assert.match(stableInstaller, new RegExp(asset.replace(".", "\\.")));
    assert.match(communityWorkflow, new RegExp(`asset: ${asset}`));
    assert.match(communityInstaller, new RegExp(asset.replace(".", "\\.")));
    assert.match(downloads, new RegExp(asset.replace(".", "\\.")));
  });
}

test("public installer verifies release integrity and never injects legacy hooks", () => {
  assert.match(stableInstaller, /shasum -a 256/);
  assert.match(stableInstaller, /codesign --verify --deep --strict/);
  assert.match(stableInstaller, /hdiutil attach/);
  assert.doesNotMatch(
    stableInstaller,
    /hooks\/install\.py|cargo build|sudo/,
  );
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
    assert.match(stableWorkflow, new RegExp(`test -n "\\$${secret}"`));
  }
  assert.match(stableWorkflow, /releaseDraft: true/);
});

test("community release is ad-hoc, fixed-tagged, and does not weaken stable", () => {
  assert.match(communityWorkflow, /community-latest/);
  assert.match(communityWorkflow, /--sign -/);
  assert.match(communityWorkflow, /hdiutil create/);
  assert.match(communityWorkflow, /gh release upload/);
  assert.doesNotMatch(communityWorkflow, /secrets\.APPLE_/);

  assert.match(downloads, /releases\/download\/community-latest/);
  assert.match(downloads, /releases\/latest\/download/);
});

test("community installer verifies artifacts without disabling Gatekeeper", () => {
  assert.match(communityInstaller, /community-latest/);
  assert.match(communityInstaller, /shasum -a 256/);
  assert.match(communityInstaller, /codesign --verify --deep --strict/);
  assert.match(communityInstaller, /hdiutil attach/);
  assert.doesNotMatch(
    communityInstaller,
    /hooks\/install\.py|cargo build|sudo|^[ \t]*xattr(?:[ \t]|$)/m,
  );
});
