"""Approval hook: routes a gated tool call through the pet's bubble.

POSTs {tool_name, detail} to the pet's approval server and blocks until the
user clicks Allow/Deny (or 50s timeout). Translation:
  deny    -> print a deny decision (verified honored by WorkBuddy)
  allow   -> print an allow decision (bypasses the native dialog if honored)
  timeout / server down / any error -> print nothing, exit 0 (FAIL-OPEN:
             WorkBuddy behaves exactly as if the pet did not exist)

Privacy: the command summary is sent over loopback for display only and is
never persisted anywhere.
"""
import sys, json, os, urllib.request

def main():
    try:
        raw = sys.stdin.read()
        d = json.loads(raw) if raw.strip() else {}
        if not isinstance(d, dict):
            d = {}
    except Exception:
        d = {}

    tool = d.get("tool_name") or d.get("hook_event_name") or "?"
    ti = d.get("tool_input")
    detail = ""
    if isinstance(ti, dict):
        detail = str(ti.get("command") or ti.get("file_path") or ti.get("path") or "")[:160]

    port = os.environ.get("WB_BUDDY_APPROVAL_PORT", "8792")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/approve",
        data=json.dumps({"tool_name": tool, "detail": detail}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=55) as r:
            decision = r.read().decode().strip()
    except Exception:
        return  # fail-open

    marker = "decided via workbuddy-buddy pet"
    if decision == "deny":
        out = {"decision": "block", "reason": f"denied ({marker})",
               "hookSpecificOutput": {"hookEventName": d.get("hook_event_name", "PreToolUse"),
                                      "permissionDecision": "deny",
                                      "permissionDecisionReason": f"denied ({marker})",
                                      "decision": {"behavior": "deny", "message": f"denied ({marker})"}}}
        print(json.dumps(out))
    elif decision == "allow":
        out = {"decision": "approve", "reason": f"allowed ({marker})",
               "hookSpecificOutput": {"hookEventName": d.get("hook_event_name", "PreToolUse"),
                                      "permissionDecision": "allow",
                                      "permissionDecisionReason": f"allowed ({marker})",
                                      "decision": {"behavior": "allow"}}}
        print(json.dumps(out))
    # timeout / anything else: no output → native flow

if __name__ == "__main__":
    main()
