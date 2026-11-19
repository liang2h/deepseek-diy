import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {registerActivationProjection} from '../activation.js';

const runtime = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'));
const load = name => import(runtime.resolve(name));
const {Context} = await load('@deepseek-ai/cordis');
const {Session} = await load('@deepseek-ai/dsh-session');
const {default: Projections} = await load('@deepseek-ai/dsh-session-projection');
const {default: Tools} = await load('@deepseek-ai/dsh-tools');

// Test the resolved packages, not only the edited manifest: a stale earlier
// environment must not be accepted as evidence for an rc.5 release.
test('compatibility target and every resolved DSH test surface are exactly rc.5', async t => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.engines.dsh, '0.2.2-rc.5');
  const declared = {...manifest.peerDependencies, ...manifest.devDependencies};
  for (const [name, version] of Object.entries(declared)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue;
    assert.equal(version, manifest.engines.dsh, name);
    const own = createRequire(import.meta.resolve(name));
    const installed = JSON.parse(await readFile(own.resolve(`${name}/package.json`), 'utf8'));
    assert.equal(installed.version, manifest.engines.dsh, name);
  }
  for (const name of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection',
    '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-system-prompt']) {
    const installed = JSON.parse(await readFile(runtime.resolve(`${name}/package.json`), 'utf8'));
    assert.equal(installed.version, manifest.engines.dsh, name);
  }
  // Follow actual resolution from every DSH package, not just a selected list.
  // A transitive rc.3 peer hidden behind an rc.5 direct dependency must fail.
  const queue = Object.keys(declared).filter(name => name.startsWith('@deepseek-ai/dsh-'))
    .map(name => createRequire(import.meta.url).resolve(`${name}/package.json`));
  const visited = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const resolved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(resolved.version, manifest.engines.dsh, `${resolved.name} at ${file}`);
    const own = createRequire(file);
    const edges = {...resolved.dependencies, ...resolved.peerDependencies};
    for (const name of Object.keys(edges).filter(name => name.startsWith('@deepseek-ai/dsh-'))) {
      let child;
      try { child = own.resolve(`${name}/package.json`); }
      catch (error) {
        if (resolved.peerDependenciesMeta?.[name]?.optional && error.code === 'MODULE_NOT_FOUND') continue;
        throw error;
      }
      assert.ok(path.isAbsolute(child));
      queue.push(child);
    }
  }
  assert.ok(visited.size > 20, 'the real DSH dependency graph must be traversed');
  t.diagnostic(`All ${visited.size} resolved DSH package instances, including transitive peers, are ${manifest.engines.dsh}.`);
});

