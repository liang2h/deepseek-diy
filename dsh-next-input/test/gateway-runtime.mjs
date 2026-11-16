// Isolated integration against pinned npm Cordis/Typert/Gateway, no DOM,
// no personal Sessions, sockets, credentials, or paid model calls.
import assert from 'node:assert/strict';
import {requireRuntime as require} from './npm-runtime.mjs';
import {clientContribution, requestSuggestion} from '../remote-contract.js';
import {canOffer, suggestionText} from '../client-state.js';
const {Context} = require('@deepseek-ai/cordis');
const registry = require('@deepseek-ai/dsh-typert-registry/client');
const gateway = require('@deepseek-ai/dsh-api-gateway/client');
const root = new Context();
const calls = [];
const ready = {endSeq: 42, status: 'ready', suggestion: '请补充原任务要求的验证结果。'};
let answer = {ok: true, value: ready};
root.reflect.provide('connection', {
  interactions: 'none', isLoopback: true,
  generation: {getSnapshot: () => undefined, subscribe: () => () => {}},
  rpc: {
    async call(channel, endpoint, payload, signal) {calls.push({channel, endpoint, payload, signal}); return answer;},
    async *open() {},
  },
  openWebSocket() {throw new Error('Network forbidden in contract test');},
});
registry.apply(root);
gateway.apply(root);
const tag = Symbol('test-agent-identity');
const scopeFiber = root.plugin(function integrationAgentScope() {});
const scope = scopeFiber.ctx.extend({[tag]: 'session-contract-only'});
root.get('typert').contexts.registerClient('agent', {identity: ctx => ctx[tag], resolve: id => id === scope[tag] ? scope : undefined});
try {
  await root.get('remote').$mount(clientContribution());
  assert.throws(() => scope.remote.localNextInput.generate,
    'Regression: a borrowed scope does not inherit the mounting plugin dependency guards');
  const legacy = await scope.get('remote.localNextInput').generate({endSeq: 42});
  assert.equal(legacy.ok, true);
  assert.equal(legacy.endSeq, undefined, 'Regression: raw RemoteResult is NOT a business reply');
  assert.equal(legacy.value.endSeq, 42);
  const reply = await requestSuggestion(scope, 42);
  assert.deepEqual(reply, ready);
  assert.equal(calls.at(-1).channel, '/api');
  assert.equal(calls.at(-1).endpoint, 'localNextInput/generate');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).payload)), {args: {agentId: 'session-contract-only', request: {endSeq: 42}}});
  const input = {phase: 'plain', draft: '', draftRev: 0, attachmentIds: []};
  const session = {openState: 'open', running: false, removed: false, subagent: null, pendingSubmissions: []};
  const visible = canOffer({cursor: {eligible: true, endSeq: 42, turn: 2}, session, input});
  assert.equal(suggestionText({visible, key: 'round', reply: {key: 'round', ...reply}}), ready.suggestion);
  answer = {ok: true, value: {endSeq: 42, status: 'none', suggestion: null}};
  const none = await requestSuggestion(scope, 42);
  assert.equal(suggestionText({visible, key: 'round', reply: {key: 'round', ...none}}), null);
  answer = {ok: false, error: {code: 'gateway/internal', message: 'Fixture only', details: {}}};
  await assert.rejects(requestSuggestion(scope, 42), error => error.code === 'remote-failed');
  answer = {ok: true, value: {endSeq: 42, status: 'ready', suggestion: null}};
  await assert.rejects(requestSuggestion(scope, 42), error => error.code === 'invalid-reply');
  answer = {ok: true, value: {...ready, endSeq: 40}};
  await assert.rejects(requestSuggestion(scope, 42), error => error.code === 'stale-reply');
  answer = {ok: true, value: ready};
  const abort = new AbortController(); abort.abort();
  await assert.rejects(requestSuggestion(scope, 42, abort.signal), error => error.code === 'cancelled');
  console.log('npm Gateway Client integration passed: scoped identity, RemoteResult unwrapping, ready/no-gap display, failures, payload validation, stale and cancelled replies.');
} finally {
  await root.fiber.dispose();
}
