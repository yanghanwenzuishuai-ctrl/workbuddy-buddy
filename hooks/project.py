"""Privacy-safe hook payload projector.

Reads a raw WorkBuddy hook payload and produces ONE structural line for the
event spool. It keeps only non-content fields; it NEVER emits prompt text,
tool_input, message bodies, titles, or transcript paths. The question flag is
derived from last_assistant_message and the text itself is discarded.

Importable (project / ends_with_question are unit-tested); runnable as the hook.
"""
import sys, json, time, os

def ends_with_question(msg):
    if not isinstance(msg, str):
        return None
    s = msg.rstrip()
    return s.endswith("?") or s.endswith("？")

def project(event, payload):
    """Raw payload -> structural-only dict. The whitelist is exhaustive: any
    field not listed here (prompt, tool_input, message, title, transcript_path…)
    is dropped and can never reach the spool."""
    d = payload if isinstance(payload, dict) else {}
    return {
        "event": event,
        "ts": int(time.time() * 1000),               # Unix epoch ms (matches daemon clock)
        "session_id": d.get("session_id"),
        "tool_name": d.get("tool_name"),             # structural (e.g. "Read"), not args
        "permission_mode": d.get("permission_mode"),
        "notification_type": d.get("notification_type"),
        "ends_with_question": ends_with_question(d.get("last_assistant_message"))
                              if event == "Stop" else None,
    }

def spool_path():
    return os.environ.get("WB_BUDDY_SPOOL") or os.path.expanduser("~/.workbuddy-buddy/events.spool")

MAX_BYTES = 512 * 1024
def _rotate(spool):
    """Bound growth: when the spool exceeds MAX_BYTES, keep one previous copy."""
    try:
        if os.path.exists(spool) and os.path.getsize(spool) > MAX_BYTES:
            os.replace(spool, spool + ".1")
    except OSError:
        pass

def main():
    event = sys.argv[1] if len(sys.argv) > 1 else "?"
    spool = spool_path()
    d_dir = os.path.dirname(spool) or "."
    os.makedirs(d_dir, exist_ok=True)
    try:
        os.chmod(d_dir, 0o700)
    except OSError:
        pass
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        payload = {}
    safe = project(event, payload)
    _rotate(spool)
    try:
        fd = os.open(spool, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a") as f:
            f.write(json.dumps(safe, ensure_ascii=False) + "\n")
    except Exception:
        pass  # never fail the hook

if __name__ == "__main__":
    main()
