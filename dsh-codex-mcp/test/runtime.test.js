import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectSession} from '../runtime.js';
import {saveTrust} from '../project.js';
import {parseProjectConfig, configDigest} from '../config.js';

function harness(text = '[mcp_servers.demo]\nurl="https://example.test/mcp"', options = {}) {
  let current = {root: '/synthetic-project', target: {}, digest: configDigest(text), ...parseProjectConfig(text)};
  const records = new Map(), callbacks = new Map();
  const credentials = {readRecord: async key => records.get(key),
    modifyRecord: async (key, fn) => { const value = await fn(records.get(key)); if (value !== undefined) records.set(key, value); return records.get(key); },
    deleteRecord: async key => records.delete(key)};
  const ctx = {credentials, fs: {watch: async () => { throw new Error('unsupported'); }}, get: () => undefined,
    on: (name, fn) => callbacks.set(name, fn)};
  class FakeConnection {
    constructor(options) { Object.assign(this, options); this.tools = new Map(); this.state = 'stopped'; }
    async connect() { await this.validate(); this.state = 'ready'; this.tools.set('mcp__demo__tool', {name: 'mcp__demo__tool', rawName: 'tool'}); }
    clearTools() { this.tools.clear(); }
    async closeGeneration() { this.clearTools(); }
    async dispose() { this.clearTools(); this.state = 'stopped'; }
    status() { return {name: this.server.name, state: this.state, tools: this.tools.size}; }
  }
  class FakeOAuth {
    state = 'need_auth'; started = 0; cancelled = 0;
    async dispose() {} async logout() {this.state = 'need_auth';}
    async cancel() {++this.cancelled; this.state = 'need_auth';}
    async status() {return {state: this.state};}
    async startLogin() {++this.started; this.state = 'pending'; return {url: 'https://example.test/authorize', expiresAt: 123};}
  }
  const agent = {id: 'fake-agent'}, opened = [];
  const session = new ProjectSession(ctx, agent, {scope: {ctx, dispose: async () => {}}, read: async () => {
    if (current instanceof Error) throw current; return current;
  }, Connection: FakeConnection, OAuth: FakeOAuth,
    openBrowser: async (...args) => {opened.push(args); return options.openBrowser ? options.openBrowser(...args) : {state: 'requested'};}});
  return {session, agent, ctx, credentials, callbacks, opened, get current() { return current; }, set current(value) { current = value; }};
}

test('untrusted configuration never creates connections; only explicit human trust starts servers', async t => {
  const h = harness(); t.after(() => h.session.dispose());
  const state = await h.session.status(); assert.equal(state.phase, 'needs-trust'); assert.equal(h.session.connections.size, 0);
  await assert.rejects(h.session.perform('trust'), /UNKNOWN_ACTION/);
  await assert.rejects(h.session.human('trust wrong'), /请/);
  await h.session.human(`trust ${h.current.digest}`);
  assert.equal((await h.session.status()).phase, 'loaded'); assert.equal(h.session.connections.size, 1);
  await h.session.human('untrust'); assert.equal(h.session.connections.size, 0);
});
test('configuration mutation revokes old tools and requires new digest', async t => {
  const h = harness(); t.after(() => h.session.dispose()); await saveTrust(h.credentials, h.current); await h.session.reconcile();
  const old = h.session.connections.get('demo'); assert.equal(old.tools.size, 1);
  h.current = {...h.current, digest: configDigest('changed')};
  await assert.rejects(h.session.validate(h.session.generation), /STALE_PROJECT/);
  assert.equal(old.tools.size, 0); await h.session.queue;
  assert.equal((await h.session.status()).phase, 'needs-trust');
});
test('malformed configuration fails closed and removes existing registrations', async t => {
  const h = harness(); t.after(() => h.session.dispose()); await saveTrust(h.credentials, h.current); await h.session.reconcile();
  h.current = new Error('SYNTHETIC_SECRET_SHOULD_NOT_LEAK');
  const state = await h.session.status(); assert.equal(state.phase, 'error'); assert.equal(h.session.connections.size, 0);
  assert.doesNotMatch(JSON.stringify(state), /SYNTHETIC_SECRET/);
});
test('approve delegates downstream decisions; auto/prompt/writes ask conservatively', async t => {
  const h = harness('[mcp_servers.demo]\nurl="https://example.test/mcp"\n[mcp_servers.demo.tools.tool]\napproval_mode="approve"');
  t.after(() => h.session.dispose()); await saveTrust(h.credentials, h.current); await h.session.reconcile();
  const hook = h.callbacks.get('tools/pre-execute'); const exec = {agent: h.agent, name: 'mcp__demo__tool'};
  assert.deepEqual(await hook(exec, async () => ({kind: 'allow'})), {kind: 'allow'});
  assert.equal((await hook(exec, async () => ({kind: 'deny', reason: 'policy'}))).kind, 'deny');
  const connection = h.session.connections.get('demo');
  for (const mode of ['auto', 'prompt', 'writes']) {
    connection.server.toolApprovals.tool = mode;
    assert.equal((await hook(exec, async () => ({kind: 'allow'}))).kind, 'ask');
  }
  connection.tools.get(exec.name).annotations = {readOnlyHint: true};
  connection.server.toolApprovals.tool = 'writes';
  assert.equal((await hook(exec, async () => ({kind: 'allow'}))).kind, 'allow');
  connection.server.toolApprovals.tool = 'prompt';
  assert.equal((await hook(exec, async () => ({kind: 'allow'}))).kind, 'ask');
  assert.equal((await hook({...exec, agent: {id: 'other'}}, async () => ({kind: 'allow'}))).kind, 'allow');
});
test('project roots cannot reuse another project trust and late callbacks cannot resurrect tools', async t => {
  const h = harness(); t.after(() => h.session.dispose()); await saveTrust(h.credentials, h.current); await h.session.reconcile();
  const oldGeneration = h.session.generation;
  h.current = {...h.current, root: '/different-project'};
  await h.session.reconcile(); assert.equal(h.session.trusted, false); assert.equal(h.session.connections.size, 0);
  await assert.rejects(h.session.validate(oldGeneration), /STALE_PROJECT/);
});
test('missing config is inert and tools results are bounded', async t => {
  const h = harness(); t.after(() => h.session.dispose());
  h.current = {...h.current, digest: undefined, servers: []};
  assert.equal((await h.session.status()).phase, 'no-config');
  assert.deepEqual((await h.session.perform('tools')).tools, []);
});

