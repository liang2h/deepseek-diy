import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {ServerConnection} from '../connection.js';
import {configDigest, parseProjectConfig, publicToolName} from '../config.js';
import {saveTrust} from '../project.js';
import * as plugin from '../index.js';

// Resolve one coherent set of real, exact-version DSH packages. No ASAR access,
// provider account plugins, credentials-local, user config, or remote endpoint.
const requireRuntime = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'));
const load = name => import(requireRuntime.resolve(name));
const {Context} = await load('@deepseek-ai/cordis');
const {default: Sessions} = await load('@deepseek-ai/dsh-session');
const {default: Projections} = await load('@deepseek-ai/dsh-session-projection');
const {default: Agents} = await load('@deepseek-ai/dsh-agent');
const {default: Llm, createUserMessage, isAgentLoopRequest} = await load('@deepseek-ai/dsh-llm');
const {default: SystemPrompt} = await load('@deepseek-ai/dsh-system-prompt');
const {default: Tools} = await load('@deepseek-ai/dsh-tools');
const {default: AgentLoop} = await import('@deepseek-ai/dsh-agent-loop');
const nativeExecutor = await import('@deepseek-ai/dsh-tool-executor-native');
const {DeepSeekAdapter, resolveAdapterOptions} = await import('@deepseek-ai/dsh-llm-deepseek');

const TOOL_COUNT = 240;
const FIRST_RAW = 'catalog_item_000';
const FIRST_NAME = publicToolName('large_local', FIRST_RAW);
const CALL_MARKER = 'DSH_SYNTHETIC_LOCAL_ONLY';
// OAuth identity canonicalizes an existing root, but all config/credential reads
// remain the explicit in-memory services below (never the project's real files).
const PROJECT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tools = Array.from({length: TOOL_COUNT}, (_, index) => ({
  name: `catalog_item_${String(index).padStart(3, '0')}`,
  description: `Local synthetic catalog operation ${index}. Inspect the requested item and return its status, category, owner, region and bounded detail. No external data.`,
  inputSchema: {type: 'object', properties: {
    item: {type: 'string', description: 'Synthetic local item identifier.'},
    region: {type: 'string', description: 'Synthetic local region.'},
    category: {type: 'string', description: 'Synthetic category filter.'},
    offset: {type: 'integer', minimum: 0, description: 'First synthetic item offset.'},
    limit: {type: 'integer', minimum: 1, maximum: 100, description: 'Maximum synthetic result count.'},
  }, additionalProperties: false},
  annotations: {readOnlyHint: true},
}));

function sse(action = {text: 'Local fixture completed.'}) {
  const block = action.call ? {type: 'tool_use', id: `local-${action.id ?? 'call'}`, name: action.name ?? 'codex_mcp', input: action.call} : {type: 'text', text: action.text};
  return [
    {type: 'message_start', message: {usage: {input_tokens: 0, output_tokens: 0}}},
    {type: 'content_block_start', index: 0, content_block: block},
    {type: 'content_block_stop', index: 0},
    {type: 'message_delta', delta: {stop_reason: action.call ? 'tool_use' : 'end_turn'}, usage: {output_tokens: 1}},
    {type: 'message_stop'},
  ].map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join('');
}

