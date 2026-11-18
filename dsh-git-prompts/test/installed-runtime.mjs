// Optional manual acceptance against the installed ASAR-aware Electron runtime.
// Same isolated contract as npm CI: no live profile, model or Git subprocess.
// Run with ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" test/installed-runtime.mjs.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {exerciseRuntime} from './runtime-fixture.mjs';

assert.ok(process.versions.electron, 'Use the installed ASAR-aware Electron runtime.');
assert.ok(process.env.DSH_INSTALL_DIR, 'A verified installed DSH anchor is required.');
const runtime = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'));
console.log(JSON.stringify({fixture: 'installed-desktop', runtime: runtime('@deepseek-ai/dsh/package.json').version,
  ...await exerciseRuntime(runtime)}, null, 2));
