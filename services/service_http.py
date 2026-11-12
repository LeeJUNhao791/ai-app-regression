import argparse
import json
import re
from contextlib import closing
from http.client import HTTPConnection, HTTPException, HTTPSConnection
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit


CATEGORIES = ("noise", "leak", "overheat", "unknown")
DEVICE_ID = re.compile(r"pump-[1-9][0-9]*")
MAX_BODY_BYTES = 16 * 1024
MAX_TEXT_LENGTH = 4000
PROVIDER_TIMEOUT_SECONDS = 30
MODEL_SERVICE_TIMEOUT_SECONDS = PROVIDER_TIMEOUT_SECONDS + 5
UPSTREAM_ERRORS = (HTTPException, OSError, ValueError, RecursionError)


class UpstreamStatusError(ValueError):
    def __init__(self, status):
        super().__init__("Upstream returned an error status")
        self.status = status


class PredictionSchemaError(ValueError):
    pass


def checked_result(value):
    if not isinstance(value, dict) or set(value) != {"device", "category"}:
        raise PredictionSchemaError("invalid_prediction_fields")
    device = value["device"]
    if device is not None and (not isinstance(device, str) or not DEVICE_ID.fullmatch(device)):
        raise PredictionSchemaError("invalid_device")
    if value["category"] not in CATEGORIES:
        raise PredictionSchemaError("invalid_category")
    return value


def post_json(url, payload, timeout, headers=None):
    endpoint = urlsplit(url)
    if (endpoint.scheme not in ("http", "https") or not endpoint.hostname
            or endpoint.username is not None or endpoint.query or endpoint.fragment):
        raise ValueError("Invalid upstream URL")
    connection = HTTPSConnection if endpoint.scheme == "https" else HTTPConnection
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    with closing(connection(endpoint.hostname, endpoint.port, timeout=timeout)) as client:
        client.request("POST", endpoint.path, body, {"Content-Type": "application/json", **(headers or {})})
        response = client.getresponse()
        if response.status != 200:
            raise UpstreamStatusError(response.status)
        body = response.read(64 * 1024 + 1)
    if len(body) > 64 * 1024:
        raise ValueError("Upstream response too large")
    return json.loads(body)


class JsonHandler(BaseHTTPRequestHandler):
    timeout = 5

    def log_message(self, format, *args):
        pass

    def write_body(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def write_json(self, status, value):
        self.write_body(status, json.dumps(value).encode("utf-8"), "application/json; charset=utf-8")

    def read_text(self):
        if self.headers.get_content_type() != "application/json":
            self.write_json(415, {"error": "json_required"})
            return None
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > MAX_BODY_BYTES:
                self.write_json(413, {"error": "body_too_large"})
                return None
            if length <= 0:
                raise ValueError
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            text = payload.get("text") if isinstance(payload, dict) else None
            if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_LENGTH:
                raise ValueError
            text.encode("utf-8")
            return text
        except TimeoutError:
            self.write_json(408, {"error": "request_timeout"})
        except (ValueError, RecursionError):
            self.write_json(400, {"error": "invalid_text"})
        return None


def serve(create_server, default_port):
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=default_port, type=int)
    args = parser.parse_args()
    try:
        server = create_server(args.host, args.port)
    except ValueError as exc:
        parser.error(str(exc))
    with server:
        print(f"Listening on {args.host}:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
