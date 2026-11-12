# AI App Regression

[简体中文](README.zh-CN.md)

Run one maintenance ticket through a real browser, a backend API, a Linux model
service, and an Android phone. One command produces an HTML report with the
ticket ID, labelled examples, and evidence from each check.

[Quick start](#quick-start) · [Step-by-step guide](docs/getting-started.md)

![Four-layer work-order flow. Chromium submits and looks up the work order through the backend API, which calls the Linux model service. Android looks up the same work order by ID.](docs/assets/work-order-flow.svg)

The demo submits `三号泵启动后异响` (Pump 3 makes an abnormal noise). Web, an
independent API lookup, and the Android app verify the same completed work order
by ID. The expected result is `pump-3 / noise`.

## Quick start

Use Node.js 22+ and Python 3.10+. On Windows and macOS, start Docker with Linux
containers to run the model service. On Linux, the command starts the service
directly. From the repository root, run the demo with fixed model responses.

```sh
npm ci
npx playwright install chromium
node workflow/run.mjs --android off
```

Open the printed `artifacts/run-…/report.html`. Expect the Web, API, and Linux
model checks to pass, with Android marked **skipped** and the workflow marked
**partial**. To add a phone or a real model, follow the [step-by-step guide](docs/getting-started.md).

## Example report

![Screenshot of a live v0.1.1 HTML report. Web, the backend API, and the physical Android device verified the same completed work order. Model accuracy was 4/4 and robustness was 11/12.](docs/assets/live-report.png)

In this run, Chromium, the API, and a Pixel 4 XL matched the ticket ID and
`pump-3 / noise / completed`. The overall report shows **failed** because one
robustness sample timed out against `qwen3.6-flash`.

## What the report verifies

- **Web and API.** Playwright submits the form in Chromium. The runner
  independently fetches the completed ticket and checks its ID, status, and data.
- **Android.** Instrumentation enters that ticket ID in the app and checks the
  displayed fields on a physical device.
- **Model.** Four original cases check exact field accuracy. Twelve variants
  exercise paraphrases, field order, missing information, and a deliberate
  typo. A robustness case passes when the original and variant both match
  the label. Each row records elapsed milliseconds and, on failure, a
  reason such as a provider timeout, invalid JSON, or a label mismatch.
  Mock scores exercise the test harness. Live scores apply to this small
  labelled sample.

To see a failure report, inject a wrong device ID:

```sh
node workflow/run.mjs --fault wrong-device --android off
```

The Web and API steps can agree on the wrong label. The model check still fails
and shows the expected and observed values.

## Development checks

```sh
npm test
python -B -m unittest discover -s tests -p 'test_*.py' -v
```

[GitHub Actions](https://github.com/LeeJUNhao791/ai-app-regression/actions) runs the positive and negative workflow in
Chromium with the Linux model service. It also compiles the Android app and
instrumentation APKs. Use a connected phone for the device run.

The v0.1 device run passed on a Pixel 4 XL with Android 11 (API 30), using
Chromium, the Python backend, and the mock model service in a Linux container.
All 4 original cases and 12 robustness variants passed in mock mode.

The v0.1.1 live run used `qwen3.6-flash` in a Linux container and a Pixel 4 XL
running Android 11 (API 30, `arm64-v8a`). Chromium created work order
`e96fb437-30da-430f-a239-deb49891ddb6`. The independent API lookup and Android
instrumentation matched the same ID and fields (`pump-3`, `noise`, `completed`).

The live suite passed 4/4 original cases and 11/12 robustness variants.
`pump-noise.2` timed out after 30.03 seconds during the full run. An isolated
retest with the same model configuration returned the expected `pump-3 / noise`
in 2.88 seconds.

## License

[MIT](LICENSE)
