import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {activationProjection as projection, activationReceiptSchema, registerActivationProjection} from '../activation.js';

const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-mcp-client'));
const {Context} = await import(require.resolve('@deepseek-ai/cordis'));
const {Session, SessionLogOffset, buildForkSeed} = await import(require.resolve('@deepseek-ai/dsh-session'));
const {SessionProjectionRegistry} = await import(require.resolve('@deepseek-ai/dsh-session-projection'));
const first = 'mcp__demo__first', second = 'mcp__demo__second';
const fingerprint = 'a'.repeat(64), signature = 'b'.repeat(64);
const receipt = (selected = [first], extra = {}) => ({version: 1, sessionId: 'test-session', project: '/synthetic-project', fingerprint,
  authority: 'synthetic-authority', tools: selected.map(name => ({name, signature})), ...extra});
const event = (type, data, seq = 0, extra = {}) => ({type, seq, time: seq + 1, data, ...extra});
const initial = (sessionId = 'test-session', inheritedCount = 0) => projection.init({id: sessionId}, inheritedCount);
const call = (selected = [first], callId = 'call-1', seq = 0, extra = {}) => event('tool/call', {
  turn: 1, step: 1, callId, name: 'codex_mcp', arguments: JSON.stringify({action: 'load', names: selected}), ...extra}, seq);
const result = (value = receipt(), callId = 'call-1', seq = 1, extra = {}, envelope = {}) => event('tool/result', {
  turn: 1, step: 1, message: {id: `message-${seq}`, role: 'tool', source: {kind: 'tool', callId}, toolCallId: callId,
    content: [{type: 'text', text: 'A truncated display is not an activation receipt.'}], isError: false},
  meta: {codexMcpActivation: value}, ...extra}, seq, {surfaceOp: 'append', ...envelope});
const fold = (...events) => events.reduce((state, item) => projection.apply(state, item), initial());
const ptcStart = (selected = [first], seq = 0, extra = {}) => event('tool/ptc-dispatch-start', {
  rootCallId: 'root', parentCallId: 'parent', subCallId: 'opaque-sub-id', name: 'codex_mcp',
  arguments: JSON.stringify({action: 'load', names: selected}), ...extra}, seq);
const ptcResult = (value = receipt(), seq = 1, extra = {}) => event('tool/ptc-dispatch', {
  rootCallId: 'root', parentCallId: 'parent', subCallId: 'opaque-sub-id', name: 'codex_mcp',
  arguments: JSON.stringify({action: 'load', names: value.tools.map(tool => tool.name)}),
  isError: false, content: [], meta: {codexMcpActivation: value}, ...extra}, seq);

test('activation is a whole replacement only after a paired successful native result', () => {
  const start = projection.apply(initial(), call());
  assert.equal(start.activation, null); assert.equal(start.pending.length, 1);
  const loaded = projection.apply(start, result());
  assert.deepEqual(loaded.activation, receipt()); assert.deepEqual(loaded.pending, []);
  const replaced = projection.apply(projection.apply(loaded, call([second], 'call-2', 2)), result(receipt([second]), 'call-2', 3));
  assert.deepEqual(replaced.activation.tools.map(tool => tool.name), [second]);
  const cleared = projection.apply(projection.apply(replaced, call([], 'call-3', 4)), result(receipt([]), 'call-3', 5));
  assert.deepEqual(cleared.activation.tools, []);
  assert.deepEqual(JSON.parse(JSON.stringify(cleared)), cleared);
  assert.doesNotThrow(() => projection.stateSchema.parse(cleared));
});

test('native pairing checks call identity, turn, step, and source before consuming pending', () => {
  const start = projection.apply(initial(), call());
  for (const item of [result(receipt(), 'other'), result(receipt(), 'call-1', 1, {turn: 2}),
    result(receipt(), 'call-1', 1, {step: 2}), result(receipt(), 'call-1', 1, {message: {...result().data.message, source: {kind: 'tool', callId: 'other'}}})]) {
    assert.equal(projection.apply(start, item), start);
  }
  assert.equal(projection.apply(initial(), result()).activation, null);
});

