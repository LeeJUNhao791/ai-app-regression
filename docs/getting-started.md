# Getting started

[简体中文](getting-started.zh-CN.md)

Run the maintenance work-order demo with fixed model responses. Then choose
whether to add an Android phone, a live model, or both.

## 1. Run with fixed model responses

Install Git, Node.js 22+, and Python 3.10+. On Windows or macOS, start Docker
Desktop in Linux container mode. `docker info --format '{{.OSType}}'` should print
`linux`. On Linux, the runner starts the model service with Python directly.

```sh
git clone https://github.com/LeeJUNhao791/ai-app-regression.git
cd ai-app-regression
npm ci
npx playwright install chromium --only-shell
node workflow/run.mjs --android off
```

On Linux, replace the browser installation step with
`npx playwright install chromium --only-shell --with-deps` to install system
dependencies too.

Expect **Basic demo passed. Android skipped by request (--android off).** in
the terminal and at the top of the printed `report.html`. The Web frontend,
backend API, and Linux model service pass, with **4/4** accuracy cases and
**12/12** robustness variants. The **partial** badge indicates that Android was
excluded from this run. This run requires no API key.

## Use your own samples

Run the [editable template](../fixtures/custom-tickets.example.json). It includes
two original cases and one robustness variant.

```sh
node workflow/run.mjs --fixtures fixtures/custom-tickets.example.json --android off
```

Copy it to your own UTF-8 JSON file and point `--fixtures` to that file. Relative
paths start from your current directory. The flag works with any run mode
below. The default file is `fixtures/tickets.json`.

- Use a non-empty array of objects. Give each sample a unique, non-empty `id`
  and non-empty `text`.
- Set `expected.device` to a pump ID such as `pump-1` or to `null`. Set
  `expected.category` to `noise`, `leak`, `overheat`, or `unknown`.
- Omit `variants` or provide an array of non-empty text strings. Each variant
  uses the original sample's expected result.

The first original sample becomes the work order used by the end-to-end
checks. The model evaluation runs every original and variant. In mock mode,
the built-in rules produce the predictions. The report compares those
predictions with your expected results and shows a duration and verdict per row.
If validation fails, the terminal names the file and, for a field error, the
sample and field. The runner exits before starting services.

## Model-only evaluation

Use Node.js 22+. To start the model service locally, use Python 3.10+ on Linux
or Docker Desktop in Linux container mode on Windows and macOS.
The command only runs the Linux model service and the labelled evaluation.

```sh
node workflow/run.mjs --model-only --fixtures fixtures/custom-tickets.example.json
```

