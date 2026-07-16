# workbuddy-buddy

A tiny desktop pet that shows your **WorkBuddy** agent's live status at a glance —
thinking, running a tool, waiting for you, done, or blocked. Inspired by the
Codex Pets ecosystem.

![status states](docs/img/states.png)

![license: MIT](https://img.shields.io/badge/license-MIT-blue)
![platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)
![built with Tauri](https://img.shields.io/badge/built%20with-Tauri%20v2-24C8DB)

> **Not affiliated with, endorsed by, or connected to Tencent or WorkBuddy.**
> "WorkBuddy" is used only to describe compatibility.

---

## What it does

- **Glanceable status.** A hook on WorkBuddy's lifecycle drives the pet through 7
  states — `idle · thinking · working · review · waiting · done · failed` — so you
  can tell what your agent is doing without watching its window.
- **A library of 15 hand-drawn buddies, plus your own.** Switch anytime; drop a
  new one in without a rebuild.
- **The pet is a permission gate.** When WorkBuddy needs approval, the pet pops an
  **允许 / 拒绝** bubble and your click is fed back as the decision.
- **Click to summon.** Click the pet to bring WorkBuddy to the front; drag to move;
  right-click for the buddy picker.
- **Private by construction.** The pet only ever sees the *shape* of events — never
  your prompts, tool arguments, or messages. It runs fully local.

## Quick start

**One line** — macOS, needs [Rust](https://rustup.rs) (the installer tells you if it's missing):

```sh
curl -fsSL https://raw.githubusercontent.com/FlashFamily/workbuddy-buddy/main/install.sh | bash
```

It fetches the source, builds the pet, installs the WorkBuddy hook (backing up
your `settings.json`), and launches it. Then **fully restart WorkBuddy** (Cmd+Q,
its config is cached at startup), open a folder, and run a task.

<details>
<summary>Or step by step</summary>

```sh
git clone https://github.com/FlashFamily/workbuddy-buddy && cd workbuddy-buddy
cargo test                      # state logic
python3 hooks/test_privacy.py   # privacy contract

# 1) install the hook into WorkBuddy (backs up settings.json), then restart WorkBuddy
python3 hooks/install.py

# 2) run the pet — pick one:
cargo run -p wb-buddy-bridge    # browser pet  → http://127.0.0.1:8787
cargo run -p wb-buddy-app       # native transparent floating window (macOS)
```
</details>

To get a proper `.app` (Dock icon, app name) install the Tauri CLI and bundle:

```sh
npm i -g @tauri-apps/cli
tauri build --bundles app       # → target/release/bundle/macos/workbuddy-buddy.app
```

Undo the hook anytime: `cp ~/.workbuddy/settings.json.wb-buddy-bak ~/.workbuddy/settings.json`

## Buddies

![buddy gallery](docs/img/buddies.png)

Open the picker from the **menu-bar tray → 选择伙伴**, by **right-clicking** the
pet (or **double-click** in the browser build). Your choice is remembered.

**Bring your own:** drop a pack into `~/.workbuddy-buddy/pets/<id>/` and it appears
in the picker instantly (tagged 自定义) — no rebuild. Full authoring guide:
**[docs/PET_SPEC.md](docs/PET_SPEC.md)**.

## Approval UI

When WorkBuddy is about to run a gated tool (default: `Bash`) or shows a permission
prompt, the pet asks **允许 / 拒绝**; your click is returned to WorkBuddy as a hook
decision (verified honored live). **Fail-open by design** — if the pet isn't
running or you don't answer in 50s, the hook stays silent and WorkBuddy behaves
exactly as if the pet weren't there.

## Privacy

The pet reads **event shape only** — event name, timestamp, session id, tool
*name*, permission mode, notification kind, and a computed "did the agent end on a
question?" flag. It **never** reads or stores prompt text, tool arguments, message
bodies, titles, or transcript paths, and it runs fully local (loopback only). The
projection happens in `hooks/project.py` before anything is written; the event
spool is `0600` and size-capped. Enforced by `hooks/test_privacy.py`.

## How it works

```
WorkBuddy  ──hook──▶  wb-buddy-hook.sh ──▶ events.spool (JSONL, structural-only)
(lifecycle)          (privacy projector)         │
                                          wb-buddy-watch  (robust spool tailer)
                                          wb-buddy-core   (7 states · priority
                                            │              arbitration · TTL decay)
                                          display state
                                            ├─▶ wb-buddy-bridge → HTTP → browser pet
                                            └─▶ wb-buddy-app    → Tauri event → native pet
```

- **wb-buddy-core** — pure, content-free state derivation (no I/O; heavily tested).
- **wb-buddy-watch** — tails the spool; safe against partial lines and rotation.
- **wb-buddy-bridge** — serves the frontend + a `/state` endpoint (browser build).
- **src-tauri** — the desktop app: transparent window, tray, approval server, and
  the click-to-foreground shortcut.
- **frontend/** — canvas sprite renderer + the buddy library.

## Contributing

New buddies, code, and docs welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## License

[MIT](LICENSE). Buddy art is provided under the license in each pack's `pet.json`.
