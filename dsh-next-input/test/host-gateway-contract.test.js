import test from 'node:test';
import {runRuntimeFixture} from './run-runtime.mjs';

test('npm DSH Host Gateway dispatches the plugin Remote through real strict registration and lookup', () => {
  runRuntimeFixture('host-gateway-runtime.mjs', /npm Host Gateway integration passed/);
});
