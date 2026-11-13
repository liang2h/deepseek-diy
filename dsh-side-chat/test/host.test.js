import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SideChatService, apply, modelContext, legacySideChats, remoteContribution} from '../index.js';
const copy = value => JSON.parse(JSON.stringify(value));
const msg = (id, role, text, source = {kind: 'user'}) => ({id, role, content: [{type: 'text', text}], source});
const config = {provider: 'test-provider', model: 'source-model', reasoningEffort: 'high'};

function fixture(options = {}) {
  const calls = []; const registered = {}; const tables = {chats: copy(options.stored || {})};
  const context = options.context || [msg('system', 'system', 'Original system context', {kind: 'system-prompt'}), msg('source-q', 'user', 'Main question'), msg('source-a', 'assistant', 'Main answer', {kind: 'model', provider: 'test-provider', model: 'source-model'})];
  const events = options.events || [];
  const session = {id: 'source', seq: 13, header: {agentPreset: 'cordis'}, deriveMessages: () => context,
    toolHistory: () => ({tools: [{name: 'original_tool', parameters: {type: 'object'}}], updates: []}), requestHeader: () => ({config}), snapshotEvents: () => events};
  const source = {id: 'source', session, options: config};
  let closed = false;
  const unit = {loadAll: async () => ({tables, global: null}), putRecord: async (table, key, value) => {assert.equal(closed, false); tables[table][key] = copy(value);}, close: async () => {closed = true; calls.push(['close']);}};
  const ctx = {
    reflect: {provide: (name, value) => {registered[name] = value; return () => {}; }}, effect: operation => {const value = operation(); return value;},
    commands: {register: value => {registered.command = value; return () => {}; }}, tools: {register: value => {registered.tool = value; return () => {}; }},
    typert: {register: value => {registered.remote = value; return () => {}; }},
    sessionTitle: {get: target => {assert.equal(target, session); return {title: 'Main conversation'};}},
    workingDirectory: {get: () => '/workspace'}, permissionPresets: {current: () => 'workspace-write'},
    sessionProjections: {stateOf: () => ({pending: options.selection})},
    storage: {backend: {get: name => {assert.equal(name, 'json'); return {kv: {open: async descriptor => {assert.equal(descriptor.name, 'local_side_chat'); assert.match(descriptor.name, /^[a-z][a-z0-9_]*$/); return unit;}}};}}},
    agents: {get: () => options.legacyRunning ? {status: 'running'} : undefined, withoutInitiator: fn => fn(), create: () => {throw Error('Must never create a DSH Session');}},
    sessions: {prepare: (_id, request) => ({deriveMessages: () => request.seed.flatMap(event => event.type === 'user/message' ? [event.data] : event.type === 'assistant/message' ? [event.data.message] : []), toolHistory: session.toolHistory, requestHeader: session.requestHeader})},
    sessionController: {fork: () => {throw Error('Must never fork');}, create: () => {throw Error('Must never create');}, inspect: async () => options.inspection},
    workspaceRegistry: {archiveSession: async id => {assert.notEqual(id, 'source'); calls.push(['archive', id]);}},
    llm: {prepareCall: async (selection, signal) => {calls.push(['prepare', copy(selection)]); return {config: selection, stream: async function* (request) {
      calls.push(['stream', request]); signal?.throwIfAborted();
      if (options.onStream) return yield* options.onStream(request);
      if (options.fail) {yield {type: 'finish', reason: {kind: 'error', failure: {message: 'provider failed'}}}; return;}
      yield {type: 'block-start', index: 0, blockType: 'text'};
      yield {type: 'text-delta', index: 0, text: 'Side answer'};
      yield {type: 'block-end', index: 0, block: {type: 'text', text: 'Side answer'}};
      yield {type: 'finish', reason: {kind: 'stop'}, replayState: {response: {id: 'safe-replay'}}};
    }};}}
  };
  return {ctx, source, session, context, calls, registered, tables, options};
}
async function answer(service, source, request, signal) {
  const frames = []; for await (const frame of service.send(source, request, signal)) frames.push(frame);
  return {frames, view: frames.filter(frame => frame.kind === 'state').at(-1).view};
}

