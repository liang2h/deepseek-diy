// Isolated real Host Gateway/Typert dispatch. Fixture-only Agent/Session and LLM:
// no private Session, sockets, credentials, browser state, or paid model request.
import assert from 'node:assert/strict';
import {requireRuntime as require} from './npm-runtime.mjs';
import {NextInputService, remoteContribution} from '../index.js';
import {initialState, reduceState, SYSTEM_PROMPT} from '../core.js';
import {clientContribution, requestSuggestion} from '../remote-contract.js';
import {canOffer, suggestionText} from '../client-state.js';
import {OPEN_ITEMS} from './fixtures/open-items.js';
import {DEFERRED_RELEASE_ANSWER} from './fixtures/deferred-release.js';

const {Context} = require('@deepseek-ai/cordis');
const {TypertRegistry} = require('@deepseek-ai/dsh-typert-registry');
const {TypertGatewayService} = require('@deepseek-ai/dsh-api-gateway');
const {RemoteAccessService} = require('@deepseek-ai/dsh-api-remote-access');
const root = new Context();
const calls = [];
const wireId = 'session-host-gateway-contract-only';
const session = {id: wireId, requestHeader: () => ({config: {provider: 'fixture-provider', model: 'fixture-model'}})};
let state = initialState({});
for (const event of [
  {type: 'turn/start', data: {turn: 1}},
  {type: 'user/message', data: {role: 'user', source: {kind: 'user'}, content: [{type: 'text', text: '完成固定测试任务并验证。'}]}},
  {type: 'assistant/message', data: {turn: 1, message: {role: 'assistant', content: [{type: 'text', text: '已完成修改，尚未验证。'}]}}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'completed'}}},
].map((event, seq) => ({...event, seq}))) state = reduceState(state, event);
const agent = {id: wireId, status: 'idle', session, ctx: {get: () => undefined}};
const expected = {endSeq: 3, status: 'ready', suggestion: '请补充原任务要求的验证结果。'};
const modelText = JSON.stringify({hasGap: true, suggestion: expected.suggestion});
root.reflect.provide('agents', {get: id => id === wireId ? agent : undefined, withoutInitiator: operation => operation()});
root.reflect.provide('llm', {async prepareCall(config, signal, configure) {
  calls.push({config, signal});
  const concrete = {...config, ...configure({maxTokens: config.maxTokens}, {reasoning: {efforts: [{id: 'fixture-low'}]}})};
  return {config: concrete, async *stream(options) {
    assert.equal(options.system, SYSTEM_PROMPT); assert.equal(options.tools, undefined);
    assert.equal(options.messages.length, 1); assert.equal(options.purpose, 'local-next-input');
    yield {type: 'block-start', index: 0, blockType: 'text'};
    yield {type: 'text-delta', index: 0, text: modelText};
    yield {type: 'finish', reason: {kind: 'stop'}};
  }};
}});
const registry = new TypertRegistry(root);
new RemoteAccessService(root);
const gateway = new TypertGatewayService(root, TypertGatewayService.Config({}));
const service = new NextInputService(root, {stateOf: value => {
  assert.equal(value, session); return state;
}});
root.reflect.provide('localNextInput', service);
registry.register(remoteContribution());
registry.lookups.register('agent', {parameter: 'agent', wire: 'agentId',
  hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent', wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
  resolve: id => id === wireId ? agent : undefined});
const peerFiber = root.plugin(function hostGatewayFixturePeer() {});
const peerAbort = new AbortController();
const peer = {id: 'peer-host-gateway-contract-only', ctx: peerFiber.ctx, principal: {kind: 'owner'},
  signal: peerAbort.signal, interactions: 'none', async dispose() {peerAbort.abort(); await peerFiber.dispose();}};
