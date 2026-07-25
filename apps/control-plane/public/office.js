(() => {
  "use strict";

  const MAX_SAFE_REVISION = 9_007_199_254_740_991;
  const RETRY_MAX_MS = 15_000;
  const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
  const DISPLAY_STATES = new Set(["idle", "working", "waiting", "done", "failed"]);
  const IDLE_STAGES = new Set(["none", "fresh", "salted", "costume", "fish"]);

  const PETS = Object.freeze({
    bloop: { emoji: "🫧", name: "Bloop", hue: 188 },
    "buzz-bit": { emoji: "🐝", name: "Buzz Bit", hue: 45 },
    "comet-lop": { emoji: "🐰", name: "Comet Lop", hue: 216 },
    "gizmo-kernel": { emoji: "🐹", name: "Gizmo Kernel", hue: 34 },
    "kiki-koala": { emoji: "🐨", name: "Kiki Koala", hue: 204 },
    "momo-mug": { emoji: "🦫", name: "Momo Mug", hue: 25 },
    "moss-shell": { emoji: "🐢", name: "Moss Shell", hue: 126 },
    "nimbus-noodle": { emoji: "🐉", name: "Nimbus Noodle", hue: 205 },
    "nori-nibble": { emoji: "🦝", name: "Nori Nibble", hue: 12 },
    "olli-orbit": { emoji: "🦉", name: "Olli Orbit", hue: 31 },
    "pico-patch": { emoji: "🦊", name: "Pico Patch", hue: 24 },
    "pogo-ping": { emoji: "🐧", name: "Pogo Ping", hue: 195 },
    "rumi-relay": { emoji: "🦝", name: "Rumi Relay", hue: 220 },
    "sora-shiba": { emoji: "🐕", name: "Sora Shiba", hue: 31 },
    "taro-tinker": { emoji: "🦔", name: "Taro Tinker", hue: 39 },
  });

  const STAGES = Object.freeze({
    none: { badge: "", label: "" },
    fresh: { badge: "🐟", label: "摸到新鲜鱼" },
    salted: { badge: "🧂", label: "正在腌咸鱼" },
    costume: { badge: "🥋", label: "穿上咸鱼装" },
    fish: { badge: "💤", label: "彻底躺成咸鱼" },
  });

  const DISPLAY_LABELS = Object.freeze({
    idle: "等待新任务",
    working: "认真工作中",
    waiting: "等待回应",
    done: "任务完成",
    failed: "任务遇阻",
  });

  const elements = {
    officeName: byId("office-name"),
    officeClock: byId("office-clock"),
    officeDate: byId("office-date"),
    rooms: byId("rooms"),
    onlineCount: byId("online-count"),
    revision: byId("revision-label"),
    connectionState: byId("connection-state"),
    connectionLabel: byId("connection-label"),
    championKicker: byId("champion-kicker"),
    championPet: byId("champion-pet"),
    championName: byId("champion-heading"),
    championScore: byId("champion-score"),
    championBadge: byId("champion-badge"),
    leaderboard: byId("leaderboard"),
    leaderboardStatus: byId("leaderboard-status"),
    leaderboardTime: byId("leaderboard-time"),
    generatedAt: byId("generated-at"),
    notice: byId("notice"),
  };

  const token = readOfficeToken(window.location.pathname);
  let endpoint = null;
  let currentRevision = -1;
  let eventSource = null;
  let retryTimer = null;
  let retryAttempt = 0;
  let connectionGeneration = 0;
  let clockTimer = null;

  if (token === null) {
    setConnection("retrying", "办公室链接无效");
    showNotice("这个办公室链接无效或已经失效，请使用完整的 /o/:token 分享链接。");
    renderEmptyOffice();
    return;
  }

  const encodedToken = encodeURIComponent(token);
  const endpointCandidates = [
    {
      snapshot: `/api/v1/offices/${encodedToken}/snapshot`,
      events: `/api/v1/offices/${encodedToken}/events`,
    },
  ];

  window.addEventListener("online", () => {
    void recoverImmediately();
  });
  window.addEventListener("offline", () => {
    closeEventSource();
    setConnection("retrying", "网络已断开");
  });
  window.addEventListener("beforeunload", () => {
    connectionGeneration += 1;
    closeEventSource();
    clearRetry();
    if (clockTimer !== null) window.clearInterval(clockTimer);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && eventSource === null) {
      void recoverImmediately();
    }
  });

  void refreshSnapshot();

  function byId(id) {
    const element = document.getElementById(id);
    if (element === null) throw new Error(`Missing required element: ${id}`);
    return element;
  }

  function readOfficeToken(pathname) {
    const parts = pathname.split("/").filter(Boolean);
    const officeSegment = parts.lastIndexOf("o");
    if (officeSegment < 0 || officeSegment + 1 >= parts.length) return null;
    try {
      const candidate = decodeURIComponent(parts[officeSegment + 1]);
      return TOKEN_PATTERN.test(candidate) ? candidate : null;
    } catch {
      return null;
    }
  }

  async function refreshSnapshot() {
    const generation = ++connectionGeneration;
    closeEventSource();
    clearRetry();
    setConnection("connecting", retryAttempt === 0 ? "正在同步办公室" : "正在重新同步");

    try {
      const result = await fetchSnapshot();
      if (generation !== connectionGeneration) return;

      endpoint = result.endpoint;
      retryAttempt = 0;
      hideNotice();
      applySnapshot(result.snapshot, true);
      connectEvents(generation);
    } catch (error) {
      if (generation !== connectionGeneration) return;
      const message =
        error instanceof Error && error.message === "office_not_found"
          ? "办公室不存在、分享链接已轮换，或链接已经过期。"
          : "实时办公室暂时连接不上，正在自动重试。";
      showNotice(message);
      scheduleRecovery();
    }
  }

  async function fetchSnapshot() {
    let lastError = null;
    const candidates = endpoint === null ? endpointCandidates : [endpoint, ...endpointCandidates.filter((item) => item !== endpoint)];

    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate.snapshot, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
        if (response.status === 404) {
          lastError = new Error("office_not_found");
          continue;
        }
        if (!response.ok) {
          throw new Error(`snapshot_http_${response.status}`);
        }
        const snapshot = await response.json();
        if (!isSnapshot(snapshot)) throw new Error("invalid_snapshot");
        return { endpoint: candidate, snapshot };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("snapshot_unavailable");
  }

  function connectEvents(generation) {
    if (endpoint === null || currentRevision < 0) return;
    closeEventSource();

    const url = `${endpoint.events}?after_revision=${encodeURIComponent(String(currentRevision))}`;
    const source = new EventSource(url, { withCredentials: false });
    eventSource = source;

    source.addEventListener("open", () => {
      if (generation !== connectionGeneration || source !== eventSource) return;
      retryAttempt = 0;
      hideNotice();
      setConnection("live", "实时连接");
    });

    source.addEventListener("office.snapshot", (event) => {
      if (generation !== connectionGeneration || source !== eventSource) return;
      try {
        const next = JSON.parse(event.data);
        if (!isSnapshot(next)) throw new Error("invalid_snapshot_event");
        const eventRevision = parseRevision(event.lastEventId);
        if (eventRevision !== null && eventRevision !== next.office_revision) {
          throw new Error("revision_mismatch");
        }
        if (next.office_revision <= currentRevision) return;
        if (next.office_revision !== currentRevision + 1) {
          void recoverImmediately();
          return;
        }
        applySnapshot(next, false);
      } catch {
        void recoverImmediately();
      }
    });

    source.addEventListener("resync.required", () => {
      if (generation !== connectionGeneration || source !== eventSource) return;
      void recoverImmediately();
    });

    source.onerror = () => {
      if (generation !== connectionGeneration || source !== eventSource) return;
      closeEventSource();
      scheduleRecovery();
    };
  }

  async function recoverImmediately() {
    retryAttempt = 0;
    await refreshSnapshot();
  }

  function scheduleRecovery() {
    closeEventSource();
    clearRetry();
    const delay = Math.min(1_000 * 2 ** retryAttempt, RETRY_MAX_MS);
    retryAttempt += 1;
    setConnection("retrying", `将在 ${Math.ceil(delay / 1_000)} 秒后重连`);
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void refreshSnapshot();
    }, delay);
  }

  function clearRetry() {
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function closeEventSource() {
    if (eventSource !== null) {
      eventSource.close();
      eventSource = null;
    }
  }

  function applySnapshot(snapshot, replaceRevision) {
    if (!replaceRevision && snapshot.office_revision <= currentRevision) return;
    currentRevision = snapshot.office_revision;

    elements.officeName.textContent = safeText(snapshot.office.name, "咸鱼办公室", 80);
    document.title = `${safeText(snapshot.office.name, "咸鱼办公室", 80)} · WorkBuddy Buddy`;
    elements.revision.textContent = `#${String(currentRevision)}`;
    elements.officeDate.textContent = formatOfficeDate(snapshot.office.local_date);
    elements.generatedAt.textContent = `画面生成于 ${formatTime(snapshot.generated_at, snapshot.office.timezone)}`;

    renderRooms(snapshot);
    renderLeaderboard(snapshot);
    renderChampion(snapshot);
    updateClock(snapshot.office.timezone);
  }

  function renderRooms(snapshot) {
    const agents = snapshot.agents.filter(isAgent);
    const online = agents.filter((agent) => agent.presence === "online").length;
    elements.onlineCount.textContent = String(online);
    elements.rooms.replaceChildren();

    if (snapshot.rooms.length === 0) {
      renderEmptyOffice();
      return;
    }

    for (const room of snapshot.rooms) {
      if (!isRoom(room)) continue;
      const roomAgents = agents.filter((agent) => agent.room_id === room.room_id);
      elements.rooms.append(createRoom(room, roomAgents));
    }

    if (elements.rooms.childElementCount === 0) renderEmptyOffice();
  }

  function createRoom(room, agents) {
    const section = document.createElement("section");
    section.className = "room";
    section.setAttribute("aria-label", safeText(room.name, "办公室房间", 40));

    const header = document.createElement("header");
    header.className = "room-header";
    const name = document.createElement("h3");
    name.className = "room-name";
    name.textContent = safeText(room.name, "未命名房间", 40);
    const capacity = document.createElement("span");
    capacity.className = "room-capacity";
    capacity.textContent = `${String(agents.length)} / ${String(room.scene_capacity)} 个工位`;
    header.append(name, capacity);

    const grid = document.createElement("div");
    grid.className = "desk-grid";
    if (agents.length === 0) {
      const empty = document.createElement("div");
      empty.className = "room-empty";
      const icon = document.createElement("div");
      icon.className = "loading-fish";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "🫧";
      const copy = document.createElement("p");
      copy.textContent = "工位空着，鱼也很安静";
      empty.append(icon, copy);
      grid.append(empty);
    } else {
      const visibleAgents = agents.slice(0, Math.min(room.scene_capacity, 24));
      for (const agent of visibleAgents) grid.append(createDesk(agent));
      if (agents.length > visibleAgents.length) {
        const overflow = document.createElement("p");
        overflow.className = "overflow-note";
        overflow.textContent = `另有 ${String(agents.length - visibleAgents.length)} 位伙伴在场外休息`;
        grid.append(overflow);
      }
    }

    section.append(header, grid);
    return section;
  }

  function createDesk(agent) {
    const stageKey = IDLE_STAGES.has(agent.idle_stage) ? agent.idle_stage : "none";
    const stage = STAGES[stageKey];
    const pet = petFor(agent.pet_id);
    const online = agent.presence === "online";

    const desk = document.createElement("article");
    desk.className = online ? "desk" : "desk is-offline";
    desk.dataset.stage = stageKey;
    desk.style.setProperty("--pet-hue", String(pet.hue));

    const petWrap = document.createElement("div");
    petWrap.className = "pet-wrap";
    const avatar = document.createElement("div");
    avatar.className = "pet";
    avatar.setAttribute("aria-hidden", "true");
    if (stageKey === "fish") {
      avatar.textContent = "🐟";
    } else {
      mountPetPreview(avatar, agent.pet_id, pet.emoji, "pet-preview");
    }
    petWrap.append(avatar);

    if (stage.badge !== "") {
      const badge = document.createElement("span");
      badge.className = "fish-badge";
      badge.setAttribute("aria-hidden", "true");
      badge.textContent = stage.badge;
      petWrap.append(badge);
    }

    const copy = document.createElement("div");
    copy.className = "pet-copy";
    const alias = document.createElement("span");
    alias.className = "pet-alias";
    alias.textContent = safeText(agent.alias, pet.name, 32);
    const state = document.createElement("span");
    state.className = "pet-state";
    state.textContent = describeAgent(agent, stage);
    copy.append(alias, state);

    desk.append(petWrap, copy);
    return desk;
  }

  function describeAgent(agent, stage) {
    if (agent.presence !== "online") return "离线休息";
    if (stage.label !== "") return stage.label;
    if (typeof agent.display_state === "string" && DISPLAY_STATES.has(agent.display_state)) {
      return DISPLAY_LABELS[agent.display_state];
    }
    return "状态同步中";
  }

  function renderLeaderboard(snapshot) {
    const leaderboard = snapshot.leaderboard;
    const entries = Array.isArray(leaderboard.entries)
      ? leaderboard.entries.filter(isRankEntry).slice(0, 10)
      : [];
    elements.leaderboard.replaceChildren();
    elements.leaderboardStatus.textContent =
      leaderboard.status === "final" ? "已结算" : "实时暂定";
    elements.leaderboardTime.textContent =
      `数据更新时间 ${formatTime(leaderboard.as_of, snapshot.office.timezone)}`;

    if (entries.length === 0) {
      const empty = document.createElement("li");
      empty.className = "leaderboard-empty";
      empty.textContent = "今天还没有人摸到鱼";
      elements.leaderboard.append(empty);
      return;
    }

    for (const entry of entries) {
      const item = document.createElement("li");
      item.className = "rank-item";
      const rank = document.createElement("span");
      rank.className = "rank-number";
      rank.textContent = String(entry.rank);

      const agent = document.createElement("span");
      agent.className = "rank-agent";
      const pet = document.createElement("span");
      pet.className = "rank-pet";
      pet.setAttribute("aria-hidden", "true");
      mountPetPreview(
        pet,
        entry.pet_id,
        petFor(entry.pet_id).emoji,
        "rank-pet-preview",
      );
      const alias = document.createElement("span");
      alias.className = "rank-alias";
      alias.textContent = safeText(entry.alias, "匿名伙伴", 32);
      agent.append(pet, alias);

      const score = document.createElement("span");
      score.className = "rank-score";
      score.textContent = formatDuration(entry.slacking_seconds);
      item.append(rank, agent, score);
      elements.leaderboard.append(item);
    }
  }

  function renderChampion(snapshot) {
    const finalWinner =
      snapshot.daily_award !== null && isAward(snapshot.daily_award)
        ? snapshot.daily_award.winner
        : null;
    const provisional =
      Array.isArray(snapshot.leaderboard.entries) &&
      snapshot.leaderboard.entries.length > 0 &&
      isRankEntry(snapshot.leaderboard.entries[0])
        ? snapshot.leaderboard.entries[0]
        : null;
    const winner = finalWinner ?? provisional;

    if (winner === null) {
      elements.championKicker.textContent = "今日咸鱼王";
      elements.championPet.textContent = "🐟";
      elements.championName.textContent = "等待第一位选手";
      elements.championScore.textContent = "摸鱼时长 0 分钟";
      elements.championBadge.textContent = "实时评选中";
      return;
    }

    elements.championKicker.textContent =
      finalWinner === null ? "今日暂列咸鱼王" : "今日咸鱼王";
    mountPetPreview(
      elements.championPet,
      winner.pet_id,
      petFor(winner.pet_id).emoji,
      "champion-pet-preview",
    );
    elements.championName.textContent = safeText(winner.alias, "匿名伙伴", 32);
    elements.championScore.textContent =
      `摸鱼时长 ${formatDuration(winner.slacking_seconds)}`;
    elements.championBadge.textContent =
      finalWinner === null ? "实时评选中" : "今日已结算";
  }

  function renderEmptyOffice() {
    elements.rooms.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "loading-room";
    const fish = document.createElement("div");
    fish.className = "loading-fish";
    fish.setAttribute("aria-hidden", "true");
    fish.textContent = "🐟";
    const copy = document.createElement("p");
    copy.textContent = "办公室暂时空空的";
    empty.append(fish, copy);
    elements.rooms.append(empty);
  }

  function updateClock(timezone) {
    if (clockTimer !== null) window.clearInterval(clockTimer);
    const tick = () => {
      elements.officeClock.textContent = formatTime(new Date().toISOString(), timezone);
    };
    tick();
    clockTimer = window.setInterval(tick, 1_000);
  }

  function setConnection(kind, label) {
    elements.connectionState.className = `connection-state is-${kind}`;
    elements.connectionLabel.textContent = label;
  }

  function showNotice(message) {
    elements.notice.textContent = message;
    elements.notice.hidden = false;
  }

  function hideNotice() {
    elements.notice.textContent = "";
    elements.notice.hidden = true;
  }

  function petFor(petId) {
    return typeof petId === "string" && Object.hasOwn(PETS, petId)
      ? PETS[petId]
      : { emoji: "🐾", name: "WorkBuddy", hue: 170 };
  }

  function mountPetPreview(container, petId, fallback, className) {
    container.replaceChildren();
    if (typeof petId !== "string" || !Object.hasOwn(PETS, petId)) {
      container.textContent = fallback;
      return;
    }
    const preview = document.createElement("img");
    preview.className = className;
    preview.src = `/pets/${encodeURIComponent(petId)}/preview.png`;
    preview.alt = "";
    preview.decoding = "async";
    preview.loading = "lazy";
    preview.addEventListener(
      "error",
      () => {
        if (preview.parentNode === container) container.textContent = fallback;
      },
      { once: true },
    );
    container.append(preview);
  }

  function formatDuration(seconds) {
    const total = safeInteger(seconds, 0);
    if (total < 60) return `${String(total)} 秒`;
    const hours = Math.floor(total / 3_600);
    const minutes = Math.floor((total % 3_600) / 60);
    if (hours > 0) return minutes > 0 ? `${String(hours)}时${String(minutes)}分` : `${String(hours)} 小时`;
    return `${String(minutes)} 分钟`;
  }

  function formatTime(value, timezone) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--:--";
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        timeZone: safeText(timezone, "UTC", 64),
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date);
    } catch {
      return new Intl.DateTimeFormat("zh-CN", {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date);
    }
  }

  function formatOfficeDate(value) {
    if (typeof value !== "string") return "今日";
    const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (parts === null) return "今日";
    return `${parts[2]} 月 ${parts[3]} 日`;
  }

  function safeText(value, fallback, maximum) {
    if (typeof value !== "string") return fallback;
    const normalized = value.replace(/[\r\n]/g, " ").trim();
    return normalized.length === 0 ? fallback : normalized.slice(0, maximum);
  }

  function safeInteger(value, fallback) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  }

  function parseRevision(value) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision <= MAX_SAFE_REVISION
      ? revision
      : null;
  }

  function isSnapshot(value) {
    return (
      isRecord(value) &&
      value.schema_version === 1 &&
      Number.isSafeInteger(value.office_revision) &&
      value.office_revision >= 0 &&
      value.office_revision <= MAX_SAFE_REVISION &&
      typeof value.generated_at === "string" &&
      isRecord(value.office) &&
      typeof value.office.name === "string" &&
      typeof value.office.local_date === "string" &&
      typeof value.office.timezone === "string" &&
      Array.isArray(value.rooms) &&
      value.rooms.length <= 20 &&
      Array.isArray(value.agents) &&
      value.agents.length <= 500 &&
      isRecord(value.leaderboard) &&
      typeof value.leaderboard.as_of === "string" &&
      Array.isArray(value.leaderboard.entries)
    );
  }

  function isRoom(value) {
    return (
      isRecord(value) &&
      typeof value.room_id === "string" &&
      typeof value.name === "string" &&
      Number.isSafeInteger(value.scene_capacity) &&
      value.scene_capacity >= 1 &&
      value.scene_capacity <= 24
    );
  }

  function isAgent(value) {
    return (
      isRecord(value) &&
      typeof value.mount_id === "string" &&
      typeof value.room_id === "string" &&
      typeof value.alias === "string" &&
      typeof value.pet_id === "string" &&
      (value.presence === "online" || value.presence === "offline") &&
      typeof value.idle_stage === "string"
    );
  }

  function isRankEntry(value) {
    return (
      isRecord(value) &&
      Number.isSafeInteger(value.rank) &&
      value.rank >= 1 &&
      typeof value.alias === "string" &&
      typeof value.pet_id === "string" &&
      Number.isSafeInteger(value.slacking_seconds) &&
      value.slacking_seconds >= 0
    );
  }

  function isAward(value) {
    return isRecord(value) && value.final === true && isRankEntryLike(value.winner);
  }

  function isRankEntryLike(value) {
    return (
      isRecord(value) &&
      typeof value.alias === "string" &&
      typeof value.pet_id === "string" &&
      Number.isSafeInteger(value.slacking_seconds) &&
      value.slacking_seconds >= 0
    );
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
})();
