import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import * as compatibility from '../index.js';

// One coherent npm-installed rc.3 graph, never the running Desktop's ASAR,
// account plugins, credentials, user profile, filesystem tools, or MCP config.
const requireRuntime = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'));
const load = name => import(requireRuntime.resolve(name));
const {Context} = await load('@deepseek-ai/cordis');
const {default: Sessions} = await load('@deepseek-ai/dsh-session');
const {default: Projections} = await load('@deepseek-ai/dsh-session-projection');
const {default: Agents} = await load('@deepseek-ai/dsh-agent');
const {default: Llm, LlmAdapter, createUserMessage, isAgentLoopRequest} = await load('@deepseek-ai/dsh-llm');
const {default: SystemPrompt} = await load('@deepseek-ai/dsh-system-prompt');
const {default: Tools} = await load('@deepseek-ai/dsh-tools');
const {default: Approval, setApprovalPolicy} = await load('@deepseek-ai/dsh-user-approval');
const {default: PermissionPresets, AUTO_PRESET} = await load('@deepseek-ai/dsh-permission-presets');
const {default: AgentLoop} = await import('@deepseek-ai/dsh-agent-loop');
const nativeExecutor = await import('@deepseek-ai/dsh-tool-executor-native');
const actualAutoReview = await import('@deepseek-ai/dsh-experimental-auto-review');

// Route names and model aliases are opaque test inputs, never capability heuristics.
// Every adapter below is in memory: these are not real provider/account connections.
const ROUTES = [
  {provider: 'openai-codex', model: 'synthetic-local-model', supportsTemperature: false},
  {provider: 'openai', model: 'synthetic-api-reasoner', supportsTemperature: false},
  {provider: 'openai-responses', model: 'synthetic-responses-alias', supportsTemperature: false},
  {provider: 'corporate-openai-alias', model: 'synthetic-private-deployment', supportsTemperature: false},
  {provider: 'future-router-v7', model: 'private-reasoner-2031', supportsTemperature: false},
  {provider: 'deepseek', model: 'synthetic-deepseek-chat', supportsTemperature: true},
  {provider: 'anthropic', model: 'synthetic-claude-alias', supportsTemperature: true},
];
const SAFETY_ROUTES = [ROUTES[0], ROUTES[1], ROUTES[4]];
const CWD = '/synthetic/auto-review-project'; // Metadata only: this path is never opened.
const TOOL = 'synthetic_body_probe';
const MARKER = 'DSH_AUTO_REVIEW_SYNTHETIC_ONLY';
const ALLOW = '{"risk":"low","decision":"allow"}';
const DENY = '{"risk":"medium","decision":"deny","reason":"Synthetic reviewer denial"}';
const UNSUPPORTED = "Unsupported parameter: 'temperature' is not supported with this model.";

function* textChunks(text, finish = {kind: 'stop'}) {
  yield {type: 'block-start', index: 0, blockType: 'text'};
  yield {type: 'text-delta', index: 0, text};
  yield {type: 'block-end', index: 0, block: {type: 'text', text}};
  yield {type: 'finish', reason: finish};
}

function* callChunks(id) {
  const block = {type: 'tool-call', id, name: TOOL, arguments: JSON.stringify({marker: MARKER})};
  yield {type: 'block-start', index: 0, blockType: 'tool-call'};
  yield {type: 'tool-call-delta', index: 0, id, name: TOOL, argumentsDelta: block.arguments};
  yield {type: 'block-end', index: 0, block};
  yield {type: 'finish', reason: {kind: 'tool-calls'}};
}

// Only the model is fake. It deliberately reproduces the unsupported-control
// rejection; all review snapshot construction, strict JSON parsing, permission
// folds, approval audit, tool dispatch, and Session logging are shipped DSH code.
class SyntheticModel extends LlmAdapter {
  requests = [];
  main = [];
  review = {text: ALLOW};

  constructor(supportsTemperature) {
    super();
    this.supportsTemperature = supportsTemperature;
  }

