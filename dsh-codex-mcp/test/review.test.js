// Minimal regressions identified by read-only review. No real project config,
// external servers or cloud programs are used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createScope, bindScopeParent } from '@deepseek-ai/dsh-scope';
import { fileURLToPath } from 'node:url';
import { ProjectSession } from '../runtime.js';
import { parseProjectConfig, configDigest } from '../config.js';
import { saveTrust, isTrusted } from '../project.js';
import * as plugin from '../index.js';
import { stdioConnection } from './helpers.js';

const scopeRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-scope'));
const bridgeRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-mcp-client'));
const { Context } = await import(scopeRequire.resolve('@deepseek-ai/cordis'));
const { default: ToolsService } = await import(bridgeRequire.resolve('@deepseek-ai/dsh-tools'));
const source = '[mcp_servers.demo]\ncommand="synthetic-command-never-executed"';
const snapshot = { root: '/synthetic-review-project', target: {}, digest: configDigest(source), ...parseProjectConfig(source) };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function credentials() {
  const records = new Map();
  return {
    readRecord: async (key) => records.get(key),
    modifyRecord: async (key, fn) => { const value = await fn(records.get(key)); if (value !== undefined) records.set(key, value); },
    deleteRecord: async (key) => records.delete(key),
  };
}

test('review: descendant Agents must not inherit callable parent-project MCP routes', async (t) => {
  const ctx = new Context();
  ctx.reflect.provide('systemPrompt', { tools: () => () => {} });
  new ToolsService(ctx);
  ctx.reflect.provide('credentials', credentials());
  ctx.reflect.provide('fs', { watch: async () => () => {} });
  ctx.reflect.provide('subprocess', { resolveExecutable: async (command) => command });
  const fixture = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));
  const realSource = `[mcp_servers.demo]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([fixture])}\nenabled_tools=["echo"]`;
  const realSnapshot = { root: process.cwd(), target: {}, digest: configDigest(realSource), ...parseProjectConfig(realSource) };
  const parent = { id: 'parent-review' }, child = { id: 'child-other-project-review' };
  bindScopeParent(child, parent);
  const owner = ctx.plugin({ apply() {} });
  await owner;
  const session = new ProjectSession(owner.ctx, parent, { read: async () => realSnapshot });
  t.after(async () => { await session.dispose(); await owner.dispose(); });
  await saveTrust(ctx.credentials, realSnapshot);
  await session.reconcile();
  const parentDefinition = ctx.tools.get('mcp__demo__echo', parent);
  assert.ok(parentDefinition);
  const selection = await ctx.tools.resolve({ agent: child, signal: new AbortController().signal });
  t.after(() => selection.dispose());
  assert.equal(ctx.tools.executable('mcp__demo__echo', child, selection), undefined,
    'descendant step admission must exclude parent-project routes');
  await assert.rejects(parentDefinition.execute({}, { agent: child, signal: new AbortController().signal }),
    'a retained parent definition must independently reject a different Agent');
});

test('review: dispose racing an in-progress project read must drain connections created by that read', async (t) => {
  const store = credentials(), entered = deferred(), release = deferred();
  let scopeDisposed = false;
  const ctx = { credentials: store, on() {}, get() {}, fs: { watch: async () => () => {} } };
  const session = new ProjectSession(ctx, { id: 'dispose-race' }, {
    scope: { ctx, async dispose() { scopeDisposed = true; } },
    read: async () => { entered.resolve(); await release.promise; return snapshot; },
  });
  t.after(async () => { release.resolve(); await session.closeConnections(); await session.dispose(); });
  await saveTrust(store, snapshot);
  const loading = session.reconcile();
  await entered.promise;
  const disposing = session.dispose();
  // dispose has synchronously marked stopped and drained the old empty maps.
  release.resolve();
  await Promise.all([loading, disposing]);
  assert.equal(scopeDisposed, true);
  assert.equal(session.connections.size, 0, 'no late-created connection may survive disposal');
  assert.equal(session.auth.size, 0, 'no late-created OAuth manager may survive disposal');
});

