# TraceFreeze：从干净源码目录运行

[English](tracefreeze-portable.md) · [契约和限制](tracefreeze.md)

这份源码预览包直接使用已有命令。Chromium 向内置的确定性图书馆 API 提交真实预约，冻结和回放会生成不同的回执 ID。无需模型密钥、Python、Docker、Android SDK 或设备。本模式 Android 未测，也不包含自主探索和自动修复。

## 安装

准备 Node.js 22+（包含 npm）。将源码 ZIP 解压到新目录，在解压后的项目根目录打开 PowerShell：

```powershell
npm ci --no-audit --no-fund
npx playwright install chromium --only-shell
```

Linux 请用 `npx playwright install chromium --only-shell --with-deps`，同时安装浏览器系统依赖。源码包不包含 npm 依赖和 Playwright 配套 Chromium，它们需要单独安装。全新电脑首次安装需要联网。如果当前电脑已经缓存锁定版本的 npm 包和配套 Chromium，可以改用 `npm ci --offline --no-audit --no-fund`，并跳过浏览器安装。复用缓存的干净目录验证不等于全新电脑离线安装验证。请在解压后的项目根目录操作。

## 冻结，再回放

终端 1 在解压后的根目录启动示例 API，并保持运行：

```powershell
node examples/library/backend.mjs
```

等待出现 `Library reservation example listening on http://127.0.0.1:8091/reserve`。终端 2 也进入同一个解压后的根目录：

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

两条命令都应以退出码 0 结束，报告显示 `passed`、`modelCalls: 0`、`android: not tested`。每个输出目录包含 `report.json`、`report.html`、`web.png`；成功冻结还会保存 `contract.json`。回放会重新提交预约并独立查询新 ID，不会复用保存的成功响应。用浏览器打开 `artifacts/replay/report.html` 查看结果。每次必须使用新的输出目录，重新运行时换目录名，保留已有证据。结束后在终端 1 按 Ctrl+C 停止 API。

## 让实际业务结果出错

保留成功冻结的契约不变。在终端 1 按 Ctrl+C 停止原 API。终端 2 把小型示例复制到新的临时目录，只修改副本返回的分馆：

```powershell
if (Test-Path artifacts/fault-library) { throw 'Use a new fault-library directory' }
Copy-Item examples/library artifacts/fault-library -Recurse
$backend = Get-Content artifacts/fault-library/backend.mjs -Raw
if (-not $backend.Contains("branchCode: 'branch-2'")) { throw 'Unexpected sample source' }
$backend.Replace("branchCode: 'branch-2'", "branchCode: 'branch-3'") | Set-Content artifacts/fault-library/backend.mjs -Encoding utf8
```

终端 1 在同一个端口启动副本：

```powershell
node artifacts/fault-library/backend.mjs
```

终端 2 用原始冻结契约回放：

```powershell
node workflow/tracefreeze.mjs replay --contract artifacts/freeze/contract.json --base-url http://127.0.0.1:8091 --output artifacts/wrong-business
if ($LASTEXITCODE -ne 1) { throw 'Expected the corrupted business result to fail with exit code 1' }
$bad = Get-Content artifacts/wrong-business/report.json -Raw | ConvertFrom-Json
if ($bad.status -ne 'failed') { throw 'Expected failed report' }
$bad.steps | Where-Object status -eq failed | Select-Object name, summary
```

预期 `API lookup and assertions` 失败，原因包含 `Lookup did not have the expected labels`；报告显示实际 `branch-3` 与预期 `branch-2`。副本 API 真的创建并保存了错误分馆的新预约，即使创建和查询结果一致，契约仍能发现错误。这不是修改预期值，也不是播放录制的失败响应。`artifacts/wrong-business` 保留 JSON、HTML 和截图。最后在终端 1 按 Ctrl+C 停止副本 API；原始 `examples/library` 和冻结契约未修改。

已有完整回归还覆盖查询结果损坏和禁止的网络目的地：

```powershell
$env:TRACEFREEZE_EVIDENCE_ROOT = 'artifacts/regression'
node --test tests/tracefreeze-browser.mjs
```

## 构建并核验源码 ZIP

维护者可直接从已提交版本制作本地预览包，无需新增打包程序。在干净 Git 工作目录执行；`git archive` 只包含已提交文件，因此先提交要交付的修改。输出目录必须是新的：

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

文件名用提交版本标识预览包，不创建正式发布或标签。保留锁文件和 `LICENSE`。已跟踪的源码中包含原有 Android 源码和 Gradle wrapper，但 TraceFreeze 命令不会编译或运行 Android。ZIP 不包含未跟踪文件、`.git`、依赖安装目录、报告、凭据和本地配置，因为这些内容没有纳入版本控制。打包前核对 Git 跟踪文件列表，不要把密钥或生成结果加入 Git。

收到预览包后，先用单独提供的 `SHA256SUMS.txt` 核对摘要，再解压（摘要能检测文件不一致，不能证明发布者身份）：

```powershell
$zip = Get-Item ./tracefreeze-source-*.zip
if (@($zip).Count -ne 1) { throw 'Select one source ZIP' }
$expected = ((Get-Content ./SHA256SUMS.txt -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash $zip.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'ZIP checksum mismatch' }
Expand-Archive -LiteralPath $zip.FullName -DestinationPath ./clean-extract
Set-Location ./clean-extract/tracefreeze
```

随后执行前面的安装和双终端命令。这是源码交付预览，不是注册表安装包、独立可执行程序或公开发布。