test('failure, absent metadata, bad binding shape and wrong selected names cannot activate', () => {
  assert.equal(fold(call(), result(receipt(), 'call-1', 1, {meta: {}})).activation, null);
  assert.equal(fold(call(), result(receipt(), 'call-1', 1, {meta: undefined})).activation, null);
  const badReceipts = [{},  {...receipt(), version: 2}, {...receipt(), sessionId: 'other-agent'},
    {...receipt(), authority: ''}, {...receipt(), fingerprint: 'bad'}, receipt([second]), receipt([]),
    {...receipt(), tools: [{name: first, signature: 'bad'}]}, receipt([first, first]),
    {...receipt(), extra: 'not-the-owned-schema'}];
  for (const value of badReceipts) {
    const state = fold(call(), result(value));
    assert.equal(state.activation, null); assert.deepEqual(state.pending, []);
  }
  for (const extra of [{error: {name: 'AbortError', code: 'ABORTED'}},
    {message: {...result().data.message, isError: true}}]) {
    assert.equal(fold(call(), result(receipt(), 'call-1', 1, extra)).activation, null);
  }
  const loaded = fold(call(), result());
  const failed = projection.apply(projection.apply(loaded, call([second], 'next', 2)), result(receipt([second]), 'next', 3,
    {message: {...result(receipt(), 'next').data.message, isError: true}}));
  assert.equal(failed.activation, loaded.activation);
});

test('load arguments reject invalid, duplicate, oversized and unsupported selections', () => {
  const raw = ['{', '[]', 'null', JSON.stringify({action: 'status', names: [first]}), JSON.stringify({action: 'load'}),
    JSON.stringify({action: 'load', names: [first, first]}), JSON.stringify({action: 'load', names: Array.from({length: 9}, (_, i) => `tool${i}`)}),
    JSON.stringify({action: 'load', names: ['x'.repeat(65)]}), JSON.stringify({action: 'load', names: ['invalid name']}), ' '.repeat(4097)];
  for (const arguments_ of raw) {
    const state = initial(); assert.equal(projection.apply(state, call([first], 'call', 0, {arguments: arguments_})), state);
  }
  const selected = Array.from({length: 8}, (_, i) => `mcp__demo__tool${i}`);
  assert.deepEqual(fold(call(selected), result(receipt([...selected].reverse()))).activation.tools.map(tool => tool.name), [...selected].reverse());
  assert.equal(activationReceiptSchema.safeParse(receipt(Array.from({length: 9}, (_, i) => `tool${i}`))).success, false);
});

test('surface replacements, duplicate completions and unrelated events preserve state identity', () => {
  const loaded = fold(call(), result());
  assert.equal(projection.apply(loaded, result()), loaded);
  const nextPending = projection.apply(loaded, call([second], 'next', 2));
  const replacement = result(receipt(), 'call-1', 3, {}, {surfaceOp: {op: 'replace', startSeq: 1, endSeq: 1}, sourceEventSeqs: [1]});
  assert.equal(projection.apply(nextPending, replacement), nextPending);
  assert.equal(projection.apply(loaded, event('assistant/attempt', {}, 10)), loaded);
  assert.equal(projection.apply(loaded, event('request/header', {}, 11)), loaded);
});

test('fork inherited prefix is ignored and owner session binding is exact', () => {
  let child = initial('child-session', 2);
  child = projection.apply(child, call()); child = projection.apply(child, result());
  assert.equal(child.activation, null); assert.deepEqual(child.pending, []);
  child = projection.apply(child, call([first], 'own', 2));
  child = projection.apply(child, result(receipt(), 'own', 3));
  assert.equal(child.activation, null);
  child = projection.apply(child, call([first], 'own2', 4));
  child = projection.apply(child, result(receipt([first], {sessionId: 'child-session'}), 'own2', 5));
  assert.equal(child.activation.sessionId, 'child-session');
});

test('PTC uses exact opaque sub/root/parent IDs and strict successful completed receipts', () => {
  const start = projection.apply(initial(), ptcStart());
  for (const extra of [{subCallId: 'other'}, {rootCallId: 'other'}, {parentCallId: 'other'}, {name: 'another_tool'},
    {arguments: JSON.stringify({action: 'load', names: [second]})}, {arguments: '{'}]) {
    assert.equal(projection.apply(start, ptcResult(receipt(), 1, extra)), start);
  }
  assert.deepEqual(projection.apply(start, ptcResult()).activation, receipt());
  assert.equal(fold(ptcStart(), ptcResult(receipt(), 1, {isError: true})).activation, null);
  assert.equal(fold(ptcStart(), ptcResult(receipt(), 1, {isError: undefined})).activation, null);
  assert.equal(fold(ptcStart(), ptcResult(receipt(), 1, {error: {name: 'Error', code: 'FAIL'}})).activation, null);
  assert.equal(fold(ptcStart(), ptcResult(receipt([second]))).activation, null);
  assert.deepEqual(fold(ptcStart([]), ptcResult(receipt([]))).activation.tools, []);
  assert.equal(fold(ptcStart(), result()).activation, null);
  assert.equal(fold(call(), ptcResult()).activation, null);
});