test('rc.5 array Session.append preserves committed activation metadata and the instruction ledger', async t => {
  const ctx = new Context(); new Projections(ctx);
  let handle;
  const owner = ctx.plugin({name: 'compat-batch-projection', inject: ['sessionProjections'],
    async apply(scope) {handle = await registerActivationProjection(scope);}});
  await owner; t.after(() => owner.dispose());
  const session = Session.create('compat-batch-session');
  const name = 'mcp__local__read';
  const activation = {version: 1, sessionId: session.id, project: '/synthetic-compat-project',
    fingerprint: 'a'.repeat(64), authority: 'synthetic-human-grant', tools: [{name, signature: 'b'.repeat(64)}]};
  const input = (id, names, receipt, spentBytes) => [
    ['tool/call', {turn: 1, step: 1, callId: id, name: 'codex_mcp', arguments: JSON.stringify({action: 'load', names})}],
    ['tool/result', {turn: 1, step: 1,
      message: {id: `result-${id}`, role: 'tool', source: {kind: 'tool', callId: id}, toolCallId: id,
        content: [{type: 'text', text: 'Synthetic rc.5 successful completion.'}]},
      meta: {codexMcpActivation: receipt, codexMcpInstructions: {version: 1, sessionId: session.id, spentBytes}}},
    {surfaceOp: 'append'}],
  ];
  const appended = session.append(input('compat-load', [name], activation, 2048));
  assert.equal(appended.length, 2);
  assert.deepEqual(handle.stateOf(session).activation, activation);
  assert.equal(handle.stateOf(session).instructionsSpent, 2048);
  // rc.5 exposes detached checkpoint values. A cache consumer must not be
  // able to rewrite the live authority or refund instructions through a row.
  const checkpoint = ctx.sessionProjections.checkpoint(session);
  checkpoint.codexMcpActivation.val.activation.tools[0].signature = 'c'.repeat(64);
  checkpoint.codexMcpActivation.val.instructionsSpent = 0;
  assert.deepEqual(handle.stateOf(session).activation, activation);
  assert.equal(handle.stateOf(session).instructionsSpent, 2048);
  assert.equal(ctx.sessionProjections.checkpoint(session).codexMcpActivation.val.instructionsSpent, 2048);
  session.append(input('compat-clear', [], {...activation, tools: []}, 2048));
  assert.deepEqual(handle.stateOf(session).activation.tools, []);
  assert.equal(handle.stateOf(session).instructionsSpent, 2048, 'batch clear must not refund instructions');
  const single = session.append('step/end', {turn: 1, step: 1});
  assert.equal(single.type, 'step/end', 'the existing single-event overload remains available');
});

function deferred() {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};}
function definition(name) {
  return {name, description: 'Synthetic admission probe; never performs I/O.', parameters: {type: 'object'},
    output: {schema: {type: 'object'}, render: () => []}, execute: async () => ({})};
}

// These are real target-version registry calls, not a hand-built admission map.
// ProjectSession.selected uses precisely this asynchronous `when` lifecycle.
test('rc.5 late conditional admission cannot resurrect an unregistered MCP generation', async t => {
  const ctx = new Context();
  ctx.reflect.provide('systemPrompt', {tools: () => () => {}});
  const tools = new Tools(ctx), entered = deferred(), release = deferred();
  const early = tools.register(definition('synthetic_early'), {when: () => true});
  const stale = tools.register(definition('synthetic_stale'), {when: async () => {
    entered.resolve(); await release.promise; return true;
  }});
  t.after(() => {release.resolve(); early(); stale();});
  const agent = {id: 'synthetic-rc5-admission'};
  const pending = tools.resolve({agent, modelSelection: {provider: 'synthetic', model: 'synthetic'}, signal: new AbortController().signal});
  await entered.promise;
  stale(); release.resolve();
  const admitted = await pending; t.after(() => admitted.dispose());
  assert.ok(tools.executable('synthetic_early', agent, admitted));
  assert.equal(tools.executable('synthetic_stale', agent, admitted), undefined);
  assert.equal(tools.executable('synthetic_early', agent), undefined, 'conditional tools require a step admission');
});

test('rc.5 cancelled condition resolution publishes no partial callable working set', async t => {
  const ctx = new Context();
  ctx.reflect.provide('systemPrompt', {tools: () => () => {}});
  const tools = new Tools(ctx), entered = deferred(), release = deferred(), controller = new AbortController();
  const early = tools.register(definition('synthetic_early'), {when: () => true});
  const late = tools.register(definition('synthetic_late'), {when: async () => {
    entered.resolve(); await release.promise; return true;
  }});
  t.after(() => {release.resolve(); early(); late();});
  const agent = {id: 'synthetic-rc5-cancellation'};
  const pending = tools.resolve({agent, modelSelection: {provider: 'synthetic', model: 'synthetic'}, signal: controller.signal});
  await entered.promise;
  const reason = new Error('synthetic admission cancellation');
  controller.abort(reason); release.resolve();
  await assert.rejects(pending, error => error === reason);
  for (const name of ['synthetic_early', 'synthetic_late']) assert.equal(tools.executable(name, agent), undefined);
});
