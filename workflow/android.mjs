import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const androidDir = fileURLToPath(new URL('../android/', import.meta.url));
const appId = 'io.github.leejunhao791.aiappregression';
const testId = `${appId}.test`;
const apk = 'app/build/outputs/apk';
const windows = process.platform === 'win32';
const packageName = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

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

export function loadAndroidMap(path) {
  const invalid = (field, message) => { throw new Error(`Android map "${path}", field ${field}: ${message}`); };
  let map;
  try {
    map = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)));
  } catch {
    invalid('root', 'expected a readable UTF-8 JSON file.');
  }
  if (typeof map?.app_package !== 'string' || !packageName.test(map.app_package)) {
    invalid('app_package', 'expected the target Android package name.');
  }
  const component = typeof map.instrumentation === 'string' ? map.instrumentation.split('/') : [];
  if (component.length !== 2 || !component.every((part) => packageName.test(part)) ||
      component[0] === map.app_package) {
    invalid('instrumentation', 'expected test.package/fully.qualified.Runner for a separate test package.');
  }
  const apkPath = (field) => {
    const value = map[field];
    if (typeof value !== 'string' || !value.toLowerCase().endsWith('.apk')) invalid(field, 'expected an APK path.');
    const file = resolve(dirname(path), value);
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) invalid(field, `APK file does not exist: ${file}`);
    return file;
  };
  return {
    packages: [[map.app_package, apkPath('app_apk')], [component[0], apkPath('test_apk')]],
    instrumentation: map.instrumentation,
  };
}

export async function verifyAndroidApks(apks, sdk) {
  const name = windows ? 'aapt.exe' : 'aapt';
  const sdkAapt = sdk && join(sdk, 'build-tools', '35.0.0', name);
  const aapt = sdkAapt && existsSync(sdkAapt) ? sdkAapt : name;
  for (const [packageId, path] of apks.packages) {
    const result = await run(aapt, ['dump', 'badging', path]);
    if (result.error) throw new Error('Could not inspect the supplied APKs. Install Android Build Tools 35.0.0 or put aapt on PATH.');
    if (/^package: name='([^']+)'/m.exec(result.stdout)?.[1] !== packageId) {
      throw new Error(`The supplied APK package does not match ${packageId} in the Android map.`);
    }
  }
}

export async function checkAndroid({ backendPort, ticket, serial, outputDir, required, externalApks }) {
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
  const packages = externalApks?.packages ?? [
    [appId, join(androidDir, `${apk}/debug/app-debug.apk`)],
    [testId, join(androidDir, `${apk}/androidTest/debug/app-debug-androidTest.apk`)],
  ];
  try {
    for (const [id] of packages) {
      const installed = await deviceCommand(`Check for existing package ${id}`, ['shell', 'pm', 'list', 'packages', '-u', id]);
      if (installed.split(/\r?\n/).includes(`package:${id}`)) {
        throw new Error(`Package ${id} is already installed. Use a device without the supplied packages.`);
      }
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

    if (!externalApks) {
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
    }

    const port = `tcp:${backendPort}`;
    await deviceCommand('Create loopback reverse', ['reverse', '--no-rebind', port, port]);
    cleanups.push(() => deviceCommand('Remove loopback reverse', ['reverse', '--remove', port]));

    const success = /^Success\r?$/m;
    for (const [id, path] of packages) {
      await deviceCommand(`Install ${id}`, ['install', '--no-incremental', '-R', '-t', path], { timeout: 90_000, success });
      cleanups.push(() => deviceCommand(`Uninstall ${id}`, ['uninstall', id], { success }));
    }

    const instrumentation = externalApks?.instrumentation ?? `${testId}/${appId}.TicketInstrumentation`;
    if (externalApks) {
      const target = packages[0][0];
      const listed = await deviceCommand('Verify instrumentation target', ['shell', 'pm', 'list', 'instrumentation', target]);
      if (!listed.split(/\r?\n/).includes(`instrumentation:${instrumentation} (target=${target})`)) {
        throw new Error('The supplied instrumentation runner does not target the supplied app package.');
      }
    }
    const result = await run(adb, ['-s', selected, 'shell', 'am', 'instrument', '-w', '-r',
      '-e', 'backendPort', String(backendPort), '-e', 'ticketId', ticketId,
      '-e', 'expectedDevice', expectedDevice, '-e', 'expectedCategory', expectedCategory,
      instrumentation], { timeout: 45_000 });
    await save('android-instrumentation.log', `${result.stdout}${result.stderr}${result.error?.killed ? '\nTimed out\n' : ''}`);
    if (result.error || !/^Ticket UI assertions passed\r?$/m.test(result.stdout) || !/^INSTRUMENTATION_CODE: -1\r?$/m.test(result.stdout)) {
      throw new Error('Android ticket UI assertions failed. See android-instrumentation.log for details.');
    }
    if (externalApks) {
      const lines = result.stdout.split(/\r?\n/);
      if (![`Ticket ID: ${ticketId}`, 'Status: completed', `Device: ${expectedDevice}`,
        `Category: ${expectedCategory}`].every((line) => lines.includes(line))) {
        throw new Error('Android instrumentation did not report the matching ticket ID, status, and labels.');
      }
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
