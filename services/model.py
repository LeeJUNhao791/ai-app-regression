import json
import os
import platform
import re
from http.server import ThreadingHTTPServer

from service_http import UPSTREAM_ERRORS, JsonHandler, checked_result, post_json, serve


PUMP = re.compile(
    r"\bpump\s*[-#]?\s*([1-9][0-9]*)\b"
    r"|(?<![0-9零〇一二两三四五六七八九十百千万])"
    r"([1-9][0-9]*|[一二两三四五六七八九]?十[一二三四五六七八九]?|[一二两三四五六七八九])\s*号泵",
    re.IGNORECASE,
)
CHINESE_DIGITS = str.maketrans("一二两三四五六七八九", "1223456789")
KEYWORDS = {
    "noise": ("异响", "异想", "噪音", "噪声", "noise", "noisy", "rattle", "rattling"),
    "leak": ("漏水", "漏油", "渗漏", "泄漏", "leak"),
    "overheat": ("过热", "温度过高", "overheat", "high temperature"),
}
SYSTEM_PROMPT = (
    "Extract one device ID and issue category from the synthetic maintenance ticket. "
    'Respond with exactly one JSON object with the fields "device" and "category". '
    'Use a lowercase ID such as "pump-3" for a numbered pump or null for no identifiable device. '
    'Use exactly one category from "noise", "leak", "overheat", and "unknown". '
    "Recognize both English and Chinese ticket descriptions."
)


def mock_prediction(text, wrong_device):
    device = None
    match = PUMP.search(text)
    if match:
        number = (match[1] or match[2]).translate(CHINESE_DIGITS)
        if "十" in number:
            tens, _, units = number.partition("十")
            number = (tens or "1") + (units or "0")
        device = "pump-" + number
        if wrong_device and device == "pump-3":
            device = "pump-2"
    lowered = text.lower()
    category = next((label for label, words in KEYWORDS.items() if any(word in lowered for word in words)), "unknown")
    return {"device": device, "category": category}


def live_prediction(text, endpoint, model, api_key):
    headers = {"Authorization": "Bearer " + api_key} if api_key else None
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": text}],
    }
    response = post_json(endpoint, payload, timeout=10, headers=headers)
    try:
        content = response["choices"][0]["message"]["content"]
        if not isinstance(content, str):
            raise ValueError("Invalid model message")
        return checked_result(json.loads(content))
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("Invalid chat completions response") from exc


class ModelHandler(JsonHandler):
    def do_GET(self):
        if self.path == "/health":
            return self.write_json(200, {"status": "ok", "mode": self.server.mode, "os": platform.system()})
        return self.write_json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/predict":
            return self.write_json(404, {"error": "not_found"})
        text = self.read_text()
        if text is None:
            return
        try:
            if self.server.mode == "live":
                prediction = live_prediction(text, *self.server.live_config)
            else:
                prediction = mock_prediction(text, self.server.wrong_device)
        except TimeoutError:
            return self.write_json(504, {"error": "upstream_timeout"})
        except UPSTREAM_ERRORS:
            return self.write_json(502, {"error": "upstream_unavailable"})
        return self.write_json(200, prediction)


def create_server(host, port):
    mode = "live" if os.environ.get("MODEL_MODE") == "live" else "mock"
    live_config = None
    if mode == "live":
        base_url = os.environ.get("LLM_BASE_URL", "").rstrip("/")
        model = os.environ.get("LLM_MODEL", "")
        if not base_url or not model:
            raise ValueError("Live mode requires LLM_BASE_URL and LLM_MODEL")
        live_config = (base_url + "/chat/completions", model, os.environ.get("LLM_API_KEY"))
    server = ThreadingHTTPServer((host, port), ModelHandler)
    server.mode = mode
    server.live_config = live_config
    server.wrong_device = os.environ.get("MOCK_FAULT") == "wrong-device"
    return server


if __name__ == "__main__":
    serve(create_server, 8001)
