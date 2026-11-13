import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {apply as hostApply} from '../index.js';

const scopeRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-scope'));
const {Context, Service} = await import(scopeRequire.resolve('@deepseek-ai/cordis'));
let definition;
const warnings = [];
vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
  window: {__ModuleLoader__: {load: value => {definition = value;}}},
  console: {warn: value => warnings.push(value)},
});
assert.equal(definition.id, '@local/dsh-codex-mcp');
// No renderer/DOM emulation: this test exercises registration and candidate data,
// not React output. The real browser supplies React when it renders the icon.
const client = definition.factory(name => {
  assert.equal(name, 'react'); return {createElement() {throw new Error('This is not a visual test');}};
});
let command;
await hostApply({sessionProjections: {register: async () => ({stateOf: () => ({activation: null})})}, tools: {register() {}}, commands: {register: value => {command = value;}}, agents: {list: () => []}, effect() {}, on() {}});
const otherA = Object.freeze({name: 'model', label: '模型', description: '选择模型', section: '指令'});
const ownRow = Object.freeze({name: command.name, hint: command.input.hint, description: command.description, section: '指令'});
const otherB = Object.freeze({name: 'side-chat', label: '侧边聊天', description: '私有侧问', section: '指令'});
const nativeRows = Object.freeze([otherA, ownRow, otherB]);
const session = Object.freeze({sessionId: 'synthetic-menu-session'});
const request = extra => ({query: '', position: 'leading', signal: new AbortController().signal, ...extra});
const ownDescriptor = value => Object.getOwnPropertyDescriptor(value, 'candidates');
const text = key => ({label: '项目 MCP', description: command.description})[key];
function deferred() {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};}

class Menu extends Service {
  calls = [];
  constructor(ctx) {
    super(ctx, 'commandUi');
    // Same dispatch shape as the installed native command source.
    this.source = {candidates: (target, req) => this.candidates(target, req)};
  }
  async candidates(target, req, extra) {
    this.calls.push({target, req, extra, caller: this.ctx.caller});
    if (req.cleanup) this.ctx.effect(() => () => req.cleanup(this.ctx.caller), 'native-candidate-owner');
    if (req.wait) await req.wait;
    req.signal?.throwIfAborted();
    if (req.failure) throw req.failure;
    return req.result === undefined ? nativeRows : req.result;
  }
  matchEnter(...args) {return args;}
  claimOf(...args) {return args;}
  dispatch(...args) {return args;}
}
function setup() {
  const ctx = new Context().extend({caller: 'provider'}), menu = new Menu(ctx);
  return {ctx, menu, a: ctx.extend({caller: 'a'}), b: ctx.extend({caller: 'b'})};
}

test('Client face decorates only our frozen row; native ordering, section, hint and siblings stay intact', async () => {
  const {menu, a} = setup(); const dispose = client.attachCommandFace(a.get('commandUi'), text);
  const args = request(), marker = {};
  const result = await a.get('commandUi').candidates(session, args, marker);
  assert.equal(result[0], otherA); assert.equal(result[2], otherB);
  assert.equal(result[1].name, command.name); assert.equal(result[1].label, '项目 MCP');
  assert.equal(result[1].description, command.description); assert.equal(typeof result[1].icon, 'function');
  assert.equal(result[1].hint, command.input.hint); assert.equal(result[1].section, ownRow.section);
  assert.equal(ownRow.label, undefined); assert.equal(ownRow.icon, undefined);
  assert.equal(menu.calls.length, 1); assert.equal(menu.calls[0].target, session);
  assert.equal(menu.calls[0].req, args); assert.equal(menu.calls[0].extra, marker);
  dispose(); assert.equal(ownDescriptor(menu), undefined);
});

test('real Cordis preserves distinct caller contexts and the native raw-source closure', async () => {
  const {menu, a, b} = setup();
  const original = Menu.prototype.candidates;
  const dispose = client.attachCommandFace(a.get('commandUi'), text);
  assert.notEqual(a.get('commandUi').candidates, a.get('commandUi').candidates);
  for (const context of [a, b]) assert.equal((await context.get('commandUi').candidates(session, request()))[1].label, '项目 MCP');
  assert.equal((await menu.source.candidates(session, request()))[1].label, '项目 MCP');
  assert.deepEqual(menu.calls.map(value => value.caller), ['a', 'b', 'provider']);
  dispose(); assert.equal(menu.candidates, original);
  assert.equal(await menu.source.candidates(session, request()), nativeRows);
});

test('candidate adaptation does not replace native parameter claims, dispatch or the Host command handler', async () => {
  const {menu, a} = setup();
  const before = {handler: command.handler, input: command.input, matchEnter: menu.matchEnter, claimOf: menu.claimOf, dispatch: menu.dispatch};
  const dispose = client.attachCommandFace(a.get('commandUi'), text);
  await menu.source.candidates(session, request());
  assert.equal(command.name, 'codex-mcp'); assert.equal(command.handler, before.handler); assert.equal(command.input, before.input);
  for (const key of ['matchEnter', 'claimOf', 'dispatch']) assert.equal(menu[key], before[key]);
  const line = '/codex-mcp login agentlens';
  assert.equal(menu.matchEnter(session, line)[1], line);
  dispose();
});

