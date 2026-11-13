import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createScope} from '@deepseek-ai/dsh-scope';
import {ProjectSession} from '../runtime.js';
import {registerActivationProjection} from '../activation.js';
import {parseProjectConfig, configDigest} from '../config.js';
import {saveTrust, trustKey, trustAuthority} from '../project.js';
import {clipText} from '../limits.js';
import * as managerPlugin from '../index.js';

const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-mcp-client'));
const {Context} = await import(require.resolve('@deepseek-ai/cordis'));
const {default: ToolsService} = await import(require.resolve('@deepseek-ai/dsh-tools'));
const {Session, buildForkSeed} = await import(require.resolve('@deepseek-ai/dsh-session'));
const {SessionProjectionRegistry} = await import(require.resolve('@deepseek-ai/dsh-session-projection'));
const signal = () => new AbortController().signal;
const name = (server = 'demo', index = 0) => `mcp__${server}__tool_${index}`;
const snapshot = (text, root = '/synthetic-project') => ({root, target: {}, digest: configDigest(text), ...parseProjectConfig(text)});
const config = (servers = ['demo']) => servers.map(server => `[mcp_servers.${server}]\nurl="https://${server}.example.test/mcp"`).join('\n');

async function harness(t, options = {}) {
  const ctx = new Context();
  const sections = [];
  ctx.reflect.provide('systemPrompt', {tools: () => () => {}, getSectionOrder: () => 10,
    section: section => {sections.push(section); return () => {};}});
  new ToolsService(ctx); new SessionProjectionRegistry(ctx);
  const records = new Map();
  const credentials = {
    readRecord: async key => records.get(key),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(records.get(key));
      if (next !== undefined) {records.set(key, next); ctx.emit('credentials/record-updated', key);}
      return records.get(key);
    },
    deleteRecord: async key => {if (records.delete(key)) ctx.emit('credentials/record-updated', key);},
  };
  ctx.reflect.provide('credentials', credentials);
  ctx.reflect.provide('fs', {watch: async () => {throw new Error('Synthetic filesystem has no watch');}});
  let current = snapshot(options.text ?? config());
  const revisions = new Map(), connections = [], oauthManagers = [], projects = [];
  const counts = {connects: 0, oauth: 0, business: 0, reads: 0};
  class FakeConnection {
    constructor(settings) {
      Object.assign(this, settings); this.tools = new Map(); this.disposers = []; this.state = 'stopped'; this.stopped = false;
      const rawInstructions = `BEGIN_${this.server.name}\n` + '远程说明🙂'.repeat(5000);
      this.instructionsBytes = Buffer.byteLength(rawInstructions);
      this.instructions = clipText(rawInstructions, 32768); connections.push(this);
    }
    async connect() {
      ++counts.connects; await this.validate();
      if (this.stopped) return;
      const revision = revisions.get(this.server.name) ?? 1;
      for (let index = 0; index < 120; ++index) {
        const rawName = `tool_${index}`, publicName = name(this.server.name, index);
        if (this.server.enabledTools && !this.server.enabledTools.includes(rawName)) continue;
        if (this.server.disabledTools.includes(rawName)) continue;
        const raw = {name: rawName, description: index === 119 ? '大'.repeat(1500) : `Synthetic ${rawName} revision ${revision}`,
          inputSchema: {type: 'object', properties: {value: {type: 'integer'}}, additionalProperties: false}};
        const signature = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
        const definition = {name: publicName, description: raw.description, parameters: raw.inputSchema,
          output: {schema: {type: 'object'}, render: () => []}, execute: async (_args, exec) => {
            assert.equal(exec.agent, this.agent); await this.validate(); ++counts.business; return {};
          }};
        const schemaBytes = Buffer.byteLength(JSON.stringify({name: publicName, description: definition.description, parameters: definition.parameters}));
        this.tools.set(publicName, {name: publicName, rawName, signature, schemaBytes, definition, annotations: {readOnlyHint: true}});
        this.disposers.push(this.ctx.tools.register(definition, {when: context => !this.stopped && this.state === 'ready' &&
          context.agent === this.agent && this.selected(publicName, signature, context)}));
      }
      this.state = 'ready';
    }
    clearTools() {for (const dispose of this.disposers.splice(0)) dispose(); this.tools.clear();}
    publish(state) {this.state = state;}
    async closeGeneration() {this.clearTools(); this.state = 'stopped';}
    async dispose() {this.stopped = true; await this.closeGeneration();}
    status() {return {name: this.server.name, state: this.state, tools: this.tools.size};}
  }
  class FakeOAuth {
    constructor(settings) {Object.assign(this, settings); ++counts.oauth; oauthManagers.push(this); this.state = 'authorized';}
    async status() {return {state: this.state};}
    async logout() {this.state = 'need_auth';}
    async cancel() {} async dispose() {}
  }
  let activation;
  const owner = ctx.plugin({name: 'progressive-lifecycle-fixture', inject: ['tools', 'sessionProjections'], async apply(scope) {
    activation = await registerActivationProjection(scope);
    scope.tools.register({name: 'codex_mcp', description: 'Synthetic manager', parameters: {type: 'object'},
      output: {schema: {type: 'object'}, render: () => []}, execute: async () => ({})});
  }});
  await owner;
  const create = async (id = 'lifecycle-session', seed) => {
    const session = seed ? Session.create(id, seed.events, seed.header, seed.inheritedCount) : Session.create(id);
    const agent = {id, session}; const agentScope = createScope(owner.ctx, agent); agent.ctx = agentScope.ctx;
    const project = new ProjectSession(owner.ctx, agent, {activation, limits: options.limits,
      read: async () => {++counts.reads; return current;}, Connection: FakeConnection, OAuth: FakeOAuth});
    projects.push({project, agentScope}); await project.reconcile(); return {agent, session, project};
  };
  t.after(async () => {for (const {project, agentScope} of projects.reverse()) {await project.dispose(); await agentScope.dispose();} await owner.dispose();});
  if (options.trusted !== false) await saveTrust(credentials, current);
  const primary = await create();
  return {ctx, owner, activation, credentials, records, counts, sections, connections, oauthManagers, revisions, create, ...primary,
    get current() {return current;}, set current(value) {current = value;}};
}

