import {OPEN_ITEMS} from './fixtures/open-items.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {apply, Config, NextInputService, projectionDefinition, remoteContribution, stateSchema, viewSchema} from '../index.js';
import {LIMITS, initialState, reduceState, SYSTEM_PROMPT} from '../core.js';

const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};
const message = (role, text) => ({role, source: role === 'user' ? {kind: 'user', rpcId: 'rpc-test'} : {kind: 'model'}, content: [{type: 'text', text}]});
const response = (text = '{"hasGap":true,"suggestion":"请补上原任务要求的验证结果。"}', finish = 'stop') => async function* () {
  yield {type: 'block-start', index: 0, blockType: 'text'};
  yield {type: 'text-delta', index: 0, text};
  if (finish) yield {type: 'finish', reason: {kind: finish}};
};
function runtime(options = {}) {
  const states = new WeakMap(), registry = new Map(), events = new Map(), cleanups = [], calls = [], streams = [], order = [];
  const started = deferred(); let withoutDepth = 0, projectionDisposed = false;
  const projection = {stateOf: session => states.get(session), dispose: async () => {projectionDisposed = true;}};
  const ctx = {
    agents: {get: id => registry.get(id), withoutInitiator: fn => {withoutDepth++; try {return fn();} finally {withoutDepth--;}}},
    llm: {prepareCall: async (config, signal, configure) => {
      calls.push({config, signal, without: withoutDepth > 0});
      const controls = configure({maxTokens: config.maxTokens}, {reasoning: {efforts: [{id: 'minimal'}, {id: 'high'}]}});
      if (options.prepare) return options.prepare(config, signal, configure);
      return {config: {...config, ...controls}, stream: request => {
        streams.push(request);
        const underlying = (options.stream || response())(request)[Symbol.asyncIterator]();
        return {[Symbol.asyncIterator]() {return this;}, next() {
          assert.ok(withoutDepth > 0, 'iterator.next runs without the main initiator'); started.resolve(); return underlying.next();
        }, return() {
          assert.ok(withoutDepth > 0, 'iterator.return runs without the main initiator');
          options.onReturn?.(); return underlying.return?.() || Promise.resolve({done: true});
        }};
      }};
    }},
    sessionProjections: {register: async definition => {order.push('register'); assert.equal(definition.key, 'localNextInput'); if (options.registration) await options.registration.promise; order.push('ready'); return projection;}},
    reflect: {provide: (key, service) => {order.push('provide'); ctx[key] = service; return () => {delete ctx[key];};}},
    typert: {register: value => {order.push('typert'); assert.equal(value.package, '@local/dsh-next-input'); return () => {}; }},
    on: (name, listener) => {const listeners = events.get(name) || new Set(); listeners.add(listener); events.set(name, listeners); const cleanup = () => listeners.delete(listener); cleanups.push(cleanup); return cleanup;},
    effect: fn => {const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup;},
    inject: (dependencies, callback) => {if (dependencies.every(key => ctx[key])) callback(ctx); return () => {};},
  };
  function agent(id = `session-${registry.size}`) {
    const session = {id, requestHeader: () => ({config: {provider: 'last-provider', model: 'last-model', maxTokens: 99999, reasoningEffort: 'high'}}),
      append() {throw new Error('Session mutation forbidden');}, deriveMessages() {throw new Error('History scan forbidden');}, snapshotEvents() {throw new Error('History scan forbidden');}};
    let state = initialState({});
    for (const event of [{type: 'turn/start', data: {turn: 1}}, {type: 'user/message', data: message('user', '完成任务并验证。')},
      {type: 'assistant/message', data: {turn: 1, message: message('assistant', '已修改。')}}, {type: 'turn/end', data: {turn: 1, reason: {kind: 'completed'}}}].map((e, seq) => ({...e, seq}))) state = reduceState(state, event);
    states.set(session, state);
    const value = {id, session, status: 'idle', options: {provider: 'next-provider', model: 'next-model'}, ctx: {get: name => options.scopedLlm && name === 'llm' ? options.scopedLlm : undefined}};
    registry.set(id, value); return value;
  }
  function emit(name, ...args) {
    if (name === 'session/event') {const [session, event] = args; states.set(session, reduceState(states.get(session), event));}
    for (const listener of events.get(name) || []) listener(...args);
  }
  return {ctx, states, registry, projection, calls, streams, order, started, agent, emit,
    get projectionDisposed() {return projectionDisposed;}, cleanup: async () => {for (const cleanup of cleanups.reverse()) await cleanup();}};
}
const generate = (service, agent, signal) => service.generate(agent, {endSeq: 3}, signal);