async function trusted(t, options) {
  const h = harness(undefined, options); t.after(() => h.session.dispose());
  await h.session.human(`trust ${h.current.digest}`); return h;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
}

test('human login opens one browser after trust and returns pending without blocking cancellation', async t => {
  const h = await trusted(t);
  const result = await h.session.human('login demo');
  assert.equal(result.state, 'waiting-for-user'); assert.equal(result.browser.state, 'requested');
  assert.equal(h.opened.length, 1); assert.equal(h.opened[0][0], result.url);
  assert.equal(h.session.auth.get('demo').state, 'pending');
  await h.session.human('cancel demo'); assert.equal(h.session.auth.get('demo').state, 'need_auth');
});

test('untrusted commands and model actions cannot initiate browser login; reload/status/tools never open it', async t => {
  const h = harness(); t.after(() => h.session.dispose());
  await assert.rejects(h.session.human('login demo'), /信任/);
  await assert.rejects(h.session.perform('login'), /UNKNOWN_ACTION/);
  assert.equal(h.opened.length, 0);
  await h.session.human(`trust ${h.current.digest}`);
  for (const action of ['status', 'tools', 'reload']) await h.session.perform(action);
  assert.equal(h.opened.length, 0); assert.equal(h.session.auth.get('demo').started, 0);
});

test('failed browser launch retains the URL and active callback, with no upstream exception text', async t => {
  for (const openBrowser of [async () => ({state: 'manual', reason: 'open_failed'}), async () => {throw new Error('FAKE_SECRET');}]) {
    const h = await trusted(t, {openBrowser});
    const result = await h.session.human('login demo');
    assert.equal(result.browser.state, 'manual'); assert.equal(result.state, 'waiting-for-user');
    assert.ok(result.url); assert.equal(h.session.auth.get('demo').state, 'pending');
    assert.equal(JSON.stringify(result).includes('FAKE_SECRET'), false);
  }
});

test('changed project configuration between URL creation and OS handoff cancels instead of opening', async t => {
  const h = await trusted(t), oauth = h.session.auth.get('demo');
  const start = oauth.startLogin.bind(oauth);
  oauth.startLogin = async () => {const result = await start(); h.current = {...h.current, digest: configDigest('changed')}; return result;};
  await assert.rejects(h.session.human('login demo'), /已变化/);
  assert.equal(h.opened.length, 0); assert.equal(oauth.cancelled, 1);
});

test('cancel racing browser startup cannot be reported as still waiting or cancel twice', async t => {
  const entered = deferred(), released = deferred();
  const h = await trusted(t, {openBrowser: async () => {entered.resolve(); await released.promise; return {state: 'requested'};}});
  const oauth = h.session.auth.get('demo');
  const login = assert.rejects(h.session.human('login demo'), /已取消/);
  await entered.promise; await h.session.human('cancel demo'); released.resolve(); await login;
  assert.equal(oauth.cancelled, 1); assert.equal(oauth.state, 'need_auth');
});

test('an older browser startup completing late cannot cancel a newer human login', async t => {
  const entered = deferred(), released = deferred(); let opened = 0;
  const h = await trusted(t, {openBrowser: async () => {
    if (++opened === 1) {entered.resolve(); await released.promise;}
    return {state: 'requested'};
  }});
  const old = assert.rejects(h.session.human('login demo'), /已取消/); await entered.promise;
  const latest = await h.session.human('login demo'); released.resolve(); await old;
  assert.equal(latest.state, 'waiting-for-user');
  assert.equal(h.session.auth.get('demo').cancelled, 0); assert.equal(h.session.auth.get('demo').state, 'pending');
});

test('a callback completed during browser launch is reported as authorized rather than still waiting', async t => {
  let h;
  h = await trusted(t, {openBrowser: async () => {h.session.auth.get('demo').state = 'authorized'; return {state: 'requested'};}});
  const result = await h.session.human('login demo');
  assert.equal(result.state, 'authorized'); assert.equal(result.url, undefined);
});
