import json
import os
import platform
import re
from http.client import HTTPException, IncompleteRead
from http.server import ThreadingHTTPServer
from ssl import SSLCertVerificationError, SSLEOFError
from time import monotonic

from service_http import (
    PROVIDER_TIMEOUT_SECONDS, UPSTREAM_ERRORS, JsonHandler, PredictionSchemaError,
    UpstreamStatusError, checked_result, load_profile, post_json, serve,
)


PUMP = re.compile(
    r"\bpump\s*[-#]?\s*([1-9][0-9]*)\b"
    r"|(?<![0-9零〇一二两三四五六七八九十百千万])"
    r"([1-9][0-9]*|[一二两三四五六七八九]?十[一二三四五六七八九]?|[一二两三四五六七八九])\s*号泵",
    re.IGNORECASE,
)
CHINESE_DIGITS = str.maketrans("一二两三四五六七八九", "1223456789")
JSON_CODE_BLOCK = re.compile(r"(`{3,}|~{3,})(?:json)?[ \t]*\r?\n(.*?)\r?\n[ \t]*\1", re.IGNORECASE | re.DOTALL)
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


class PredictionResponseError(ValueError):
    pass


def live_prediction(
    text, endpoint, model, api_key, enable_thinking=None, json_mode=False,
    attempt_timeout=PROVIDER_TIMEOUT_SECONDS, *, profile=None,
):
    headers = {"Authorization": "Bearer " + api_key} if api_key else None
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": profile["system_prompt"] if profile else SYSTEM_PROMPT},
                     {"role": "user", "content": text}],
    }
    if enable_thinking is not None:
        payload["enable_thinking"] = enable_thinking
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    started = monotonic()
    try:
        try:
            response = post_json(endpoint, payload, timeout=attempt_timeout, headers=headers)
        except (OSError, HTTPException) as error:
            remaining = PROVIDER_TIMEOUT_SECONDS - (monotonic() - started)
            if isinstance(error, SSLCertVerificationError) or remaining <= 0:
                raise
            response = post_json(endpoint, payload, timeout=remaining, headers=headers)
    except (json.JSONDecodeError, UnicodeDecodeError, RecursionError) as error:
        raise PredictionResponseError("invalid_provider_response") from error
    try:
        content = response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise PredictionResponseError("invalid_provider_response") from exc
    if content is None or (isinstance(content, str) and not content.strip()):
        raise PredictionResponseError("empty_model_content")
    if not isinstance(content, str):
        raise PredictionResponseError("invalid_provider_response")
    block = JSON_CODE_BLOCK.fullmatch(content.strip())
    try:
        value = json.loads(block[2] if block else content)
    except (ValueError, RecursionError) as error:
        raise PredictionResponseError("invalid_model_json") from error
    return checked_result(value, profile)


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
                prediction = live_prediction(text, *self.server.live_config, profile=self.server.profile)
            else:
                prediction = mock_prediction(text, self.server.wrong_device)
        except TimeoutError:
            return self.write_json(504, {"error": "provider_timeout"})
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, IncompleteRead, SSLEOFError):
            return self.write_json(502, {"error": "provider_connection_closed"})
        except UpstreamStatusError as error:
            status = 504 if error.status == 504 else 502
            return self.write_json(status, {"error": "provider_http_error", "provider_status": error.status})
        except (PredictionResponseError, PredictionSchemaError) as error:
            return self.write_json(502, {"error": str(error)})
        except HTTPException:
            return self.write_json(502, {"error": "provider_protocol_error"})
        except OSError:
            return self.write_json(502, {"error": "provider_network_error"})
        except UPSTREAM_ERRORS:
            return self.write_json(502, {"error": "upstream_unavailable"})
        return self.write_json(200, prediction)


def optional_boolean(name):
    setting = os.environ.get(name, "").strip().lower()
    if setting not in ("", "true", "false"):
        raise ValueError(f"{name} must be true or false")
    return setting == "true" if setting else None


def create_server(host, port):
    mode = "live" if os.environ.get("MODEL_MODE") == "live" else "mock"
    profile = load_profile(os.environ.get("MODEL_PROFILE_JSON"))
    if profile and mode != "live":
        raise ValueError("MODEL_PROFILE_JSON requires MODEL_MODE=live.")
    live_config = None
    if mode == "live":
        base_url = os.environ.get("LLM_BASE_URL", "").rstrip("/")
        model = os.environ.get("LLM_MODEL", "")
        if not base_url or not model:
            raise ValueError("Live mode requires LLM_BASE_URL and LLM_MODEL")
        try:
            attempt_timeout = int(os.environ.get("LLM_ATTEMPT_TIMEOUT_SECONDS") or PROVIDER_TIMEOUT_SECONDS)
        except ValueError:
            attempt_timeout = 0
        if not 1 <= attempt_timeout <= PROVIDER_TIMEOUT_SECONDS:
            raise ValueError("LLM_ATTEMPT_TIMEOUT_SECONDS must be an integer from 1 to 30")
        live_config = (
            base_url + "/chat/completions", model, os.environ.get("LLM_API_KEY"),
            optional_boolean("LLM_ENABLE_THINKING"), optional_boolean("LLM_JSON_MODE"), attempt_timeout,
        )
    server = ThreadingHTTPServer((host, port), ModelHandler)
    server.mode = mode
    server.profile = profile
    server.live_config = live_config
    server.wrong_device = os.environ.get("MOCK_FAULT") == "wrong-device"
    return server


if __name__ == "__main__":
    serve(create_server, 8001)
