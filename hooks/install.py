"""Register workbuddy-buddy hooks into ~/.workbuddy/settings.json.

Two hook sets:
  * status hooks  — wb-buddy-hook.sh on 7 lifecycle events (drives the pet's state)
  * approval hook — wb-buddy-approve.sh gates Bash via PreToolUse and any native
    permission prompt via PermissionRequest; the pet's bubble decides (fail-open)

Idempotent and non-destructive: backs up pristine settings once, removes only
OUR previous entries (incl. any W0 probe), preserves user hooks, writes
atomically. Requires a WorkBuddy restart to take effect.
"""
import json, os, shutil, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
STATUS = os.path.join(HERE, "wb-buddy-hook.sh")
APPROVE = os.path.join(HERE, "wb-buddy-approve.sh")
settings = os.path.expanduser("~/.workbuddy/settings.json")
STATUS_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
                 "PermissionRequest", "Notification", "Stop"]

def is_ours(cmd):
    return isinstance(cmd, str) and ("wb-buddy-hook.sh" in cmd or "wb-buddy-approve.sh" in cmd
                                     or ".workbuddy-buddy-w0" in cmd)

def group_is_ours(g):
    return isinstance(g, dict) and any(
        is_ours(h.get("command")) for h in g.get("hooks", []) if isinstance(h, dict))

d = json.load(open(settings)) if os.path.exists(settings) else {}
bak = settings + ".wb-buddy-bak"
if os.path.exists(settings) and not os.path.exists(bak):
    shutil.copy2(settings, bak)

hooks = d.get("hooks", {})

# strip all of our previous groups everywhere (also removes W0 probes)
for ev in list(hooks):
    hooks[ev] = [g for g in hooks.get(ev, []) if isinstance(g, dict) and not group_is_ours(g)]

# status hooks
for ev in STATUS_EVENTS:
    entry = {"hooks": [{"type": "command", "command": f"{STATUS} {ev}"}]}
    if ev in ("PreToolUse", "PostToolUse"):
        entry = {"matcher": ".*", **entry}
    hooks.setdefault(ev, []).append(entry)

# approval hooks (blocking; generous timeout > pet's 50s decision window)
hooks.setdefault("PreToolUse", []).append(
    {"matcher": "Bash", "hooks": [{"type": "command", "command": f"{APPROVE} PreToolUse", "timeout": 90}]})
hooks.setdefault("PermissionRequest", []).append(
    {"hooks": [{"type": "command", "command": f"{APPROVE} PermissionRequest", "timeout": 90}]})

d["hooks"] = hooks
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(settings), prefix=".settings.", suffix=".tmp")
try:
    with os.fdopen(fd, "w") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
        f.flush(); os.fsync(f.fileno())
    os.replace(tmp, settings)
except Exception:
    if os.path.exists(tmp):
        os.remove(tmp)
    raise

print("registered:")
print(f"  status  : {STATUS_EVENTS}")
print(f"  approval: PreToolUse[Bash] + PermissionRequest (fail-open, 50s bubble)")
print(f"  backup  : {bak}")
print("Restart WorkBuddy for hooks to load.")