test('projection uses strict real Zod schemas, JSON state and tiny stable wire', () => {
  const definition = projectionDefinition(); const state = initialState({});
  assert.deepEqual(stateSchema.parse(state), state);
  assert.equal(definition.stateVersion, 3); assert.equal(state.firstTaskSeq, -1);
  const legacyState = {...state}; delete legacyState.firstTaskSeq;
  assert.throws(() => stateSchema.parse(legacyState), 'version-1 checkpoint state must not be reused as version 2');
  assert.deepEqual(Object.keys(definition.wire.view(state)).sort(), ['eligible', 'endSeq', 'turn']);
  assert.equal(definition.wire.view(state), state.view); assert.equal(definition.wire.summary, false);
  assert.throws(() => viewSchema.parse({...state.view, recent: []}));
  assert.throws(() => stateSchema.parse({...state, recent: Array(9).fill({seq: 0, role: 'assistant', text: 'x'})}));
  assert.equal(Config({}).maxConcurrent, 2); assert.throws(() => Config({maxConcurrent: 3}));
});
test('apply awaits projection registration before publishing service/remote and tears down', async () => {
  const registration = deferred(), r = runtime({registration});
  const applying = apply(r.ctx); assert.deepEqual(r.order, ['register']); assert.equal(r.ctx.localNextInput, undefined);
  registration.resolve(); await applying;
  assert.deepEqual(r.order, ['register', 'ready', 'provide', 'typert']);
  assert.ok(r.ctx.localNextInput instanceof NextInputService);
  await r.cleanup(); assert.equal(r.ctx.localNextInput, undefined); assert.equal(r.projectionDisposed, true);
});
test('generate uses completed-turn route, lowest effort and fixed no-tool JSON request', async () => {
  const r = runtime(), agent = r.agent(), service = new NextInputService(r.ctx, r.projection);
  Object.defineProperty(agent, 'draft', {get() {throw Error('Draft must not be read');}});
  const result = await generate(service, agent);
  assert.equal(result.status, 'ready'); assert.equal(result.endSeq, 3); assert.ok(result.suggestion);
  assert.deepEqual(r.calls[0].config, {provider: 'last-provider', model: 'last-model', maxTokens: 512});
  assert.ok(r.calls[0].without);
  const request = r.streams[0]; assert.equal(request.reasoningEffort, 'minimal'); assert.equal(request.purpose, 'local-next-input');
  assert.equal(request.system, SYSTEM_PROMPT); assert.equal(request.sessionId, undefined);
  assert.equal(request.tools, undefined); assert.equal(request.toolHistory, undefined); assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, 'user'); assert.equal(request.messages[0].id, undefined);
  assert.ok(JSON.parse(request.messages[0].content[0].text).recent.length);
  await service.dispose();
});
test('explicit unresolved evidence gets a safe local next input without a model request or configured route', async () => {
  const r = runtime(), agent = r.agent(), state = r.states.get(agent.session);
  state.recent[state.recent.length - 1].text = OPEN_ITEMS;
  agent.session.requestHeader = () => undefined;
  const service = new NextInputService(r.ctx, r.projection);
  const result = await generate(service, agent);
  assert.equal(result.status, 'ready'); assert.equal(result.reason, 'permission-blocked');
  assert.match(result.suggestion, /证据|验证清单/);
  assert.match(result.suggestion, /权限|授权/);
  assert.doesNotMatch(result.suggestion, /绕过|切换账号|我授权|继续查询/);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(await generate(service, agent), result);
  await service.dispose();
});