async function localEndpoints(t, {allowSyntheticCalls = false} = {}) {
  const modelRequests = [], mcpRequests = [], actions = [], sockets = new Set(), fixtureErrors = [];
  const catalog = structuredClone(tools), businessCalls = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.socket.remoteAddress, '127.0.0.1');
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      if (request.url === '/v1/messages') {
        assert.equal(request.method, 'POST');
        assert.equal(request.headers.authorization, undefined, 'fixture must never receive a real credential');
        modelRequests.push({raw, body, headers: {...request.headers}});
        response.writeHead(200, {'content-type': 'text/event-stream'});
        response.end(sse(actions.shift())); return;
      }
      assert.equal(request.url, '/mcp');
      mcpRequests.push({method: request.method, body});
      if (request.method === 'GET') {response.writeHead(405); response.end(); return;}
      if (request.method === 'DELETE') {response.writeHead(200); response.end(); return;}
      if (!body || body.id === undefined) {response.writeHead(202); response.end(); return;}
      let result;
      if (body.method === 'initialize') result = {protocolVersion: '2025-11-25', capabilities: {tools: {}},
        serverInfo: {name: 'large-local-fixture', version: '1.0.0'},
        instructions: 'LOCAL_MCP_INSTRUCTIONS_SENTINEL: use only the loaded synthetic local catalog operations.'};
      else if (body.method === 'tools/list') result = {tools: catalog};
      else if (body.method === 'tools/call') {
        assert.equal(allowSyntheticCalls, true, 'business calls are forbidden in request-shape tests');
        assert.equal(body.params.arguments?.item, CALL_MARKER, 'only explicitly marked synthetic local calls are permitted');
        assert.ok(catalog.some(tool => tool.name === body.params.name));
        businessCalls.push(body.params);
        result = {content: [{type: 'text', text: JSON.stringify({synthetic: true, marker: CALL_MARKER,
          rawName: body.params.name, arguments: body.params.arguments})}]};
      }
      else result = {};
      response.writeHead(200, {'content-type': 'application/json', ...(body.method === 'initialize' ? {'mcp-session-id': 'large-local-session'} : {})});
      response.end(JSON.stringify({jsonrpc: '2.0', id: body.id, result}));
    } catch (error) {
      fixtureErrors.push(error); response.writeHead(500); response.end();
    }
  });
  server.on('connection', socket => {sockets.add(socket); socket.on('close', () => sockets.delete(socket));});
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(fixtureErrors, []);
    assert.equal(mcpRequests.filter(request => request.body?.method === 'tools/call').length, allowSyntheticCalls ? businessCalls.length : 0);
  });
  return {baseURL: `http://127.0.0.1:${server.address().port}`, modelRequests, mcpRequests, actions, catalog, businessCalls};
}

function memoryCredentials() {
  const records = new Map();
  return {
    async resolve() {throw new Error('Request test must not resolve credentials');},
    async readRecord(key) {return records.get(String(key));},
    async modifyRecord(key, change) {key = String(key); const next = await change(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key);},
    async deleteRecord(key) {records.delete(String(key));},
  };
}

async function harness(t, endpoints, mode, {baseline = false, managementDefinition, standalone = false} = {}) {
  const app = new Context(), commands = new Map();
  const owner = app.plugin({name: `progressive-request-harness-${mode ?? 'compat'}`, async apply(ctx) {
    // These are the actual DSH services, including their init hooks and folds.
    for (const service of [Sessions, Projections, Agents, Llm, SystemPrompt, Tools]) await ctx.plugin(service);
    await ctx.plugin(nativeExecutor); await ctx.plugin(AgentLoop);
    ctx.reflect.provide('credentials', memoryCredentials());
    ctx.reflect.provide('commands', {register: definition => {
      commands.set(definition.name, definition); return () => commands.delete(definition.name);
    }});
    ctx.reflect.provide('subprocess', {resolveExecutable: async () => {throw new Error('No subprocess in request tests');}});
    ctx.reflect.provide('workingDirectory', {get: () => PROJECT});
    const text = `[mcp_servers.large_local]\nurl=${JSON.stringify(`${endpoints.baseURL}/mcp`)}\n`;
    ctx.reflect.provide('fs', {
      resolve: async value => ({displayPath: value}), processPath: value => value.displayPath,
      processPathFromHostPath: value => value, contains: () => true,
      stat: async () => ({type: 'file', size: Buffer.byteLength(text)}),
      readBytes: async () => Buffer.from(text), watch: async () => () => {},
    });
    await saveTrust(ctx.credentials, {root: PROJECT, digest: configDigest(text)});
    const options = resolveAdapterOptions({baseURL: endpoints.baseURL, thinking: 'disabled', models: [{id: 'local-model',
      systemPromptUpdate: 'in-history', ...(mode === undefined ? {} : {toolUpdate: mode})}]});
    ctx.get('llm').registerAdapter(['local-request-fixture'], new DeepSeekAdapter({options: () => options,
      resolveAuth: async () => ({headers: {}}), resolveUserId: () => 'synthetic-request-test',
      prepareExtensions: async () => ({fields: {}, accept: async () => {}})}));
    if (baseline) ctx.get('tools').register(managementDefinition);
    else if (!standalone) await ctx.plugin(plugin);
  }});
  await owner;
  const ctx = owner.ctx, errors = [], loopRequests = [], logs = new WeakMap();
  // Observe the genuine append feed; do not use deprecated Session snapshot APIs
  // or hand-author activation/tool-result records for restoration tests.
  ctx.on('session/event', (session, event) => {
    let events = logs.get(session); if (!events) {events = []; logs.set(session, events);}
    events.push(event);
  });
  ctx.on('agent/error', ({error}) => errors.push(error));
  ctx.on('llm/stream', (request, next) => {
    assert.equal(isAgentLoopRequest(request), true, 'request must come from the real loop builder');
    assert.equal(Object.isFrozen(request), true);
    loopRequests.push(request); return next();
  });
  const create = options => ctx.get('agents').create({
    agentOptions: {provider: 'local-request-fixture', model: 'local-model'}, meta: {cwd: PROJECT}, ...options});
  let handle = await create({sessionId: `request-${mode ?? 'compat'}-${baseline ? 'baseline' : 'progressive'}`});
  let connection;
  if (baseline) {
    const server = parseProjectConfig(`[mcp_servers.large_local]\nurl=${JSON.stringify(`${endpoints.baseURL}/mcp`)}\n`).servers[0];
    connection = new ServerConnection({ctx: handle.agent.ctx, agent: handle.agent, server, projectRoot: PROJECT,
      selected: () => true, validate: async () => {}});
    await connection.connect(); assert.equal(connection.state, 'ready');
  }
  t.after(async () => {await connection?.dispose(); await handle.dispose(); await owner.dispose();});
  async function turn(actions = [{text: 'Local fixture completed.'}]) {
    const start = endpoints.modelRequests.length;
    endpoints.actions.push(...actions);
    handle.agent.followup(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'Inspect the synthetic local catalog.'}]}));
    await handle.agent.whenIdle();
    assert.deepEqual(errors, [], errors.map(error => error?.stack ?? String(error)).join('\n'));
    assert.equal(endpoints.actions.length, 0, 'every scripted model response should be consumed');
    return endpoints.modelRequests.slice(start);
  }
  return {ctx, get agent() {return handle.agent;}, turn, loopRequests,
    events: () => logs.get(handle.agent.session) ?? [],
    async rebuild(options) {
      await handle.dispose(); handle = await create(options);
    },
    async command(rawInput) {
      const result = await commands.get('codex-mcp').handler({agent: handle.agent, rawInput, signal: new AbortController().signal});
      assert.equal(result.kind, 'success', result.text); return JSON.parse(result.text);
    },
  };
}

