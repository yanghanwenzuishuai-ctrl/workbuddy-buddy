# Contributing to workbuddy-buddy

Thanks for helping out! The most fun way to contribute is a **new buddy**, but
code and docs are very welcome too.

## Add a buddy

The pet is a swappable **pet pack** (`pet.json` + a 7-state spritesheet). See
**[docs/PET_SPEC.md](docs/PET_SPEC.md)** for the full authoring spec (grid,
states, `pet.json` schema, checklist).

- **Just for yourself?** Drop the pack into `~/.workbuddy-buddy/pets/<id>/` — it
  shows up in the picker instantly, no rebuild.
- **Want it in the library?** Put it in `frontend/pets/<id>/`, then run
  `python3 assets/import_pets.py frontend/pets` to validate it, generate a
  `preview.png`, and update `frontend/pets/index.json`. Open a PR.

Please set a `license` in your `pet.json` and only submit art you have the right
to share.

## Build & run

Rust (stable) + Python 3. Then:

```sh
cargo test                      # core + watch state logic
python3 hooks/test_privacy.py   # privacy contract

cargo run -p wb-buddy-bridge    # browser pet at http://127.0.0.1:8787 (easiest dev loop)
cargo run -p wb-buddy-app       # native desktop pet (macOS)
```

## Layout

- `crates/core`  — pure state machine (no I/O; heavily tested)
- `crates/watch` — tails the event spool, drives the core
- `crates/hookd` — headless state printer
- `crates/bridge`— local web host (frontend + `/state`)
- `src-tauri`    — desktop app (window, tray, approval server, activate-host)
- `hooks/`       — the WorkBuddy hook (privacy projector) + installer
- `frontend/`    — canvas renderer + the buddy library
- `assets/`      — icon & sprite generators, pet importer

## Ground rules

- **Privacy is non-negotiable.** The pet reads event *shape* only — never prompt
  text, tool arguments, or message bodies. `hooks/test_privacy.py` must stay green.
- Keep `cargo test` green; add tests for state-machine changes.
- Not affiliated with Tencent or WorkBuddy — keep naming/claims accurate.
