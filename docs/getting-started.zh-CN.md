# 上手教程

[English](getting-started.md)

先用固定模型响应跑通维修工单演示，再接入 Android 真机，最后换成真实模型重复同一组检查。

## 1. 用固定模型响应运行

安装 Git、Node.js 22+ 和 Python 3.10+。在 Windows 或 macOS 上，启动 Docker Desktop 并使用 Linux 容器模式。`docker info --format '{{.OSType}}'` 应输出 `linux`。在 Linux 上，测试脚本会直接用 Python 启动模型服务。

```sh
git clone https://github.com/LeeJUNhao791/ai-app-regression.git
cd ai-app-regression
npm ci
npx playwright install chromium
node workflow/run.mjs --android off
```

打开终端输出路径中的 `report.html`。Web 前端、后端 API 和 Linux 模型服务应通过检查，报告应显示准确性 **4/4**、鲁棒性 **12/12**。**Android device** 标记为 **skipped**（跳过），整次运行标记为 **partial**（部分完成）。这一步无需 API Key。

## 2. 接入 Android 真机

1. 安装 JDK 17、Android SDK Platform 35、Build Tools 35.0.0 和 Platform-Tools。将 `JAVA_HOME` 指向 JDK 目录，将 `ANDROID_HOME` 指向 SDK 目录，并把 SDK 下的 `platform-tools` 目录加入 `PATH`。
2. 用 USB 数据线连接一台 Android 7.0+ 手机。解锁手机，打开 USB 调试，并在弹窗中授权当前电脑。运行 `adb devices`，确认手机状态为 `device`。
3. 保持手机解锁，在项目根目录运行以下命令。

```sh
node workflow/run.mjs --android required
```

**Android device** 和整次运行都应通过。仪器化测试在手机上查询由 Web 创建的工单，并与独立 API 查询结果核对工单 ID、设备（`pump-3`）、类别（`noise`）和状态（`completed`）。可以在报告中打开 `web.png` 和 `android-instrumentation.log` 查看证据。

测试脚本会构建并临时安装演示和测试 APK，通过 ADB 映射本地端口，并在检查结束后移除 APK 和端口映射。请使用尚未安装这两个应用包的手机。如果连接了多台设备，请加上 `--serial SERIAL`，并使用 `adb devices` 中对应手机的序列号。

## 3. 换成真实模型复测

在运行测试的终端中设置环境变量，把示例地址和模型 ID 换成服务商提供的值。如果接口路径为 `/v1/chat/completions`，基础地址应以 `/v1` 结尾。服务商要求鉴权时再输入 API Key。

**PowerShell**

```powershell
$env:LLM_BASE_URL = 'https://api.example.com/v1'
$env:LLM_MODEL = 'your-model-id'
$env:LLM_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'API key' -AsSecureString)).Password
node workflow/run.mjs --live --android required
```

**Bash**

```bash
export LLM_BASE_URL='https://api.example.com/v1'
export LLM_MODEL='your-model-id'
read -rs -p 'API key: ' LLM_API_KEY
echo
export LLM_API_KEY
node workflow/run.mjs --live --android required
```

使用 Linux 模型服务能访问的地址。如果服务商接口运行在 Docker Desktop 的宿主机上，请在 URL 中使用 `host.docker.internal`。如果本项目的模型服务已经运行在 Linux 上，请在该实例中设置真实模型模式和服务商凭据，再给测试命令加上 `--model-url URL`。

模型服务会将构造的工单文本发给配置好的服务商。Chat Completions 的消息内容应返回包含 `device` 和 `category` 的 JSON 对象，也支持用一层 Markdown 代码块包裹 JSON。如果模型支持相关选项，可以设置 `LLM_ENABLE_THINKING=false` 关闭思考模式，设置 `LLM_JSON_MODE=true` 请求 JSON 输出。

在新报告中确认 **Model mode** 为 **live**，再核对 Web、后端 API 和 Android 是否查到同一张已完成的工单。查看 16 条标注样例的预期字段、实际字段、耗时和失败原因。工单核对通过时，模型评测仍可能有失败样例。

## 根据报告排障

| 现象 | 检查方法 |
| --- | --- |
| Linux 模型服务未启动 | 查看 `model.log`。在 Windows 或 macOS 上，确认 Docker 正在运行 Linux 容器。 |
| Chromium 未启动 | 在项目根目录运行 `npx playwright install chromium`。 |
| ADB 显示手机为 `unauthorized` | 解锁手机并接受 USB 调试授权，再运行 `adb devices`。 |
| Android 构建或安装失败 | 打开 `android-build.log` 或 `android-adb.log`。检查 JDK 17、SDK Platform 35，以及手机上是否有安装确认提示。 |
| 模型服务商拒绝请求 | 核对 API 基础地址、模型 ID、API Key 和可选模型配置。 |
| 模型请求超时 | 查看失败样例及耗时。每次模型调用的总预算为 30 秒。可用 `LLM_ATTEMPT_TIMEOUT_SECONDS` 缩短首次尝试的时限，为预算内的一次重试留出时间。 |
| JSON 无效或字段与标注不符 | 对照预期字段、实际字段和失败原因，确认所选模型可以返回要求的 JSON 字段。 |

每次运行会保存 `report.html`、`report.json` 及可用的截图和日志。可用 `--output path/to/new-directory` 指定新的输出目录。检查失败时，命令会以非零状态退出，同时写出报告。

[返回中文 README](../README.zh-CN.md)