async function admitted(h, agent = h.agent) {
  const toolSet = await h.ctx.tools.resolve({agent, modelSelection: {provider: 'synthetic', model: 'synthetic'}, signal: signal()});
  return {toolSet, names: h.ctx.tools.schemas(agent, toolSet).map(tool => tool.name).sort()};
}
let callCount = 0;
function commit(h, selected, loaded, owner = h) {
  const callId = `load-${++callCount}`;
  const started = owner.session.append('tool/call', {turn: 1, step: callCount, callId, name: 'codex_mcp',
    arguments: JSON.stringify({action: 'load', names: selected})});
  owner.session.append('tool/result', {turn: 1, step: callCount,
    message: {id: `result-${callCount}`, role: 'tool', source: {kind: 'tool', callId}, toolCallId: callId,
      content: [{type: 'text', text: 'Display intentionally omits the receipt.'}], isError: false},
    meta: {codexMcpActivation: loaded.activation,
      codexMcpInstructions: {version: 1, sessionId: owner.session.id, spentBytes: loaded.instructionBytesSpent}}},
    {surfaceOp: 'append', sourceEventSeqs: [started.seq]});
}
async function load(h, selected, owner = h) {
  const value = await owner.project.perform('load', {names: selected}, signal()); commit(h, selected, value, owner); return value;
}
const only = (...selected) => ['codex_mcp', ...selected].sort();