test('pending state is bounded, ambiguous duplicate IDs do not rewrite it, lifecycle markers clear it', () => {
  let state = initial();
  for (let i = 0; i < 70; ++i) state = projection.apply(state, call([first], `call-${i}`, i));
  assert.equal(state.pending.length, 64); assert.equal(state.pending[0].callId, 'call-6');
  assert.equal(projection.apply(state, call([second], 'call-69', 70)), state);
  assert.equal(projection.apply(state, result(receipt(), 'call-0', 71)), state);
  for (const type of ['step/end', 'turn/end', 'session/end-seed']) {
    assert.deepEqual(projection.apply(state, event(type, {}, 72)).pending, []);
  }
  assert.doesNotThrow(() => projection.stateSchema.parse(state));
});

async function registryFixture(t) {
  const ctx = new Context(); new SessionProjectionRegistry(ctx);
  let handle;
  const owner = ctx.plugin({name: 'test-activation', inject: ['sessionProjections'], async apply(scope) {handle = await registerActivationProjection(scope);}});
  await owner; t.after(() => owner.dispose());
  return {registry: ctx.sessionProjections, handle};
}

function appendPair(session, selected = [first], callId = 'call-1', spentBytes = 0) {
  const started = session.append('tool/call', call(selected, callId).data);
  const completed = result(receipt(selected), callId).data;
  completed.meta.codexMcpInstructions = {version: 1, sessionId: session.id, spentBytes};
  session.append('tool/result', completed, {surfaceOp: 'append', sourceEventSeqs: [started.seq]});
}

test('real projection handle lazily folds synthetic sessions and checkpoint/tail replay restores whole state', async t => {
  const {registry, handle} = await registryFixture(t);
  const session = Session.create('test-session');
  assert.equal(handle.stateOf(session).activation, null);
  appendPair(session, [first], 'call-1', 1024);
  assert.deepEqual(handle.stateOf(session).activation, receipt());
  assert.equal(handle.stateOf(session).instructionsSpent, 1024);
  const checkpoint = registry.checkpoint(session);
  assert.equal(checkpoint[projection.key].ver, 3);
  assert.deepEqual(checkpoint[projection.key].val.activation, receipt());
  appendPair(session, [second], 'next', 3072);
  const all = session.snapshotEvents(); // Test-only reader; production projection never scans events.
  const floor = registry.restoreFloor(checkpoint);
  const restored = registry.restore(checkpoint, all.slice(floor), floor, session.header, SessionLogOffset(0));
  assert.deepEqual(restored.checkpoint[projection.key].val.activation, receipt([second]));
  assert.equal(restored.checkpoint[projection.key].val.instructionsSpent, 3072);
  const replayed = Session.create('test-session', all, session.header);
  assert.deepEqual(handle.stateOf(replayed).activation, receipt([second]));
  assert.equal(handle.stateOf(replayed).instructionsSpent, 3072);
  const oldState = {...checkpoint[projection.key].val}; delete oldState.instructionsSpent;
  const versionOne = {[projection.key]: {...checkpoint[projection.key], ver: 1, val: oldState}};
  assert.equal(registry.restoreFloor(versionOne), 0);
  const migrated = registry.restore(versionOne, all, SessionLogOffset(0), session.header, SessionLogOffset(0));
  assert.equal(migrated.checkpoint[projection.key].val.instructionsSpent, 3072);
  const empty = Session.create('another-session');
  assert.equal(handle.stateOf(empty).activation, null);
});

