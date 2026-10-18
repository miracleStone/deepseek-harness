"""Log-only workspace grants retain the same raw SDK projection in both languages."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from deepseek_harness import DeepSeekHarness


EXPECTED = Path(__file__).parent / "expected" / "workspace-roots-projection.json"
TYPESCRIPT_EXPECTED = Path(__file__).resolve().parents[3] / "packages" / "sdk" / "client" / "tests" / "expected" / "workspace-roots-projection.json"


def test_workspace_root_records_retain_order_and_original_assistant_response(tmp_path: Path) -> None:
    assert EXPECTED.read_bytes() == TYPESCRIPT_EXPECTED.read_bytes()
    expected = json.loads(EXPECTED.read_text(encoding="utf-8"))
    events = [
        {"type": "sandbox/workspace-roots", "seq": 3, "time": 0,
         "data": {"additionalWorkspaceRoots": ["/projects/library", "/projects/tools"]}},
        {"type": "sandbox/workspace-roots", "seq": 4, "time": 0,
         "data": {"additionalWorkspaceRoots": []}},
    ]
    script = tmp_path / "workspace_roots_runtime.py"
    script.write_text(
        """
import json
import os
import sys


def notify(method, params):
    print(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}), flush=True)


for line in sys.stdin:
    message = json.loads(line)
    if message["method"] == "initialize":
        result = {"serverInfo": {"name": "workspace-roots-fixture"}}
    elif message["method"] == "session/prompt":
        session_id = message["params"]["sessionId"]
        notify("session.event", {"sessionId": session_id, "event": {
            "type": "agent/inbox/spliced", "seq": 0, "time": 0,
            "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "accepted"}]}}})
        notify("session.status", {"sessionId": session_id, "status": "running"})
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {"messageId": "accepted"}}), flush=True)
        notify("session.event", {"sessionId": session_id, "event": {
            "type": "turn/start", "seq": 1, "time": 0, "data": {"turn": 0}}})
        notify("session.event", {"sessionId": session_id, "event": {"type": "assistant/message", "seq": 2, "time": 0,
            "data": {"message": {"role": "assistant", "content": [{"type": "text", "text": os.environ["MAIN_RESPONSE"]}]}}}})
        for event in json.loads(os.environ["WORKSPACE_ROOTS_EVENTS"]):
            notify("session.event", {"sessionId": session_id, "event": event})
        notify("session.event", {"sessionId": session_id, "event": {"type": "turn/end", "seq": 5, "time": 0,
            "data": {"turn": 0, "reason": {"kind": "completed"}}}})
        notify("session.status", {"sessionId": session_id, "status": "idle"})
        continue
    elif message["method"] == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {}}), flush=True)
        break
    else:
        raise RuntimeError("Unexpected protocol method")
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
""".strip(), encoding="utf-8",
    )
    with DeepSeekHarness(
        _launch_args=(sys.executable, str(script)), cwd=str(tmp_path),
        env={"MAIN_RESPONSE": expected["finalResponse"], "WORKSPACE_ROOTS_EVENTS": json.dumps(events)},
    ) as harness:
        result = harness.run("Keep the assistant response.", session_id="sdk-workspace-roots")
    root_notifications = [notification for notification in result.notifications
                          if notification.method == "session.event"
                          and notification.payload["event"]["type"] == "sandbox/workspace-roots"]
    assert all(notification.payload["sessionId"] == result.session_id for notification in root_notifications)
    projection = {
        "finalResponse": result.final_response,
        "workspaceRootsEvents": [event for event in result.events if event["type"] == "sandbox/workspace-roots"],
        "workspaceRootsNotifications": [{"method": notification.method, "event": notification.payload["event"]}
                                        for notification in root_notifications],
        "eventOrder": [event["type"] for event in result.events],
        "assistantTexts": [block["text"] for event in result.events if event["type"] == "assistant/message"
                           for block in event["data"]["message"]["content"] if block["type"] == "text"],
    }
    assert projection == expected
    assert projection["workspaceRootsEvents"] == events
    for event in projection["workspaceRootsEvents"]:
        assert "surfaceOp" not in event
        assert "sourceEventSeqs" not in event
