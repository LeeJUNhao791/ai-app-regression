# TraceFreeze v1: freeze and replay a reservation contract

[Install from a clean source ZIP and reproduce a failing business result](tracefreeze-portable.md) · [中文操作指南](tracefreeze-portable.zh-CN.md)

TraceFreeze executes one explicit library reservation Web -> API flow. You review the JSON contract yourself; freeze validates it with a real Chromium submission and independent API lookup, then saves the contract. Replay performs a new submission and binds its fresh receipt ID to the lookup. It never substitutes recorded successful responses.

Use Node.js 22+, the existing npm dependencies and installed Playwright Chromium. This mode needs no Python, Docker, model keys or model service. From the repository root, start the bundled business API in one terminal:

```sh
node examples/library/backend.mjs
```

In a second terminal:

```sh
node workflow/tracefreeze.mjs freeze --contract examples/library/tracefreeze.json --base-url http://127.0.0.1:8091 --output artifacts/freeze
node workflow/tracefreeze.mjs replay --contract artifacts/freeze/contract.json --base-url http://127.0.0.1:8091 --output artifacts/replay
```

Each output directory must be new. Both commands produce `report.json`, escaped `report.html`, and a real `web.png` screenshot when Chromium reaches the page. Only a successful freeze writes `contract.json`; a failed run exits with code 1 and retains its failing report. Existing directories are refused without overwriting their contents.

The version 1 contract contains exactly `version`, `page_path`, `web`, `backend`, `text`, and `expected`. The inline Web/API field maps use the existing external runner format. `expected` specifies the reservation status, branch (`device`) and space type (`category`). The created response must preserve `text`; its ID must equal the visible DOM ID and become the lookup path variable. The lookup must return the complete same mapped record with the explicit expected status and labels. The JSON report retains both bound IDs and the runner/browser request audit.

V1 is intentionally limited to `http://127.0.0.1:PORT`, `GET /reserve`, `POST /v1/reservations`, and `GET /v1/receipts/{id}`. Unknown fields, unsupported versions, external URLs, credentials, file references and alternate/traversal paths fail preflight before any browser or API request. Browser HTTP requests outside the exact page/create pair and all WebSockets are aborted and fail the run; service workers are blocked. Node lookup refuses redirects. IDs must be safe single path segments.

`modelCalls: 0` means this runner has no model-client or model-service call path and the allowed browser/API requests only exercise the bundled library business API. This is a real deterministic reservation API, not a mock model inference service. The audit and negative tests verify that attempted browser model HTTP/WebSocket requests never reach a server. It does not attest to the internals of an arbitrary service substituted on the same loopback port.

**Android not tested.** A passing status covers the declared Web/API contract only. Autonomous natural-language exploration, automatic repair, model exploration, Android and other destinations are deferred.

To verify the positive and injected-fault cases with an installed Chromium:

```sh
node --test tests/tracefreeze-browser.mjs
```

This checks fresh IDs, wrong expected labels, corrupted lookup, redirects, forbidden same-origin/external model HTTP and WebSocket requests, and malformed/unsafe contracts. CI runs it after Chromium setup and retains the resulting reports and request audit with its normal artifacts. No package is published by these commands.
