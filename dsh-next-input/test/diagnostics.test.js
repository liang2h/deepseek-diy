import test from 'node:test';
import assert from 'node:assert/strict';
import {installHostDiagnostics, installClientDiagnostics} from '../diagnostics.js';
import {VERSION, PROJECTION_VERSION} from '../version.js';
import {initialState} from '../core.js';

function registryContext(available = true) {
  let provider, disposed = false;
  const cleanups = [];
  const ctx = {inject(dependencies, callback) {
    assert.deepEqual(dependencies, ['cordisInspect']); if (available) callback(ctx); return () => {};
  }, effect(callback) {const dispose = callback(); cleanups.push(dispose); return dispose;},
  cordisInspect: {register(value) {provider = value; return () => {disposed = true;};}}};
  return {ctx, get provider() {return provider;}, get disposed() {return disposed;}, cleanup() {for (const fn of cleanups) fn();}};
}
const queryContext = () => ({signal: new AbortController().signal});

test('Host diagnostics prove loaded version without revealing excerpts or triggering generation', async () => {
  const r = registryContext(), session = {}, state = initialState({});
  state.firstTask = 'private-user-text'; state.firstTaskSeq = 1;
  state.view = {endSeq: 9, turn: 1, eligible: true}; state.activeTurn = 1; state.lastAssistantTurn = 1;
  const cache = new Map([['key', {session: new WeakRef(session), result: {status: 'ready', suggestion: 'private-suggestion', reason: 'explicit-open-items'}}]]);
  const service = {cache, running: new Map(), cacheKey: () => 'key', generate() {throw new Error('Inspection must not generate');}};
  installHostDiagnostics(r.ctx, service, {stateOf: value => {assert.equal(value, session); return state;}});
  const result = await r.provider.query('status', {}, {...queryContext(), agent: {session, status: 'idle'}});
  assert.equal(r.provider.manifest.id, 'NextInput'); assert.equal(result.version, VERSION);
  assert.equal(result.projectionVersion, PROJECTION_VERSION); assert.equal(result.eligible, true);
  assert.equal(result.cacheStatus, 'ready'); assert.equal(result.reason, 'explicit-open-items');
  assert.doesNotMatch(JSON.stringify(result), /private-user-text|private-suggestion/);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(r.provider.manifest.methods[0].outputSchema.properties).sort());
  r.cleanup(); assert.equal(r.disposed, true);
});

test('diagnostics remain optional and fail promptly on cancellation', async () => {
  const missing = registryContext(false);
  installHostDiagnostics(missing.ctx, {}, {}); assert.equal(missing.provider, undefined);
  const r = registryContext(); installClientDiagnostics(r.ctx, () => undefined);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(r.provider.query('status', {}, {signal: abort.signal, sessionId: 'fixture'}));
  await assert.rejects(r.provider.query('unexpected', {}, {...queryContext(), sessionId: 'fixture'}));
  r.cleanup();
});

test('Client diagnostics report only mounted-view flags and cannot override the code revision', async () => {
  const r = registryContext();
  installClientDiagnostics(r.ctx, sessionId => sessionId === 'shown' ? {version: 'not-loaded-code', mounted: true,
    eligible: true, endSeq: 42, canOffer: false, hasDraft: true, replyStatus: 'ready', reason: 'permission-blocked',
    draft: 'private-draft', text: 'private-answer'} : undefined);
  const current = await r.provider.query('status', {}, {...queryContext(), sessionId: 'shown'});
  assert.equal(current.version, VERSION); assert.equal(current.mounted, true); assert.equal(current.hasDraft, true);
  assert.equal(current.reason, 'permission-blocked'); assert.doesNotMatch(JSON.stringify(current), /private/);
  const absent = await r.provider.query('status', {}, {...queryContext(), sessionId: 'not-mounted'});
  assert.equal(absent.mounted, false); assert.equal(absent.openState, 'unmounted');
  assert.deepEqual(Object.keys(absent).sort(), Object.keys(r.provider.manifest.methods[0].outputSchema.properties).sort());
  r.cleanup();
});