function schemaNames(request) {return (request.body.tools ?? []).map(tool => tool.name);}
function changeBlocks(request, type) {return request.body.messages.flatMap(message => message.content ?? []).filter(block => block.type === type);}
function syntheticCall(id, name = FIRST_NAME) {return {name, id, call: {item: CALL_MARKER}};}
function managementCall(id, action, fields = {}) {return {id, call: {action, ...fields}};}
function toolOutcome(runtime, id) {
  const event = runtime.events().findLast(event => event.type === 'tool/result' && event.data.message.toolCallId === `local-${id}`);
  assert.ok(event, `native loop did not commit tool/result for ${id}`); return event.data;
}
function assertUnknown(runtime, id) {
  const outcome = toolOutcome(runtime, id);
  assert.equal(outcome.message.isError, true);
  assert.equal(outcome.error?.code, 'UNKNOWN_TOOL');
}
function activeNames(runtime) {return (runtime.loopRequests.at(-1).tools ?? []).map(tool => tool.name);}

function metrics(request) {
  const schemaText = JSON.stringify(request.body.tools ?? []);
  return {bodyBytes: Buffer.byteLength(request.raw), schemaBytes: Buffer.byteLength(schemaText),
    schemas: request.body.tools?.length ?? 0, maxTokens: request.body.max_tokens,
    // Character density only, not the model tokenizer or reported API usage.
    schemaTokensDensityEstimate: Math.ceil(schemaText.length / 4)};
}