test('review: untrust must preempt a pending connection startup rather than wait behind its queue', async (t) => {
  const store = credentials(), started = deferred(), stopStartup = deferred();
  const routes = new Set();
  const ctx = { credentials: store, on() {}, get() {}, fs: { watch: async () => () => {} } };
  class PendingConnection {
    constructor(options) {
      Object.assign(this, options); this.tools = new Map([['synthetic_schema', {}]]);
      routes.add('synthetic_schema');
    }
    async connect() { started.resolve(); await stopStartup.promise; }
    clearTools() { this.tools.clear(); routes.clear(); }
    async dispose() { this.clearTools(); stopStartup.resolve(); }
    status() { return { name: this.server.name, state: 'connecting', tools: this.tools.size }; }
  }
  const session = new ProjectSession(ctx, { id: 'untrust-review' }, {
    scope: { ctx, async dispose() {} }, read: async () => snapshot, Connection: PendingConnection,
  });
  await saveTrust(store, snapshot);
  const loading = session.reconcile();
  await started.promise;
  const revoking = session.human('untrust');
  let deadline;
  t.after(async () => {
    clearTimeout(deadline); stopStartup.resolve();
    await Promise.allSettled([loading, revoking]);
    await session.dispose();
  });
  assert.equal(routes.size, 0, 'revocation must withdraw schemas synchronously, before waiting for startup');
  const outcome = await Promise.race([
    revoking.then(() => 'revoked'),
    new Promise((resolve) => { deadline = setTimeout(() => resolve('blocked-by-startup'), 150); }),
  ]);
  clearTimeout(deadline);
  assert.equal(outcome, 'revoked', 'explicit revocation must cancel startup before awaiting the reconcile queue');
  assert.equal(session.trusted, false);
  assert.equal(session.connections.size, 0);
});

test('review: an in-flight validation must reject after a same-digest generation reload', async (t) => {
  const store = credentials(), entered = deferred(), release = deferred();
  let reads = 0;
  const ctx = { credentials: store, on() {}, get() {}, fs: { watch: async () => () => {} } };
  const inertSnapshot = { ...snapshot, servers: [] };
  const session = new ProjectSession(ctx, { id: 'validation-race' }, {
    scope: { ctx, async dispose() {} },
    read: async () => {
      reads++;
      if (reads === 2) { entered.resolve(); await release.promise; }
      return inertSnapshot;
    },
  });
  t.after(async () => { release.resolve(); await session.dispose(); });
  await saveTrust(store, inertSnapshot);
  await session.reconcile();
  const prior = session.generation;
  const pending = session.validate(prior).then(() => ({ passed: true }), (error) => ({ passed: false, error }));
  await entered.promise;
  await session.reconcile({ force: true });
  assert.notEqual(session.generation, prior);
  release.resolve();
  const outcome = await pending;
  assert.equal(outcome.passed, false, 'generation must be checked after asynchronous reads, not only at entry');
  assert.match(outcome.error.message, /STALE_PROJECT/);
});

test('review: listChanged sync cannot republish registrations while dispose waits for its queue', { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred();
  let holding = false, checks = 0;
  t.after(() => release.resolve());
  const handle = await stdioConnection(t, { validate: async () => {
    if (holding && ++checks === 2) { entered.resolve(); await release.promise; }
  } });
  await handle.value.connect();
  assert.equal(handle.value.state, 'ready');
  assert.ok(handle.ctx.registered.size > 0);
  holding = true;
  handle.value.scheduleSync();
  await entered.promise;
  const disposing = handle.value.dispose();
  assert.equal(handle.ctx.registered.size, 0, 'disposal synchronously withdraws existing routes');
  release.resolve();
  await disposing;
  assert.equal(handle.ctx.registered.size, 0, 'the old sync must not republish routes after teardown');
  assert.equal(handle.value.tools.size, 0);
  assert.equal(handle.value.state, 'stopped');
});