test('create stores a private model-context snapshot, with no native Session and no displayed main messages', async () => {
  const f = fixture(); const service = new SideChatService(f.ctx);
  const view = await service.perform(f.source, {action: 'create', tabKey: 'tab'});
  assert.match(view.sideChatId, /^side-chat-/); assert.equal(view.sourceSessionId, 'source');
  assert.deepEqual(view.config, config); assert.deepEqual(view.messages, []); assert.equal(view.busy, false);
  assert.equal(f.calls.length, 0); assert.equal(f.session.seq, 13);
  const stored = f.tables.chats[view.sideChatId];
  assert.deepEqual(stored.context.slice(0, f.context.length), f.context);
  assert.equal('context' in view, false); assert.equal('toolHistory' in view, false);
  f.context[1].content[0].text = 'Changed later';
  assert.equal(stored.context[1].content[0].text, 'Main question');
});

test('UI tab creation is idempotent even on concurrent effect re-entry', async () => {
  const f = fixture(); const service = new SideChatService(f.ctx);
  const [a, b] = await Promise.all([service.perform(f.source, {tabKey: 'same'}), service.perform(f.source, {tabKey: 'same'})]);
  assert.equal(a.sideChatId, b.sideChatId); assert.equal(Object.keys(f.tables.chats).length, 1);
});

test('latest pending model selection is inherited rather than stale header or global default', async () => {
  const f = fixture({selection: {provider: 'other', model: 'new-model', reasoningEffort: 'medium'}});
  assert.deepEqual((await new SideChatService(f.ctx).perform(f.source)).config, f.options.selection);
});

test('model context retains native roles and closes outstanding tools without touching source', () => {
  const f = fixture({context: [msg('q', 'user', 'q'), {id: 'a', role: 'assistant', source: {kind: 'model', provider: 'p', model: 'm'}, content: [{type: 'tool-call', id: 'call-1', name: 'pending', arguments: '{}'}]}]});
  const context = modelContext(f.session);
  assert.equal(context[1].role, 'assistant'); assert.equal(context[2].role, 'tool');
  assert.equal(context[2].toolCallId, 'call-1'); assert.equal(context[3].role, 'developer');
  assert.equal(f.context.length, 2); assert.equal(f.session.seq, 13);
});

test('send streams only side answer and preserves hidden source context and model settings', async () => {
  const f = fixture(); const service = new SideChatService(f.ctx); const created = await service.perform(f.source);
  const outcome = await answer(service, f.source, {sideChatId: created.sideChatId, text: 'Side question', requestId: 'request-1'});
  assert.deepEqual(outcome.view.messages.map(item => [item.role, item.text]), [['user', 'Side question'], ['assistant', 'Side answer']]);
  assert.ok(outcome.frames.some(frame => frame.kind === 'delta' && frame.text === 'Side answer'));
  assert.equal(outcome.view.busy, false); assert.equal(outcome.view.error, null);
  const request = f.calls.find(call => call[0] === 'stream')[1];
  assert.deepEqual(request.tools, []); assert.equal(request.model, config.model); assert.equal(request.reasoningEffort, 'high');
  assert.deepEqual(request.messages.slice(0, 3), f.context); assert.equal(request.messages.at(-1).content[0].text, 'Side question');
  assert.equal(request.sessionId, undefined); assert.equal(f.session.seq, 13);
});

test('follow-up includes previous private turns exactly once and no source history in UI', async () => {
  const f = fixture(); const service = new SideChatService(f.ctx); const {sideChatId} = await service.perform(f.source);
  await answer(service, f.source, {sideChatId, text: 'One', requestId: 'one'});
  const outcome = await answer(service, f.source, {sideChatId, text: 'Two', requestId: 'two'});
  assert.equal(outcome.view.messages.length, 4);
  const request = f.calls.filter(call => call[0] === 'stream').at(-1)[1];
  assert.equal(request.messages.filter(item => item.content.some(block => block.text === 'One')).length, 1);
  assert.equal(request.messages.at(-1).content[0].text, 'Two');
});

test('replay of a completed request is idempotent and different text cannot reuse its identity', async () => {
  const f = fixture(); const service = new SideChatService(f.ctx); const {sideChatId} = await service.perform(f.source);
  const request = {sideChatId, text: 'Question', requestId: 'identity'};
  await answer(service, f.source, request); await answer(service, f.source, request);
  assert.equal(f.calls.filter(call => call[0] === 'stream').length, 1);
  await assert.rejects(answer(service, f.source, {...request, text: 'Changed'}), /different text/);
});