  async *stream(options) {
    this.requests.push(options);
    if (options.purpose === 'auto-review') {
      if (!this.supportsTemperature && Object.hasOwn(options, 'temperature')) throw new Error(UNSUPPORTED);
      if (this.review.throw) throw this.review.throw;
      yield* textChunks(this.review.text ?? ALLOW, this.review.finish);
      return;
    }
    const action = this.main.shift();
    if (!action) throw new Error('Unexpected extra synthetic main-model request');
    if (action.call) yield* callChunks(action.call);
    else yield* textChunks('Synthetic fixture turn complete.');
  }
}

async function harness(t, {fixed = true, approvalPolicy = 'ask', answer = 'rejected',
  provider = ROUTES[0].provider, model = ROUTES[0].model,
  supportsTemperature = false, compatibilityConfig} = {}) {
  const app = new Context(), adapter = new SyntheticModel(supportsTemperature);
  const events = [], errors = [], approvals = [], mainIngress = [], reviewIngress = [], bodies = [];
  const owner = app.plugin({name: 'synthetic-auto-review-regression', async apply(ctx) {
    for (const service of [Sessions, Projections, Agents, Llm, SystemPrompt, Tools, Approval]) await ctx.plugin(service);
    // The permission catalog requires a confining-shell capability fact. There
    // is deliberately no shell executor, subprocess, filesystem or account I/O.
    ctx.reflect.provide('shell', {sandboxMode: 'workspace-write'});
    ctx.reflect.provide('workingDirectory', {get: () => CWD, ensure: async () => CWD});
    await ctx.plugin(PermissionPresets);
    await ctx.plugin(nativeExecutor);
    await ctx.plugin(AgentLoop);
    ctx.get('llm').registerAdapter([provider], adapter);
    ctx.get('tools').register({
      name: TOOL,
      description: 'Increment an in-memory synthetic counter; no files, network, accounts or external effects.',
      parameters: {type: 'object', properties: {marker: {type: 'string', const: MARKER}}, required: ['marker'], additionalProperties: false},
      output: {schema: {type: 'object', properties: {synthetic: {type: 'boolean'}}, required: ['synthetic'], additionalProperties: false},
        render: (_args, value) => [{type: 'text', text: JSON.stringify(value)}]},
      async execute(args) {assert.deepEqual(args, {marker: MARKER}); bodies.push(args); return {synthetic: true};},
    });
    ctx.on('session/event', (_session, event) => events.push(event));
    ctx.on('agent/error', ({error}) => errors.push(error));
    ctx.on('approval/request', async request => {approvals.push(request); return answer;});
    ctx.on('llm/stream', (request, next) => {
      if (isAgentLoopRequest(request)) mainIngress.push(request);
      else if (request.purpose === 'auto-review') reviewIngress.push(request);
      return next();
    });
    await ctx.plugin(actualAutoReview); // Actual unmodified experimental plugin, not a copied gate.
  }});
  await owner;
  const ctx = owner.ctx;
  let fix;
  const mountFix = async () => {fix = ctx.plugin(compatibility, compatibilityConfig); await fix;};
  if (fixed) await mountFix();
  const handle = await ctx.get('agents').create({
    sessionId: `synthetic-auto-review-${t.name}`,
    agentOptions: {provider, model, maxTokens: 1234}, meta: {cwd: CWD},
  });
  const agent = handle.agent;
  ctx.get('permissionPresets').set(agent.session, AUTO_PRESET);
  if (approvalPolicy === 'never') setApprovalPolicy(agent.session, 'never');
  assert.equal(ctx.get('permissionPresets').current(agent.session), AUTO_PRESET);
  assert.equal(ctx.get('approval').overrideOf(agent.session), approvalPolicy);
  t.after(async () => {await handle.dispose(); await owner.dispose();});

  let serial = 0;
  async function turn(review = {text: ALLOW}) {
    const requestStart = adapter.requests.length, eventStart = events.length;
    const bodyStart = bodies.length, approvalStart = approvals.length, ingressStart = mainIngress.length;
    const reviewIngressStart = reviewIngress.length;
    const policy = ctx.get('permissionPresets').current(agent.session);
    const approvalOverride = ctx.get('approval').overrideOf(agent.session);
    const id = `synthetic-call-${++serial}`;
    adapter.review = review;
    adapter.main.push({call: id}, {done: true});
    agent.followup(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'Run the marked in-memory synthetic probe exactly once.'}]}));
    await agent.whenIdle();
    assert.deepEqual(errors, [], errors.map(error => error?.stack ?? String(error)).join('\n'));
    assert.equal(adapter.main.length, 0, 'both scripted main-model responses must be consumed exactly once');
    const emitted = events.slice(eventStart), requests = adapter.requests.slice(requestStart);
    const reviews = requests.filter(request => request.purpose === 'auto-review');
    const main = requests.filter(request => request.purpose !== 'auto-review');
    const outcomes = emitted.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === id);
    assert.equal(outcomes.length, 1, 'real native loop must commit exactly one tool result');
    assert.equal(emitted.filter(event => event.type === 'tool/call' && event.data.callId === id).length, 1);
    assert.equal(reviews.length, 1, 'one real gate review per call; never retry, swallow then replay, or duplicate dispatch');
    assert.equal(main.length, 2, 'the main loop makes only the scripted tool-call and final response requests');
    const ingress = mainIngress.slice(ingressStart);
    assert.equal(ingress.length, main.length);
    for (const [index, request] of main.entries()) {
      assert.equal(request, ingress[index], 'compatibility middleware must preserve native loop request identity');
      assert.equal(isAgentLoopRequest(request), true);
      assert.equal(Object.isFrozen(request), true);
      assert.equal(request.provider, provider, 'main request must keep its original provider/account route');
      assert.equal(request.model, model, 'main request must keep its original model alias');
      assert.equal(request.sessionId, agent.session.id);
      assert.equal(request.maxTokens, 1234, 'native frozen AgentLoop controls must remain untouched');
      assert.equal(Object.hasOwn(request, 'temperature'), false, 'rc.3 AgentOptions does not expose temperature');
    }
    const [request] = reviews;
    const sourceRequest = reviewIngress[reviewIngressStart];
    assert.ok(sourceRequest, 'the shipped AutoReview plugin must construct the original review');
    assert.equal(Object.isFrozen(sourceRequest), true);
    assert.equal(sourceRequest.temperature, 0, 'the actual rc.3 reviewer supplies temperature: 0');
    // Only the temperature member may change. In particular, retain the policy,
    // immutable history, cancellation signal, tools, and any other reference by identity.
    assert.deepEqual(Reflect.ownKeys(request).filter(key => key !== 'temperature'),
      Reflect.ownKeys(sourceRequest).filter(key => key !== 'temperature'));
    for (const key of Reflect.ownKeys(sourceRequest)) {
      if (key !== 'temperature') assert.equal(request[key], sourceRequest[key], `review field ${String(key)} must retain its value/reference`);
    }
    assert.equal(request.maxTokens, sourceRequest.maxTokens, 'review token budget must not change');
    assert.equal(isAgentLoopRequest(request), false);
    assert.equal(Object.isFrozen(request), true);
    assert.equal(request.provider, provider);
    assert.equal(request.model, model);
    assert.equal(request.sessionId, agent.session.id);
    assert.equal(request.signal instanceof AbortSignal, true);
    assert.match(request.system, /^REVIEW_POLICY\n/);
    const history = request.messages.slice(1).map(message => JSON.parse(message.content[0].text));
    assert.deepEqual(history.at(-1), {kind: 'tool-call', role: 'fact', mode: 'native', name: TOOL, arguments: JSON.stringify({marker: MARKER})});
    assert.ok(history.some(item => item.kind === 'tool-schema' && item.name === TOOL && item.mode === 'native'), 'schema must come from the real logged request header');
    assert.ok(main[1].messages.some(message => message.role === 'tool' && message.toolCallId === id), 'real native result must reach the following model step');
    assert.equal(ctx.get('permissionPresets').current(agent.session), policy, 'fix must not replace the permission policy');
    assert.equal(policy, AUTO_PRESET, 'fix must not disable Auto');
    assert.equal(ctx.get('approval').overrideOf(agent.session), approvalOverride, 'fix must not change approval policy');
    assert.equal(approvalOverride, approvalPolicy);
    return {outcome: outcomes[0].data, request, sourceRequest, events: emitted, bodyCount: bodies.length - bodyStart,
      approvals: approvals.slice(approvalStart)};
  }
  return {ctx, agent, turn, bodies, mountFix, async unloadFix() {await fix.dispose(); fix = undefined;}};
}

