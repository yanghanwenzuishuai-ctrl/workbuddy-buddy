# workbuddy-buddy

A desktop pet that reflects your **WorkBuddy** agent's live status — thinking,
running tools, waiting for you, done, or blocked — inspired by the Codex Pets
ecosystem.

> **Not affiliated with, endorsed by, or connected to Tencent or WorkBuddy.**
> "WorkBuddy" is used only to describe compatibility. (A non-trademark name may
> be chosen for any formal/commercial release.)

## Status: v0

Working end-to-end today: **WorkBuddy hook → event spool → state machine →
live pet**, shown either in the browser (wb-buddy-bridge) or as a native
transparent floating window (wb-buddy-app, Tauri v2).

## Architecture

```
WorkBuddy  ──hook──▶  wb-buddy-hook.sh ──▶ events.spool (JSONL, structural-only)
(lifecycle)          (privacy projector)         │
                                          wb-buddy-watch  (tails spool, robust to
                                            │              partial lines / rotation)
                                          wb-buddy-core   (5 states · priority
                                            │              arbitration · TTL decay)
                                          display state
                                            ├─▶ wb-buddy-hookd   → stdout (debug/CLI)
                                            └─▶ wb-buddy-bridge  → HTTP /state → browser pet
                                                                   (Tauri: pushes pet-state events)
```

Crates:
- **wb-buddy-core** — pure, content-free state derivation. States
  `idle/working/waiting/done/failed`; cross-session priority arbitration
  (`failed > waiting > working > done > idle`); TTL decay (Codex-pet lifetimes)
  so a state fades without an end-of-session event; decayed sessions are evicted.
- **wb-buddy-watch** — tails the spool and drives the core; robust to concurrent
  appends (only complete lines consumed) and truncation/rotation (offset resets).
- **wb-buddy-hookd** — headless daemon; prints the state on every change.
- **wb-buddy-bridge** — local web host; serves the pet frontend + a `/state`
  endpoint the page polls. Makes the whole pipeline demoable in any browser.
- **frontend/** — canvas sprite renderer; loads `pet.json` + spritesheet, animates
  the row for the current state. Self-made placeholder art (`assets/gen_sprite.py`).

## Approval UI (the pet as a permission gate)

When WorkBuddy is about to run a gated tool (default: `Bash`) or shows a native
permission prompt, the pet pops a bubble with **允许 / 拒绝**. Your click is
returned to WorkBuddy as a hook decision (verified honored live — deny reasons
are fed back to the agent, in every permission mode including dontAsk).
**Fail-open by design**: if the pet isn't running or you don't click within
50s, the hook stays silent and WorkBuddy behaves exactly as if the pet did not
exist. Approval details (tool name + truncated command) travel over loopback
for display only and are never persisted.

## Privacy contract

The pet reads **event shape only** — event name, timestamp, session id, tool
*name*, permission mode, notification kind, and a computed "did the agent end on
a question?" flag. It **never** reads or stores prompt text, tool arguments,
message bodies, titles, or transcript paths, and it runs **fully local** (no
network beyond loopback). Projection happens in the hook (`hooks/project.py`)
before anything is written; the spool is `0600` and size-capped.
Enforced by `hooks/test_privacy.py`.

## Run it

```sh
cargo test                      # core + watch + privacy logic
python3 hooks/test_privacy.py   # privacy contract

# install the hook into WorkBuddy (backs up settings.json), then restart WorkBuddy
python3 hooks/install.py

# option A — browser pet: serve frontend + live state, open the printed URL
cargo run -p wb-buddy-bridge    # → http://127.0.0.1:8787

# option B — native desktop pet: transparent, always-on-top floating window
cargo run -p wb-buddy-app       # needs a desktop session (macOS/Windows)

# option C — terminal: print the state on every change
cargo run -p wb-buddy-hookd
```

Undo the hook: `cp ~/.workbuddy/settings.json.wb-buddy-bak ~/.workbuddy/settings.json`

## License

MIT
