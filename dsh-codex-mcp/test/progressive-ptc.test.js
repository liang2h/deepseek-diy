import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {resolve, join} from 'node:path';
import {configDigest, publicToolName} from '../config.js';
import {saveTrust} from '../project.js';
import * as plugin from '../index.js';

// One coherent exact-rc.3 npm dependency graph. This deliberately does not use
// Desktop's ASAR, profile, an account adapter, credentials-local or real config.
const requireRuntime = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'));
const load = name => import(requireRuntime.resolve(name));
const {Context} = await load('@deepseek-ai/cordis');
const {default: Sessions} = await load('@deepseek-ai/dsh-session');
const {default: Projections} = await load('@deepseek-ai/dsh-session-projection');
const {default: Agents} = await load('@deepseek-ai/dsh-agent');
const {default: Llm, createUserMessage, isAgentLoopRequest} = await load('@deepseek-ai/dsh-llm');
const {default: SystemPrompt} = await load('@deepseek-ai/dsh-system-prompt');
const {default: Tools} = await load('@deepseek-ai/dsh-tools');
const {default: AgentLoop} = await load('@deepseek-ai/dsh-agent-loop');
const nativeExecutor = await load('@deepseek-ai/dsh-tool-executor-native');
const ptcExecutor = await load('@deepseek-ai/dsh-tool-executor-ptc');
const {default: NodePtcRuntime} = await load('@deepseek-ai/dsh-ptc-runtime-node');
const {default: SubprocessLocal} = await load('@deepseek-ai/dsh-subprocess-local');
const {default: SandboxLocal} = await load('@deepseek-ai/dsh-sandbox-local');
const {default: SandboxPolicy} = await load('@deepseek-ai/dsh-sandbox-policy');
const {DeepSeekAdapter, resolveAdapterOptions} = await load('@deepseek-ai/dsh-llm-deepseek');

const PROJECT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVER = 'codegraph', RAW_NAME = 'codegraph_explore';
const NAME = publicToolName(SERVER, RAW_NAME);
const MARKER = 'DSH_PTC_SYNTHETIC_LOOPBACK_ONLY';
const businessArgs = {marker: MARKER};
const managementArgs = names => ({action: 'load', names});
const programCall = (id, code) => ({id, name: 'run_code', input: {code, description: 'Inspect synthetic local PTC binding state'}});
const managementCall = (id, names) => ({id, name: 'codex_mcp', input: managementArgs(names)});
const probeCode = `return {bindingType: typeof tools.${NAME}, names: Object.keys(tools).sort()};`;
const callCode = `return await tools.${NAME}(${JSON.stringify(businessArgs)});`;
const loadCode = names => `return await tools.codex_mcp(${JSON.stringify(managementArgs(names))});`;
const done = {text: 'Synthetic local fixture completed.'};

function sse(action) {
  assert.ok(action, 'unscripted model request');
  const block = action.name ? {type: 'tool_use', id: action.id, name: action.name, input: action.input} : {type: 'text', text: action.text};
  return [
    {type: 'message_start', message: {usage: {input_tokens: 0, output_tokens: 0}}},
    {type: 'content_block_start', index: 0, content_block: block},
    {type: 'content_block_stop', index: 0},
    {type: 'message_delta', delta: {stop_reason: action.name ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 1}},
    {type: 'message_stop'},
  ].map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join('');
}

