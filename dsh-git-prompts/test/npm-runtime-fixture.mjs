import assert from 'node:assert/strict';
import {requireRuntime, runtimeGraph, SDK_VERSION, CORDIS_VERSION} from './npm-runtime.mjs';
import {exerciseRuntime} from './runtime-fixture.mjs';

assert.equal(process.versions.electron, undefined, 'The npm contract must run in ordinary Node');
assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24 or later is required');
assert.deepEqual(Object.keys(process.env).filter(name => name.startsWith('DSH_') || name === 'NODE_PATH' || name === 'ELECTRON_RUN_AS_NODE'), [],
  'The npm contract must not inherit Desktop/profile/global-module configuration');
console.log(JSON.stringify({fixture: 'npm', runtime: SDK_VERSION, cordis: CORDIS_VERSION, runtimeGraph,
  ...await exerciseRuntime(requireRuntime)}, null, 2));