For a real model, set the variables in [Live model only](#live-model-only) and
add `--live`. Use `--model-url URL` to connect to an existing instance of the
project's Linux model service. The HTML and JSON reports show the expected and
observed labels, duration, and verdict for each row. CI gets exit 0 when all
cases pass and exit 1 when evaluation or service startup fails.

## Domain profile

Copy the [fan profile](../fixtures/fan.profile.json) and its
[labelled cases](../fixtures/fan-tickets.example.json). Configure a provider as
described in [Live model only](#live-model-only), then run:

```sh
node workflow/run.mjs --model-only --live --profile fixtures/fan.profile.json --fixtures fixtures/fan-tickets.example.json
```

- `system_prompt` is the system message sent to the provider. The prediction
  still uses the JSON fields `device` and `category`.
- `device_id_pattern` must match the whole device ID. Use regular expression
  syntax common to JavaScript and Python, such as `fan-[1-9][0-9]*`.
  IDs and category labels use ASCII letters, digits, underscores, and hyphens.
  A missing device can be represented by `null`.
- `categories` lists the allowed labels. Predictions outside this list fail
  evaluation, as do predictions with an invalid device ID.

The profile works with live model-only and end-to-end runs. For a separate
`--model-url` service, configure that process with the same JSON in
`MODEL_PROFILE_JSON`. The built-in fixed-response demo uses the default pump
profile.

## Choose a run mode

To test a separate work-order API, follow [External backend](#external-backend).

| Mode | Use it to check |
| --- | --- |
| [Android only](#android-only) | Verify the same work order on a physical phone with fixed model responses. |
| [Live model only](#live-model-only) | Evaluate a real model through Web and API with Android skipped. |
| [Android and live model](#android-and-live-model) | Verify the same live-model work order across all four layers. |

### Android only

1. Install JDK 17, Android SDK Platform 35, Build Tools 35.0.0, and
   Platform-Tools. Set `JAVA_HOME` to the JDK folder and `ANDROID_HOME` to the
   SDK folder. Add the SDK's `platform-tools` folder to your `PATH`.
2. Connect an Android 7.0+ phone with a USB data cable. Unlock it, enable USB
   debugging, and accept the prompt to authorize your computer. Run
   `adb devices` and confirm the phone has status `device`.
3. Keep the phone unlocked and run the demo with fixed model responses from the
   repository root. This mode requires no API key.

```sh
node workflow/run.mjs --android required
```

Expect **Android device** and the overall workflow to pass. The instrumentation
looks up the Web-created ticket on the phone and checks its ID, device
(`pump-3`), category (`noise`), and status (`completed`) against the independent
API result. Open `web.png` and `android-instrumentation.log` from the report to
review the evidence.

The runner builds and installs temporary demo and test APKs and forwards a
local port over ADB. It removes the APKs and port mapping after the check.
Use a phone without the demo and test packages already installed. If several
devices are attached, add `--serial SERIAL` using the phone's serial from
`adb devices`.

### Live model only

Set the environment variables in the terminal you will run the workflow from.
Replace the example URL and model ID with the provider's values. The API base
should end in `/v1` for an endpoint at `/v1/chat/completions`. Enter the API key
only if the provider requires authentication. When the runner starts the model
service, it names any missing `LLM_BASE_URL` or `LLM_MODEL` in the terminal.

**PowerShell**

```powershell
$env:LLM_BASE_URL = 'https://api.example.com/v1'
$env:LLM_MODEL = 'your-model-id'
$env:LLM_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'API key' -AsSecureString)).Password
```

**Bash**

```bash
export LLM_BASE_URL='https://api.example.com/v1'
export LLM_MODEL='your-model-id'
read -rs -p 'API key: ' LLM_API_KEY
echo
export LLM_API_KEY
```

Run with Android disabled.

```sh
node workflow/run.mjs --live --android off
```

Use the provider's network address as seen from the Linux model service. For a
provider running on the Docker Desktop host, use `host.docker.internal` in the
URL. If you already have a Linux instance of this project's model service,
configure live mode and provider credentials on that instance and add
`--model-url URL` to the workflow command.

The model service sends synthetic work-order text to the configured provider.
It expects a JSON object with `device` and `category` in the Chat Completions
message content. A single Markdown code block around the JSON is supported.
If the model supports these options, set `LLM_ENABLE_THINKING=false` for
non-thinking mode and `LLM_JSON_MODE=true` to request JSON output.

In the report, confirm **Model mode** is **live** and Web and Backend API match
the completed work order. Review all 16 labelled rows for expected fields,
observed fields, elapsed time, and failure reasons. A passing work-order check
can appear alongside a failed model evaluation. When all selected checks pass,
the overall status is **partial** because Android was skipped by request.

### Android and live model

Follow the phone setup in [Android only](#android-only) and set the provider
variables from [Live model only](#live-model-only). Then run the combined check.

```sh
node workflow/run.mjs --live --android required
```

The runner checks ADB authorization before it starts the model service or sends
any model requests. If authorization fails, unlock the phone, accept the USB
debugging prompt, and rerun the command. In the report, compare the work-order
ID and fields across Web, Backend API, and Android, then review the model scores.

## External backend

Use Node.js 22+. Start the alternate example API in one terminal.

```sh
node examples/alternate-backend.mjs
```

Run the API check in another terminal from the repository root.

```sh
node workflow/run.mjs --backend-url http://127.0.0.1:8090 --backend-map fixtures/alternate-backend.map.json --fixtures fixtures/custom-tickets.example.json
```

Copy the [mapping template](../fixtures/alternate-backend.map.json) for your
test API. Each run creates one work order from the first original fixture.

- `create_path` is the POST path. `request_text_field` is the top-level JSON
  key for the submitted work-order text. The example uses `/v2/orders` and
  `description`.
- `lookup_path` is the GET path with one `{id}` placeholder. The runner uses
  the URL-encoded ID returned by creation. Both paths are appended to the base URL.
- `response` maps `id`, `text`, `status`, `device`, and `category` to JSON field
  paths such as `order.reference`. Use the same response shape for both routes.
  IDs can be non-empty strings or safe integers. Set `completed_status` to
  the status returned by both routes, such as `resolved`.

The check expects synchronous JSON responses. POST accepts HTTP 200 or 201,
and GET expects HTTP 200. The report shows the ticket ID and checks that both
responses map to the same ID, text, state, and classification. The labels must
match the fixture. Use `--profile` if the API uses another device or category
scheme. The external API controls its own prompt and model. This run executes
only the external API checks.

## External Web

Install the browser using the commands in [the basic demo](#1-run-with-fixed-model-responses),
then start the [alternate backend](#external-backend). Its form is served at
`/service-desk`.

```sh
node workflow/run.mjs --backend-url http://127.0.0.1:8090 --backend-map fixtures/alternate-backend.map.json --web-url http://127.0.0.1:8090/service-desk --web-map fixtures/alternate-web.map.json --fixtures fixtures/custom-tickets.example.json
```

Copy the [Web map](../fixtures/alternate-web.map.json). Set the CSS selectors
`input_selector`, `submit_selector`, and `ticket_id_selector` to the work-order
input, submit control, and element that displays the ID. The ID element should
contain the ID as its visible text. If the page and API use different origins,
the API must permit the page's browser request.

The browser submits the fixture text as JSON through the form's own POST. The
runner checks the request against the mapped create endpoint and text field,
then matches the displayed ID to the mapped response. It uses that ID for the
independent API lookup and checks the mapped fields and expected classification.
The report includes the work-order ID and a Web screenshot.

## Troubleshoot from the report

| What you see | What to check |
| --- | --- |
| Linux model service did not start | Check `model.log`. On Windows or macOS, verify Docker is running Linux containers. |
| Chromium could not start | Run `npx playwright install chromium --only-shell` from the repository root. On Linux, add `--with-deps` to install system dependencies. |
| ADB lists the phone as `unauthorized` | Unlock the phone and accept the USB debugging prompt, then run `adb devices` again. |
| Android build or install failed | Open `android-build.log` or `android-adb.log`. Check JDK 17, SDK Platform 35, and any installation prompt on the phone. |
| Missing required live model settings | Set the variables named in the terminal. `LLM_API_KEY` is required only if the provider requires authentication. |
| Provider rejected the request | Check the API base, model ID, key, and any optional model settings. |
| Model request timed out | Check the failed row and its duration. Each provider call has a 30-second total budget. A shorter first-attempt limit via `LLM_ATTEMPT_TIMEOUT_SECONDS` leaves time for one retry within that budget. |
| Invalid JSON or wrong labels | Compare the expected and observed fields and read the row's failure reason. Check that the selected model can return the required JSON fields. |

Each run saves `report.html`, `report.json`, and available screenshots and logs.
Use `--output path/to/new-directory` to choose a fresh destination. A failed
check produces a nonzero exit code and still writes the report.

### Model timeout example

This live v0.1.1 run matched the same completed work order in Chromium, the API,
and a Pixel 4 XL. The workflow shows **failed** because `pump-noise.2` timed out
against `qwen3.6-flash`. The failed row shows the duration and failure reason.

![Live model report with 4/4 accuracy, 11/12 robustness, a passing Android check, and a timeout recorded for pump-noise.2.](assets/live-report.png)

[Back to the project README](../README.md)
