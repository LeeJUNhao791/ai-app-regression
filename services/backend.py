import os
from http.server import ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

from service_http import (
    MODEL_SERVICE_TIMEOUT_SECONDS, UPSTREAM_ERRORS, JsonHandler, UpstreamStatusError,
    checked_result, post_json, serve,
)


WEB = Path(__file__).resolve().parents[1] / "web"
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
}


class BackendHandler(JsonHandler):
    def do_GET(self):
        path = self.path.partition("?")[0]
        if path == "/health":
            return self.write_json(200, {"status": "ok"})
        if path in ASSETS:
            name, content_type = ASSETS[path]
            try:
                body = (WEB / name).read_bytes()
            except FileNotFoundError:
                return self.write_json(404, {"error": "not_found"})
            return self.write_body(200, body, content_type)
        if path.startswith("/api/tickets/"):
            ticket = self.server.tickets.get(path.removeprefix("/api/tickets/"))
            if ticket is not None:
                return self.write_json(200, ticket)
        return self.write_json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/api/tickets":
            return self.write_json(404, {"error": "not_found"})
        text = self.read_text()
        if text is None:
            return
        try:
            result = checked_result(post_json(
                self.server.predict_url, {"text": text}, timeout=MODEL_SERVICE_TIMEOUT_SECONDS,
            ))
        except TimeoutError:
            return self.write_json(504, {"error": "upstream_timeout"})
        except UpstreamStatusError as error:
            if error.status == 504:
                return self.write_json(504, {"error": "upstream_timeout"})
            return self.write_json(502, {"error": "upstream_unavailable"})
        except UPSTREAM_ERRORS:
            return self.write_json(502, {"error": "upstream_unavailable"})

        ticket_id = str(uuid4())
        ticket = {"id": ticket_id, "text": text, "status": "completed", "result": result}
        self.server.tickets[ticket_id] = ticket
        self.write_json(201, ticket)


def create_server(host, port):
    server = ThreadingHTTPServer((host, port), BackendHandler)
    server.predict_url = os.environ.get("MODEL_URL", "http://127.0.0.1:8001").rstrip("/") + "/predict"
    server.tickets = {}
    return server


if __name__ == "__main__":
    serve(create_server, 8000)
