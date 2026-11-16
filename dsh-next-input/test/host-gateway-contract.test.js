import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('installed Host Gateway dispatches the plugin Remote through real strict registration and lookup', {
  skip: !process.env.DSH_NODE_EXECUTABLE || !process.env.DSH_INSTALL_DIR ? 'Run inside DSH to exercise its installed Host Gateway.' : false,
}, () => {
  const result = spawnSync(process.env.DSH_NODE_EXECUTABLE, [fileURLToPath(new URL('host-gateway-runtime.mjs', import.meta.url))], {
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Installed Host Gateway integration passed/);
});