function assertFailure(result, code, message) {
  assert.equal(result.bodyCount, 0, 'a failed/denied review must never run the synthetic business body');
  assert.equal(result.outcome.message.isError, true);
  assert.equal(result.outcome.error?.code, code);
  if (message) assert.match(result.outcome.message.content.map(block => block.text ?? '').join('\n'), message);
}

function assertPatched(result) {
  assert.equal(Object.hasOwn(result.request, 'temperature'), false, 'omit the member, not temperature: undefined');
}

// Preserve all eleven original regressions, and run the same real gate failure
// paths for OpenAI API and an opaque custom route/model with no OpenAI substring.
for (const route of SAFETY_ROUTES) {
  const routeTest = (name, options, run) => test(`[${route.provider}] ${name}`, options, run);
  const routeHarness = (t, options) => harness(t, {...route, ...options});

  routeTest('actual Auto gate: unsupported temperature fails closed; fix allows once; unloading restores failure', {timeout: 15000}, async t => {
    const runtime = await routeHarness(t, {fixed: false});
    const before = await runtime.turn();
    assertFailure(before, 'AUTO_REVIEW_FAILED', /Unsupported parameter: 'temperature'/);
    assert.equal(before.request.temperature, 0);
    assert.equal(before.approvals.length, 0);

    await runtime.mountFix();
    const after = await runtime.turn();
    assertPatched(after);
    assert.equal(after.bodyCount, 1);
    assert.equal(after.outcome.message.isError, false);
    assert.equal(after.outcome.error, undefined);
    assert.equal(after.approvals.length, 0);
    assert.equal(before.request.temperature, 0, 'the original frozen review request was not mutated');

    await runtime.unloadFix();
    const unloaded = await runtime.turn();
    assertFailure(unloaded, 'AUTO_REVIEW_FAILED', /Unsupported parameter: 'temperature'/);
    assert.equal(unloaded.request.temperature, 0);
    assert.equal(runtime.bodies.length, 1, 'only the explicitly allowed fixed call ran');
  });

  routeTest('actual reviewer deny + ask retains real user-approval rejection and audit', {timeout: 15000}, async t => {
    const runtime = await routeHarness(t);
    const result = await runtime.turn({text: DENY});
    assertPatched(result);
    assertFailure(result, 'APPROVAL_REJECTED', /user rejected/);
    assert.equal(result.approvals.length, 1);
    assert.equal(result.approvals[0].toolName, TOOL);
    assert.match(result.approvals[0].reason, /Synthetic reviewer denial/);
    assert.equal(result.events.filter(event => event.type === 'approval/asked').length, 1);
    assert.deepEqual(result.events.filter(event => event.type === 'approval/decided').map(event => event.data.outcome), ['rejected']);
  });

  routeTest('actual reviewer deny + never is final without prompting, even with a willing synthetic answerer', {timeout: 15000}, async t => {
    const runtime = await routeHarness(t, {approvalPolicy: 'never', answer: 'allowed-once'});
    const result = await runtime.turn({text: DENY});
    assertPatched(result);
    assertFailure(result, 'AUTO_REVIEW_DENIED', /Auto review rejected/);
    assert.equal(result.outcome.error.reason, 'Synthetic reviewer denial');
    assert.equal(result.approvals.length, 0);
    assert.equal(result.events.filter(event => event.type === 'approval/asked').length, 0);
  });

  routeTest('reviewer allow still respects an independent downstream denial', {timeout: 15000}, async t => {
    const runtime = await routeHarness(t);
    runtime.ctx.on('tools/pre-execute', async () => ({kind: 'deny', reason: 'Synthetic independent policy veto',
      info: {name: 'SyntheticPolicyError', code: 'SYNTHETIC_POLICY_DENIED'}}));
    const result = await runtime.turn();
    assertPatched(result);
    assertFailure(result, 'SYNTHETIC_POLICY_DENIED', /independent policy veto/);
    assert.equal(result.approvals.length, 0);
  });

  const failedReviews = [
    ['finish error', {text: ALLOW, finish: {kind: 'error', failure: {code: 'SYNTHETIC_REVIEW_ERROR', message: 'Synthetic model failure'}}}, /reviewer ended with error SYNTHETIC_REVIEW_ERROR/],
    ['finish aborted', {text: ALLOW, finish: {kind: 'aborted', failure: {code: 'SYNTHETIC_REVIEW_ABORT', message: 'Synthetic model cancellation'}}}, /reviewer ended with aborted SYNTHETIC_REVIEW_ABORT/],
    ['adapter throw', {throw: new Error('Synthetic adapter threw')}, /Synthetic adapter threw/],
    ['malformed JSON', {text: '{not JSON}'}, /Auto review .* failed/],
    ['invalid allow with reason', {text: '{"risk":"low","decision":"allow","reason":"not permitted"}'}, /risk\/decision protocol/],
    ['invalid high allow', {text: '{"risk":"high","decision":"allow"}'}, /risk\/decision protocol/],
    ['duplicate JSON member', {text: '{"risk":"low","decision":"deny","decision":"allow"}'}, /repeats a JSON member/],
  ];
  for (const [label, review, errorMessage] of failedReviews) {
    routeTest(`actual Auto gate remains fail-closed without retries: ${label}`, {timeout: 15000}, async t => {
      const runtime = await routeHarness(t);
      const result = await runtime.turn(review);
      assertPatched(result);
      assertFailure(result, 'AUTO_REVIEW_FAILED', errorMessage);
      assert.equal(result.approvals.length, 0, 'review failure is not silently converted into a human-approval fallback');
    });
  }
}

