import json
import os
import platform
import sys
import threading
import unittest
import uuid
from http.client import HTTPConnection, RemoteDisconnected
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

    def test_live_model_uses_thirty_second_timeout(self):
        from model import live_prediction

        reply = {"choices": [{"message": {"content": '{"device":"pump-8","category":"leak"}'}}]}
        with patch("model.post_json", return_value=reply) as call:
            live_prediction("Pump 8 is leaking", "http://fixture.invalid/chat/completions", "fixture", None)
        self.assertEqual(call.call_args.kwargs["timeout"], 30)

    def test_live_model_retries_transport_failure_with_remaining_timeout(self):
        from model import live_prediction

        reply = {"choices": [{"message": {"content": '{"device":"pump-8","category":"leak"}'}}]}
        with patch("model.monotonic", side_effect=[100, 105]), patch(
            "model.post_json", side_effect=[RemoteDisconnected("private diagnostic"), reply],
        ) as call:
            result = live_prediction("Pump 8 is leaking", "http://fixture.invalid/chat/completions", "fixture", None)
        self.assertEqual(result, {"device": "pump-8", "category": "leak"})
        self.assertEqual([entry.kwargs["timeout"] for entry in call.call_args_list], [30, 25])

    def test_live_model_does_not_retry_an_exhausted_timeout(self):
        from model import live_prediction

        with patch("model.monotonic", side_effect=[100, 130]), patch(
            "model.post_json", side_effect=TimeoutError,
        ) as call:
            with self.assertRaises(TimeoutError):
                live_prediction("No details", "http://fixture.invalid/chat/completions", "fixture", None)
        call.assert_called_once()

    def test_live_model_can_retry_a_short_first_timeout_within_the_total_budget(self):
        from model import live_prediction

        reply = {"choices": [{"message": {"content": '{"device":null,"category":"unknown"}'}}]}
        with patch("model.monotonic", side_effect=[100, 115]), patch(
            "model.post_json", side_effect=[TimeoutError, reply],
        ) as call:
            result = live_prediction("No details", "http://fixture.invalid/chat/completions", "fixture", None,
                                     attempt_timeout=15)
        self.assertEqual(result, {"device": None, "category": "unknown"})
        self.assertEqual([entry.kwargs["timeout"] for entry in call.call_args_list], [15, 15])

    def test_live_mode_can_enable_nonthinking_json_output(self):
        fixture = ThreadingHTTPServer(("127.0.0.1", 0), ChatCompletionsFixture)
        fixture.status = 200
        fixture.reply = '{"device":null,"category":"unknown"}'
        upstream = self.start_server(fixture)
        _, model = self.start_demo(
            MODEL_MODE="live", LLM_BASE_URL=f"http://127.0.0.1:{upstream}/v1",
            LLM_MODEL="fixture-model", LLM_ENABLE_THINKING="false", LLM_JSON_MODE="true",
        )
        self.assertEqual(request(model, "/predict", {"text": "No details"})[0], 200)
        self.assertIs(fixture.received[1]["enable_thinking"], False)
        self.assertEqual(fixture.received[1]["response_format"], {"type": "json_object"})

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
        self.assertNotIn("enable_thinking", payload)
        self.assertNotIn("response_format", payload)
        self.assertIsNone(auth)

        for fenced_reply in [
            '```json\n{"device":"pump-8","category":"leak"}\n```',
            '  ```JSON\r\n{"device":"pump-8","category":"leak"}\r\n```  ',
            '```\n{"device":"pump-8","category":"leak"}\n```',
        ]:
            with self.subTest(fenced_reply=fenced_reply):
                fixture.reply = fenced_reply
                status, ticket = request(backend, "/api/tickets", {"text": text})
                self.assertEqual(status, 201)
                self.assertEqual(ticket["result"], {"device": "pump-8", "category": "leak"})

        for invalid_reply, reason in [
            ("diagnostic from provider", "invalid_model_json"),
            ("", "empty_model_content"),
            ('{"device":"pump-8","category":"made-up"}', "invalid_category"),
            ('{"device":"notapump-8","category":"leak"}', "invalid_device"),
            ('{"device":8,"category":"leak"}', "invalid_device"),
            ('{"device":"pump-8","category":"leak","diagnostic":"unexpected"}', "invalid_prediction_fields"),
            ('```json\n{"device":"pump-8","category":"made-up"}\n```', "invalid_category"),
            ('```json\n{"device":"pump-8","category":"leak","diagnostic":"unexpected"}\n```', "invalid_prediction_fields"),
            ('Provider note\n```json\n{"device":"pump-8","category":"leak"}\n```', "invalid_model_json"),
            ("[]", "invalid_prediction_fields"),
        ]:
            fixture.reply = invalid_reply
            with self.subTest(invalid_reply=invalid_reply[:100]):
                self.assertEqual(request(model, "/predict", {"text": text}), (502, {"error": reason}))
        # Python versions differ in how deeply nested JSON is decoded.
        fixture.reply = "[" * 2000 + "]" * 2000
        status, result = request(model, "/predict", {"text": text})
        self.assertEqual(status, 502)
        self.assertIn(result["error"], ("invalid_model_json", "invalid_prediction_fields"))
        fixture.status = 429
        self.assertEqual(request(model, "/predict", {"text": text}),
                         (502, {"error": "provider_http_error", "provider_status": 429}))
        with patch("model.post_json", side_effect=TimeoutError("private diagnostic")):
            self.assertEqual(request(model, "/predict", {"text": text}), (504, {"error": "provider_timeout"}))
        with patch("model.post_json", side_effect=RemoteDisconnected("private diagnostic")):
            self.assertEqual(request(model, "/predict", {"text": text}),
                             (502, {"error": "provider_connection_closed"}))
        fixture.status = 504
        self.assertEqual(request(backend, "/api/tickets", {"text": text}), (504, {"error": "upstream_timeout"}))