test('large catalogs stay dormant until a successful native result commits; loading replaces and clears', async t => {
  const h = await harness(t);
  assert.equal(h.project.connections.get('demo').tools.size, 120);
  assert.deepEqual((await admitted(h)).names, only());
  const catalog = await h.project.perform('tools');
  assert.equal(catalog.total, 120); assert.equal(catalog.tools.length, 10);
  assert.equal(catalog.tools.every(tool => !tool.loaded), true);
  await h.project.perform('search', {query: 'tool_1'});
  assert.deepEqual((await admitted(h)).names, only());
  const value = await h.project.perform('load', {names: [name()]}, signal());
  assert.equal(value.effective, 'next-step-after-successful-log-commit');
  assert.deepEqual((await admitted(h)).names, only());
  commit(h, [name()], value);
  assert.deepEqual((await admitted(h)).names, only(name()));
  await load(h, [name('demo', 1), name('demo', 2)]);
  assert.deepEqual((await admitted(h)).names, only(name('demo', 1), name('demo', 2)));
  await load(h, []); assert.deepEqual((await admitted(h)).names, only());
  assert.equal(h.counts.business, 0);
});

test('unknown, duplicate, excess count and schema-byte loads preserve the last committed selection', async t => {
  const h = await harness(t, {limits: {maxSchemaBytes: 1024}}); await load(h, [name()]);
  const before = h.activation.stateOf(h.session).activation;
  for (const selected of [[name('unknown')], [name(), name()], Array.from({length: 9}, (_, i) => name('demo', i)),
    [name('demo', 119)], ['bad name'], ['x'.repeat(65)]]) {
    await assert.rejects(h.project.perform('load', {names: selected}, signal()));
    assert.equal(h.activation.stateOf(h.session).activation, before);
    assert.deepEqual((await admitted(h)).names, only(name()));
  }
  const limited = await harness(t, {limits: {maxActiveTools: 1}});
  await assert.rejects(limited.project.perform('load', {names: [name(), name('demo', 1)]}, signal()));
  assert.deepEqual((await admitted(limited)).names, only());
});

test('Agent scopes, copied fork history and serialized same-id restoration remain isolated', async t => {
  const h = await harness(t); await load(h, [name()]);
  const sibling = await h.create('sibling');
  assert.deepEqual((await admitted(h, sibling.agent)).names, only());
  assert.deepEqual((await admitted(h)).names, only(name()));
  const original = JSON.parse(JSON.stringify({events: h.session.snapshotEvents(), header: h.session.header}));
  const childHeader = {...original.header, id: 'fork-child', isSeeded: true};
  const forkEvents = buildForkSeed(original.events, original.events.at(-1).seq);
  const child = await h.create('fork-child', {events: forkEvents, header: childHeader, inheritedCount: original.events.length});
  assert.equal(h.activation.stateOf(child.session).inheritedCount, original.events.length);
  assert.equal(h.activation.stateOf(child.session).activation, null);
  assert.deepEqual((await admitted(h, child.agent)).names, only());
  const resumed = await h.create('lifecycle-session', original);
  assert.deepEqual((await admitted(h, resumed.agent)).names, only(name()));
  assert.equal(h.activation.stateOf(resumed.session).activation.sessionId, h.session.id);
});

