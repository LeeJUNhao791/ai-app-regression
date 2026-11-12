import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const androidDir = fileURLToPath(new URL('../android/', import.meta.url));
const appId = 'io.github.leejunhao791.aiappregression';
const testId = `${appId}.test`;
const apk = 'app/build/outputs/apk';
const windows = process.platform === 'win32';

function run(program, args, { timeout = 15_000, ...options } = {}) {
  return new Promise((resolve) => {
    execFile(program, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

function unavailable(required, summary) {
  if (required) throw new Error(summary);
  return { status: 'skipped', summary };
}

export async function findAndroidDevice({ serial, required }) {
  const windowsSdk = windows && process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk');
  const sdk = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, windowsSdk].find((dir) => dir && existsSync(dir));
  const adbName = windows ? 'adb.exe' : 'adb';
  const sdkAdb = sdk && join(sdk, 'platform-tools', adbName);
  const adb = sdkAdb && existsSync(sdkAdb) ? sdkAdb : adbName;
  const discovery = await run(adb, ['devices']);
  if (discovery.error?.code === 'ENOENT') {
    return unavailable(required, 'ADB is unavailable. Install Android SDK Platform-Tools or set ANDROID_HOME.');
  }
  if (discovery.error) throw new Error('ADB could not list devices. Check that Platform-Tools and the ADB server are working.');

  const devices = Array.from(discovery.stdout.matchAll(/^(\S+)\s+device\s*$/gm), (match) => match[1]);
  if (devices.length === 0) {
    return unavailable(required, 'No authorized Android device was found by ADB. ' +
      'Unlock the phone, accept the USB debugging prompt, and run adb devices.');
  }
  if (!serial && devices.length > 1) throw new Error('Multiple authorized Android devices are connected. Specify a device serial.');
  if (serial && !devices.includes(serial)) throw new Error('The requested Android device is not connected and authorized.');
  const selected = serial ?? devices[0];
  if (selected.startsWith('emulator-')) return unavailable(required, 'An Android emulator cannot satisfy the physical-device check.');

  const qemu = await run(adb, ['-s', selected, 'shell', 'getprop', 'ro.kernel.qemu']);
  if (qemu.error) throw new Error('ADB could not verify the selected Android device type.');
  if (qemu.stdout.trim() === '1') return unavailable(required, 'An Android emulator cannot satisfy the physical-device check.');
  return { adb, sdk, serial: selected };
}

export async function checkAndroid({ backendPort, ticket, serial, outputDir, required }) {
  const device = await findAndroidDevice({ serial, required });
  if (device.status === 'skipped') return device;
  const { adb, sdk, serial: selected } = device;
  const ticketId = ticket?.id;
  const expectedDevice = ticket?.result?.device === null ? 'None' : ticket?.result?.device;
  const expectedCategory = ticket?.result?.category;
  const safeArgument = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
  if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535 || ticket?.status !== 'completed' ||
      ![ticketId, expectedDevice, expectedCategory].every(safeArgument)) {
    throw new Error('Android check requires a local backend port and a completed ticket with valid result fields.');
  }

  await mkdir(outputDir, { recursive: true });
  const evidence = [];
  const log = [];
  const redact = (output) => output.replaceAll(selected, '[serial redacted]');
  const save = async (name, data) => {
    await writeFile(join(outputDir, name), redact(data), 'utf8');
    evidence.push(name);
  };
  const deviceCommand = async (label, args, { timeout, success } = {}) => {
    const result = await run(adb, ['-s', selected, ...args], { timeout });
    log.push(`${label}\n${result.stdout}${result.stderr}${result.error?.killed ? '\nTimed out' : ''}`);
    if (result.error || (success && !success.test(result.stdout))) {
      throw new Error(`${label} failed. See android-adb.log for details.`);
    }
    return result.stdout;
  };
  const cleanups = [];
  const errors = [];
  try {
    const packages = await deviceCommand('Check for existing demo packages', ['shell', 'pm', 'list', 'packages', '-u', appId]);
    const installed = packages.split(/\r?\n/);
    if (installed.includes(`package:${appId}`) || installed.includes(`package:${testId}`)) {
      throw new Error('The demo or instrumentation app is already installed. Use a device without those packages.');
    }

    const metadata = { type: 'physical' };
    const properties = { model: 'ro.product.model', release: 'ro.build.version.release', api: 'ro.build.version.sdk', abi: 'ro.product.cpu.abi' };
    for (const [key, property] of Object.entries(properties)) {
      const value = await run(adb, ['-s', selected, 'shell', 'getprop', property]);
      if (!value.error && value.stdout.trim()) metadata[key] = value.stdout.trim();
    }
    const pageSize = await run(adb, ['-s', selected, 'shell', 'getconf', 'PAGE_SIZE']);
    if (!pageSize.error && /^\d+$/.test(pageSize.stdout.trim())) metadata.pageSize = Number(pageSize.stdout.trim());
    await save('android-device.json', JSON.stringify(metadata, null, 2) + '\n');

    const javaName = windows ? 'java.exe' : 'java';
    const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', javaName) : javaName;
    const build = await run(java, ['-classpath', 'gradle/wrapper/gradle-wrapper.jar', 'org.gradle.wrapper.GradleWrapperMain',
      ':app:assembleDebug', ':app:assembleDebugAndroidTest', '--console=plain'], {
      cwd: androidDir,
      timeout: 300_000,
      env: sdk ? { ...process.env, ANDROID_HOME: sdk } : process.env,
    });
    await save('android-build.log', `${build.stdout}${build.stderr}${build.error ? `\nBuild process error: ${build.error.code ?? build.error.signal}\n` : ''}`);
    if (build.error) throw new Error('Android APK build failed. See android-build.log and verify Java 17 and Android SDK 35 are configured.');

    const port = `tcp:${backendPort}`;
    await deviceCommand('Create loopback reverse', ['reverse', '--no-rebind', port, port]);
    cleanups.push(() => deviceCommand('Remove loopback reverse', ['reverse', '--remove', port]));

    const success = /^Success\r?$/m;
    for (const [id, path] of [[appId, `${apk}/debug/app-debug.apk`], [testId, `${apk}/androidTest/debug/app-debug-androidTest.apk`]]) {
      await deviceCommand(`Install ${id}`, ['install', '--no-incremental', '-R', '-t', join(androidDir, path)], { timeout: 90_000, success });
      cleanups.push(() => deviceCommand(`Uninstall ${id}`, ['uninstall', id], { success }));
    }

    const result = await run(adb, ['-s', selected, 'shell', 'am', 'instrument', '-w', '-r',
      '-e', 'backendPort', String(backendPort), '-e', 'ticketId', ticketId,
      '-e', 'expectedDevice', expectedDevice, '-e', 'expectedCategory', expectedCategory,
      `${testId}/${appId}.TicketInstrumentation`], { timeout: 45_000 });
    await save('android-instrumentation.log', `${result.stdout}${result.stderr}${result.error?.killed ? '\nTimed out\n' : ''}`);
    if (result.error || !/^Ticket UI assertions passed\r?$/m.test(result.stdout) || !/^INSTRUMENTATION_CODE: -1\r?$/m.test(result.stdout)) {
      throw new Error('Android ticket UI assertions failed. See android-instrumentation.log for details.');
    }
  } catch (error) {
    errors.push(error.message);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error.message);
      }
    }
    try {
      await save('android-adb.log', log.join('\n'));
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (errors.length) throw Object.assign(new Error(redact(errors.join(' '))), { evidence });
  return { status: 'passed', summary: 'The physical Android device displayed the ticket ID, completed status, device, and category.', evidence };
}
