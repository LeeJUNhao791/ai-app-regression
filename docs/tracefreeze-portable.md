# TraceFreeze: run from a clean source directory

[简体中文](tracefreeze-portable.zh-CN.md) · [Contract and limits](tracefreeze.md)

This source-only preview uses the existing CLI. Chromium submits a real reservation to the bundled deterministic library API; freeze and replay create different receipt IDs. No model key, Python, Docker, Android SDK or device is needed. Android is not tested. There is no autonomous exploration or repair.

## Install

Use Node.js 22+ (including npm). Extract the source ZIP into a new directory, open PowerShell there, and run:

```powershell
npm ci --no-audit --no-fund
npx playwright install chromium --only-shell
```

Preview acceptance is Windows with a clean extraction and reused npm/Chromium caches. A fresh-machine installation and Linux preview setup have not been independently accepted.

On Linux, use `npx playwright install chromium --only-shell --with-deps` to install browser system dependencies too. Dependencies and a compatible Playwright Chromium are installed separately; they are not bundled in the source ZIP. A fresh machine needs network access for installation. If this computer already has the locked npm packages and compatible Chromium cached, use `npm ci --offline --no-audit --no-fund` and skip the browser installation. A clean extraction with reused caches is not a fresh-machine/offline installation test. Do not run these commands from an older checkout's `node_modules` directory.

## Freeze, then replay

From the extracted root, start the sample API in terminal 1 and leave it running:

```powershell
node examples/library/backend.mjs
```

Wait for `Library reservation example listening on http://127.0.0.1:8091/reserve`. Terminal 2 must also be in the extracted root:

```powershell
node workflow/tracefreeze.mjs freeze --contract examples/library/tracefreeze.json --base-url http://127.0.0.1:8091 --output artifacts/freeze
if ($LASTEXITCODE -ne 0) { throw 'Freeze failed; inspect artifacts/freeze/report.html' }
node workflow/tracefreeze.mjs replay --contract artifacts/freeze/contract.json --base-url http://127.0.0.1:8091 --output artifacts/replay
if ($LASTEXITCODE -ne 0) { throw 'Replay failed; inspect artifacts/replay/report.html' }
$freeze = Get-Content artifacts/freeze/report.json -Raw | ConvertFrom-Json
$replay = Get-Content artifacts/replay/report.json -Raw | ConvertFrom-Json
if ($freeze.ticketId -eq $replay.ticketId) { throw 'Expected a fresh receipt ID' }
$freeze, $replay | Select-Object status, ticketId, modelCalls, android
```

Both exit with code 0 and report `passed`, `modelCalls: 0`, and `android: not tested`. Each directory contains `report.json`, `report.html` and `web.png`; successful freeze also writes `contract.json`. Replay submits again and independently looks up its new receipt ID; it does not play back a saved response. Open `artifacts/replay/report.html` in a browser to inspect the result. Every output directory must be new: for another run, choose different names rather than overwriting evidence. Stop the API with Ctrl+C when finished.

## Make actual business results wrong

Keep the successful frozen contract unchanged. Stop terminal 1's API with Ctrl+C. In terminal 2, copy the small sample into a new temporary directory and change only that copy's branch result:

```powershell
if (Test-Path artifacts/fault-library) { throw 'Use a new fault-library directory' }
Copy-Item examples/library artifacts/fault-library -Recurse
$backend = Get-Content artifacts/fault-library/backend.mjs -Raw
if (-not $backend.Contains("branchCode: 'branch-2'")) { throw 'Unexpected sample source' }
$backend.Replace("branchCode: 'branch-2'", "branchCode: 'branch-3'") | Set-Content artifacts/fault-library/backend.mjs -Encoding utf8
```

In terminal 1, start the copied API on the same port:

```powershell
node artifacts/fault-library/backend.mjs
```

In terminal 2, replay the original frozen contract:

```powershell
node workflow/tracefreeze.mjs replay --contract artifacts/freeze/contract.json --base-url http://127.0.0.1:8091 --output artifacts/wrong-business
if ($LASTEXITCODE -ne 1) { throw 'Expected the corrupted business result to fail with exit code 1' }
$bad = Get-Content artifacts/wrong-business/report.json -Raw | ConvertFrom-Json
if ($bad.status -ne 'failed') { throw 'Expected failed report' }
$bad.steps | Where-Object status -eq failed | Select-Object name, summary
```

Expect `API lookup and assertions` to fail with `Lookup did not have the expected labels`; the report includes actual `branch-3` versus expected `branch-2`. The copied API really creates and stores the wrong branch in a new reservation, so creation and lookup can agree and the contract still catches the error. This is not an altered expectation or a recorded failure response. `artifacts/wrong-business` retains JSON, HTML and screenshot evidence. Stop the copied API with Ctrl+C. The original `examples/library` and frozen contract remain unchanged.

The broader existing regression suite also checks corrupted lookup responses and blocked destinations:

```powershell
$env:TRACEFREEZE_EVIDENCE_ROOT = 'artifacts/regression'
node --test tests/tracefreeze-browser.mjs
```

## Build and verify a source ZIP

Maintainers can create a local preview from a committed revision without adding a build wrapper. Run from a clean Git checkout; `git archive` includes committed files only, so commit intended changes first. Choose a new output directory:

```powershell
$revision = git rev-parse HEAD
$packageDir = Join-Path (Split-Path (Get-Location) -Parent) "tracefreeze-source-$($revision.Substring(0, 12))"
New-Item -ItemType Directory $packageDir -ErrorAction Stop | Out-Null
$zip = Join-Path $packageDir "tracefreeze-source-$($revision.Substring(0, 12)).zip"
git -c core.autocrlf=false archive --format=zip --prefix=tracefreeze/ --output=$zip $revision
if ($LASTEXITCODE -ne 0) { throw 'Source archive failed' }
"Source revision: $revision" | Set-Content (Join-Path $packageDir 'SOURCE.txt') -Encoding utf8
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $(Split-Path $zip -Leaf)" | Set-Content (Join-Path $packageDir 'SHA256SUMS.txt') -Encoding ascii
```

The revision in the filename identifies this preview without making a release or tag. Retain the lockfile and `LICENSE`. Tracked source includes the existing Android source and Gradle wrapper, but the TraceFreeze commands do not build or run Android. The ZIP excludes untracked files, `.git`, installed packages, reports, credentials and local configuration because these are not tracked. Review tracked filenames before packaging; do not add secrets or generated output to Git.

Before extracting a received preview, compare its hash with the separately provided `SHA256SUMS.txt` (a checksum detects a mismatch, not publisher identity):

```powershell
$zip = Get-Item ./tracefreeze-source-*.zip
if (@($zip).Count -ne 1) { throw 'Select one source ZIP' }
$expected = ((Get-Content ./SHA256SUMS.txt -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash $zip.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'ZIP checksum mismatch' }
Expand-Archive -LiteralPath $zip.FullName -DestinationPath ./clean-extract
Set-Location ./clean-extract/tracefreeze
```

Continue with installation and the two-terminal commands above. This preview is source delivery, not a registry package, executable bundle or public release.