test('failed reply is visible and retry does not duplicate the question', async () => {
  const f = fixture({fail: true}); const service = new SideChatService(f.ctx); const {sideChatId} = await service.perform(f.source);
  const request = {sideChatId, text: 'Retry this', requestId: 'retry-1'};
  assert.match((await answer(service, f.source, request)).view.error, /provider failed/);
  f.options.fail = false;
  const {view} = await answer(service, f.source, request);
  assert.equal(view.error, null); assert.equal(view.messages.filter(item => item.role === 'user').length, 1);
});

test('stop cancels only the private request and retains its partial reply', async () => {
  const f = fixture({onStream: async function* (request) {
    yield {type: 'text-delta', index: 0, text: 'Partial'};
    await new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('cancelled')), {once: true}));
  }});
  const service = new SideChatService(f.ctx); const {sideChatId} = await service.perform(f.source);
  const iterator = service.send(f.source, {sideChatId, text: 'Q', requestId: 'stop-1'});
  await iterator.next(); await iterator.next();
  const pending = iterator.next(); await service.perform(f.source, {action: 'stop', sideChatId});
  const result = await pending;
  assert.match(result.value.view.error, /stopped/); assert.equal(result.value.view.messages.at(-1).text, 'Partial');
  await iterator.return(); assert.equal(f.session.seq, 13);
});

test('reopening private storage restores only side turns without making a new request', async () => {
  const f = fixture(); const first = new SideChatService(f.ctx); const {sideChatId} = await first.perform(f.source);
  await answer(first, f.source, {sideChatId, text: 'Saved', requestId: 'saved'});
  const second = new SideChatService(f.ctx); const view = await second.perform(f.source, {action: 'get', sideChatId});
  assert.deepEqual(view.messages.map(item => item.text), ['Saved', 'Side answer']);
  assert.equal(f.calls.filter(call => call[0] === 'stream').length, 1);
});

test('interrupted persisted request becomes explicitly retryable after restart', async () => {
  const f = fixture(); const first = new SideChatService(f.ctx); const {sideChatId} = await first.perform(f.source);
  const saved = f.tables.chats[sideChatId]; saved.pendingRequestId = 'crash'; saved.lastRequest = {requestId: 'crash', text: 'Q'};
  const second = new SideChatService(f.ctx); const view = await second.perform(f.source, {action: 'get', sideChatId});
  assert.match(view.error, /runtime restart/); assert.equal(view.retry.requestId, 'crash');
});

test('cross-source access, source override and invalid requests fail closed', async () => {
  const f = fixture(); const service = new SideChatService(f.ctx); const {sideChatId} = await service.perform(f.source);
  await assert.rejects(service.perform({...f.source, id: 'other'}, {action: 'get', sideChatId}), /does not belong/);
  await assert.rejects(service.perform(f.source, {sourceSessionId: 'other'}), /Unexpected/);
  await assert.rejects(service.perform(f.source, {action: 'get', sideChatId, limit: 201}), /1–200/);
  await assert.rejects(service.perform(null), /live main/);
  await assert.rejects(service.perform(f.source, {}, AbortSignal.abort()));
});

function legacyFixture(extra = {}) {
  const ticket = {sessionId: 'session-legacy', sourceSessionId: 'source', sourceSeq: 3, context: 'fork'};
  const inherited = [msg('old-main-u', 'user', 'Main history'), msg('old-main-a', 'assistant', 'Main history answer')];
  const own = [msg('own-u', 'user', 'Actual side question'), msg('own-a', 'assistant', 'Actual side answer')];
  const events = [{type: 'command/run', data: {name: 'side-chat', commandId: 'old'}}, {type: 'command/done', data: {commandId: 'old', kind: 'success', text: JSON.stringify(ticket)}}];
  const inspection = {meta: {id: ticket.sessionId, parentSession: 'source', cwd: '/workspace', agentPreset: 'cordis'}, inheritedEventCount: 4,
    events: [{type: 'user/message', data: inherited[0]}, {type: 'assistant/message', data: {message: inherited[1]}}, {type: 'step/end', data: {}}, {type: 'turn/end', data: {}},
      {type: 'tool/result', data: {}}, {type: 'turn/start', data: {}}, {type: 'user/message', data: own[0]}, {type: 'assistant/message', data: {message: own[1]}}]};
  return fixture({events, inspection, ...extra});
}

