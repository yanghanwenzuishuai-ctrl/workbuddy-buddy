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

test("desktop app cannot launch before a server pairing code is validated", () => {
  assert.match(script, /const DESKTOP_APP_SCHEME = "workbuddy-buddy:\/\/connect";/);
  assert.doesNotMatch(html, /id="prepare-buddy"/);
  assert.doesNotMatch(script, /prepareBuddy|openBuddyWithoutCode/);
  assert.match(
    script,
    /elements\.openBuddy\.addEventListener\("click", openBuddyWithPairing\);/,
  );
  assert.match(
    script,
    /`\$\{DESKTOP_APP_SCHEME\}#code=\$\{encodeURIComponent\(pairingCode\)\}`/,
  );
  assert.equal((script.match(/DESKTOP_APP_SCHEME/g) ?? []).length, 2);
  assert.equal((script.match(/navigateToDesktopApp\(/g) ?? []).length, 2);
  assert.doesNotMatch(script, /[?&]code=/);
  assert.doesNotMatch(script, /console\./);
  assert.match(html, /id="open-buddy"[^>]*disabled/);
  assert.match(
    script,
    /nextCode === null \|\|\s*!PAIRING_CODE_PATTERN\.test\(nextCode\)/,
  );

  const showPanel = script.slice(
    script.indexOf("function showPairingPanel()"),
    script.indexOf("function startCountdown()"),
  );
  assert.doesNotMatch(showPanel, /navigateToDesktopApp|DESKTOP_APP_SCHEME/);
  assert.match(
    showPanel,
    /pairingCode === null \|\| !PAIRING_CODE_PATTERN\.test\(pairingCode\)/,
  );
  assert.match(showPanel, /elements\.openBuddy\.disabled = false;/);

  const launch = script.slice(
    script.indexOf("function openBuddyWithPairing()"),
    script.indexOf("function navigateToDesktopApp("),
  );
  assert.match(
    launch,
    /pairingCode === null \|\| !PAIRING_CODE_PATTERN\.test\(pairingCode\)/,
  );
  assert.match(
    launch,
    /`\$\{DESKTOP_APP_SCHEME\}#code=\$\{encodeURIComponent\(pairingCode\)\}`/,
  );
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
  assert.match(html, /下载 Apple 芯片版/);
  assert.match(html, /下载 Intel 芯片版/);
  assert.match(html, /推荐 · 适用于 M 系列 Mac/);
  assert.match(html, /网页无法可靠判断桌宠是否已安装或识别 Mac 芯片架构/);
  assert.match(html, /Windows 桌宠正在开发中，暂不提供下载/);
  assert.doesNotMatch(html, /\/download\/windows/i);
});

test("community installer is a prominent copyable primary action", () => {
  const installCommand =
    /curl -fsSL https:\/\/raw\.githubusercontent\.com\/FlashFamily\/workbuddy-buddy\/main\/install-community\.sh \| bash/g;
  assert.equal((html.match(installCommand) ?? []).length, 2);
  assert.equal((html.match(/class="quick-install"/g) ?? []).length, 2);
  assert.equal((html.match(/data-copy-install/g) ?? []).length, 2);
  assert.equal((html.match(/data-copy-label>复制命令</g) ?? []).length, 2);
  assert.match(html, /推荐 · 最快/);
  assert.match(html, /复制一行命令，自动安装桌宠/);
  assert.match(html, /不想用终端？直接下载 macOS 应用/);
  assert.doesNotMatch(html, /<details class="terminal-install"/);
  assert.match(html, /校验 SHA256/);
  assert.match(html, /不会关闭 Gatekeeper/);
  assert.match(html, /不会自动清除 quarantine 标记/);
  assert.match(script, /document\.querySelectorAll\("\[data-copy-install\]"\)/);
  assert.match(script, /void copyInstallCommand\(button\);/);
  assert.match(script, /async function writeClipboardText\(value\)/);
  assert.match(script, /命令已复制。现在打开“终端”，粘贴并按回车即可安装。/);
  assert.match(script, /浏览器未允许自动复制，请长按或选中上方命令手动复制。/);
});

test("desktop app controls retain a narrow portrait layout", () => {
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /\.install-copy-button\s*\{[\s\S]*?min-height: 2\.75rem;/);
  assert.match(css, /\.open-buddy-button\s*\{[\s\S]*?min-height: 2\.75rem;/);
  assert.match(css, /\.copy-button\s*\{[\s\S]*?min-height: 2\.75rem;/);
  assert.match(css, /\.copy-button:focus-visible/);
  const mobile = css.slice(css.indexOf("@media (max-width: 560px)"));
  assert.match(
    mobile,
    /\.download-choices\s*\{\s*grid-template-columns: 1fr;\s*\}/,
  );
  assert.match(
    mobile,
    /\.install-command-row\s*\{\s*grid-template-columns: 1fr;\s*\}/,
  );
  assert.match(mobile, /\.install-copy-button\s*\{[\s\S]*?width: 100%;/);
  assert.match(mobile, /\.app-card-badge\s*\{\s*display: none;\s*\}/);
});
