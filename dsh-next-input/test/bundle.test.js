import {VERSION} from '../version.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = new URL('../', import.meta.url);

test('built browser artifact registers one lazy factory under the exact package identity', async () => {
  // Capture registration only; do not emulate React, render components or emulate a DOM.
  const registrations = [];
  const artifact = await readFile(new URL('client.bundle.js', root), 'utf8');
  vm.runInNewContext(artifact, {window: {__ModuleLoader__: {load: definition => registrations.push(definition)}}}, {timeout: 1000});
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, '@local/dsh-next-input');
  assert.equal(typeof registrations[0].factory, 'function');
});

test('manifest, code marker and generated Client artifact share the same release revision', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const artifact = await readFile(new URL('client.bundle.js', root), 'utf8');
  assert.equal(manifest.version, VERSION);
  assert.ok(artifact.includes(JSON.stringify(VERSION)), 'Rebuild the browser artifact when changing the code revision.');
});

test('all explicit exported resources exist and remain inside the bundle directory', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const base = fileURLToPath(root);
  for (const target of Object.values(manifest.exports)) {
    if (target.includes('*')) continue;
    const resolved = path.resolve(base, target);
    assert.ok(resolved.startsWith(base));
    assert.equal((await stat(resolved)).isFile(), true);
  }
  assert.equal(manifest.scripts?.postinstall, undefined);
  assert.equal(manifest.scripts?.preinstall, undefined);
  assert.equal(manifest.scripts?.install, undefined);
});