for (const mode of [undefined, 'addition-only', 'in-history']) {
  test(`actual SDK execution and trust/directory lifecycle: ${mode ?? 'unsupported'}`, {timeout: 20000}, async t => {
    const endpoints = await localEndpoints(t, {allowSyntheticCalls: true});
    const runtime = await harness(t, endpoints, mode);
    await runtime.turn([syntheticCall('before-load'), {text: 'Unavailable tool rejected.'}]);
    assertUnknown(runtime, 'before-load'); assert.equal(endpoints.businessCalls.length, 0);

    const loaded = await runtime.turn([
      managementCall('select', 'load', {names: [FIRST_NAME]}),
      syntheticCall('first-success'), {text: 'The marked synthetic operation completed.'},
    ]);
    assert.equal(loaded.length, 3);
    assert.notEqual(toolOutcome(runtime, 'first-success').message.isError, true);
    assert.equal(toolOutcome(runtime, 'first-success').error, undefined);
    assert.equal(endpoints.businessCalls.length, 1);
    assert.equal(endpoints.businessCalls[0].name, FIRST_RAW);
    assert.equal(endpoints.businessCalls[0].arguments.item, CALL_MARKER);
    const returned = changeBlocks(loaded[2], 'tool_result').find(block => block.tool_use_id === 'local-first-success');
    assert.ok(returned, 'the actual model request must answer the successful native tool call');
    const responseValue = JSON.parse(returned.content.find(block => block.type === 'text').text);
    assert.equal(responseValue.synthetic, true, 'the real SDK response, not just echoed call arguments, must reach the model');
    assert.equal(responseValue.rawName, FIRST_RAW);

    const initialized = () => endpoints.mcpRequests.filter(request => request.body?.method === 'initialize').length;
    const beforeReconnect = initialized();
    await runtime.turn([managementCall('same-directory-reload', 'reload'), {text: 'Reconnected without replay.'}]);
    assert.equal(initialized(), beforeReconnect + 1);
    assert.ok(activeNames(runtime).includes(FIRST_NAME), 'same schema signature restores the selected tool after reconnect');
    assert.equal(endpoints.businessCalls.length, 1, 'reconnect must never replay previous business calls');
    await runtime.turn([syntheticCall('after-reload'), {text: 'Explicit second synthetic call completed.'}]);
    assert.equal(toolOutcome(runtime, 'after-reload').error, undefined);
    assert.equal(endpoints.businessCalls.length, 2);

    const fingerprint = (await runtime.command('status')).fingerprint;
    await runtime.command('untrust');
    await runtime.turn([syntheticCall('after-untrust'), {text: 'Revoked trust rejected the old call.'}]);
    assertUnknown(runtime, 'after-untrust'); assert.equal(endpoints.businessCalls.length, 2);
    await runtime.command(`trust ${fingerprint}`);
    await runtime.turn([syntheticCall('after-retrust'), {text: 'Retrust does not restore the previous activation receipt.'}]);
    assertUnknown(runtime, 'after-retrust'); assert.equal(endpoints.businessCalls.length, 2);
    assert.equal(activeNames(runtime).includes(FIRST_NAME), false, 'same digest plus a new trust authority must not revive selection');
    await runtime.turn([managementCall('select-after-retrust', 'load', {names: [FIRST_NAME]}), {text: 'Selected under the new authority.'}]);
    assert.ok(activeNames(runtime).includes(FIRST_NAME));

    // A real tools/list response changes the raw SDK tool signature. Neither a
    // same-name changed definition nor a newly advertised name may auto-load.
    endpoints.catalog[0].description += ' Signature-changing revision two.';
    const addedRaw = 'catalog_item_new';
    endpoints.catalog.push({...structuredClone(endpoints.catalog[1]), name: addedRaw});
    const addedName = publicToolName('large_local', addedRaw);
    await runtime.turn([
      managementCall('changed-directory-reload', 'reload'),
      syntheticCall('changed-signature'), syntheticCall('new-tool', addedName),
      {text: 'Changed and newly advertised definitions remained unloaded.'},
    ]);
    assertUnknown(runtime, 'changed-signature'); assertUnknown(runtime, 'new-tool');
    assert.equal(endpoints.businessCalls.length, 2);
    assert.equal(activeNames(runtime).includes(FIRST_NAME), false);
    assert.equal(activeNames(runtime).includes(addedName), false);
    await runtime.turn([
      managementCall('select-revised', 'load', {names: [FIRST_NAME]}),
      syntheticCall('revised-success'), {text: 'Explicit selection activates the revised schema.'},
    ]);
    assert.equal(toolOutcome(runtime, 'revised-success').error, undefined);
    assert.equal(endpoints.businessCalls.length, 3);
    const cleared = await runtime.turn([
      managementCall('clear-working-set', 'load', {names: []}),
      syntheticCall('after-clear'), {text: 'Cleared tool rejected despite historical schemas.'},
    ]);
    assertUnknown(runtime, 'after-clear'); assert.equal(endpoints.businessCalls.length, 3);
    assert.equal(activeNames(runtime).includes(FIRST_NAME), false);
    if (mode === 'in-history') assert.ok(schemaNames(cleared[1]).includes(FIRST_NAME), 'historical wire declaration is not execution authority');
  });

  test(`serialized native log reconstruction and fork isolation: ${mode ?? 'unsupported'}`, {timeout: 20000}, async t => {
    const endpoints = await localEndpoints(t, {allowSyntheticCalls: true});
    const runtime = await harness(t, endpoints, mode);
    await runtime.turn([
      managementCall('seed-selection', 'load', {names: [FIRST_NAME]}),
      syntheticCall('seed-success'), {text: 'Recorded selection and completed synthetic operation.'},
    ]);
    assert.equal(endpoints.businessCalls.length, 1);
    const sessionId = runtime.agent.session.id;
    const seed = JSON.parse(JSON.stringify(runtime.events()));
    assert.ok(seed.some(event => event.type === 'tool/result' && event.data.meta?.codexMcpActivation), 'reconstruction must use genuinely committed presentation metadata');
    assert.equal(seed.at(-1).seq + 1, seed.length, 'capture must contain the complete contiguous native event log');
    await runtime.rebuild({sessionId, seed, inheritedEventCount: 0});
    assert.equal(endpoints.businessCalls.length, 1, 'reconstruction never replays completed business calls');
    await runtime.turn([syntheticCall('restored-success'), {text: 'Same-id JSON-log reconstruction restored selection.'}]);
    assert.equal(toolOutcome(runtime, 'restored-success').error, undefined);
    assert.equal(endpoints.businessCalls.length, 2);
    assert.ok(activeNames(runtime).includes(FIRST_NAME));
    // This is explicit seeded reconstruction, not the persistence resume API.
    // A child receives the exact same historical log as an inherited prefix.
    await runtime.rebuild({sessionId: `${sessionId}-fork`, seed, inheritedEventCount: seed.length,
      meta: {cwd: PROJECT, isSeeded: true, parentSession: sessionId}});
    await runtime.turn([syntheticCall('fork-denied'), {text: 'Fork must select its own working set.'}]);
    assertUnknown(runtime, 'fork-denied');
    assert.equal(activeNames(runtime).includes(FIRST_NAME), false);
    assert.equal(endpoints.businessCalls.length, 2);
  });

  test(`deferLoading wire contract through the actual loop and HTTP adapter: ${mode ?? 'unsupported'}`, {timeout: 20000}, async t => {
    const endpoints = await localEndpoints(t);
    const runtime = await harness(t, endpoints, mode, {standalone: true});
    const definition = {name: 'deferred_probe', description: 'Synthetic definition used only to inspect deferred-loading serialization.',
      parameters: {type: 'object', additionalProperties: false}, deferLoading: true,
      output: {schema: {type: 'object'}, render: () => []},
      execute: async () => {throw new Error('Probe execution is forbidden');}};
    const dispose = runtime.agent.ctx.get('tools').register(definition);
    const [first] = await runtime.turn();
    assert.deepEqual(schemaNames(first), ['deferred_probe']);
    assert.equal(first.body.tools[0].defer_loading, mode === undefined ? undefined : true);
    assert.equal(changeBlocks(first, 'tool_addition').length, 0, 'a deferred baseline declaration must not manufacture an activation');
    dispose();
    const [removed] = await runtime.turn();
    assert.deepEqual(schemaNames(removed), mode === 'in-history' ? ['deferred_probe'] : []);
    runtime.agent.ctx.get('tools').register(definition);
    const [reintroduced] = await runtime.turn();
    assert.deepEqual(schemaNames(reintroduced), ['deferred_probe']);
    // rc.2 rebaseAdditionOnlyHistory rebuilds the immediate baseline on a
    // removal or addition to an empty set, omitting superseded tool updates.
    // Only in-history retains the deferred declaration plus its new activation.
    assert.equal(reintroduced.body.tools[0].defer_loading, mode === 'in-history' ? true : undefined);
    assert.deepEqual(changeBlocks(reintroduced, 'tool_addition').map(block => block.tool.name), mode === 'in-history' ? ['deferred_probe'] : []);
  });
  test(`real Loop + LlmRuntime + DeepSeek HTTP request: ${mode ?? 'unsupported compatibility'} with ${TOOL_COUNT} connected tools`, {timeout: 20000}, async t => {
    const endpoints = await localEndpoints(t);
    const progressive = await harness(t, endpoints, mode);
    assert.equal(endpoints.mcpRequests.filter(request => request.body?.method === 'tools/list').length, 1,
      JSON.stringify(await progressive.ctx.get('tools').get('codex_mcp').execute({action: 'status'}, {agent: progressive.agent, signal: new AbortController().signal})));
    const [first] = await progressive.turn();
    t.diagnostic(JSON.stringify({stage: 'first-connected-request', mode: mode ?? 'unsupported', ...metrics(first)}));
    assert.equal(schemaNames(first).length, 1, 'only the management schema belongs in the first connected request');
    assert.deepEqual(schemaNames(first), ['codex_mcp']);
    assert.equal(first.raw.includes('LOCAL_MCP_INSTRUCTIONS_SENTINEL'), false, 'unloaded server instructions must not leak into first request');
    const before = progressive.loopRequests.length;
    const loaded = await progressive.turn([
      {call: {action: 'load', names: [FIRST_NAME]}, id: 'load'},
      {text: 'Loaded the selected synthetic tool.'},
    ]);
    assert.equal(loaded.length, 2);
    assert.equal(schemaNames(loaded[0]).includes(FIRST_NAME), false, 'load call request precedes its committed result');
    assert.deepEqual(schemaNames(loaded[1]).sort(), ['codex_mcp', FIRST_NAME].sort());
    assert.equal(loaded[1].raw.includes('LOCAL_MCP_INSTRUCTIONS_SENTINEL'), true);
    const loopAfterLoad = progressive.loopRequests[before + 1];
    assert.ok(loopAfterLoad.messages.some(message => message.role === 'tool' && message.toolCallId === 'local-load'), 'the native loop must commit the actual management tool result before activating the next step');
    assert.ok(loopAfterLoad.messages.some(message => message.role === 'developer' && message.content.some(block => block.type === 'tool-addition' && block.toolName === FIRST_NAME)), 'the loop, not this test, must derive and log the schema addition');
    if (mode === undefined) {
      assert.equal(loaded[1].body.tools.some(tool => Object.hasOwn(tool, 'defer_loading')), false);
      assert.equal(changeBlocks(loaded[1], 'tool_addition').length, 0);
    } else {
      assert.equal(loaded[1].body.tools.find(tool => tool.name === FIRST_NAME).defer_loading, true);
      assert.deepEqual(changeBlocks(loaded[1], 'tool_addition').map(block => block.tool.name), [FIRST_NAME]);
      assert.match(loaded[1].headers['anthropic-beta'], /tool/);
    }
    const unloaded = await progressive.turn([
      {call: {action: 'load', names: []}, id: 'unload'},
      {text: 'Unloaded the selected synthetic tool.'},
    ]);
    assert.equal(unloaded.length, 2);
    if (mode === 'in-history') {
      assert.equal(schemaNames(unloaded[1]).includes(FIRST_NAME), true, 'in-history retains historical definition with removal');
      assert.deepEqual(changeBlocks(unloaded[1], 'tool_removal').map(block => block.tool.name), [FIRST_NAME]);
    } else {
      assert.deepEqual(schemaNames(unloaded[1]), ['codex_mcp']);
      assert.equal(changeBlocks(unloaded[1], 'tool_removal').length, 0);
    }
    const baseline = await harness(t, endpoints, mode, {baseline: true, managementDefinition: progressive.ctx.get('tools').get('codex_mcp')});
    const [eagerFirst] = await baseline.turn();
    assert.equal(schemaNames(eagerFirst).length, TOOL_COUNT + 1, 'pre-fix comparison admits the actual connected MCP definitions eagerly');
    const eager = metrics(eagerFirst), lazy = metrics(first);
    assert.ok(eager.bodyBytes > lazy.bodyBytes * 5, 'first request reduction must be measured from actual HTTP payloads');
    t.diagnostic(JSON.stringify({mode: mode ?? 'unsupported', toolsConnected: TOOL_COUNT, baselineAdmission: 'explicit selected=always true; actual MCP definitions and actual DSH request builder', before: eager, after: lazy}));
  });
}
