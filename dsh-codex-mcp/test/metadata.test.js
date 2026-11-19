import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {apply} from '../index.js';

test('distribution metadata includes original icon, localized titles and all runtime modules', async () => {
  const root = new URL('..', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.version, '1.2.4');
  assert.equal(manifest.engines.dsh, '0.2.2-rc.5');
  for (const [name, version] of Object.entries({...manifest.peerDependencies, ...manifest.devDependencies}))
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(version, manifest.engines.dsh, `${name} must test against the declared DSH release`);
  assert.equal(manifest.exports['./icon'], './icon.svg');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.dsh.client.platform, 'web'); assert.equal(manifest.dsh.client.immediately, true);
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-commands']);
  for (const name of ['index.js', 'client.js', 'activation.js', 'limits.js', 'runtime.js', 'project.js', 'connection.js', 'oauth.js', 'oauth-errors.js', 'oauth-record.js', 'browser.js', 'config.js', 'cordis.patch.yml', 'README.md', 'icon.svg'])
    assert.equal((await stat(new URL(name, root))).isFile(), true);
  for (const locale of ['en', 'zh']) {
    const value = JSON.parse(await readFile(new URL(`locale/${locale}.json`, root), 'utf8'));
    assert.ok(value.meta.title); assert.ok(value.meta.description);
  }
  const icon = await readFile(new URL('icon.svg', root), 'utf8');
  assert.match(icon, /<svg[^>]*viewBox="0 0 64 64"/); assert.ok(Buffer.byteLength(icon) < 256 * 1024);
  assert.doesNotMatch(icon, /<script|https?:\/\/(?!www\.w3\.org)|href=/);
});

test('first-turn management schema stays bounded without eager instructions', async t => {
  let tool; const sections = [];
  await apply({sessionProjections: {register: async () => ({stateOf: () => ({activation: null})})}, tools: {register: value => {tool = value;}}, commands: {register() {}}, agents: {list: () => []},
    effect() {}, on() {}, systemPrompt: {section: value => sections.push(value)}});
  const schema = {name: tool.name, description: tool.description, parameters: tool.parameters};
  const characters = JSON.stringify([schema]).length;
  const estimate = Math.ceil(characters / 4) + 4; // DSH token-meter's documented density heuristic, not exact tokenization.
  t.diagnostic(`Management-only first-turn tool-schema estimate: before=0, after=${estimate} tokens; characters=${characters}; extra system sections=${sections.length}.`);
  assert.ok(estimate < 300); assert.equal(sections.length, 0);
});

test('human command keeps its canonical name and argument handling with a short menu description', async () => {
  let command;
  await apply({sessionProjections: {register: async () => ({stateOf: () => ({activation: null})})}, tools: {register() {}}, commands: {register: value => {command = value;}}, agents: {list: () => []},
    effect() {}, on() {}});
  assert.equal(command.name, 'codex-mcp');
  assert.equal(command.description, '管理项目 MCP 连接与 OAuth 登录');
  assert.ok(command.description.length <= 30);
  assert.equal(command.input.hint, 'status | tools [server] | reload | trust <fingerprint> | untrust | login/logout/cancel <server>');
  assert.equal(typeof command.handler, 'function');
  // Current DSH's Host descriptor has no label/icon contract. Do not add fields
  // here that look configured but are discarded by commands.list / the menu.
  assert.equal(Object.hasOwn(command, 'label'), false); assert.equal(Object.hasOwn(command, 'icon'), false);
});
