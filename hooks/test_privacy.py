"""Privacy contract tests — the product's core guarantee that no conversation
content is ever persisted. Run: python3 hooks/test_privacy.py
"""
import json, os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import project

ALLOWED = {"event", "ts", "session_id", "tool_name",
           "permission_mode", "notification_type", "ends_with_question"}
FORBIDDEN = ["SECRET", "leak me", "/etc/passwd", "tool_input", "last_assistant_message", "prompt"]

def test_project_keeps_only_structural_fields():
    payload = {
        "session_id": "s1", "tool_name": "Read", "permission_mode": "default",
        "prompt": "SECRET leak me",
        "tool_input": {"file": "/etc/passwd", "content": "SECRET"},
        "last_assistant_message": "Here is the secret. Continue?",
        "title": "SECRET title", "transcript_path": "/x/secret.jsonl",
    }
    safe = project.project("PreToolUse", payload)
    assert set(safe.keys()) == ALLOWED, safe.keys()
    blob = json.dumps(safe, ensure_ascii=False)
    for bad in FORBIDDEN:
        assert bad not in blob, f"LEAK: {bad} in {blob}"
    assert safe["tool_name"] == "Read" and safe["session_id"] == "s1"

def test_ends_with_question():
    assert project.ends_with_question("Ready?\n") is True
    assert project.ends_with_question("继续吗？") is True        # fullwidth ？
    assert project.ends_with_question("All done.") is False
    assert project.ends_with_question(123) is None
    assert project.ends_with_question("") is False

def test_question_flag_only_on_stop():
    assert project.project("Stop", {"last_assistant_message": "ok?"})["ends_with_question"] is True
    assert project.project("PreToolUse", {"last_assistant_message": "ok?"})["ends_with_question"] is None

def test_end_to_end_subprocess_no_leak():
    with tempfile.TemporaryDirectory() as td:
        spool = os.path.join(td, "events.spool")
        env = dict(os.environ, WB_BUDDY_SPOOL=spool)
        payload = json.dumps({"session_id": "s", "prompt": "SECRET",
                              "tool_input": {"p": "/etc/passwd"}, "last_assistant_message": "hi?"})
        subprocess.run(["python3", os.path.join(HERE, "project.py"), "Stop"],
                       input=payload, text=True, env=env, check=True)
        data = open(spool).read()
        for bad in ["SECRET", "/etc/passwd", "prompt", "tool_input", "last_assistant_message"]:
            assert bad not in data, f"LEAK {bad}: {data}"
        line = json.loads(data.strip())
        assert line["event"] == "Stop" and line["ends_with_question"] is True
        # spool must be private
        assert oct(os.stat(spool).st_mode & 0o777) == "0o600", oct(os.stat(spool).st_mode & 0o777)

def test_malformed_stdin_is_safe():
    with tempfile.TemporaryDirectory() as td:
        spool = os.path.join(td, "events.spool")
        env = dict(os.environ, WB_BUDDY_SPOOL=spool)
        r = subprocess.run(["python3", os.path.join(HERE, "project.py"), "UserPromptSubmit"],
                           input="not json at all", text=True, env=env)
        assert r.returncode == 0, "hook must never fail"
        line = json.loads(open(spool).read().strip())
        assert line["session_id"] is None and line["event"] == "UserPromptSubmit"

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn(); print("ok  ", fn.__name__)
    print(f"\n{len(tests)} privacy/projection tests passed")
