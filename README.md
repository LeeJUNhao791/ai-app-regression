# AI App Regression

Run one maintenance ticket through a real browser, a backend API, a Linux model
service, and an Android phone. One command produces an HTML report with the
ticket ID, labelled examples, and evidence from each check.

A browser submits `三号泵启动后异响`. The backend sends the text to the model
service and returns a completed ticket. The browser and Android app each
retrieve that ticket by ID. The labelled expectation is `pump-3 / noise`.

## Run the demo

Use Node.js 22+ and Python 3.10+. On Windows and macOS, start Docker with Linux
containers to run the model service. On Linux, the command starts the service
directly. Install the browser once:

```sh
npm ci
npx playwright install chromium
```

Then run from the repository root:

```sh
npm run check
```

Open the printed `artifacts/run-…/report.html`. Each run also saves
`report.json`, the Chromium screenshot, and available service and device logs.
Use `--output path/to/new-directory` to choose a fresh destination.

### Include an Android phone

Install JDK 17, Android SDK Platform 35, Build Tools 35.0.0, and Platform-Tools.
Set `JAVA_HOME` and `ANDROID_HOME`. Connect and unlock an Android 7.0+ phone,
enable USB debugging, and authorize the computer. Run:

```sh
node workflow/run.mjs --android required
```

The runner builds and installs both APKs, maps the backend's loopback port
over ADB, and checks the ticket fields on the app screen. It removes the
temporary APKs and port mapping after the check. Pass `--serial SERIAL` when
multiple devices are attached. With the default `--android auto`, a missing
device yields a partial result. Use `--android off` for a browser/API/model
run. A failed required check returns a nonzero exit code.

### Connect a real model

Set `LLM_BASE_URL` to an OpenAI-compatible API base ending in `/v1`, set
`LLM_MODEL`, and set `LLM_API_KEY` if the provider requires it. The provider's
Chat Completions endpoint must return a JSON object with `device` and
`category` in its message content. When using a model provider on the host
from Docker Desktop, use `host.docker.internal` in the provider URL.

```sh
node workflow/run.mjs --live --android required
```

The Linux model service forwards the synthetic ticket text to the configured
provider. To use an already-running Linux copy of this project's model service,
pass `--model-url URL` and select the matching mock or live mode.

## What the report verifies

- **Web and API.** Playwright submits the form in Chromium. The runner
  independently fetches the completed ticket and checks its ID, status, and data.
- **Android.** Instrumentation enters that ticket ID in the app and checks the
  displayed fields on a physical device.
- **Model.** Four original cases check exact field accuracy. Twelve variants
  exercise paraphrases, field order, missing information, and a deliberate
  typo. A robustness case passes when the original and variant both match
  the label. Mock scores exercise the test harness. Live scores apply to this
  small labelled sample.

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

## License

[MIT](LICENSE)