test('review: logout completing after force reload cannot overwrite the new generation or orphan its connection', async (t) => {
  const store = credentials(), entered = deferred(), release = deferred(), created = [];
  const httpSource = '[mcp_servers.demo]\nurl="https://synthetic.example.test/mcp"';
  const current = { root: snapshot.root, target: {}, digest: configDigest(httpSource), ...parseProjectConfig(httpSource) };
  const ctx = { credentials: store, on() {}, get() {}, fs: { watch: async () => () => {} } };
  class ObservedConnection {
    constructor(options) { Object.assign(this, options); this.tools = new Map(); created.push(this); }
    async connect() { await this.validate(); this.state = 'ready'; }
    clearTools() { this.tools.clear(); }
    publish(state) { this.state = state; }
    async dispose() { this.disposed = true; this.clearTools(); }
  }
  class PausedOAuth {
    constructor(options) { Object.assign(this, options); }
    async dispose() { this.disposed = true; }
    async logout() { entered.resolve(); await release.promise; }
  }
  const session = new ProjectSession(ctx, { id: 'logout-reload-review' }, {
    scope: { ctx, async dispose() {} }, read: async () => current,
    Connection: ObservedConnection, OAuth: PausedOAuth,
  });
  let loggingOut;
  t.after(async () => { release.resolve(); await loggingOut; await session.dispose(); });
  await saveTrust(store, current);
  await session.reconcile();
  loggingOut = session.human('logout demo');
  await entered.promise;
  await session.reconcile({ force: true });
  const newConnection = session.connections.get('demo');
  assert.equal(newConnection.disposed, undefined);
  release.resolve();
  await loggingOut;
  const live = session.connections.get('demo');
  assert.equal(live.oauth, session.auth.get('demo'), 'replacement must not retain the disposed old OAuth manager');
  assert.equal(created.filter((item) => !item.disposed && item !== live).length, 0,
    'a concurrent logout must not orphan the new generation connection');
});

test('review: a later untrust defeats an older trust paused during its confirmation read', async (t) => {
  const store = credentials(), entered = deferred(), release = deferred();
  let reads = 0, pendingTrust;
  const current = { ...snapshot, servers: [] };
  const ctx = { credentials: store, on() {}, get() {}, fs: { watch: async () => () => {} } };
  const session = new ProjectSession(ctx, { id: 'trust-untrust-review' }, {
    scope: { ctx, async dispose() {} },
    read: async () => {
      if (++reads === 3) { entered.resolve(); await release.promise; }
      return current;
    },
  });
  t.after(async () => { release.resolve(); await pendingTrust; await session.dispose(); });
  await session.reconcile();
  assert.equal(session.phase, 'needs-trust');
  pendingTrust = session.human(`trust ${current.digest}`).then(() => ({ passed: true }), (error) => ({ passed: false, error }));
  await entered.promise;
  const revoked = await session.human('untrust');
  assert.equal(revoked.trusted, false);
  release.resolve();
  await pendingTrust;
  await session.queue;
  assert.equal(session.locallyRevoked, true, 'the older trust must not clear a later revocation flag');
  assert.equal(session.trusted, false);
  assert.equal(await isTrusted(store, current), false, 'the older trust must not recreate the deleted grant');
});

test('review: human command errors cannot echo forged Chinese-prefix upstream secrets', async (t) => {
  const ctx = new Context(), commands = new Map();
  ctx.reflect.provide('systemPrompt', { tools: () => () => {} });
  new ToolsService(ctx);
  const store = credentials();
  store.modifyRecord = async () => { throw new Error('请 FAKE_UPSTREAM_SECRET_DO_NOT_ECHO'); };
  ctx.reflect.provide('credentials', store);
  ctx.reflect.provide('fs', {
    resolve: async (value) => ({ displayPath: value }), processPath: (target) => target.displayPath,
    processPathFromHostPath: (value) => value, contains: () => true,
    stat: async () => ({ type: 'file', size: Buffer.byteLength(source) }),
    readBytes: async () => Buffer.from(source), watch: async () => () => {},
  });
  ctx.reflect.provide('workingDirectory', { get: () => snapshot.root });
  ctx.reflect.provide('subprocess', {});
  ctx.reflect.provide('sessionProjections', {register: async () => ({stateOf: () => ({activation: null})})});
  ctx.reflect.provide('commands', { register: (definition) => { commands.set(definition.name, definition); return () => commands.delete(definition.name); } });
  const agent = { id: 'error-review', session: {} };
  agent.ctx = createScope(ctx, agent).ctx;
  ctx.reflect.provide('agents', { list: () => [agent] });
  const owner = ctx.plugin(plugin);
  t.after(() => owner.dispose());
  await owner;
  const response = await commands.get('codex-mcp').handler({
    agent, rawInput: `trust ${snapshot.digest}`, signal: new AbortController().signal,
  });
  assert.equal(response.kind, 'error');
  assert.equal(response.text.includes('FAKE_UPSTREAM_SECRET'), false,
    'prefix matching must not turn untrusted exception messages into trusted UI errors');
});
