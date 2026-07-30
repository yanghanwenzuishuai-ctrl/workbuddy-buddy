(() => {
  "use strict";

  const STATUS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
  const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
  const PET_IDS = new Set([
    "bloop",
    "buzz-bit",
    "comet-lop",
    "gizmo-kernel",
    "kiki-koala",
    "momo-mug",
    "moss-shell",
    "nimbus-noodle",
    "nori-nibble",
    "olli-orbit",
    "pico-patch",
    "pogo-ping",
    "rumi-relay",
    "sora-shiba",
    "taro-tinker",
  ]);
  const POLL_INTERVAL_MS = 2_000;
  const DESKTOP_APP_SCHEME = "workbuddy-buddy://connect";
  const PAIRING_LAUNCH_HINT =
    "点击后系统会尝试打开桌宠。本页不会把“无响应”误判为“未安装”。";

  const elements = {
    form: byId("onboarding-form"),
    createButton: byId("create-button"),
    formError: byId("form-error"),
    pairingPanel: byId("pairing-panel"),
    pairingCode: byId("pairing-code"),
    copyCode: byId("copy-code"),
    expiryLabel: byId("expiry-label"),
    pairingState: byId("pairing-state"),
    pairingStateTitle: byId("pairing-state-title"),
    pairingStateDetail: byId("pairing-state-detail"),
    officeLink: byId("office-link"),
    restartButton: byId("restart-button"),
    openBuddy: byId("open-buddy"),
    pairingLaunchHint: byId("pairing-launch-hint"),
  };

  let statusToken = null;
  let pairingCode = null;
  let expiresAtMs = 0;
  let officeUrl = null;
  let pollTimer = null;
  let countdownTimer = null;
  let createPending = false;

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void createPairing();
  });
  elements.copyCode.addEventListener("click", () => {
    void copyPairingCode();
  });
  for (const button of document.querySelectorAll("[data-copy-install]")) {
    button.addEventListener("click", () => {
      void copyInstallCommand(button);
    });
  }
  elements.openBuddy.addEventListener("click", openBuddyWithPairing);
  elements.restartButton.addEventListener("click", resetPairing);
  window.addEventListener("beforeunload", stopTimers);

  function byId(id) {
    const element = document.getElementById(id);
    if (element === null) throw new Error(`Missing required element: ${id}`);
    return element;
  }

  async function createPairing() {
    if (createPending) return;
    hideFormError();

    if (!elements.form.reportValidity()) {
      showFormError("请补全办公室名称、宠物昵称，并确认显示在线状态。");
      return;
    }

    const formData = new FormData(elements.form);
    const officeName = readFormString(formData, "office_name", 80);
    const alias = readFormString(formData, "alias", 32);
    const petId = readFormString(formData, "pet_id", 40);
    if (officeName === null || alias === null || petId === null || !PET_IDS.has(petId)) {
      showFormError("表单内容无效，请重新检查后提交。");
      return;
    }

    createPending = true;
    elements.createButton.disabled = true;
    elements.createButton.firstChild.textContent = "正在创建安全配对… ";

    try {
      const response = await fetch("/api/v1/onboarding/offices", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          office_name: officeName,
          alias,
          pet_id: petId,
          presence_visible: formData.get("presence_visible") === "on",
          stats_opt_in: formData.get("stats_opt_in") === "on",
          poster_opt_in: formData.get("poster_opt_in") === "on",
        }),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });

      if (!response.ok) {
        throw new Error(await responseError(response));
      }

      const result = await response.json();
      const parsed = parsePairingResponse(result);
      if (parsed === null) throw new Error("invalid_response");

      statusToken = parsed.statusToken;
      pairingCode = parsed.pairingCode;
      expiresAtMs = parsed.expiresAtMs;
      officeUrl = parsed.officeUrl;
      showPairingPanel();
      schedulePoll(250);
    } catch (error) {
      const message =
        error instanceof Error && error.message === "service_unavailable"
          ? "配对服务暂时不可用，请稍后再试。"
          : "工位创建失败，请检查网络后重试。";
      showFormError(message);
    } finally {
      createPending = false;
      elements.createButton.disabled = false;
      elements.createButton.firstChild.textContent = "生成有效配对码并继续 ";
    }
  }

  function parsePairingResponse(value) {
    if (!isRecord(value)) return null;
    const nextCode = readString(value.pairing_code, 43, 43);
    const nextToken = readString(value.status_token, 16, 256);
    const nextExpiry = readString(value.expires_at, 16, 64);
    const nextOfficeUrl = readString(value.office_url, 1, 2048);
    if (
      nextCode === null ||
      !PAIRING_CODE_PATTERN.test(nextCode) ||
      nextToken === null ||
      !STATUS_TOKEN_PATTERN.test(nextToken) ||
      nextExpiry === null ||
      nextOfficeUrl === null
    ) {
      return null;
    }

    const nextExpiryMs = Date.parse(nextExpiry);
    const safeOfficeUrl = validateOfficeUrl(nextOfficeUrl);
    if (!Number.isFinite(nextExpiryMs) || nextExpiryMs <= Date.now() || safeOfficeUrl === null) {
      return null;
    }

    return {
      pairingCode: nextCode,
      statusToken: nextToken,
      expiresAtMs: nextExpiryMs,
      officeUrl: safeOfficeUrl,
    };
  }

  function validateOfficeUrl(value) {
    try {
      const url = new URL(value, window.location.origin);
      if (url.origin !== window.location.origin || !url.pathname.startsWith("/o/")) {
        return null;
      }
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return null;
    }
  }

  function showPairingPanel() {
    if (pairingCode === null || !PAIRING_CODE_PATTERN.test(pairingCode)) return;
    elements.pairingCode.textContent = pairingCode;
    elements.form.hidden = true;
    elements.pairingPanel.hidden = false;
    elements.openBuddy.disabled = false;
    elements.pairingLaunchHint.textContent = PAIRING_LAUNCH_HINT;
    elements.pairingLaunchHint.classList.remove("is-requested");
    setProgress(2);
    setPairingState(
      "pending",
      "正在等待 WorkBuddy Buddy…",
      "本页会自动检测配对结果",
    );
    elements.officeLink.hidden = true;
    startCountdown();
    elements.pairingPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function startCountdown() {
    updateCountdown();
    countdownTimer = window.setInterval(updateCountdown, 1_000);
  }

  function updateCountdown() {
    const remainingMs = Math.max(0, expiresAtMs - Date.now());
    if (remainingMs === 0) {
      expirePairing();
      return;
    }
    const totalSeconds = Math.ceil(remainingMs / 1_000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    elements.expiryLabel.textContent = `有效期 ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function schedulePoll(delayMs) {
    if (statusToken === null) return;
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(() => {
      pollTimer = null;
      void pollPairing();
    }, delayMs);
  }

  async function pollPairing() {
    if (statusToken === null || Date.now() >= expiresAtMs) {
      expirePairing();
      return;
    }

    try {
      const response = await fetch(
        `/api/v1/onboarding/pairings/${encodeURIComponent(statusToken)}`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
        },
      );
      if (response.status === 404 || response.status === 410) {
        expirePairing();
        return;
      }
      if (!response.ok) throw new Error(`pairing_http_${String(response.status)}`);

      const result = await response.json();
      const status = isRecord(result) ? result.status : null;
      if (status === "claimed") {
        claimPairing();
        return;
      }
      if (status === "expired") {
        expirePairing();
        return;
      }
      if (status !== "pending") throw new Error("invalid_pairing_status");

      setPairingState(
        "pending",
        "正在等待 WorkBuddy Buddy…",
        "本页会自动检测配对结果",
      );
    } catch {
      setPairingState("pending", "网络有一点波动", "仍在等待配对，将自动继续检测");
    }

    schedulePoll(POLL_INTERVAL_MS);
  }

  function claimPairing() {
    stopTimers();
    setProgress(3);
    elements.expiryLabel.textContent = "设备已连接";
    elements.openBuddy.disabled = true;
    setPairingState("claimed", "配对成功！", "你的宠物已获得办公室工位");
    if (officeUrl === null) return;
    elements.officeLink.href = officeUrl;
    elements.officeLink.hidden = false;
    window.setTimeout(() => {
      if (officeUrl !== null) window.location.assign(officeUrl);
    }, 1_200);
  }

  function expirePairing() {
    stopTimers();
    elements.expiryLabel.textContent = "配对码已过期";
    elements.openBuddy.disabled = true;
    setPairingState("expired", "配对码已过期", "请重新创建一个一次性配对码");
  }

  function setPairingState(kind, title, detail) {
    elements.pairingState.className = `pairing-state is-${kind}`;
    elements.pairingStateTitle.textContent = title;
    elements.pairingStateDetail.textContent = detail;
  }

  function setProgress(activeStep) {
    for (const item of document.querySelectorAll("[data-progress-step]")) {
      const step = Number(item.getAttribute("data-progress-step"));
      item.classList.toggle("is-active", step === activeStep);
      item.classList.toggle("is-done", step < activeStep);
    }
  }

  async function copyPairingCode() {
    if (pairingCode === null) return;
    try {
      await navigator.clipboard.writeText(pairingCode);
      elements.copyCode.textContent = "已复制";
      window.setTimeout(() => {
        elements.copyCode.textContent = "复制配对码";
      }, 1_500);
    } catch {
      elements.copyCode.textContent = "请长按上方配对码复制";
    }
  }

  async function copyInstallCommand(button) {
    const panel = button.closest(".quick-install");
    const command = panel?.querySelector("[data-install-command]");
    const label = button.querySelector("[data-copy-label]");
    const status = panel?.querySelector("[data-copy-status]");
    if (command === null || command === undefined || label === null || status === null) return;

    const defaultStatus = status.textContent;
    try {
      await writeClipboardText(command.textContent.trim());
      label.textContent = "已复制";
      button.classList.add("is-success");
      button.classList.remove("is-error");
      status.textContent = "命令已复制。现在打开“终端”，粘贴并按回车即可安装。";
      status.classList.add("is-success");
      status.classList.remove("is-error");
    } catch {
      label.textContent = "复制失败";
      button.classList.add("is-error");
      button.classList.remove("is-success");
      status.textContent = "浏览器未允许自动复制，请长按或选中上方命令手动复制。";
      status.classList.add("is-error");
      status.classList.remove("is-success");
    }

    window.setTimeout(() => {
      label.textContent = "复制命令";
      button.classList.remove("is-success", "is-error");
      status.textContent = defaultStatus;
      status.classList.remove("is-success", "is-error");
    }, 2_400);
  }

  async function writeClipboardText(value) {
    if (navigator.clipboard !== undefined) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {
        // Continue to the selection-based fallback for restricted browser contexts.
      }
    }

    const textArea = document.createElement("textarea");
    textArea.value = value;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.inset = "0 auto auto -9999px";
    document.body.append(textArea);
    textArea.select();
    const copied = document.execCommand("copy");
    textArea.remove();
    if (!copied) throw new Error("Clipboard copy was rejected");
  }

  function openBuddyWithPairing() {
    if (pairingCode === null || !PAIRING_CODE_PATTERN.test(pairingCode)) {
      elements.openBuddy.disabled = true;
      elements.pairingLaunchHint.textContent =
        "当前没有有效配对码。请返回上一步重新生成后再打开桌宠。";
      return;
    }
    void copyPairingCode();
    elements.pairingLaunchHint.textContent =
      "已请求系统打开 WorkBuddy Buddy，并尝试复制配对码。若没有响应，请先安装 macOS 社区测试版再点击一次。";
    elements.pairingLaunchHint.classList.add("is-requested");
    const target = `${DESKTOP_APP_SCHEME}#code=${encodeURIComponent(pairingCode)}`;
    navigateToDesktopApp(target, elements.pairingLaunchHint);
  }

  function navigateToDesktopApp(target, hintElement) {
    try {
      window.location.assign(target);
    } catch {
      hintElement.textContent =
        "浏览器未能请求打开桌宠。请下载或启动 WorkBuddy Buddy 后再试。";
    }
  }

  function resetPairing() {
    stopTimers();
    statusToken = null;
    pairingCode = null;
    expiresAtMs = 0;
    officeUrl = null;
    elements.pairingPanel.hidden = true;
    elements.form.hidden = false;
    elements.openBuddy.disabled = true;
    elements.pairingLaunchHint.textContent = PAIRING_LAUNCH_HINT;
    elements.pairingLaunchHint.classList.remove("is-requested");
    elements.officeLink.hidden = true;
    setProgress(1);
    hideFormError();
    elements.form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function stopTimers() {
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (countdownTimer !== null) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function readFormString(formData, key, maxLength) {
    const value = formData.get(key);
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
  }

  function readString(value, minLength, maxLength) {
    return typeof value === "string" &&
      value.length >= minLength &&
      value.length <= maxLength
      ? value
      : null;
  }

  async function responseError(response) {
    if (response.status === 429 || response.status === 503) {
      return "service_unavailable";
    }
    try {
      const body = await response.json();
      if (isRecord(body) && typeof body.code === "string") return body.code;
    } catch {
      // Error bodies are optional; use a generic message below.
    }
    return `onboarding_http_${String(response.status)}`;
  }

  function showFormError(message) {
    elements.formError.textContent = message;
    elements.formError.hidden = false;
  }

  function hideFormError() {
    elements.formError.hidden = true;
    elements.formError.textContent = "";
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
})();