async function localEndpoints(t) {
  const actions = [], requests = [], calls = [], errors = [], sockets = new Set();
  const catalog = [{name: RAW_NAME, description: 'Synthetic loopback graph probe; never queries any project or account.',
    inputSchema: {type: 'object', properties: {marker: {type: 'string', const: MARKER}}, required: ['marker'], additionalProperties: false},
    annotations: {readOnlyHint: true}}];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.socket.remoteAddress, '127.0.0.1');
      assert.equal(request.headers.authorization, undefined, 'no credential may reach either local endpoint');
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({url: request.url, method: request.method, body});
      if (request.url === '/v1/messages') {
        assert.equal(request.method, 'POST');
        response.writeHead(200, {'content-type': 'text/event-stream'});
        response.end(sse(actions.shift())); return;
      }
      assert.equal(request.url, '/mcp');
      if (request.method === 'GET') {response.writeHead(405); response.end(); return;}
      if (request.method === 'DELETE') {response.writeHead(200); response.end(); return;}
      if (body?.id === undefined) {response.writeHead(202); response.end(); return;}
      let result;
      if (body.method === 'initialize') result = {protocolVersion: '2025-11-25', capabilities: {tools: {}},
        serverInfo: {name: 'synthetic-codegraph-local', version: '1.0.0'}};
      else if (body.method === 'tools/list') result = {tools: catalog};
      else if (body.method === 'tools/call') {
        assert.equal(body.params.name, RAW_NAME);
        assert.deepEqual(body.params.arguments, businessArgs);
        calls.push(body.params);
        result = {content: [{type: 'text', text: JSON.stringify({synthetic: true, marker: MARKER, rawName: RAW_NAME})}]};
      } else result = {};
      response.writeHead(200, {'content-type': 'application/json', ...(body.method === 'initialize' ? {'mcp-session-id': 'ptc-local-session'} : {})});
      response.end(JSON.stringify({jsonrpc: '2.0', id: body.id, result}));
    } catch (error) {errors.push(error); response.writeHead(500); response.end();}
  });
  server.on('connection', socket => {sockets.add(socket); socket.on('close', () => sockets.delete(socket));});
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  return {baseURL: `http://127.0.0.1:${server.address().port}`, actions, requests, calls, catalog};
}

function memoryCredentials() {
  const records = new Map();
  return {
    async resolve() {throw new Error('PTC fixture must never resolve credentials');},
    async readRecord(key) {return records.get(String(key));},
    async modifyRecord(key, change) {key = String(key); const next = await change(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key);},
    async deleteRecord(key) {records.delete(String(key));},
  };
}

