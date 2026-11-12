import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('a host without ADB skips the optional Android check and fails a required check', async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), 'android-no-sdk-'));
  try {
    const adapter = new URL('../workflow/android.mjs', import.meta.url).href;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { checkAndroid } from ${JSON.stringify(adapter)};
      const optional = await checkAndroid({ required: false });
      assert.equal(optional.status, 'skipped');
      assert.match(optional.summary, /ADB/i);
      await assert.rejects(checkAndroid({ required: true }), /ADB/i);
      process.stdout.write('ok');
    `], {
      cwd: emptyDir,
      encoding: 'utf8',
      env: { ...process.env, PATH: emptyDir, ANDROID_HOME: emptyDir, ANDROID_SDK_ROOT: emptyDir, LOCALAPPDATA: emptyDir },
    });
    assert.equal(output, 'ok');
  } finally {
    await rmdir(emptyDir);
  }
});
