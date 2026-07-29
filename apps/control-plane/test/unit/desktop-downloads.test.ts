import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerDesktopDownloadRoutes } from "../../src/desktop-downloads.js";

const RELEASE_ROOT =
  "https://github.com/FlashFamily/workbuddy-buddy/releases/latest/download";

for (const [arch, asset] of [
  ["arm64", "workbuddy-buddy_macos_arm64.dmg"],
  ["x64", "workbuddy-buddy_macos_x64.dmg"],
] as const) {
  test(`macOS ${arch} download uses the stable GitHub Release asset`, async (t) => {
    const app = Fastify();
    registerDesktopDownloadRoutes(app);
    t.after(() => app.close());

    const response = await app.inject({
      method: "GET",
      url: `/download/macos/${arch}`,
    });

    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, `${RELEASE_ROOT}/${asset}`);
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
  });
}