test('real restore rejects cache watermarks beyond a truncated log and full replay loses uncommitted results', async t => {
  const {registry, handle} = await registryFixture(t);
  const session = Session.create('test-session'); appendPair(session);
  assert.ok(handle.stateOf(session).activation);
  const checkpoint = registry.checkpoint(session);
  const events = session.snapshotEvents();
  const truncated = events.slice(0, events.length - 1);
  const floor = registry.restoreFloor(checkpoint);
  assert.throws(() => registry.restore(checkpoint, truncated.slice(floor), floor, session.header, SessionLogOffset(0)));
  const rebuilt = registry.restore({}, truncated, SessionLogOffset(0), session.header, SessionLogOffset(0));
  assert.equal(rebuilt.checkpoint[projection.key].val.activation, null);
  const staleVersion = {[projection.key]: {...checkpoint[projection.key], ver: 999}};
  assert.equal(registry.restoreFloor(staleVersion), 0);
  const refolded = registry.restore(staleVersion, events, SessionLogOffset(0), session.header, SessionLogOffset(0));
  assert.deepEqual(refolded.checkpoint[projection.key].val.activation, receipt());
});

const ledger = (spentBytes, sessionId = 'test-session') => ({version: 1, sessionId, spentBytes});
const budgetResult = (selected, spentBytes, callId, seq) => result(receipt(selected), callId, seq,
  {meta: {codexMcpActivation: receipt(selected), codexMcpInstructions: ledger(spentBytes)}});

test('instructions ledger is a whole-value monotone count despite out-of-order native/PTC completion', () => {
  let state = projection.apply(initial(), call([first], 'earlier', 0));
  state = projection.apply(state, call([second], 'later', 1));
  state = projection.apply(state, budgetResult([second], 4096, 'later', 2));
  assert.equal(state.instructionsSpent, 4096);
  state = projection.apply(state, budgetResult([first], 1024, 'earlier', 3));
  assert.equal(state.instructionsSpent, 4096);
  assert.deepEqual(state.activation.tools.map(tool => tool.name), [first]);
  state = projection.apply(state, ptcStart([second], 4));
  state = projection.apply(state, ptcResult(receipt([second]), 5,
    {meta: {codexMcpActivation: receipt([second]), codexMcpInstructions: ledger(8192)}}));
  assert.equal(state.instructionsSpent, 8192);
  state = projection.apply(state, call([], 'clear', 6));
  state = projection.apply(state, budgetResult([], 8192, 'clear', 7));
  assert.deepEqual(state.activation.tools, []); assert.equal(state.instructionsSpent, 8192);
  assert.doesNotThrow(() => projection.stateSchema.parse(state));
});

test('clear, changed authority, missing ledger, replacement and lifecycle boundaries never refund instructions', () => {
  let state = fold(call(), budgetResult([first], 2048, 'call-1', 1));
  const replacement = budgetResult([first], 32000, 'call-1', 2);
  replacement.surfaceOp = {op: 'replace', startSeq: 1, endSeq: 1};
  assert.equal(projection.apply(state, replacement), state);
  const newReceipt = receipt([second], {authority: 'new-grant'});
  state = projection.apply(projection.apply(state, call([second], 'new-grant', 3)),
    result(newReceipt, 'new-grant', 4));
  assert.equal(state.activation.authority, 'new-grant'); assert.equal(state.instructionsSpent, 2048);
  state = projection.apply(projection.apply(state, call([], 'clear', 5)), result(receipt([]), 'clear', 6));
  assert.equal(state.instructionsSpent, 2048);
  for (const type of ['step/end', 'turn/end', 'session/end-seed']) state = projection.apply(state, event(type, {}, 7));
  assert.equal(state.instructionsSpent, 2048);
});

test('only strict successful own-session ledger metadata counts, independently of valid activation receipts', () => {
  for (const invalid of [undefined, null, {}, ledger(-1), ledger(32769), ledger(0.5), ledger('1'),
    ledger(100, 'other-session'), {...ledger(100), version: 2}, {...ledger(100), delta: 100}]) {
    const state = fold(call(), result(receipt(), 'call-1', 1,
      {meta: {codexMcpActivation: receipt(), codexMcpInstructions: invalid}}));
    assert.deepEqual(state.activation, receipt()); assert.equal(state.instructionsSpent, 0);
  }
  const success = budgetResult([first], 1024, 'call-1', 1);
  const failed = {...success, data: {...success.data, message: {...success.data.message, isError: true}}};
  assert.equal(fold(call(), failed).instructionsSpent, 0);
  assert.equal(fold(ptcStart(), ptcResult(receipt(), 1, {isError: true,
    meta: {codexMcpActivation: receipt(), codexMcpInstructions: ledger(1024)}})).instructionsSpent, 0);
  const invalidActivation = result({}, 'call-1', 1, {meta: {codexMcpActivation: {}, codexMcpInstructions: ledger(1024)}});
  assert.equal(fold(call(), invalidActivation).activation, null);
  assert.equal(fold(call(), invalidActivation).instructionsSpent, 1024);
  assert.equal(projection.stateSchema.safeParse({...initial(), instructionsSpent: 32769}).success, false);
});

