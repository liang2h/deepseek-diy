import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const text = name => readFile(new URL(name, root), 'utf8');

test('manifest exports every runtime and display resource without build scripts', async () => {
  const manifest = JSON.parse(await text('package.json'));
  assert.equal(manifest.name, '@local/dsh-personalization');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'));
  for (const name of ['index.js', 'core.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md']) {
    assert.ok(manifest.files.includes(name)); assert.ok((await stat(new URL(name, root))).isFile());
  }
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(await text(`locale/${locale}.json`)).meta;
    assert.ok(meta.title.length > 0); assert.ok(meta.description.length > 20);
  }
  assert.ok(manifest.exports['./icon']); assert.ok(manifest.exports['./locale/*.json']);
  assert.equal(manifest.scripts.postinstall, undefined);
});
test('UI uses native settings scope and shared mirror, atomic revisioned edits, no transport or DOM bypass', async () => {
  const source = await text('client.js');
  assert.match(source, /ctx\.configForms\.get\(ENTRY\)/);
  assert.match(source, /ctx\.configForms\.describe\(\)/);
  assert.match(source, /form\.mutate\(/); assert.match(source, /\], draft\.revision\)/);
  assert.match(source, /name: 'settings.section', id: ENTRY/);
  assert.match(source, /role: 'switch'/); assert.match(source, /'aria-checked'/);
  assert.match(source, /retainedDraft/); assert.match(source, /snapshot\.revision !== draft\.revision/);
  assert.doesNotMatch(source, /document\.|localStorage|setInterval|fetch\(|\.remote\./);
  assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]), ['react']);
  assert.doesNotMatch(source, /#[a-fA-F0-9]{3,8}\b|rgba?\(/);
  const cssVars = [...source.matchAll(/var\((--[^)]+)\)/g)].map(match => match[1]);
  assert.ok(cssVars.every(name => name.startsWith('--dsw-alias-')));
});
test('patch adds a Host-global entry without overriding any existing plugin', async () => {
  const patch = await text('cordis.patch.yml');
  assert.match(patch, /- insert:/); assert.match(patch, /id: local-personalization/);
  assert.doesNotMatch(patch, /override|disabled|system-prompt|preset/);
});
