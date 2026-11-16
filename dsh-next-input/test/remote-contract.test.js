import test from 'node:test';
import assert from 'node:assert/strict';
import {requestSuggestion, parseReply, clientContribution} from '../remote-contract.js';
import {remoteContribution} from '../index.js';
import {suggestionText} from '../client-state.js';

const ready = {endSeq: 42, status: 'ready', suggestion: '请补充原任务要求的验证结果。'};
function scopeFor(result) {
  return {get(key) {assert.equal(key, 'remote.localNextInput'); return {async generate(request, signal) {
    assert.deepEqual(request, {endSeq: 42}); signal?.throwIfAborted(); return result;
  }};}, get remote() {throw new Error('Borrowed Context dependency guard: use get().');}};
}

test('scoped namespace lookup and successful RemoteResult reach the real display selector', async () => {
  const result = await requestSuggestion(scopeFor({ok: true, value: ready}), 42);
  assert.deepEqual(result, ready);
  assert.equal(suggestionText({visible: true, key: 'round', reply: {key: 'round', ...result}}), ready.suggestion);
  assert.equal(suggestionText({visible: true, key: 'round', reply: {key: 'round', ok: true, value: ready}}), null,
    'v1 regression: an envelope can never be displayed as a business payload');
});

test('no-gap, transport failure, missing namespace and malformed reply are distinct', async () => {
  assert.equal((await requestSuggestion(scopeFor({ok: true, value: {endSeq: 42, status: 'none', suggestion: null}}), 42)).status, 'none');
  await assert.rejects(requestSuggestion(scopeFor({ok: false, error: {message: 'private details'}}), 42), error => error.code === 'remote-failed' && !error.message.includes('private'));
  await assert.rejects(requestSuggestion({get: () => undefined}, 42), error => error.code === 'remote-unavailable');
  await assert.rejects(requestSuggestion(scopeFor({ok: true, value: {endSeq: 42}}), 42), error => error.code === 'invalid-reply');
  await assert.rejects(requestSuggestion(scopeFor({ok: true, value: {...ready, endSeq: 41}}), 42), error => error.code === 'stale-reply');
});

test('payload validation is explicit because Gateway does not call Client schema parse()', () => {
  for (const value of [null, {ok: true, value: ready}, {...ready, suggestion: null}, {...ready, status: 'none'}, {...ready, endSeq: -1}, {...ready, suggestion: 'x'.repeat(281)}]) assert.throws(() => parseReply(value));
  assert.deepEqual(parseReply({...ready, reason: 'provider secret with spaces'}), ready);
  assert.deepEqual(parseReply({endSeq: 42, status: 'error', suggestion: null, reason: 'timeout'}), {endSeq: 42, status: 'error', suggestion: null, reason: 'timeout'});
});

test('Host and Client descriptors keep exact scope, endpoint, codecs and cancellation', () => {
  const host = remoteContribution().invocations[0];
  const client = clientContribution().descriptors[0];
  for (const key of ['id', 'service', 'namespace', 'method', 'scope', 'invocation', 'cancellation']) assert.deepEqual(client[key], host[key]);
  assert.deepEqual(client.parameters.map(p => [p.name, p.wire, p.source, p.lookup, p.codec.typeSymbol]), host.parameters.map(p => [p.name, p.wire, p.source, p.lookup, p.codec.typeSymbol]));
  assert.equal(client.result.typeSymbol, host.result.typeSymbol);
});