test('instructions travel only in load results and obey per-server and lifetime UTF-8 budgets', async t => {
  const h = await harness(t, {text: config(['alpha', 'beta', 'gamma'])});
  assert.equal(h.counts.connects, 3); assert.equal(h.counts.oauth, 3);
  assert.equal(h.project.phase, 'loaded'); assert.equal(h.sections.length, 0);
  assert.equal(h.activation.stateOf(h.session).instructionsSpent, 0);
  const single = await load(h, [name('beta')]);
  assert.match(single.instructions, /MCP server beta instructions/); assert.match(single.instructions, /BEGIN_beta/);
  assert.match(single.instructions, /MCP instructions truncated/);
  assert.doesNotMatch(single.instructions, /server alpha|server gamma|BEGIN_alpha|BEGIN_gamma/);
  assert.equal(Buffer.byteLength(single.instructions) <= 2048, true);
  assert.equal(single.instructionBytesSpent, Buffer.byteLength(single.instructions));
  const all = await load(h, [name('alpha'), name('beta'), name('gamma')]);
  const total = Buffer.byteLength(single.instructions) + Buffer.byteLength(all.instructions);
  assert.equal(total <= 8192, true); assert.equal(all.instructions.includes('\ufffd'), false);
  assert.equal(all.instructionBytesSpent, total);
  assert.equal(h.activation.stateOf(h.session).instructionsSpent, total);
  for (const server of ['alpha', 'beta', 'gamma']) assert.match(all.instructions, new RegExp(`MCP server ${server} instructions`));
  const cleared = await load(h, []);
  assert.equal(cleared.instructions, ''); assert.equal(cleared.instructionBytesSpent, total);
  const again = await load(h, [name('beta')]);
  assert.equal(total + Buffer.byteLength(again.instructions) <= 8192, true);
  assert.equal(h.activation.stateOf(h.session).instructionsSpent, again.instructionBytesSpent);
  await h.project.human('untrust', signal()); await h.project.queue;
  await h.project.human(`trust ${h.current.digest}`, signal());
  const regranted = await load(h, [name('beta')]);
  assert.equal(regranted.instructions, ''); assert.equal(regranted.instructionBytesSpent, again.instructionBytesSpent);
  const tight = await harness(t, {text: config(['alpha', 'beta', 'gamma']), limits: {instructionsTotalBytes: 1024}});
  const clipped = await load(tight, [name('alpha'), name('beta'), name('gamma')]);
  assert.equal(Buffer.byteLength(clipped.instructions) <= 1024, true); assert.match(clipped.instructions, /MCP instructions truncated/);
  assert.equal(clipped.instructions.includes('\ufffd'), false);
  for (const limits of [{instructionsPerServerBytes: 0}, {instructionsTotalBytes: 0}]) {
    const disabled = await harness(t, {limits}); const value = await load(disabled, [name()]);
    assert.equal(value.instructions, ''); assert.equal(value.instructionBytesSpent, 0);
  }
});

test('uncommitted loads reserve only in-memory allowance and out-of-order successful logs cannot refund it', async t => {
  const h = await harness(t, {limits: {instructionsTotalBytes: 3072}});
  const first = await h.project.perform('load', {names: [name()]}, signal());
  const second = await h.project.perform('load', {names: [name('demo', 1)]}, signal());
  const third = await h.project.perform('load', {names: [name('demo', 2)]}, signal());
  const delivered = [first, second, third].reduce((sum, value) => sum + Buffer.byteLength(value.instructions), 0);
  assert.equal(delivered <= 3072, true); assert.equal(third.instructions, '');
  assert.equal(h.activation.stateOf(h.session).instructionsSpent, 0);
  assert.equal(h.project.instructionsReserved, delivered);
  commit(h, [name('demo', 1)], second); commit(h, [name()], first);
  assert.equal(h.activation.stateOf(h.session).instructionsSpent, delivered);
});

test('same-id resume and forks preserve inherited instruction spending without inheriting tool authority', async t => {
  const h = await harness(t, {limits: {instructionsTotalBytes: 3072}});
  const first = await load(h, [name()]); const spent = Buffer.byteLength(first.instructions);
  const original = JSON.parse(JSON.stringify({events: h.session.snapshotEvents(), header: h.session.header}));
  const resumed = await h.create('lifecycle-session', original);
  assert.equal(h.activation.stateOf(resumed.session).instructionsSpent, spent);
  const next = await load(h, [name()], resumed);
  assert.equal(spent + Buffer.byteLength(next.instructions) <= 3072, true);
  assert.equal(next.instructionBytesSpent, h.activation.stateOf(resumed.session).instructionsSpent);
  const forkEvents = buildForkSeed(original.events, original.events.at(-1).seq);
  const child = await h.create('budget-fork', {events: forkEvents, inheritedCount: original.events.length,
    header: {...original.header, id: 'budget-fork', isSeeded: true}});
  assert.equal(h.activation.stateOf(child.session).instructionsSpent, spent);
  assert.equal(h.activation.stateOf(child.session).activation, null);
  assert.deepEqual((await admitted(h, child.agent)).names, only());
  const fresh = await load(h, [name()], child);
  assert.equal(fresh.instructionBytesSpent, spent + Buffer.byteLength(fresh.instructions));
  assert.equal(fresh.instructionBytesSpent <= 3072, true);
  assert.equal(Buffer.byteLength(fresh.instructions) <= 3072 - spent, true);
});

