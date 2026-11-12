import json
import os
import platform
import sys
import threading
import unittest
import uuid
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))


def request(port, path, body=None):
    connection = HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        if body is None:
            connection.request("GET", path)
        else:
            connection.request("POST", path, json.dumps(body), {"Content-Type": "application/json"})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


class ChatCompletionsFixture(BaseHTTPRequestHandler):
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.received = (self.path, payload, self.headers.get("Authorization"))
        envelope = {"choices": [{"message": {"content": self.server.reply}}]}
        self.send_response(self.server.status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(envelope).encode())

    def log_message(self, format, *args):
        pass


class ServiceTests(unittest.TestCase):
    def start_server(self, server):
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 3)
        self.addCleanup(server.shutdown)
        return server.server_port

    def start_demo(self, model_url=None, **environment):
        from backend import create_server as create_backend
        from model import create_server as create_model

        with patch.dict(os.environ, environment, clear=True):
            model = self.start_server(create_model("127.0.0.1", 0))
        with patch.dict(os.environ, {"MODEL_URL": model_url or f"http://127.0.0.1:{model}"}, clear=True):
            backend = self.start_server(create_backend("127.0.0.1", 0))
        return backend, model

    def test_submit_and_fetch_completed_ticket(self):
        backend, model = self.start_demo()
        self.assertEqual(request(backend, "/health"), (200, {"status": "ok"}))
        self.assertEqual(request(model, "/health"), (200, {"status": "ok", "mode": "mock", "os": platform.system()}))

        text = "三号泵启动后异响"
        status, ticket = request(backend, "/api/tickets", {"text": text})
        self.assertEqual(status, 201)
        self.assertEqual(uuid.UUID(ticket["id"]).version, 4)
        self.assertEqual(ticket, {
            "id": ticket["id"], "text": text, "status": "completed",
            "result": {"device": "pump-3", "category": "noise"},
        })
        self.assertEqual(request(backend, f"/api/tickets/{ticket['id']}"), (200, ticket))
        self.assertEqual(request(backend, f"/api/tickets/{uuid.uuid4()}")[0], 404)

    def test_rejects_invalid_and_oversized_text(self):
        backend, model = self.start_demo()
        for port, route in [(backend, "/api/tickets"), (model, "/predict")]:
            for payload, status in [({"text": " "}, 400), ({"text": 3}, 400), ({"text": "x" * 17000}, 413)]:
                with self.subTest(route=route, status=status):
                    self.assertEqual(request(port, route, payload)[0], status)

    def test_mock_handles_leak_heat_and_unknown(self):
        _, model = self.start_demo()
        for text, device, category in [
            ("2号泵出口漏水", "pump-2", "leak"),
            ("Pump #4 is overheating", "pump-4", "overheat"),
            ("暂无更多信息", None, "unknown"),
        ]:
            with self.subTest(text=text):
                self.assertEqual(request(model, "/predict", {"text": text}), (200, {"device": device, "category": category}))

    def test_fault_mode_changes_device_in_completed_ticket(self):
        backend, _ = self.start_demo(MOCK_FAULT="wrong-device")
        status, ticket = request(backend, "/api/tickets", {"text": "三号泵启动后异响"})
        self.assertEqual(status, 201)
        self.assertEqual(ticket["result"], {"device": "pump-2", "category": "noise"})

    def test_backend_reports_unavailable_model(self):
        backend, _ = self.start_demo(model_url="http://127.0.0.1:0")
        self.assertEqual(request(backend, "/api/tickets", {"text": "泵有异响"}), (502, {"error": "upstream_unavailable"}))

    def test_live_mode_uses_chat_completions_and_checks_response(self):
        fixture = ThreadingHTTPServer(("127.0.0.1", 0), ChatCompletionsFixture)
        fixture.status = 200
        fixture.reply = '{"device":"pump-8","category":"leak"}'
        upstream = self.start_server(fixture)
        backend, model = self.start_demo(
            MODEL_MODE="live", LLM_BASE_URL=f"http://127.0.0.1:{upstream}/v1", LLM_MODEL="fixture-model",
        )
        self.assertEqual(request(model, "/health")[1]["mode"], "live")
        text = "Pump 8 is leaking"
        status, ticket = request(backend, "/api/tickets", {"text": text})
        self.assertEqual(status, 201)
        self.assertEqual(ticket["result"], {"device": "pump-8", "category": "leak"})
        path, payload, auth = fixture.received
        self.assertEqual(path, "/v1/chat/completions")
        self.assertEqual(payload["model"], "fixture-model")
        self.assertEqual(payload["messages"][-1], {"role": "user", "content": text})
        self.assertIsNone(auth)

        for invalid_reply in [
            "diagnostic from provider",
            '{"device":"pump-8","category":"made-up"}',
            '{"device":"notapump-8","category":"leak"}',
            '{"device":8,"category":"leak"}',
            '{"device":"pump-8","category":"leak","diagnostic":"unexpected"}',
            "[" * 2000 + "]" * 2000,
        ]:
            fixture.reply = invalid_reply
            with self.subTest(invalid_reply=invalid_reply[:100]):
                self.assertEqual(request(model, "/predict", {"text": text}), (502, {"error": "upstream_unavailable"}))
        fixture.status = 504
        self.assertEqual(request(backend, "/api/tickets", {"text": text}), (504, {"error": "upstream_timeout"}))
