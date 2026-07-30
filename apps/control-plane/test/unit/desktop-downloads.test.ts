import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerDesktopDownloadRoutes } from "../../src/desktop-downloads.js";

const COMMUNITY_RELEASE_ROOT =
  "https://github.com/FlashFamily/workbuddy-buddy/releases/download/community-latest";
const STABLE_RELEASE_ROOT =
  "https://github.com/FlashFamily/workbuddy-buddy/releases/latest/download";

for (const [arch, asset] of [
  ["arm64", "workbuddy-buddy_macos_arm64.dmg"],
  ["x64", "workbuddy-buddy_macos_x64.dmg"],
] as const) {
  for (const route of [
    `/download/macos/${arch}`,
    `/download/macos/community/${arch}`,
  ]) {
    test(`${route} uses the community-latest GitHub Release asset`, async (t) => {
      const app = Fastify();
      registerDesktopDownloadRoutes(app);
      t.after(() => app.close());

      const response = await app.inject({
        method: "GET",
        url: route,
      });

      assert.equal(response.statusCode, 302);
      assert.equal(
        response.headers.location,
        `${COMMUNITY_RELEASE_ROOT}/${asset}`,
      );
      assert.equal(response.headers["referrer-policy"], "no-referrer");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
    });
  }

  test(`/download/macos/stable/${arch} keeps the future stable Release route`, async (t) => {
    const app = Fastify();
    registerDesktopDownloadRoutes(app);
    t.after(() => app.close());

    const response = await app.inject({
      method: "GET",
      url: `/download/macos/stable/${arch}`,
    });

    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, `${STABLE_RELEASE_ROOT}/${asset}`);
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
  });
}