test('a fork inheriting an exhausted 8KiB history cannot receive fresh instructions', async t => {
  const h = await harness(t);
  for (let i = 0; i < 5; ++i) await load(h, [name()]);
  assert.equal(h.activation.stateOf(h.session).instructionsSpent, 8192);
  const parentEvents = JSON.parse(JSON.stringify(h.session.snapshotEvents()));
  const forkEvents = buildForkSeed(parentEvents, parentEvents.at(-1).seq);
  const child = await h.create('exhausted-fork', {events: forkEvents, inheritedCount: parentEvents.length,
    header: {...h.session.header, id: 'exhausted-fork', isSeeded: true}});
  const inherited = h.activation.stateOf(child.session);
  assert.equal(inherited.instructionsSpent, 8192); assert.equal(inherited.activation, null);
  assert.deepEqual(inherited.pending, []);
  assert.deepEqual((await admitted(h, child.agent)).names, only());
  const loaded = await load(h, [name()], child);
  assert.equal(loaded.instructions, ''); assert.equal(loaded.instructionBytesSpent, 8192);
  assert.deepEqual((await admitted(h, child.agent)).names, only(name()));
});

test('an explicit empty enabled_tools list creates neither a connection nor an OAuth manager', async t => {
  const h = await harness(t, {text: config() + '\nenabled_tools=[]'});
  assert.equal(h.counts.connects, 0); assert.equal(h.counts.oauth, 0);
  assert.equal(h.connections.length, 0); assert.equal(h.oauthManagers.length, 0);
  const status = await h.project.status();
  assert.equal(status.servers[0].state, 'no-tools'); assert.equal(status.servers[0].tools, 0);
  assert.deepEqual((await admitted(h)).names, only());
});

test('untrust/retrust and external trust deletion cannot resurrect an old activation receipt', async t => {
  const h = await harness(t); await load(h, [name()]);
  const sibling = await h.create('revocation-sibling'); await load(h, [name('demo', 1)], sibling);
  assert.deepEqual((await admitted(h, sibling.agent)).names, only(name('demo', 1)));
  const oldAuthority = h.project.authority;
  await h.project.human('untrust', signal()); await h.project.queue;
  assert.deepEqual((await admitted(h)).names, only());
  assert.deepEqual((await admitted(h, sibling.agent)).names, only());
  await h.project.human(`trust ${h.current.digest}`, signal()); await sibling.project.reconcile();
  assert.notEqual(h.project.authority, oldAuthority);
  assert.deepEqual((await admitted(h)).names, only());
  assert.deepEqual((await admitted(h, sibling.agent)).names, only());
  await load(h, [name()]); assert.deepEqual((await admitted(h)).names, only(name()));
  await h.credentials.deleteRecord(trustKey(h.current.root));
  assert.deepEqual((await admitted(h)).names, only());
  await h.project.reconcile();
  await saveTrust(h.credentials, h.current); await h.project.reconcile();
  assert.deepEqual((await admitted(h)).names, only());
  await load(h, [name()]);
  // Simulate a backend edit not yet delivered by its notification feed. when still rereads authority.
  h.records.delete(trustKey(h.current.root));
  const generation = h.project.generation;
  assert.deepEqual((await admitted(h)).names, only());
  assert.equal(h.project.generation, generation);
  assert.equal(h.project.connections.get('demo').tools.size, 120);
});

test('readonly resolve detects config/authority changes before pre-step, and observed A-B-A stays revoked', async t => {
  const h = await harness(t); await load(h, [name()]);
  const a = h.current, generation = h.project.generation, connects = h.counts.connects;
  h.current = snapshot(config() + '\n# observed configuration B');
  assert.deepEqual((await admitted(h)).names, only());
  assert.equal(h.project.generation, generation); assert.equal(h.counts.connects, connects);
  await h.project.reconcile();
  assert.equal(h.project.phase, 'needs-trust');
  h.current = a; await h.project.reconcile();
  assert.equal(await trustAuthority(h.credentials, a), undefined);
  assert.deepEqual((await admitted(h)).names, only());
  await h.project.human(`trust ${a.digest}`, signal());
  assert.deepEqual((await admitted(h)).names, only());
  await load(h, [name()]); assert.deepEqual((await admitted(h)).names, only(name()));
  h.current = {...a, root: '/synthetic-other-project'};
  assert.deepEqual((await admitted(h)).names, only());
});