async function harness(t, endpoints, {native = false} = {}) {
  const app = new Context(), commands = new Map();
  let executorOwner;
  const owner = app.plugin({name: 'progressive-real-ptc-fixture', async apply(ctx) {
    for (const service of [Sessions, Projections, Agents, Llm, SystemPrompt, Tools]) await ctx.plugin(service);
    ctx.reflect.provide('credentials', memoryCredentials());
    ctx.reflect.provide('commands', {register: definition => {
      commands.set(definition.name, definition); return () => commands.delete(definition.name);
    }});
    ctx.reflect.provide('workingDirectory', {get: () => PROJECT, ensure: async () => PROJECT});
    const text = `[mcp_servers.${SERVER}]\nurl=${JSON.stringify(`${endpoints.baseURL}/mcp`)}\n`;
    // All project config/trust is synthetic in-memory state. Only bootstrap path
    // mapping reaches the real runtime; no ~/.codex, profile or config is read.
    ctx.reflect.provide('fs', {
      resolve: async value => ({displayPath: value}), processPath: value => value.displayPath,
      processPathFromHostPath: value => value, contains: () => true,
      stat: async target => {assert.equal(target.displayPath, join(PROJECT, '.codex', 'config.toml')); return {type: 'file', size: Buffer.byteLength(text)};},
      readBytes: async target => {assert.equal(target.displayPath, join(PROJECT, '.codex', 'config.toml')); return Buffer.from(text);},
      watch: async () => () => {},
    });
    await saveTrust(ctx.credentials, {root: PROJECT, digest: configDigest(text)});
    // Real local subprocess + OS sandbox providers, no fake evaluator or binding
    // proxy. Programs run read-only, require no approval and have a short budget.
    await ctx.plugin(SubprocessLocal);
    await ctx.plugin(SandboxLocal);
    await ctx.plugin(SandboxPolicy, {mode: 'read-only', workspaceRoot: PROJECT});
    await ctx.plugin(NodePtcRuntime, {executionMode: 'per-call', timeoutMs: 10000, maxTimeoutMs: 10000});
    executorOwner = ctx.plugin(native ? nativeExecutor : ptcExecutor); await executorOwner;
    await ctx.plugin(AgentLoop);
    const options = resolveAdapterOptions({baseURL: endpoints.baseURL, thinking: 'disabled', models: [{id: 'local-model', systemPromptUpdate: 'in-history', toolUpdate: 'in-history'}]});
    ctx.get('llm').registerAdapter(['local-ptc-fixture'], new DeepSeekAdapter({options: () => options,
      resolveAuth: async () => ({headers: {}}), resolveUserId: () => 'synthetic-ptc-test',
      prepareExtensions: async () => ({fields: {}, accept: async () => {}})}));
    await ctx.plugin(plugin);
  }});
  await owner;
  const ctx = owner.ctx, errors = [], loopRequests = [], logs = new WeakMap();
  assert.equal(ctx.get('ptcRuntime').language, 'typescript');
  assert.equal(ctx.get('ptcRuntime').isolation, 'process');
  assert.equal(ctx.get('ptcRuntime').programFormat, 'function-body');
  ctx.on('session/event', (session, event) => {
    let events = logs.get(session); if (!events) {events = []; logs.set(session, events);} events.push(event);
  });
  ctx.on('agent/error', ({error}) => errors.push(error));
  ctx.on('llm/stream', (request, next) => {
    assert.equal(isAgentLoopRequest(request), true); assert.equal(Object.isFrozen(request), true);
    loopRequests.push(request); return next();
  });
  const create = options => ctx.get('agents').create({agentOptions: {provider: 'local-ptc-fixture', model: 'local-model'}, meta: {cwd: PROJECT}, ...options});
  let handle = await create({sessionId: `ptc-fixture-${native ? 'native' : 'ptc'}`});
  t.after(async () => {await handle.dispose(); await owner.dispose();});
  return {ctx, loopRequests, get agent() {return handle.agent;},
    events: () => logs.get(handle.agent.session) ?? [],
    async turn(actions) {
      endpoints.actions.push(...actions, done);
      handle.agent.followup(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'Run only the synthetic loopback PTC regression probe.'}]}));
      await handle.agent.whenIdle();
      assert.deepEqual(errors, [], errors.map(error => error?.stack ?? String(error)).join('\n'));
      assert.equal(endpoints.actions.length, 0, 'every scripted model step must be consumed');
    },
    async usePtc() {await executorOwner.dispose(); executorOwner = ctx.plugin(ptcExecutor); await executorOwner;},
    async rebuild(options) {await handle.dispose(); handle = await create(options);},
    async command(rawInput) {
      const result = await commands.get('codex-mcp').handler({agent: handle.agent, rawInput, signal: new AbortController().signal});
      assert.equal(result.kind, 'success', result.text); return JSON.parse(result.text);
    },
  };
}

