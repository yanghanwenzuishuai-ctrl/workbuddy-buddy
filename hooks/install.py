"""Register the workbuddy-buddy hook into ~/.workbuddy/settings.json.

Idempotent and non-destructive:
  * backs up the *pristine* settings.json once (never overwrites the backup);
  * for each event, removes only OUR prior entries (this hook or the W0 probe)
    and appends a fresh one — any other user-configured hook is preserved;
  * writes atomically (temp file + os.replace) so an interrupted run can't
    corrupt settings.json.
Requires a WorkBuddy restart to take effect. Undo: restore the .wb-buddy-bak backup.
"""
import json, os, shutil, tempfile

HOOK = os.path.abspath(os.path.join(os.path.dirname(__file__), "wb-buddy-hook.sh"))
settings = os.path.expanduser("~/.workbuddy/settings.json")
EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
          "PermissionRequest", "Notification", "Stop"]

def is_ours(cmd):
    return isinstance(cmd, str) and ("wb-buddy-hook.sh" in cmd or ".workbuddy-buddy-w0" in cmd)

def group_is_ours(g):
    return isinstance(g, dict) and any(
        is_ours(h.get("command")) for h in g.get("hooks", []) if isinstance(h, dict))

d = json.load(open(settings)) if os.path.exists(settings) else {}

bak = settings + ".wb-buddy-bak"
if os.path.exists(settings) and not os.path.exists(bak):
    shutil.copy2(settings, bak)   # pristine backup, once

hooks = d.get("hooks", {})
for ev in EVENTS:
    kept = [g for g in hooks.get(ev, []) if isinstance(g, dict) and not group_is_ours(g)]
    entry = {"hooks": [{"type": "command", "command": f"{HOOK} {ev}"}]}
    if ev in ("PreToolUse", "PostToolUse"):
        entry = {"matcher": ".*", **entry}
    kept.append(entry)
    hooks[ev] = kept
d["hooks"] = hooks

fd, tmp = tempfile.mkstemp(dir=os.path.dirname(settings), prefix=".settings.", suffix=".tmp")
try:
    with os.fdopen(fd, "w") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
        f.flush(); os.fsync(f.fileno())
    os.replace(tmp, settings)  # atomic
except Exception:
    if os.path.exists(tmp):
        os.remove(tmp)
    raise

print(f"registered wb-buddy hooks: {EVENTS}")
print(f"  settings : {settings}")
print(f"  backup   : {bak}  (pristine, kept)")
print(f"  hook     : {HOOK}")
print("Restart WorkBuddy for hooks to load.")