test('an explicit user stop suppresses follow-up even when the result lists unresolved facts', async () => {
  const r = runtime(), agent = r.agent(), state = r.states.get(agent.session);
  state.recent.find(item => item.role === 'user').text = '这轮只汇总结果，不要再跟进或发起验证。';
  state.recent[state.recent.length - 1].text = OPEN_ITEMS;
  const service = new NextInputService(r.ctx, r.projection);
  const result = await generate(service, agent);
  assert.equal(result.status, 'none'); assert.equal(result.reason, 'intentional-stop');
  assert.equal(r.calls.length, 0); await service.dispose();
});

test('ready, none and error outcomes are cached for exact cursor, no automatic retry', async () => {
  for (const [stream, status] of [[response(), 'ready'], [response('{"hasGap":false,"suggestion":null}'), 'none'], [response('bad json'), 'error'], [async function* () {throw Error('offline');}, 'error']]) {
    const r = runtime({stream}), agent = r.agent(), service = new NextInputService(r.ctx, r.projection);
    const first = await generate(service, agent); assert.equal(first.status, status);
    first.suggestion = 'mutated'; const second = await generate(service, agent);
    assert.notEqual(second.suggestion, 'mutated'); assert.equal(r.calls.length, 1); await service.dispose();
  }
});
test('non-stop or missing finish always returns null; tool chunks never execute', async () => {
  const variants = ['error', 'aborted', 'max-tokens', 'tool-calls', null].map(finish => response(undefined, finish));
  variants.push(async function* () {yield {type: 'tool-call-delta', index: 0, id: 'call', name: 'bash', argumentsDelta: '{}'}; yield {type: 'finish', reason: {kind: 'stop'}};});
  variants.push(async function* () {yield {type: 'block-end', index: 0, block: {type: 'tool-call', id: 'call', name: 'bash', arguments: '{}'}};});
  for (const stream of variants) {
    const r = runtime({stream}), agent = r.agent(), service = new NextInputService(r.ctx, r.projection);
    const result = await generate(service, agent); assert.equal(result.status, 'error'); assert.equal(result.suggestion, null); await service.dispose();
  }
});
test('authoritative text block-end is parsed, reasoning is ignored, huge outputs rejected', async () => {
  for (const [stream, expected] of [[async function* () {
    yield {type: 'block-start', index: 0, blockType: 'reasoning'}; yield {type: 'reasoning-delta', index: 0, text: 'private'};
    yield {type: 'block-end', index: 0, block: {type: 'reasoning', text: 'private'}};
    yield {type: 'block-end', index: 1, block: {type: 'text', text: '{"hasGap":false,"suggestion":null}'}};
    yield {type: 'finish', reason: {kind: 'stop'}};
  }, 'none'], [response('x'.repeat(5000)), 'error']]) {
    const r = runtime({stream}), service = new NextInputService(r.ctx, r.projection);
    const result = await generate(service, r.agent()); assert.equal(result.status, expected); assert.equal(result.suggestion, null); await service.dispose();
  }
});
test('ineligible, non-idle and malformed requests never call a model', async () => {
  const r = runtime(), agent = r.agent(), service = new NextInputService(r.ctx, r.projection);
  agent.status = 'running'; assert.equal((await generate(service, agent)).status, 'stale'); agent.status = 'idle';
  r.states.get(agent.session).view.eligible = false; assert.equal((await generate(service, agent)).status, 'stale');
  await assert.rejects(service.generate(agent, {endSeq: 3, draft: 'x'})); assert.equal(r.calls.length, 0);
  await service.dispose();
});
test('single-flight callers share one request; caller cancellation only detaches its observer', async () => {
  const gate = deferred(), r = runtime({stream: async function* () {await gate.promise; yield* response()();}}), agent = r.agent();
  const service = new NextInputService(r.ctx, r.projection), controller = new AbortController();
  const first = generate(service, agent, controller.signal); const second = generate(service, agent);
  await r.started.promise; controller.abort(); assert.equal((await first).reason, 'cancelled');
  assert.equal(r.calls[0].signal.aborted, false); gate.resolve(); assert.equal((await second).status, 'ready');
  assert.equal((await generate(service, agent)).status, 'ready'); assert.equal(r.calls.length, 1); await service.dispose();
});
test('pre-aborted caller creates no call or cache entry', async () => {
  const r = runtime(), service = new NextInputService(r.ctx, r.projection), controller = new AbortController(); controller.abort();
  assert.equal((await generate(service, r.agent(), controller.signal)).reason, 'cancelled'); assert.equal(r.calls.length, 0); assert.equal(service.cache.size, 0); await service.dispose();
});
test('new turn and user message cancel old work through apply listeners', async () => {
  for (const event of [{type: 'turn/start', data: {turn: 2}, seq: 4}, {type: 'user/message', data: message('user', 'new'), seq: 4}]) {
    const gate = deferred(), r = runtime({stream: async function* () {await gate.promise; yield* response()();}}); await apply(r.ctx);
    const agent = r.agent(), pending = generate(r.ctx.localNextInput, agent); await r.started.promise;
    r.emit('session/event', agent.session, event);
    const result = await pending; assert.equal(result.status, 'stale'); assert.equal(result.suggestion, null); assert.equal(r.calls[0].signal.aborted, true);
    assert.equal(r.ctx.localNextInput.cache.size, 0); gate.resolve(); await r.cleanup();
  }
});
test('non-intersecting system-node rewrite does not cancel an in-flight suggestion', async () => {
  const gate = deferred(), r = runtime({stream: async function* () {await gate.promise; yield* response()();}}); await apply(r.ctx);
  const service = r.ctx.localNextInput, agent = r.agent(), before = r.states.get(agent.session);
  const pending = generate(service, agent); await r.started.promise;
  r.emit('session/event', agent.session, {type: 'system/message', seq: 4, data: {message: message('system', 'updated system')},
    surfaceOp: {op: 'replace', startSeq: 0, endSeq: 0}});
  assert.equal(r.states.get(agent.session), before);
  assert.equal(r.calls[0].signal.aborted, false); assert.equal(service.running.size, 1);
  gate.resolve(); assert.equal((await pending).status, 'ready'); assert.equal(r.calls.length, 1);
  await r.cleanup();
});
test('assistant surface replacement immediately cancels and isolates an in-flight suggestion', async () => {
  const never = deferred(), r = runtime({stream: async function* () {await never.promise; yield* response()();}}); await apply(r.ctx);
  const service = r.ctx.localNextInput, agent = r.agent(), pending = generate(service, agent); await r.started.promise;
  r.emit('session/event', agent.session, {type: 'assistant/message', seq: 4, data: {turn: 1, message: message('assistant', 'replacement')},
    surfaceOp: {op: 'replace', startSeq: 2, endSeq: 2}});
  assert.equal((await pending).status, 'stale'); assert.equal(r.calls[0].signal.aborted, true);
  assert.equal(service.cache.size, 0); assert.equal((await generate(service, agent)).status, 'stale');
  never.resolve(); await r.cleanup();
});
test('session disposal and plugin unload terminate even an uncooperative stream', async () => {
  for (const action of ['session', 'plugin']) {
    const never = deferred(), r = runtime({stream: async function* () {await never.promise;}}); await apply(r.ctx);
    const service = r.ctx.localNextInput, agent = r.agent(), pending = generate(service, agent); await r.started.promise;
    if (action === 'session') r.emit('session/disposed', agent.session); else await r.cleanup();
    const result = await pending; assert.equal(result.status, 'stale'); assert.equal(service.running.size, 0); assert.equal(service.cache.size, 0);
    assert.equal((await generate(service, agent)).status, 'stale'); never.resolve(); if (action === 'session') await r.cleanup();
  }
});
test('late results are stale across same-id Session replacement or cursor change', async () => {
  for (const replacement of [true, false]) {
    const gate = deferred(), r = runtime({stream: async function* () {await gate.promise; yield* response()();}}), agent = r.agent('same-id');
    const service = new NextInputService(r.ctx, r.projection), pending = generate(service, agent); await r.started.promise;
    if (replacement) r.agent('same-id'); else r.states.get(agent.session).view = {endSeq: 8, turn: 2, eligible: true};
    gate.resolve(); const result = await pending; assert.equal(result.status, 'stale'); assert.equal(service.cache.size, 0); await service.dispose();
  }
});
test('global concurrency never queues; busy outcome is cached', async () => {
  const gate = deferred(), r = runtime({stream: async function* () {await gate.promise; yield* response()();}}), service = new NextInputService(r.ctx, r.projection);
  const a = r.agent(), b = r.agent(), c = r.agent(); const pa = generate(service, a), pb = generate(service, b);
  await r.started.promise;
  assert.deepEqual(await generate(service, c), {endSeq: 3, suggestion: null, status: 'none', reason: 'busy'});
  assert.equal(service.running.size, 2); gate.resolve(); await Promise.all([pa, pb]);
  assert.equal((await generate(service, c)).reason, 'busy'); assert.equal(r.calls.length, 2); await service.dispose();
});
test('timeout settles and caches null even if adapter preparation ignores cancellation', async () => {
  const never = deferred(), r = runtime({prepare: async () => never.promise}), service = new NextInputService(r.ctx, r.projection, {timeoutMs: 10}), agent = r.agent();
  const result = await generate(service, agent); assert.deepEqual(result, {endSeq: 3, suggestion: null, status: 'error', reason: 'timeout'});
  assert.equal(r.calls[0].signal.aborted, true); assert.equal(service.running.size, 0);
  assert.deepEqual(await generate(service, agent), result); assert.equal(r.calls.length, 1); never.reject(Error('late failure')); await service.dispose();
});
test('completed cache is bounded globally and holds only weak Session identities', async () => {
  const r = runtime(), service = new NextInputService(r.ctx, r.projection);
  for (let i = 0; i < 132; i++) await generate(service, r.agent());
  assert.equal(service.cache.size, LIMITS.cacheEntries);
  for (const entry of service.cache.values()) {assert.ok(entry.session instanceof WeakRef); assert.equal(entry.result.status, 'ready');}
  const agent = r.agent(); await generate(service, agent); service.disposeSession(agent.session);
  assert.equal([...service.cache.values()].some(entry => entry.session.deref() === agent.session), false); await service.dispose();
});
test('scoped llm is preferred without changing its exact route', async () => {
  const scopedCalls = [], scopedLlm = {prepareCall: async (config, signal, configure) => {scopedCalls.push(config); return {config: {...config, ...configure({}, {})}, stream: () => response('{"hasGap":false,"suggestion":null}')()};}};
  const r = runtime({scopedLlm}), service = new NextInputService(r.ctx, r.projection);
  assert.equal((await generate(service, r.agent())).status, 'none'); assert.equal(scopedCalls.length, 1); assert.equal(r.calls.length, 0); await service.dispose();
});
test('custom Typert Remote matches exact scope, named codecs, cancellation and invocation', async () => {
  const contribution = remoteContribution(); assert.equal(contribution.face, 'host'); assert.equal(contribution.invocations.length, 1);
  const invocation = contribution.invocations[0]; assert.equal(invocation.id, '@local/dsh-next-input#localNextInput/generate');
  assert.deepEqual(invocation.scope, {context: 'agent', wire: 'agentId'}); assert.deepEqual(invocation.cancellation, {parameter: 'signal'});
  assert.equal(invocation.parameters[0].lookup, 'agent'); assert.equal(invocation.parameters[1].codec.typeSymbol, '@local/dsh-next-input#Request');
  assert.equal(invocation.result.typeSymbol, '@local/dsh-next-input#Reply');
  const input = invocation.input().create().parse({agentId: 'session-x', request: {endSeq: 3}}); assert.equal(input.agentId, 'session-x');
  assert.throws(() => invocation.input().create().parse({agentId: 'x', request: {endSeq: 3, text: 'inject'}}));
  assert.throws(() => invocation.result.create().parse({endSeq: 3, suggestion: 'bad', status: 'error'}));
  const controller = new AbortController(); let received;
  const result = await invocation.invoke({localNextInput: {generate: (...args) => {received = args; return {endSeq: 3, suggestion: null, status: 'none'};}}}, input, controller.signal);
  assert.deepEqual(received, ['session-x', {endSeq: 3}, controller.signal]); assert.equal(result.status, 'none');
});
