import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createScope, scopeTarget} from '@deepseek-ai/dsh-scope';
import * as plugin from '../index.js';
import {parseProjectConfig, configDigest} from '../config.js';
import {ProjectSession} from '../runtime.js';
import {saveTrust} from '../project.js';

const scopeRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-scope'));
const bridgeRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-mcp-client'));
const {Context} = await import(scopeRequire.resolve('@deepseek-ai/cordis'));
const {default: ToolsService} = await import(bridgeRequire.resolve('@deepseek-ai/dsh-tools'));

function credentials() {
  const records = new Map(); return {readRecord: async key => records.get(key),
    modifyRecord: async (key, fn) => { const result = await fn(records.get(key)); if (result !== undefined) records.set(key, result); return records.get(key); },
    deleteRecord: async key => records.delete(key)};
}
function root() {
  const ctx = new Context();
  ctx.reflect.provide('systemPrompt', {tools: () => () => {}});
  new ToolsService(ctx);
  ctx.reflect.provide('credentials', credentials());
  ctx.reflect.provide('sessionProjections', {register: async () => ({stateOf: () => ({activation: null})})});
  ctx.reflect.provide('fs', {resolve: async value => ({displayPath: value}), processPath: target => target.displayPath,
    processPathFromHostPath: value => value, contains: () => true, stat: async () => undefined,
    watch: async () => () => {}});
  ctx.reflect.provide('workingDirectory', {get: () => '/synthetic-project'});
  ctx.reflect.provide('subprocess', {});
  return ctx;
}

test('real Cordis + DSH registry accepts plugin tool output and loads inert missing-config session', async t => {
  const ctx = root(), commands = new Map();
  ctx.reflect.provide('commands', {register: definition => {commands.set(definition.name, definition); return () => commands.delete(definition.name); }});
  const agent = {id: 'smoke', session: {}}; agent.ctx = createScope(ctx, agent).ctx;
  ctx.reflect.provide('agents', {list: () => [agent]});
  const owner = ctx.plugin(plugin); t.after(() => owner.dispose()); await owner;
  const tool = ctx.tools.get('codex_mcp'); assert.ok(tool); assert.ok(tool.output);
  const value = await tool.execute({action: 'status'}, {agent, signal: new AbortController().signal});
  assert.equal(value.phase, 'no-config'); assert.equal(value.trusted, false);
  assert.deepEqual(tool.output.render({}, value)[0].type, 'text');
  assert.equal(commands.has('codex-mcp'), true);
  const response = await commands.get('codex-mcp').handler({agent, rawInput: 'status', signal: new AbortController().signal});
  assert.equal(response.kind, 'success'); assert.equal(JSON.parse(response.text).phase, 'no-config');
});

test('real scoped registrations do not appear globally or in a sibling Agent and disappear on disposal', async t => {
  const ctx = root(), a = {id: 'a'}, b = {id: 'b'};
  const text = '[mcp_servers.demo]\nurl="https://example.test/mcp"';
  const snapshot = {root: '/synthetic-project', digest: configDigest(text), ...parseProjectConfig(text)};
  await saveTrust(ctx.credentials, snapshot);
  class FakeConnection {
    constructor(options) { Object.assign(this, options); this.tools = new Map(); }
    async connect() {
      const definition = {name: 'mcp__demo__ping', description: 'ping', parameters: {type: 'object'},
        output: {schema: {type: 'object'}, render: () => []}, execute: async () => ({})};
      this.unregister = this.ctx.tools.register(definition);
      this.tools.set(definition.name, {name: definition.name, rawName: 'ping'});
    }
    clearTools() { this.unregister?.(); this.tools.clear(); }
    async dispose() { this.clearTools(); }
  }
  class FakeOAuth { async dispose() {} }
  const owner = ctx.plugin({apply() {}}); await owner;
  const session = new ProjectSession(owner.ctx, a, {read: async () => snapshot, Connection: FakeConnection, OAuth: FakeOAuth});
  t.after(async () => {await session.dispose(); await owner.dispose();});
  await session.reconcile();
  assert.ok(ctx.tools.get('mcp__demo__ping', a)); assert.equal(ctx.tools.get('mcp__demo__ping'), undefined);
  assert.equal(ctx.tools.get('mcp__demo__ping', b), undefined);
  const decision = await ctx.waterfall(scopeTarget(ctx.tools, a), 'tools/pre-execute', {agent: a, name: 'mcp__demo__ping'}, async () => ({kind: 'allow'}));
  assert.equal(decision.kind, 'ask');
  await session.dispose(); assert.equal(ctx.tools.get('mcp__demo__ping', a), undefined);
});