test('legacy fork is migrated with only its actual side turns, archived after saving, never deleted', async () => {
  const f = legacyFixture(); const service = new SideChatService(f.ctx);
  const view = await service.perform(f.source, {action: 'migrate', sessionId: 'session-legacy', tabKey: 'old-tab'});
  assert.deepEqual(view.messages.map(item => item.text), ['Actual side question', 'Actual side answer']);
  assert.deepEqual(f.calls, [['archive', 'session-legacy']]);
  assert.equal(f.tables.chats[view.sideChatId].legacySessionId, 'session-legacy');
  assert.ok(f.tables.chats[view.sideChatId].context.some(item => item.content.some(block => block.text === 'Main history')));
  assert.equal(legacySideChats(f.session).size, 1);
});

test('ordinary unrelated forks cannot be migrated, and active legacy side chats are never stopped', async () => {
  const f = legacyFixture({legacyRunning: true}); const service = new SideChatService(f.ctx);
  await assert.rejects(service.perform(f.source, {action: 'migrate', sessionId: 'session-unrelated'}), /not created by Side Chat/);
  await assert.rejects(service.perform(f.source, {action: 'migrate', sessionId: 'session-legacy'}), /still running/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.tables.chats, {});
});

test('new create cleans only proven old Side Chat list entries', async () => {
  const f = legacyFixture(); const service = new SideChatService(f.ctx); const view = await service.perform(f.source, {tabKey: 'new'});
  assert.deepEqual(view.messages, []); assert.deepEqual(f.calls, [['archive', 'session-legacy']]);
  assert.equal(Object.keys(f.tables.chats).length, 2);
});

test('model tool and scoped Remote share the same private service', async () => {
  const f = fixture(); apply(f.ctx);
  const created = await f.registered.tool.execute({action: 'create', tabKey: 'shared'}, {agent: f.source});
  const tool = await f.registered.tool.execute({action: 'get', sideChatId: created.sideChatId}, {agent: f.source});
  assert.equal(tool.sideChatId, created.sideChatId);
  assert.equal(f.registered.tool.name, 'side_chat');
  // The slash command is now a Client contribution so it can carry a localized
  // label; a same-name Host command would fail that contribution loudly.
  assert.equal(f.registered.command, undefined);
  assert.equal(f.registered.localSideChat.typertRemote.service, f.registered.localSideChat);
  assert.equal(f.registered.localSideChat.typertRemote.serviceKey, 'localSideChat');
  assert.equal(f.registered.remote.invocations.length, 2);
  assert.equal(f.registered.remote.invocations[0].parameters[0].codec.typeSymbol, '@deepseek-ai/dsh-session/types#SessionId');
  for (const invocation of f.registered.remote.invocations) assert.deepEqual(invocation.scope, {context: 'agent', wire: 'agentId'});
  assert.equal(remoteContribution().invocations.find(item => item.method === 'send').mode, 'stream');
  const invocation = remoteContribution().invocations.find(item => item.method === 'perform');
  const named = invocation.input({strict: true}).create().parse({agentId: 'source', request: {action: 'get', sideChatId: tool.sideChatId}});
  const received = invocation.invoke({localSideChat: {perform: (...args) => args}}, named, undefined);
  assert.deepEqual(received, ['source', {action: 'get', sideChatId: tool.sideChatId}, undefined]);
  assert.ok(invocation.result.create().parse(tool));
});

test('metadata describes private question threads and preserves original icon exports', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(manifest.version, '2.2.0'); assert.equal(manifest.exports['./icon'], './icon.svg');
  for (const language of ['en', 'zh']) {
    const locale = JSON.parse(await readFile(new URL(`../locale/${language}.json`, import.meta.url)));
    assert.ok(locale.meta.title); assert.match(locale.meta.description, language === 'en' ? /without session-list entries/ : /不创建列表会话/);
  }
});
