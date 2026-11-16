import test from 'node:test';
import {runRuntimeFixture} from './run-runtime.mjs';

test('both Inspect manifests and query outputs pass the npm DSH native schema validator', () => {
  runRuntimeFixture('diagnostics-runtime.mjs', /Native Inspect schema validation passed/);
});