test('logout rotates project-wide activation authority and invalidates selections on every server', async t => {
  const h = await harness(t, {text: config(['alpha', 'beta'])}); await load(h, [name('alpha'), name('beta')]);
  const oldAuthority = h.project.authority;
  await h.project.human('logout alpha', signal());
  const nextAuthority = await trustAuthority(h.credentials, h.current);
  assert.ok(nextAuthority); assert.notEqual(nextAuthority, oldAuthority);
  assert.deepEqual((await admitted(h)).names, only());
  await h.project.reconcile(); assert.equal(h.project.authority, nextAuthority);
  assert.deepEqual((await admitted(h)).names, only());
  await load(h, [name('beta')]); assert.deepEqual((await admitted(h)).names, only(name('beta')));
});

test('unchanged force reload restores selected names while changed signatures require a fresh load', async t => {
  const h = await harness(t); await load(h, [name()]);
  const original = h.activation.stateOf(h.session).activation;
  await h.project.reconcile({force: true});
  assert.equal(h.activation.stateOf(h.session).activation, original);
  assert.deepEqual((await admitted(h)).names, only(name()));
  h.revisions.set('demo', 2); await h.project.reconcile({force: true});
  assert.deepEqual((await admitted(h)).names, only());
  assert.equal(h.project.activeTools().length, 0);
  await load(h, [name()]); assert.deepEqual((await admitted(h)).names, only(name()));
  assert.notEqual(h.activation.stateOf(h.session).activation.tools[0].signature, original.tools[0].signature);
  const admittedBeforeDispose = await admitted(h);
  await h.project.dispose();
  assert.deepEqual((await admitted(h)).names, only());
  assert.equal(h.ctx.tools.executable(name(), h.agent, admittedBeforeDispose.toolSet), undefined);
  assert.equal(h.counts.business, 0);
});

test('actual management output renders instructions once as a separate block and emits both strict metadata receipts', async t => {
  const h = await harness(t); const value = await load(h, [name()]);
  let management;
  // Capture the actual production definition without entering any Agent or reading a real project.
  await managerPlugin.apply({
    sessionProjections: {register: async () => h.activation},
    tools: {register: definition => {management = definition; return () => {};}},
    commands: {register: () => () => {}}, agents: {list: () => []},
    effect: () => () => {}, on: () => () => {},
  });
  assert.equal(management.name, 'codex_mcp');
  const blocks = management.output.render({action: 'load'}, value);
  assert.equal(blocks.length, 2); assert.equal(blocks[0].type, 'text'); assert.equal(blocks[1].type, 'text');
  assert.equal(Object.hasOwn(JSON.parse(blocks[0].text), 'instructions'), false);
  assert.equal(blocks[0].text.includes('BEGIN_demo'), false);
  assert.equal(blocks[1].text, value.instructions);
  const metadata = management.output.presentationMeta({action: 'load'}, value);
  assert.deepEqual(metadata.codexMcpActivation, value.activation);
  assert.deepEqual(metadata.codexMcpInstructions, {version: 1, sessionId: h.session.id, spentBytes: value.instructionBytesSpent});
  assert.deepEqual(management.output.presentationMeta({action: 'status'}, value), {});
  assert.throws(() => management.output.presentationMeta({action: 'load'}, {...value, instructionBytesSpent: 32769}));
  assert.throws(() => management.output.presentationMeta({action: 'load'}, {...value, activation: {...value.activation, version: 2}}));
  const without = management.output.render({action: 'load'}, {...value, instructions: ''});
  assert.equal(without.length, 1);
});
