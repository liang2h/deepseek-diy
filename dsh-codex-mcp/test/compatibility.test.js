import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {registerActivationProjection} from '../activation.js';

const runtime = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'));
const load = name => import(runtime.resolve(name));
const {Context} = await load('@deepseek-ai/cordis');
const {Session} = await load('@deepseek-ai/dsh-session');
const {default: Projections} = await load('@deepseek-ai/dsh-session-projection');

// Test the resolved packages, not only the edited manifest: a stale rc.1 test
// environment must not be accepted as evidence for an rc.2 release.
test('compatibility target and every resolved DSH test surface are exactly rc.2', async t => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.engines.dsh, '0.2.2-rc.2');
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
  t.diagnostic(`All declared and transitive DSH test surfaces resolve to ${manifest.engines.dsh}.`);
});

test('rc.2 array Session.append preserves committed activation metadata and the instruction ledger', async t => {
  const ctx = new Context(); new Projections(ctx);
  let handle;
  const owner = ctx.plugin({name: 'rc2-batch-projection', inject: ['sessionProjections'],
    async apply(scope) {handle = await registerActivationProjection(scope);}});
  await owner; t.after(() => owner.dispose());
  const session = Session.create('rc2-batch-session');
  const name = 'mcp__local__read';
  const activation = {version: 1, sessionId: session.id, project: '/synthetic-rc2-project',
    fingerprint: 'a'.repeat(64), authority: 'synthetic-human-grant', tools: [{name, signature: 'b'.repeat(64)}]};
  const input = (id, names, receipt, spentBytes) => [
    ['tool/call', {turn: 1, step: 1, callId: id, name: 'codex_mcp', arguments: JSON.stringify({action: 'load', names})}],
    ['tool/result', {turn: 1, step: 1,
      message: {id: `result-${id}`, role: 'tool', source: {kind: 'tool', callId: id}, toolCallId: id,
        content: [{type: 'text', text: 'Synthetic rc.2 successful completion.'}]},
      meta: {codexMcpActivation: receipt, codexMcpInstructions: {version: 1, sessionId: session.id, spentBytes}}},
    {surfaceOp: 'append'}],
  ];
  const appended = session.append(input('rc2-load', [name], activation, 2048));
  assert.equal(appended.length, 2);
  assert.deepEqual(handle.stateOf(session).activation, activation);
  assert.equal(handle.stateOf(session).instructionsSpent, 2048);
  session.append(input('rc2-clear', [], {...activation, tools: []}, 2048));
  assert.deepEqual(handle.stateOf(session).activation.tools, []);
  assert.equal(handle.stateOf(session).instructionsSpent, 2048, 'batch clear must not refund instructions');
  const single = session.append('step/end', {turn: 1, step: 1});
  assert.equal(single.type, 'step/end', 'the existing single-event overload remains available');
});
