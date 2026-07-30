import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, css, script] = await Promise.all([
  readFile(new URL("../../public/start.html", import.meta.url), "utf8"),
  readFile(new URL("../../public/start.css", import.meta.url), "utf8"),
  readFile(new URL("../../public/start.js", import.meta.url), "utf8"),
]);

test("onboarding page distinguishes WorkBuddy from the WorkBuddy Buddy desktop pet", () => {
  assert.match(html, /<b>官方 WorkBuddy<\/b> 是工作客户端/);
  assert.match(html, /<b>WorkBuddy Buddy<\/b>\s+是连接咸鱼办公室的独立桌宠/);
  assert.match(html, /打开的是 <b>WorkBuddy Buddy 桌宠<\/b>，不是官方 WorkBuddy/);
});

test("desktop app launch requires an explicit click and keeps the pairing code in the fragment", () => {
  assert.match(script, /const DESKTOP_APP_SCHEME = "workbuddy-buddy:\/\/connect";/);
  assert.match(
    script,
    /elements\.prepareBuddy\.addEventListener\("click", openBuddyWithoutCode\);/,
  );
  assert.match(
    script,
    /elements\.openBuddy\.addEventListener\("click", openBuddyWithPairing\);/,
  );
  assert.match(
    script,
    /`\$\{DESKTOP_APP_SCHEME\}#code=\$\{encodeURIComponent\(pairingCode\)\}`/,
  );
  assert.doesNotMatch(script, /[?&]code=/);
  assert.doesNotMatch(script, /console\./);

  const showPanel = script.slice(
    script.indexOf("function showPairingPanel()"),
    script.indexOf("function startCountdown()"),
  );
  assert.doesNotMatch(showPanel, /navigateToDesktopApp|DESKTOP_APP_SCHEME/);
});

test("pairing code stays visible and can be copied or used to reopen the desktop app", () => {
  assert.match(html, /<strong id="pairing-code">------<\/strong>/);
  assert.match(html, /id="copy-code"[^>]*>复制配对码<\/button>/);
  assert.match(html, /id="open-buddy"[^>]*type="button"/);
  assert.match(script, /elements\.pairingCode\.textContent = pairingCode;/);
  assert.match(script, /void copyPairingCode\(\);/);
});

test("macOS fallback exposes both architectures without pretending Windows is ready", () => {
  assert.equal((html.match(/href="\/download\/macos\/arm64"/g) ?? []).length, 2);
  assert.equal((html.match(/href="\/download\/macos\/x64"/g) ?? []).length, 2);
  assert.match(html, /Apple 芯片（推荐）/);
  assert.match(html, /Intel 芯片/);
  assert.match(html, /网页无法可靠判断桌宠是否已安装或识别 Mac 芯片架构/);
  assert.match(html, /Windows 桌宠正在开发中，暂不提供下载/);
  assert.doesNotMatch(html, /\/download\/windows/i);
});

test("community download cards expose the optional verified terminal installer", () => {
  const installCommand =
    /curl -fsSL https:\/\/raw\.githubusercontent\.com\/FlashFamily\/workbuddy-buddy\/main\/install-community\.sh \| bash/g;
  assert.equal((html.match(installCommand) ?? []).length, 2);
  assert.equal((html.match(/终端安装（可选）/g) ?? []).length, 2);
  assert.match(html, /校验 SHA256/);
  assert.match(html, /不会自动关闭 Gatekeeper/);
  assert.match(html, /不会清除 quarantine 标记/);
});

test("desktop app controls retain a narrow portrait layout", () => {
  assert.match(css, /@media \(max-width: 560px\)/);
  const mobile = css.slice(css.indexOf("@media (max-width: 560px)"));
  assert.match(
    mobile,
    /\.download-choices\s*\{\s*grid-template-columns: 1fr;\s*\}/,
  );
  assert.match(mobile, /\.app-card-badge\s*\{\s*display: none;\s*\}/);
});