for (const route of ROUTES) {
  test(`[${route.provider}/${route.model}] real Auto review omits temperature regardless of capability or legacy provider allowlist`, {timeout: 15000}, async t => {
    const runtime = await harness(t, {...route, fixed: false,
      compatibilityConfig: {providers: ['openai-codex']}});
    const before = await runtime.turn();
    assert.equal(before.request.temperature, 0);
    assert.equal(before.request, before.sourceRequest, 'without the compatibility plugin the actual request is unchanged');
    if (route.supportsTemperature) {
      assert.equal(before.bodyCount, 1, 'temperature-capable adapter accepts the original reviewer request');
      assert.equal(before.outcome.message.isError, false);
      assert.equal(before.outcome.error, undefined);
    } else {
      assertFailure(before, 'AUTO_REVIEW_FAILED', /Unsupported parameter: 'temperature'/);
    }
    assert.equal(before.approvals.length, 0);

    await runtime.mountFix();
    const after = await runtime.turn();
    assertPatched(after);
    assert.notEqual(after.request, after.sourceRequest, 'the frozen original is replaced, never mutated');
    assert.equal(after.sourceRequest.temperature, 0);
    assert.equal(after.bodyCount, 1, 'exactly one real native dispatch follows the actual allow decision');
    assert.equal(after.outcome.message.isError, false);
    assert.equal(after.outcome.error, undefined);
    assert.equal(after.approvals.length, 0);
    assert.equal(runtime.bodies.length, route.supportsTemperature ? 2 : 1,
      'no unsupported unpatched call runs, and no successful call runs twice');
    assert.deepEqual(runtime.ctx.get('permissionPresets').current(runtime.agent.session), AUTO_PRESET);
  });
}
