import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const desktopPage = await readFile(
  new URL("../../../../frontend/index.html", import.meta.url),
  "utf8",
);

test("desktop connect panel clears stale codes when no valid prefill is supplied", () => {
  const openConnect = desktopPage.slice(
    desktopPage.indexOf("async function openConnect("),
    desktopPage.indexOf("async function consumePendingConnect("),
  );

  assert.match(
    openConnect,
    /\$connectCode\.value = hasPrefill \? prefillCode : "";/,
  );
  assert.doesNotMatch(
    openConnect,
    /if \(hasPrefill\) \$connectCode\.value = prefillCode;/,
  );
});
