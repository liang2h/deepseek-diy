import test from 'node:test';
import {runRuntimeFixture} from './run-runtime.mjs';

test('npm DSH Gateway Client routes scoped calls and unwraps real RemoteResult envelopes', () => {
  runRuntimeFixture('gateway-runtime.mjs', /npm Gateway Client integration passed/);
});
