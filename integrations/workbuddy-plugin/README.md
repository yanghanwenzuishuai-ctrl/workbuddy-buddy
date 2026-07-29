# workbuddy-buddy WorkBuddy Plugin

This directory is a self-contained WorkBuddy 5.3.5 plugin. It replaces the
legacy installer that edited a user's private `settings.json`; an installer
should copy this directory as one plugin unit and let WorkBuddy discover
`.codebuddy-plugin/plugin.json`.

## Runtime contract

- WorkBuddy reads `.codebuddy-plugin/plugin.json`, which points to
  `hooks/hooks.json`.
- Every hook command resolves its script through
  `${CODEBUDDY_PLUGIN_ROOT}`. There are no absolute install paths.
- The scripts require Node.js 18 or newer and have no package or network
  dependencies.
- `install-manifest.json` gives the desktop installer a deterministic plugin
  ID, version, supported targets, runtime requirement, required files, and
  spool-path contract. It is an installer integration manifest, not a second
  WorkBuddy manifest.

The plugin does not inspect, modify, copy, log, or print WorkBuddy's private
settings. Installing or removing it must be performed through WorkBuddy's
plugin installation mechanism.

## Privacy and local data

The lifecycle hook persists only this exhaustive structural whitelist:

```text
event, ts, session_id, tool_name, permission_mode,
notification_type, ends_with_question
```

Prompt text, assistant text, tool arguments/results, paths, transcripts,
titles, email data, and arbitrary extra fields are discarded before the spool
write. The `ends_with_question` boolean is derived for `Stop`; its source text
is immediately discarded.

The spool path is resolved in this order:

1. absolute `WB_BUDDY_SPOOL`;
2. absolute `WB_BUDDY_DATA_DIR` plus `events.spool`;
3. `<platform user home>/.workbuddy-buddy/events.spool`.

Node's `os.homedir()` resolves the user profile on both macOS and Windows. The
default deliberately matches the current desktop watcher's legacy path.
Relative overrides are ignored so a hook never writes into an arbitrary
workspace or plugin directory.

The spool directory/file use private Unix modes (`0700`/`0600`), symlink
targets are rejected, records are appended as complete JSONL writes, concurrent
writers coordinate through an exclusive short-lived lock, and growth is
bounded to 512 KiB plus one rotated copy. Any filesystem error, lock
contention, malformed payload, or oversized input causes a silent status drop;
it never interrupts WorkBuddy.

## Approval behavior

The approval hook sends only `tool_name` and a 160-character display summary
to the fixed loopback endpoint `http://127.0.0.1:8792/approve`. It never follows
a remote URL and never persists approval details.

Only exact `allow` and `deny` responses produce WorkBuddy decision JSON.
Unavailable desktop pet, non-200 response, malformed/oversized response,
connection failure, or timeout produces no output and exits successfully.
That fail-open behavior restores WorkBuddy's native permission flow.

## Verification

From this directory:

```sh
npm test
```

The dependency-free Node test suite checks the manifest structure, exact
privacy whitelist, content non-leakage, private modes, symlink rejection,
bounded rotation, concurrent writers, loopback-only approval projection,
verified decision shapes, and fail-open behavior.
