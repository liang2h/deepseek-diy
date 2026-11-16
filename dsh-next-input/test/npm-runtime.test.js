import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeGraph, SDK_VERSION, CORDIS_VERSION} from './npm-runtime.mjs';
import {runtimeEnvironment} from './run-runtime.mjs';

test('npm runtime graph pins every DSH dependency and shares one Cordis module', t => {
  assert.ok(runtimeGraph.some(({name}) => name === '@deepseek-ai/dsh-tools'));
  for (const {name, version} of runtimeGraph) {
    assert.equal(version, name === '@deepseek-ai/cordis' ? CORDIS_VERSION : SDK_VERSION);
  }
  t.diagnostic(runtimeGraph.map(({name, version}) => name + '@' + version).join(', '));
});

test('runtime launcher excludes inherited Desktop paths and global module lookup', () => {
  const source = {DSH_NODE_EXECUTABLE: '/invalid/desktop-node', DSH_INSTALL_DIR: '/invalid/desktop', DSH_PROFILE_DIR: '/invalid/profile',
    NODE_PATH: '/invalid/global-modules', ELECTRON_RUN_AS_NODE: '1', PATH: '/fixture/bin', CI: 'true'};
  assert.deepEqual(runtimeEnvironment(source), {PATH: '/fixture/bin', CI: 'true'});
  assert.equal(source.DSH_INSTALL_DIR, '/invalid/desktop', 'do not mutate parent environment');
});