function outcome(h, callId) {
  const event = h.events().findLast(event => event.type === 'tool/result' && event.data.message.toolCallId === callId);
  assert.ok(event, `actual AgentLoop must commit tool/result for ${callId}`); return event.data;
}
function text(h, callId) {return outcome(h, callId).message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');}
function assertSuccess(h, callId) {
  const value = outcome(h, callId);
  assert.notEqual(value.message.isError, true, text(h, callId)); assert.equal(value.error, undefined, text(h, callId));
}
function assertBinding(h, id, expected) {
  assertSuccess(h, id); const value = JSON.parse(text(h, id));
  assert.equal(value.bindingType, expected, `real runtime tools.${NAME} should be ${expected}`);
  assert.equal(value.names.includes(NAME), expected === 'function');
}
function assertMissing(h, id) {
  const result = outcome(h, id); assert.equal(result.message.isError, true);
  assert.equal(result.error?.code, 'CODE_RUN_FAILED'); assert.match(text(h, id), /is not a function/);
}
function assertUnknown(h, id) {
  const result = outcome(h, id); assert.equal(result.message.isError, true); assert.equal(result.error?.code, 'UNKNOWN_TOOL');
}
function diagnosticDispatch(t, h) {
  for (const event of h.events().filter(event => event.type.startsWith('tool/ptc-dispatch') && event.data.name === 'codex_mcp')) {
    const {subCallId, rootCallId, parentCallId, arguments: args, isError, meta} = event.data;
    t.diagnostic(JSON.stringify({type: event.type, subCallId, rootCallId, parentCallId, argumentsType: typeof args, arguments: args, isError,
      activationReceipt: meta?.codexMcpActivation !== undefined, instructionReceipt: meta?.codexMcpInstructions !== undefined}));
  }
}
function assertSyntheticResult(h, id) {
  assertSuccess(h, id); assert.match(text(h, id), new RegExp(MARKER)); assert.match(text(h, id), /synthetic/);
}

test('native committed load → next real PTC step exposes the binding and calls the local MCP SDK', {timeout: 30000}, async t => {
  const endpoints = await localEndpoints(t), h = await harness(t, endpoints, {native: true});
  await h.turn([{id: 'native-before-load', name: NAME, input: businessArgs}]);
  assertUnknown(h, 'native-before-load'); assert.equal(endpoints.calls.length, 0);
  await h.turn([managementCall('native-load', [NAME])]); assertSuccess(h, 'native-load');
  await h.usePtc();
  await h.turn([programCall('native-ptc-probe', probeCode), programCall('native-ptc-call', callCode)]);
  assertBinding(h, 'native-ptc-probe', 'function'); assertSyntheticResult(h, 'native-ptc-call');
  assert.equal(endpoints.calls.length, 1);
});

test('PTC load → next real step exposes the binding, commits receipts and calls the local MCP SDK', {timeout: 30000}, async t => {
  const endpoints = await localEndpoints(t), h = await harness(t, endpoints);
  await h.turn([programCall('ptc-before-probe', probeCode), programCall('ptc-before-call', callCode)]);
  assertBinding(h, 'ptc-before-probe', 'undefined'); assertMissing(h, 'ptc-before-call'); assert.equal(endpoints.calls.length, 0);
  await h.turn([programCall('ptc-load', loadCode([NAME])), programCall('ptc-after-probe', probeCode), programCall('ptc-after-call', callCode)]);
  diagnosticDispatch(t, h);
  assertSuccess(h, 'ptc-load');
  const dispatch = h.events().find(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'codex_mcp');
  assert.ok(dispatch); assert.equal(typeof dispatch.data.arguments, 'object');
  assert.deepEqual(dispatch.data.arguments, managementArgs([NAME]));
  assert.equal(dispatch.data.isError, false); assert.ok(dispatch.data.meta?.codexMcpActivation);
  assertBinding(h, 'ptc-after-probe', 'function'); assertSyntheticResult(h, 'ptc-after-call');
  assert.equal(endpoints.calls.length, 1);
});

test('same run_code load does not mutate its SDK snapshot; the following real step receives the binding', {timeout: 30000}, async t => {
  const endpoints = await localEndpoints(t), h = await harness(t, endpoints);
  const code = `const loaded = await tools.codex_mcp(${JSON.stringify(managementArgs([NAME]))});
let immediate; try { await tools.${NAME}(${JSON.stringify(businessArgs)}); immediate = 'unexpected-success'; }
catch (error) { immediate = {name: error.name, message: error.message}; }
return {effective: loaded.effective, bindingType: typeof tools.${NAME}, immediate};`;
  await h.turn([programCall('same-step-load-call', code), programCall('next-step-probe', probeCode), programCall('next-step-call', callCode)]);
  diagnosticDispatch(t, h);
  assertSuccess(h, 'same-step-load-call'); const same = JSON.parse(text(h, 'same-step-load-call'));
  assert.equal(same.effective, 'next-step-after-successful-log-commit'); assert.equal(same.bindingType, 'undefined');
  assert.equal(same.immediate.name, 'TypeError'); assert.match(same.immediate.message, /is not a function/);
  assertBinding(h, 'next-step-probe', 'function'); assertSyntheticResult(h, 'next-step-call'); assert.equal(endpoints.calls.length, 1);
});

test('real PTC clear, revoke, reconnect and fork do not preserve stale execution authority', {timeout: 45000}, async t => {
  // Native seeding isolates withdrawal/fork coverage from a PTC activation bug.
  const endpoints = await localEndpoints(t), h = await harness(t, endpoints, {native: true});
  await h.turn([managementCall('lifecycle-native-seed', [NAME])]); await h.usePtc();
  await h.turn([programCall('seed-call', callCode)]); assertSyntheticResult(h, 'seed-call');
  const initialized = () => endpoints.requests.filter(request => request.body?.method === 'initialize').length;
  const beforeReload = initialized();
  await h.turn([programCall('same-reload', 'return await tools.codex_mcp({action: "reload"});'), programCall('after-same-reload', callCode)]);
  assert.equal(initialized(), beforeReload + 1); assertSyntheticResult(h, 'after-same-reload');
  // A binding captured at start of run survives the object snapshot, but its
  // removed definition cannot be executed after reconnect changes the schema.
  endpoints.catalog[0].description += ' Changed signature.';
  await h.turn([programCall('changed-reload-stale-call', `await tools.codex_mcp({action: "reload"});
try { await tools.${NAME}(${JSON.stringify(businessArgs)}); return {unexpectedSuccess: true}; }
catch (error) { return {name: error.name, message: error.message}; }`), programCall('after-changed-probe', probeCode)]);
  assertSuccess(h, 'changed-reload-stale-call'); assert.match(text(h, 'changed-reload-stale-call'), /ToolCallError/);
  const denied = h.events().findLast(event => event.type === 'tool/ptc-dispatch' && event.data.name === NAME);
  assert.equal(denied.data.isError, true); assert.equal(denied.data.error?.code, 'UNKNOWN_TOOL');
  assertBinding(h, 'after-changed-probe', 'undefined'); assert.equal(endpoints.calls.length, 2);

  // Fresh selection is always needed after a changed schema.
  await h.turn([programCall('reselect', loadCode([NAME])), programCall('reselect-probe', probeCode)]);
  assertBinding(h, 'reselect-probe', 'function');
  const sessionId = h.agent.session.id, seed = JSON.parse(JSON.stringify(h.events()));
  // Fork while the exact same project authority and catalog are still valid;
  // otherwise a trust revocation could accidentally mask inherited authority.
  await h.rebuild({sessionId: `${sessionId}-fork`, seed, inheritedEventCount: seed.length,
    meta: {cwd: PROJECT, isSeeded: true, parentSession: sessionId}});
  await h.turn([programCall('fork-probe', probeCode), programCall('fork-call', callCode)]);
  assertBinding(h, 'fork-probe', 'undefined'); assertMissing(h, 'fork-call'); assert.equal(endpoints.calls.length, 2);
  await h.rebuild({sessionId, seed, inheritedEventCount: 0});
  await h.turn([programCall('same-id-restored-probe', probeCode)]); assertBinding(h, 'same-id-restored-probe', 'function');
  const fingerprint = (await h.command('status')).fingerprint;
  await h.turn([programCall('clear', loadCode([])), programCall('after-clear-probe', probeCode), programCall('after-clear-call', callCode)]);
  assertBinding(h, 'after-clear-probe', 'undefined'); assertMissing(h, 'after-clear-call');
  await h.turn([programCall('reload-before-revoke', loadCode([NAME])), programCall('before-revoke-probe', probeCode)]);
  assertSuccess(h, 'reload-before-revoke'); assertBinding(h, 'before-revoke-probe', 'function');
  await h.command('untrust');
  await h.turn([programCall('after-revoke-probe', probeCode), programCall('after-revoke-call', callCode)]);
  assertBinding(h, 'after-revoke-probe', 'undefined'); assertMissing(h, 'after-revoke-call');
  await h.command(`trust ${fingerprint}`);
  await h.turn([programCall('after-retrust-probe', probeCode)]); assertBinding(h, 'after-retrust-probe', 'undefined');
  assert.equal(endpoints.calls.length, 2, 'clear, revoke, retrust, restoration and fork never replay business calls');
});
