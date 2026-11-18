import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, stat, realpath} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import {Config, apply, inject, stateSchema} from '../index.js';
import {MAX_LENGTH, NAMESPACE, PREPARE_TOOL, SETTINGS_TOOL, PROJECTION_KEY, preparationState, foldPreparation} from '../core.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const read = relative => readFile(path.join(root, relative), 'utf8');
const manifest = JSON.parse(await read('package.json'));
const sources = Object.fromEntries(await Promise.all(['index.js', 'core.js', 'client.js'].map(async name => [name, await read(name)])));
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'];

function packaged(relative) {
  return manifest.files.some(pattern => pattern === relative ||
    (pattern.includes('*') && new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`).test(relative)));
}

async function assertResource(target) {
  assert.equal(typeof target, 'string');
  assert.ok(target.startsWith('./'), `Resource must be package-relative: ${target}`);
  const absolute = path.resolve(root, target);
  assert.ok(absolute.startsWith(root), `Resource escapes package: ${target}`);
  assert.ok((await realpath(absolute)).startsWith(`${await realpath(root)}${path.sep}`), `Resource symlink escapes package: ${target}`);
  assert.ok((await stat(absolute)).isFile(), `Resource is not a regular file: ${target}`);
  assert.ok(packaged(target.slice(2)), `Missing from package files: ${target}`);
}

test('manifest declares an ESM bundle with explicit Host/Client/resource exports and compatibility', async () => {
  assert.equal(manifest.name, '@local/dsh-git-prompts');
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, 'MIT');
  assert.match(manifest.engines.dsh, /0\.2\.2-rc\.3/);
  assert.match(manifest.engines.dsh, /<0\.3\.0/);
  assert.match(manifest.engines.node, /24/);
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.exports['.'], './index.js');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
  assert.equal(manifest.exports['./icon'], './icon.svg');
  for (const relative of ['index.js', 'core.js', 'client.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'README.md']) {
    await assertResource(`./${relative}`);
  }
});

test('bundle patch inserts only its own plugin and does not seed instruction bodies or profile changes', async () => {
  const patch = await read('cordis.patch.yml');
  assert.match(patch, /^- insert:/m);
  assert.equal((patch.match(/\bid:\s*local-git-prompts\b/g) ?? []).length, 1);
  assert.match(patch, /name:\s*['"]?@local\/dsh-git-prompts['"]?/);
  assert.doesNotMatch(patch, /(?:commitInstructions|prInstructions|systemPrompt|remove:|override:|agentPreset)/);
});

test('English and Chinese metadata describe on-demand behavior and include coverage limits', async () => {
  for (const language of ['en', 'zh']) {
    const locale = JSON.parse(await read(`locale/${language}.json`));
    assert.equal(typeof locale.meta.title, 'string');
    assert.ok(locale.meta.title.trim().length > 0);
    assert.equal(typeof locale.meta.description, 'string');
    assert.ok(locale.meta.description.trim().length > 80);
    assert.match(locale.meta.description, /Git/);
    assert.match(locale.meta.description, /PR/);
    assert.match(locale.meta.description, /git_workbench/);
    assert.match(locale.meta.description, /shell\/gh/);
    assert.match(locale.meta.description, /Forge/);
    assert.doesNotMatch(JSON.stringify(locale), /My decoration|my-plugin|Draws a badge/);
    if (locale.meta.detail) await assertResource(`./${locale.meta.detail}`);
  }
  assert.equal(JSON.parse(await read('locale/en.json')).meta.title, 'Git operation instructions');
});

test('README covers setup, empty defaults, approval/revision safety and guard limitations', async () => {
  const readme = await read('README.md');
  assert.match(readme, /prepare_git_operation/);
  assert.match(readme, /git_prompt_settings/);
  assert.match(readme, /git_workbench/);
  assert.match(readme, /PR/);
  assert.match(readme, /(?:默认|default)/i);
  assert.match(readme, /(?:空|empty|blank)/i);
  assert.match(readme, /(?:审批|approval)/i);
  assert.match(readme, /(?:版本|revision)/i);
  assert.match(readme, /(?:模型步骤|model step)/i);
  assert.match(readme, /(?:shell|bash)/i);
  assert.match(readme, /Forge/);
});

test('default settings are enabled with genuinely empty instruction bodies and volatile references', () => {
  const config = Config({});
  assert.deepEqual(Object.keys(config).sort(), ['commitInstructions', 'enabled', 'prInstructions']);
  for (const value of Object.values(config)) assert.equal(typeof value.get, 'function');
  assert.deepEqual(Object.fromEntries(Object.entries(config).map(([key, value]) => [key, value.get()])), {
    enabled: true, commitInstructions: '', prInstructions: '',
  });
  const literal = 'Keep {{}} and {{name}} literal.';
  assert.equal(Config({commitInstructions: literal}).commitInstructions.get(), literal);
  assert.equal(Config({enabled: false}).enabled.get(), false);
  for (const key of ['commitInstructions', 'prInstructions']) {
    assert.equal(Config({[key]: 'a'.repeat(MAX_LENGTH)})[key].get().length, MAX_LENGTH);
    assert.throws(() => Config({[key]: 'a'.repeat(MAX_LENGTH + 1)}));
  }
});

test('Host activation waits for its projection before publishing an effect-owned guard and two tools', async () => {
  const tools = [];
  const guards = [];
  const effects = [];
  const configured = [];
  let definition;
  let resolveRegistration;
  let disposed = 0;
  const disposer = () => {disposed += 1;};
  const fiber = {};
  const handle = {stateOf() {return preparationState({id: 'synthetic'});}};
  const ctx = new Proxy({
    fiber,
    effect(callback) {effects.push(callback());},
    settings: {configure(options, owner) {configured.push({options, owner}); return disposer;}},
    sessionProjections: {register(value) {
      definition = value;
      return new Promise(resolve => {resolveRegistration = resolve;});
    }},
    tools: {guard(callback) {guards.push(callback); return disposer;}, register(tool) {tools.push(tool); return disposer;}},
  }, {get(target, key) {
    assert.ok(key in target, `Unexpected Host API: ${String(key)} (no prompt/event/profile APIs are allowed)`);
    return target[key];
  }});
  const activation = apply(ctx);
  assert.deepEqual(tools, []);
  assert.deepEqual(guards, []);
  assert.deepEqual(configured, [{options: {auto: false}, owner: fiber}]);
  assert.equal(definition.key, PROJECTION_KEY);
  assert.equal(definition.stateVersion, 2);
  assert.equal(definition.stateSchema, stateSchema);
  assert.equal(definition.init, preparationState);
  assert.equal(definition.apply, foldPreparation);
  assert.equal(definition.wire, undefined, 'instruction bodies must not become a Client projection');
  resolveRegistration(handle);
  await activation;
  assert.deepEqual(inject, ['tools', 'settings', 'sessionProjections', 'workingDirectory']);
  assert.equal(guards.length, 1);
  assert.deepEqual(tools.map(tool => tool.name), [PREPARE_TOOL, SETTINGS_TOOL]);
  assert.equal(effects.length, 4);
  for (const cleanup of effects) {assert.equal(typeof cleanup, 'function'); cleanup();}
  assert.equal(disposed, 4);
  const [preparation, settings] = tools;
  assert.deepEqual(preparation.parameters.properties.operation.enum, ['commit', 'pr']);
  assert.deepEqual(preparation.parameters.required, []);
  assert.match(preparation.parameters.properties.operation.description, /Defaults to commit when omitted/);
  assert.match(preparation.parameters.properties.operation.description, /explicitly use pr/);
  assert.equal(preparation.parameters.additionalProperties, false);
  assert.equal(preparation.parameters.properties.repo.maxLength, 4096);
  assert.deepEqual(settings.parameters.properties.action.enum, ['get', 'update']);
  assert.equal(settings.parameters.additionalProperties, false);
  assert.equal(settings.parameters.properties.commitInstructions.maxLength, MAX_LENGTH);
  assert.equal(settings.parameters.properties.prInstructions.maxLength, MAX_LENGTH);
  assert.equal(settings.parameters.properties.expectedRevision.minimum, 0);
  assert.equal(preparation.isConcurrencySafe({operation: 'commit'}), false);
  assert.equal(settings.isConcurrencySafe({action: 'get'}), true);
  assert.equal(settings.isConcurrencySafe({action: 'update'}), false);
  for (const tool of tools) {
    assert.equal(tool.output.schema.type, 'object');
    assert.deepEqual(tool.output.render({}, {value: '{{}}'}), [{type: 'text', text: '{"value":"{{}}"}'}]);
  }
});

test('projection schema accepts initial state and rejects invalid persisted authority', () => {
  const initial = preparationState({id: 'synthetic'}, 3);
  assert.equal(initial.assistantSeq, -1);
  assert.deepEqual(stateSchema.parse(initial), initial);
  const row = {messageId: 'message', seq: 3, operation: 'commit', repo: '/synthetic/repo', revision: 1,
    rulesHash: 'rules-hash', contentHash: 'content-hash', turn: 0, preparedAtStepSeq: 1};
  assert.equal(stateSchema.safeParse({...initial, preparations: [row]}).success, true);
  assert.equal(stateSchema.parse({...initial, preparations: [row]}).preparations[0].preparedAtStepSeq, 1);
  for (const patch of [{inheritedFloor: -1}, {calls: [1]}, {assistantSeq: undefined}, {assistantSeq: 1.5},
    {preparations: [{...row, operation: 'pr'}]}, {preparations: [{...row, preparedAtStepSeq: undefined}]},
    {preparations: [{...row, preparedAtStepSeq: -1}]}, {preparations: [{...row, preparedAtStepSeq: 1.5}]},
    {preparations: [{...row, revision: -1}]}, {preparations: Array(17).fill(row)}]) {
    assert.equal(stateSchema.safeParse({...initial, ...patch}).success, false);
  }
});

test('Client manifest and loader use injected APIs without importing Harness Client implementation packages', () => {
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-settings-general']);
  assert.match(sources['client.js'], /window\.__ModuleLoader__\.load\(/);
  assert.doesNotMatch(sources['client.js'], /\bimport\b\s*(?:\(|[\w*{])/);
  assert.doesNotMatch(sources['client.js'], /\brequire\s*\(\s*['"]@deepseek-ai\//);
  const captures = [];
  vm.runInNewContext(sources['client.js'], {window: {__ModuleLoader__: {load(value) {captures.push(value);}}}}, {filename: 'client.js'});
  assert.equal(captures.length, 1);
  assert.equal(captures[0].id, manifest.name);
  const required = [];
  const plugin = captures[0].factory(name => {
    required.push(name);
    assert.equal(name, 'react');
    return {createElement() {assert.fail('Settings UI must not render during module registration');}};
  });
  assert.deepEqual(required, ['react']);
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale', 'configForms']);
  assert.equal(typeof plugin.apply, 'function');
});

test('Client setup only registers localized Git settings sections, not tools, events, prompts or profile writes', () => {
  let module;
  vm.runInNewContext(sources['client.js'], {window: {__ModuleLoader__: {load(value) {module = value;}}}}, {filename: 'client.js'});
  const plugin = module.factory(name => {assert.equal(name, 'react'); return {createElement() {}};});
  const sections = [];
  const localeRegistrations = [];
  const formRequests = [];
  const effects = [];
  const ctx = new Proxy({
    effect(callback) {effects.push(callback());},
    locale: {register(namespace, translations) {localeRegistrations.push({namespace, translations}); return () => {};}, bind(namespace) {
      assert.equal(namespace, 'localGitPrompts'); return key => key;
    }},
    configForms: {get(entry) {formRequests.push(entry); return {};}, describe() {return {}; }},
    slots: {inject(slot, callback) {return callback();}, register(options, component) {sections.push({options, component}); return () => {}; }},
  }, {get(target, key) {assert.ok(key in target, `Unexpected Client API: ${String(key)}`); return target[key];}});
  plugin.apply(ctx);
  assert.deepEqual(formRequests, [NAMESPACE]);
  assert.deepEqual(sections.map(section => section.options.name), ['settings.section', 'settings.section.icon']);
  for (const section of sections) {
    assert.equal(section.options.id, NAMESPACE);
    assert.equal(typeof section.component, 'function');
  }
  assert.equal(localeRegistrations.length, 1);
  const {translations} = localeRegistrations[0];
  assert.deepEqual(Object.keys(translations.en).sort(), Object.keys(translations.zh).sort());
  assert.match(translations.en.coverage, /Manual.*(?:bash|shell).*Forge/);
  assert.match(translations.zh.privacy, /密码|令牌/);
  assert.ok(effects.every(cleanup => typeof cleanup === 'function'));
});

test('Host/core never contribute a standing system prompt or register custom Session events', () => {
  for (const [name, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /\bctx\.(?:systemPrompt|prompts?|events?)\b/, name);
    assert.doesNotMatch(source, /\bctx\.(?:on|emit)\s*\(/, name);
    assert.doesNotMatch(source, /\.(?:registerEvent|defineEvent|registerSource)\s*\(/, name);
    assert.doesNotMatch(source, /\bsession\.append\s*\(/, name);
  }
  const imports = Array.from(sources['core.js'].matchAll(/\bfrom\s*['"]([^'"]+)['"]/g), match => match[1]);
  assert.ok(imports.length > 0);
  assert.ok(imports.every(specifier => specifier.startsWith('node:')));
  assert.doesNotMatch(sources['core.js'], /node:(?:child_process|fs|worker_threads)|\b(?:spawn|execFile|eval)\s*\(/);
});

test('package/dependencies contain no install lifecycle hooks or bundled Harness runtime', async () => {
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@deepseek-ai/schemastery', 'zod']);
  assert.equal(manifest.optionalDependencies, undefined);
  for (const hook of INSTALL_HOOKS) assert.equal(manifest.scripts?.[hook], undefined, `Bundle has install hook ${hook}`);
  assert.equal(manifest.scripts.test, 'node --test test/*.test.js');
  for (const dependency of Object.keys(manifest.dependencies)) {
    const dependencyManifest = JSON.parse(await readFile(require.resolve(`${dependency}/package.json`), 'utf8'));
    assert.equal(dependencyManifest.name, dependency);
    for (const hook of INSTALL_HOOKS) assert.equal(dependencyManifest.scripts?.[hook], undefined, `${dependency} has install hook ${hook}`);
  }
});

test('icon is an explicit 36×36 self-contained vector drawing with no embedded remote or executable content', async () => {
  const svg = await read('icon.svg');
  assert.ok(Buffer.byteLength(svg) <= 256 * 1024);
  assert.match(svg, /^\s*<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /\bwidth="36"/);
  assert.match(svg, /\bheight="36"/);
  assert.match(svg, /\bviewBox="0 0 36 36"/);
  assert.match(svg, /<path\b/);
  assert.match(svg, /<circle\b/);
  assert.match(svg, /<\/svg>\s*$/);
  assert.doesNotMatch(svg, /<(?:script|image|use|foreignObject|iframe)\b|\b(?:href|onload|onclick)\s*=|url\s*\(|<!DOCTYPE|<!ENTITY/i);
  assert.doesNotMatch(svg.replace('http://www.w3.org/2000/svg', ''), /https?:\/\/|data:/i);
  const stack = [];
  for (const token of svg.matchAll(/<(\/)?([A-Za-z][\w:-]*)\b[^>]*?(\/)?\s*>/g)) {
    if (token[1]) assert.equal(stack.pop(), token[2], 'Unbalanced SVG elements');
    else if (!token[3]) stack.push(token[2]);
  }
  assert.deepEqual(stack, []);
});