test('presentation does not invent a row, re-query, bypass filtering, or decorate an unrelated same-name command', async () => {
  const {menu, a} = setup(); const dispose = client.attachCommandFace(a.get('commandUi'), text);
  for (const result of [[], [otherA], [{...ownRow, hint: 'different'}], [{...ownRow, description: 'different'}]]) {
    const before = menu.calls.length;
    assert.equal(await menu.source.candidates(session, request({query: '项目', result})), result);
    assert.equal(menu.calls.length, before + 1);
  }
  dispose();
});

test('the actual Client apply owns locale and adapter effects, and restores the prototype on unload', async () => {
  const {ctx, menu} = setup(); let registered = false, dictionaries, language = 'zh';
  ctx.reflect.provide('locale', {
    register(namespace, value) {assert.equal(namespace, 'localCodexMcp'); registered = true; dictionaries = value; return () => {registered = false;};},
    bind() {return key => {assert.equal(registered, true); return dictionaries[language][key];};},
  });
  const owner = ctx.plugin(client); await owner;
  assert.equal((await menu.source.candidates(session, request()))[1].label, '项目 MCP');
  language = 'en'; const english = await menu.source.candidates(session, request());
  assert.equal(english[1].label, 'Project MCP'); assert.match(english[1].description, /OAuth sign-in/);
  const waiting = deferred(), pending = menu.source.candidates(session, request({wait: waiting.promise}));
  await owner.dispose(); waiting.resolve();
  assert.equal(await pending, nativeRows); assert.equal(registered, false);
  assert.equal(ownDescriptor(menu), undefined); assert.equal(await menu.source.candidates(session, request()), nativeRows);
});

test('native candidate effects remain owned by the caller plugin, not the presentation plugin', async () => {
  const {ctx} = setup(), cleaned = [];
  const owner = ctx.plugin({apply(scope) {scope.effect(() => client.attachCommandFace(scope.get('commandUi'), text));}}); await owner;
  const caller = ctx.plugin({async apply(scope) {
    await scope.extend({caller: 'native-caller'}).get('commandUi').candidates(session, request({cleanup: value => cleaned.push(value)}));
  }}); await caller;
  await owner.dispose(); assert.deepEqual(cleaned, []);
  await caller.dispose(); assert.deepEqual(cleaned, ['native-caller']);
});

test('original exceptions and aborted requests propagate unchanged', async () => {
  const {menu, a} = setup(); let warned = 0;
  const dispose = client.attachCommandFace(a.get('commandUi'), text, () => {++warned;});
  const failure = new Error('synthetic native failure');
  await assert.rejects(menu.source.candidates(session, request({failure})), value => value === failure);
  const controller = new AbortController(); controller.abort(failure);
  await assert.rejects(menu.source.candidates(session, request({signal: controller.signal})), value => value === failure);
  assert.equal(warned, 0); dispose();
});

test('a presentation/locale failure falls back to native rows and reports only once', async () => {
  const {menu, a} = setup(); let warned = 0;
  const dispose = client.attachCommandFace(a.get('commandUi'), () => {throw new Error('synthetic locale unavailable');}, () => {++warned;});
  for (let i = 0; i < 2; ++i) assert.equal(await menu.source.candidates(session, request()), nativeRows);
  assert.equal(warned, 1); dispose();
});

test('existing own method descriptors are fully restored', async () => {
  const {menu, a} = setup();
  Object.defineProperty(menu, 'candidates', {value: Menu.prototype.candidates, enumerable: true, writable: false, configurable: true});
  const before = ownDescriptor(menu), dispose = client.attachCommandFace(a.get('commandUi'), text);
  assert.equal((await menu.source.candidates(session, request()))[1].label, '项目 MCP');
  dispose(); assert.deepEqual(ownDescriptor(menu), before);
});

test('non-configurable or unknown interfaces fail closed without changing native command handling', async () => {
  const {menu, a} = setup(); let warned = 0;
  Object.defineProperty(menu, 'candidates', {value: Menu.prototype.candidates, writable: false, configurable: false});
  const before = ownDescriptor(menu), dispose = client.attachCommandFace(a.get('commandUi'), text, () => {++warned;});
  assert.equal(await menu.source.candidates(session, request()), nativeRows); dispose();
  assert.deepEqual(ownDescriptor(menu), before);
  let getterCalled = 0;
  const unsupported = Object.defineProperty({}, 'candidates', {get() {++getterCalled; throw new Error('not a data method');}});
  client.attachCommandFace(unsupported, text, () => {++warned;})();
  assert.equal(getterCalled, 0); assert.equal(warned, 2);
});

test('unload does not remove a later independent wrapper; the inner presentation becomes inert', async () => {
  const {menu, a} = setup(), dispose = client.attachCommandFace(a.get('commandUi'), text);
  const wrapped = ownDescriptor(menu).value;
  async function outside(...args) {return Reflect.apply(wrapped, this, args);}
  Object.defineProperty(menu, 'candidates', {value: outside, writable: true, configurable: true});
  dispose(); assert.equal(ownDescriptor(menu).value, outside);
  assert.equal(await menu.source.candidates(session, request()), nativeRows);
  // Unknown wrappers own their own teardown; we intentionally do not dismantle them.
});

test('unexpected non-array native results are passed through unchanged', async () => {
  const {menu, a} = setup(), dispose = client.attachCommandFace(a.get('commandUi'), text);
  const result = {unexpected: true};
  assert.equal(await menu.source.candidates(session, request({result})), result); dispose();
});
