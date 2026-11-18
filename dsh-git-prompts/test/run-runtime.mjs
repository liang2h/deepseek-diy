import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function runtimeEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([name]) => !name.startsWith('DSH_') && name !== 'NODE_PATH' && name !== 'ELECTRON_RUN_AS_NODE'));
}

export function runRuntimeFixture(source = process.env) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./npm-runtime-fixture.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: runtimeEnvironment(source), encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  return JSON.parse(result.stdout);
}