test('fork inherits only the ancestor instruction budget floor, never pending or activation authority', () => {
  let child = initial('child-session', 2);
  child = projection.apply(child, call()); child = projection.apply(child, budgetResult([first], 8192, 'call-1', 1));
  assert.equal(child.instructionsSpent, 8192);
  assert.equal(child.activation, null); assert.deepEqual(child.pending, []);
  child = projection.apply(child, call([first], 'own', 2));
  const ownReceipt = receipt([first], {sessionId: 'child-session'});
  child = projection.apply(child, result(ownReceipt, 'own', 3,
    {meta: {codexMcpActivation: ownReceipt, codexMcpInstructions: ledger(8192, 'child-session')}}));
  assert.equal(child.instructionsSpent, 8192); assert.deepEqual(child.activation, ownReceipt);
  let noLedger = initial('historical-child', 2);
  noLedger = projection.apply(noLedger, call()); noLedger = projection.apply(noLedger, result());
  assert.equal(noLedger.instructionsSpent, 0); assert.equal(noLedger.activation, null);
});

test('inherited malformed, failed and replacement ledgers are ignored while PTC ledgers preserve the floor', () => {
  const child = initial('child-session', 10);
  const malformed = budgetResult([first], 8192, 'call-1', 1);
  malformed.data.meta.codexMcpInstructions = {...ledger(8192), extra: true};
  const failed = budgetResult([first], 8192, 'call-1', 1); failed.data.message.isError = true;
  const errored = budgetResult([first], 8192, 'call-1', 1); errored.data.error = {name: 'Error', code: 'FAILED'};
  const replacement = budgetResult([first], 8192, 'call-1', 1); replacement.surfaceOp = {op: 'replace', startSeq: 0, endSeq: 0};
  const failedPtc = ptcResult(receipt(), 1, {isError: true, meta: {codexMcpInstructions: ledger(8192)}});
  const erroredPtc = ptcResult(receipt(), 1, {error: {name: 'Error', code: 'FAILED'}, meta: {codexMcpInstructions: ledger(8192)}});
  for (const item of [malformed, failed, errored, replacement, failedPtc, erroredPtc]) {
    assert.equal(projection.apply(child, item), child);
  }
  // No inherited start/pending is needed: accounting can only reduce the remaining allowance.
  const inherited = projection.apply(child, ptcResult(receipt(), 1, {meta: {codexMcpInstructions: ledger(6144, 'ancestor')}}));
  assert.equal(inherited.instructionsSpent, 6144); assert.equal(inherited.activation, null); assert.deepEqual(inherited.pending, []);
  const lower = projection.apply(inherited, budgetResult([first], 2048, 'call-1', 2));
  assert.equal(lower, inherited);
});

test('version-two child checkpoints refold inherited budget floors instead of retaining zero', async t => {
  const {registry, handle} = await registryFixture(t);
  const parent = Session.create('test-session'); appendPair(parent, [first], 'ancestor-load', 8192);
  const parentEvents = parent.snapshotEvents();
  const events = buildForkSeed(parentEvents, parentEvents.at(-1).seq);
  const child = Session.create('checkpoint-child', events, {...parent.header, id: 'checkpoint-child', isSeeded: true}, SessionLogOffset(parentEvents.length));
  assert.equal(handle.stateOf(child).instructionsSpent, 8192);
  assert.equal(handle.stateOf(child).activation, null);
  const checkpoint = registry.checkpoint(child);
  const old = {[projection.key]: {...checkpoint[projection.key], ver: 2,
    val: {...checkpoint[projection.key].val, instructionsSpent: 0}}};
  assert.equal(registry.restoreFloor(old), 0);
  const restored = registry.restore(old, child.snapshotEvents(), SessionLogOffset(0), child.header, SessionLogOffset(parentEvents.length));
  assert.equal(restored.checkpoint[projection.key].ver, 3);
  assert.equal(restored.checkpoint[projection.key].val.instructionsSpent, 8192);
  assert.equal(restored.checkpoint[projection.key].val.activation, null);
});
