import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const desktopPage = await readFile(
  new URL("../../../../frontend/index.html", import.meta.url),
  "utf8",
);
const desktopCapability = await readFile(
  new URL("../../../../src-tauri/capabilities/default.json", import.meta.url),
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

test("desktop panels expose native drag surfaces without turning controls into drag handles", () => {
  assert.match(
    desktopPage,
    /class="chead" data-tauri-drag-region="deep" title="按住拖动窗口"/,
  );
  assert.match(
    desktopPage,
    /class="phead" data-tauri-drag-region="deep" title="按住拖动窗口"/,
  );
  assert.match(
    desktopPage,
    /class="ahead" data-tauri-drag-region="deep" title="按住拖动窗口"/,
  );
  assert.doesNotMatch(
    desktopPage,
    /class="(?:cclose|pclose|ccode|csubmit)"[^>]*data-tauri-drag-region/,
  );
  assert.match(desktopCapability, /core:window:allow-start-dragging/);
  assert.match(desktopPage, /\.chead:active \{ cursor: grabbing; \}/);
  assert.match(desktopPage, /\.phead:active \{ cursor: grabbing; \}/);
});

test("desktop pairing panel is scrollable, keyboard reachable, and announces native panel mode", () => {
  assert.match(
    desktopPage,
    /overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;/,
  );
  assert.match(desktopPage, /#connect \.cclose \{[^}]*width: 44px; height: 44px;/s);
  assert.match(desktopPage, /#connect \.csubmit \{[^}]*min-height: 44px;/s);
  assert.match(desktopPage, /events\.emit\("window-panel-mode", \{ open \}\);/);
  assert.match(desktopPage, /if \(event\.key === "Escape"\)/);
  assert.match(desktopPage, /trapPanelFocus\(activePanel, event\);/);
});

test("desktop pairing prevents duplicate submissions and ends in a clear completion action", () => {
  assert.match(desktopPage, /if \(pairingInFlight\) return;/);
  assert.match(desktopPage, /pairingInFlight = true;/);
  assert.match(desktopPage, /pairingInFlight = false;/);
  assert.match(desktopPage, /const attemptId = \+\+pairingAttemptId;/);
  assert.match(desktopPage, /if \(attemptId !== pairingAttemptId\) return;/);
  assert.match(desktopPage, /if \(attemptId === pairingAttemptId\)/);
  assert.match(desktopPage, /const navigationId = \+\+panelNavigationId;/);
  assert.match(desktopPage, /navigationId !== panelNavigationId \|\| pairingInFlight/);
  assert.match(desktopPage, /pendingConsumeInFlight = true;/);
  assert.match(desktopPage, /if \(request\) deferredConnectRequest = request;/);
  assert.match(desktopPage, /!\$connect\.classList\.contains\("show"\)/);
  assert.match(desktopPage, /function isCurrentConnectNavigation\(navigationId\)/);
  assert.match(desktopPage, /configureWorkBuddyPlugin\(navigationId\)/);
  assert.match(desktopPage, /\$connectClose\.disabled = true;/);
  assert.match(desktopPage, /setTimeout\(\(\) => consumePendingConnect\(false\), 0\);/);
  assert.match(desktopPage, /showPairingComplete\(\);/);
  assert.match(desktopPage, /\$connectSubmit\.textContent = "完成并返回桌宠";/);
  assert.match(desktopPage, /\$connectCode\.disabled = true;/);
});