const request = {namespace: 'localNextInput', method: 'generate', args: {agentId: wireId, request: {endSeq: 3}}, peer};
try {
  const actual = await gateway.invoke(request);
  assert.deepEqual(actual, expected);
  assert.equal(calls.length, 1, 'real Host Gateway reaches the real plugin service');
  assert.deepEqual(calls[0].config, {provider: 'fixture-provider', model: 'fixture-model', maxTokens: 512});
  assert.deepEqual(await gateway.invoke(request), expected);
  assert.equal(calls.length, 1, 'Gateway receiver views share the original service cache');
  await assert.rejects(gateway.invoke({...request, args: {...request.args, unexpected: true}}), error => error.code === 'gateway/arguments-invalid');
  await assert.rejects(gateway.invoke({...request, args: {agentId: wireId, request: {endSeq: 3, unexpected: true}}}), error => error.code === 'gateway/input-invalid');
  await assert.rejects(gateway.invoke({...request, args: {agentId: 'missing-fixture-agent', request: {endSeq: 3}}}), error => error.code === 'gateway/lookup-not-found');
  assert.equal(calls.length, 1, 'invalid arguments and unresolved identity do not dispatch an LLM request');
  // Exercise the user's unfinished-evidence case through BOTH actual gateways,
  // including a mid-turn compaction and the real front-end display selector.
  for (const event of [
    {type: 'turn/start', data: {turn: 2}, seq: 4},
    {type: 'user/message', data: {role: 'user', source: {kind: 'user'}, content: [{type: 'text', text: '继续核验。'}]}, seq: 5},
    {type: 'user/message', data: {}, seq: 6, surfaceOp: {op: 'replace', startSeq: 1, endSeq: 5}},
    {type: 'assistant/message', data: {turn: 2, message: {role: 'assistant', content: [{type: 'text', text: OPEN_ITEMS}]}}, seq: 7},
    {type: 'turn/end', data: {turn: 2, reason: {kind: 'completed'}}, seq: 8},
  ]) state = reduceState(state, event);
  assert.equal(state.firstTask, ''); assert.equal(state.view.eligible, true);
  const clientRoot = new Context();
  const clientRegistry = require('@deepseek-ai/dsh-typert-registry/client');
  const clientGateway = require('@deepseek-ai/dsh-api-gateway/client');
  clientRoot.reflect.provide('connection', {interactions: 'none', isLoopback: true,
    generation: {getSnapshot: () => undefined, subscribe: () => () => {}},
    rpc: {async *open() {}, async call(channel, endpoint, payload, signal) {
      assert.equal(channel, '/api'); assert.equal(endpoint, 'localNextInput/generate');
      return {ok: true, value: await gateway.invoke({...request, args: payload.args, signal})};
    }}, openWebSocket() {throw new Error('Network forbidden');}});
  clientRegistry.apply(clientRoot); clientGateway.apply(clientRoot);
  const tag = Symbol('full-chain-agent');
  const scope = clientRoot.plugin(function clientGatewayFixtureScope() {}).ctx.extend({[tag]: wireId});
  clientRoot.get('typert').contexts.registerClient('agent', {identity: ctx => ctx[tag], resolve: id => id === wireId ? scope : undefined});
  try {
    await clientRoot.get('remote').$mount(clientContribution());
    const followup = await requestSuggestion(scope, 8);
    assert.equal(followup.status, 'ready'); assert.equal(followup.reason, 'permission-blocked');
    const visible = canOffer({cursor: state.view, session: {openState: 'open', running: false, pendingSubmissions: []},
      input: {phase: 'plain', draft: '', attachmentIds: []}});
    assert.equal(suggestionText({visible, key: 'round-2', reply: {key: 'round-2', ...followup}}), followup.suggestion);
    assert.match(followup.suggestion, /验证清单/); assert.match(followup.suggestion, /暂不继续访问受限环境/);
    assert.equal(calls.length, 1, 'explicit unresolved evidence does not depend on another LLM call');
    for (const event of [
      {type: 'turn/start', data: {turn: 3}, seq: 9},
      {type: 'user/message', data: {role: 'user', source: {kind: 'user'}, content: [{type: 'text', text: '请提交并推送，本次不创建发布标签。'}]}, seq: 10},
      {type: 'assistant/message', data: {turn: 3, message: {role: 'assistant', content: [{type: 'text', text: DEFERRED_RELEASE_ANSWER}]}}, seq: 11},
      {type: 'turn/end', data: {turn: 3, reason: {kind: 'completed'}}, seq: 12},
    ]) state = reduceState(state, event);
    const release = await requestSuggestion(scope, 12);
    assert.equal(release.status, 'ready'); assert.equal(release.reason, 'deferred-release');
    const releaseVisible = canOffer({cursor: state.view, session: {openState: 'open', running: false, pendingSubmissions: []},
      input: {phase: 'plain', draft: '', attachmentIds: []}});
    assert.equal(suggestionText({visible: releaseVisible, key: 'round-3', reply: {key: 'round-3', ...release}}), release.suggestion);
    assert.match(release.suggestion, /发布|版本/); assert.match(release.suggestion, /确认/);
    assert.equal(calls.length, 1, 'deferred release preflight is not dropped or delayed by an LLM call');
  } finally {await clientRoot.fiber.dispose();}
  console.log('npm Host Gateway integration passed: strict Remote dispatch, shared cache, and screenshot open items through both gateways to the display selector without another model request.');
} finally {
  await service.dispose();
  await root.fiber.dispose();
}
