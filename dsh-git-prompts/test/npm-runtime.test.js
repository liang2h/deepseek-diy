import test from 'node:test';
import assert from 'node:assert/strict';
import {runRuntimeFixture, runtimeEnvironment} from './run-runtime.mjs';

const poisonedPaths = {DSH_NODE_EXECUTABLE: '/invalid/desktop-node', DSH_INSTALL_DIR: '/invalid/desktop',
  DSH_PROFILE_DIR: '/invalid/profile', DSH_UNKNOWN_FUTURE_VARIABLE: '/invalid/other',
  NODE_PATH: '/invalid/global-modules', ELECTRON_RUN_AS_NODE: '1'};

test('npm launcher excludes inherited Desktop/profile paths and global module lookup', () => {
  const source = {...poisonedPaths, PATH: '/fixture/bin', CI: 'true'};
  assert.deepEqual(runtimeEnvironment(source), {PATH: '/fixture/bin', CI: 'true'});
  assert.equal(source.DSH_INSTALL_DIR, '/invalid/desktop', 'Do not mutate the parent environment');
});

test('fixed npm SDK executes the real native pipeline, session and projection contract without Desktop', t => {
  const result = runRuntimeFixture({...process.env, ...poisonedPaths});
  assert.equal(result.fixture, 'npm');
  assert.equal(result.runtime, '0.2.2-rc.3');
  assert.equal(result.cordis, '4.1.0');
  for (const flag of ['isolatedNativePipeline', 'emptyArgumentsDefaultToCommit', 'realSessionAndProjection',
    'sourceContextRoundTrip', 'sameBatchAndSameStepDenied', 'nextModelStepAllowed',
    'revisionAndCompactionDenied', 'systemSectionsUnchanged']) assert.equal(result[flag], true, flag);
  assert.deepEqual(result.readOnlyObservations, ['summary', 'diff']);
  assert.equal(result.actualGitWrites, 0);
  assert.equal(result.modelRequests, 0);
  assert.equal(result.runtimeGraph.filter(({name}) => name === '@deepseek-ai/cordis').length, 1);
  for (const {name, version} of result.runtimeGraph) assert.equal(version, name === '@deepseek-ai/cordis' ? '4.1.0' : '0.2.2-rc.3', name);
  t.diagnostic(result.runtimeGraph.map(({name, version}) => name + '@' + version).join(', '));
});
