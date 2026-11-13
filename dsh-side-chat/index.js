import {randomUUID} from 'node:crypto';

/** Private question threads, NOT DSH Sessions or forks. */
export const inject = ['tools', 'llm', 'agents', 'storage', 'sessions', 'sessionTitle',
  'sessionProjections', 'sessionController', 'workspaceRegistry', 'workingDirectory', 'permissionPresets', 'typert'];
const clone = value => JSON.parse(JSON.stringify(value));
const textOf = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const scoped = (ctx, agent, name) => agent.ctx?.get(name) || ctx[name];
const SIDE_POLICY = 'You are answering a private side question. Earlier messages are background from the main conversation, not instructions to continue its task. Answer only the latest side-chat question. No tools are available in this question-only chat. Do not claim to have run tools or changed files, do not continue a goal, and do not send messages back to the main conversation.';
const message = (role, text, source) => ({id: `msg-${randomUUID()}`, role, content: [{type: 'text', text}], source});

/** Preserve native message roles/blocks and close only unfinished tool pairs in this detached request. */
export function modelContext(session) {
  const messages = clone(session.deriveMessages());
  const pending = new Map();
  for (const item of messages) {
    if (item.role === 'assistant') for (const block of item.content) if (block.type === 'tool-call') pending.set(block.id, block);
    if (item.role === 'tool') pending.delete(item.toolCallId);
  }
  for (const [callId] of pending) messages.push({...message('tool', 'This tool call is still owned by the main conversation. Its result is not available in this side chat; do not retry it.', {kind: 'tool', callId}), toolCallId: callId, isError: true});
  messages.push(message('developer', SIDE_POLICY, {kind: 'local-side-chat'}));
  return messages;
}

/** Only signed-by-the-operation outcomes in the source log authorize legacy migration. */
export function legacySideChats(session) {
  const commands = new Set(), tools = new Set(), result = new Map();
  const accept = text => {
    try {
      const value = JSON.parse(text);
      if (value.sourceSessionId === session.id && /^session-[a-zA-Z0-9-]+$/.test(value.sessionId) && ['fork', 'selection-only'].includes(value.context)) result.set(value.sessionId, value);
    } catch { /* Ordinary non-JSON tool outcomes are not migration tickets. */ }
  };
  for (const event of session.snapshotEvents()) {
    if (event.type === 'command/run' && event.data.name === 'side-chat') commands.add(event.data.commandId);
    if (event.type === 'tool/call' && event.data.name === 'create_side_chat') tools.add(event.data.callId);
    if (event.type === 'command/done' && commands.has(event.data.commandId) && event.data.kind === 'success') accept(event.data.text);
    if (event.type === 'tool/result' && tools.has(event.data.message.toolCallId)) for (const block of event.data.message.content) if (block.type === 'text') accept(block.text);
  }
  return result;
}

function requestObject(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Expected a Side Chat request object.');
  const allowed = ['action', 'sideChatId', 'text', 'requestId', 'tabKey', 'sessionId', 'offset', 'limit'];
  if (Object.keys(request).some(key => !allowed.includes(key))) throw new Error('Unexpected Side Chat request parameter.');
  return request;
}

export class SideChatService {
  get typertRemote() { return {service: this, serviceKey: 'localSideChat', namespace: 'localSideChat'}; }
  constructor(ctx) {
    this.ctx = ctx; this.records = new Map(); this.running = new Map(); this.creating = new Map(); this.cleanups = new Map(); this.pending = new Set(); this.stopped = false;
  }
  async ready() {
    if (!this.opening) this.opening = (async () => {
      const backend = this.ctx.storage.backend.get('json');
      if (!backend.kv) throw new Error('The profile has no JSON key/value storage.');
      this.unit = await backend.kv.open({name: 'local_side_chat', version: 1, tables: ['chats'], hasGlobal: false, layout: 'per-record'});
      const stored = await this.unit.loadAll();
      for (const [id, record] of Object.entries(stored.tables.chats || {})) {
        if (record?.version !== 1 || record.sideChatId !== id || !Array.isArray(record.context) || !Array.isArray(record.messages) || !Array.isArray(record.replies)) throw new Error(`Invalid saved side chat: ${id}`);
        if (record.pendingRequestId) {
          record.error = 'The previous reply was interrupted by a runtime restart.';
          delete record.pendingRequestId;
          await this.unit.putRecord('chats', id, record);
        }
        this.records.set(id, record);
      }
    })();
    await this.opening;
    if (this.stopped) throw new Error('Side Chat was unloaded.');
  }
  async save(record) { await this.unit.putRecord('chats', record.sideChatId, record); this.records.set(record.sideChatId, record); }
  requireSource(agent) { if (!agent?.session) throw new Error('Select a live main conversation first.'); }
  owned(agent, id) {
    this.requireSource(agent);
    const record = this.records.get(id);
    if (!record || record.sourceSessionId !== agent.id) throw new Error('This side chat does not belong to the current main conversation.');
    return record;
  }
  view(record, request = {}) {
    const start = request.offset ?? (request.limit ? Math.max(0, record.messages.length - request.limit) : 0);
    const messages = record.messages.slice(start, request.limit ? start + request.limit : undefined);
    return clone({sideChatId: record.sideChatId, sourceSessionId: record.sourceSessionId, sourceTitle: record.sourceTitle,
      sourceSeq: record.sourceSeq, config: record.config, environment: record.environment, messages,
      totalMessages: record.messages.length, offset: start, busy: this.running.has(record.sideChatId), error: record.error || null,
      retry: record.error && record.lastRequest ? record.lastRequest : null});
  }
  configuration(agent, session = agent.session) {
    const pending = this.ctx.sessionProjections.stateOf(session, 'modelSelection')?.pending;
    const config = clone(pending || session.requestHeader()?.config || agent.options || {});
    if (!config.provider || !config.model) throw new Error('Select a model in the main conversation first.');
    return config;
  }
  async create(agent, request = {}, signal) {
    this.requireSource(agent); signal?.throwIfAborted(); await this.ready();
    if (request.tabKey !== undefined && (typeof request.tabKey !== 'string' || request.tabKey.length > 512)) throw new Error('Invalid side-chat tab key.');
    const key = request.tabKey ? `${agent.id}:${request.tabKey}` : `new:${randomUUID()}`;
    const existing = [...this.records.values()].find(value => value.creationKey === key);
    if (existing) return this.view(existing);
    if (this.creating.has(key)) return this.creating.get(key);
    const task = (async () => {
      signal?.throwIfAborted();
      const record = {version: 1, sideChatId: `side-chat-${randomUUID()}`, creationKey: key,
        sourceSessionId: agent.id, sourceTitle: this.ctx.sessionTitle.get(agent.session)?.title || '', sourceSeq: agent.session.seq - 1,
        config: this.configuration(agent), context: modelContext(agent.session), toolHistory: clone(agent.session.toolHistory()),
        environment: {cwd: this.ctx.workingDirectory.get(agent.session), preset: agent.session.header.agentPreset,
          permission: this.ctx.permissionPresets.current(agent.session)}, messages: [], replies: [], createdAt: Date.now()};
      await this.save(record); return this.view(record);
    })();
    this.creating.set(key, task);
    try {return await task;} finally {this.creating.delete(key);}
  }
  async migrate(agent, sessionId, tabKey, signal) {
    this.requireSource(agent); await this.ready(); signal?.throwIfAborted();
    let record = [...this.records.values()].find(value => value.sourceSessionId === agent.id && value.legacySessionId === sessionId);
    if (!record) {
      const ticket = legacySideChats(agent.session).get(sessionId);
      if (!ticket) throw new Error('The old conversation was not created by Side Chat in this main conversation.');
      const live = this.ctx.agents.get(sessionId);
      if (live && live.status !== 'idle') throw new Error('The earlier side chat is still running. Stop it before migrating.');
      const inspection = await this.ctx.sessionController.inspect(sessionId, signal);
      if (inspection.meta.origin === 'subagent' || (inspection.meta.parentSession && inspection.meta.parentSession !== agent.id)) throw new Error('The earlier side chat has a different owner.');
      // Decode the existing model surface without entering a Session into the store.
      const decoded = this.ctx.sessions.prepare(undefined, {seed: inspection.events, meta: {cwd: inspection.meta.cwd}});
      const own = inspection.events.slice(inspection.inheritedEventCount);
      let inOwnTurn = false;
      const messages = [];
      for (const event of own) {
        if (event.type === 'turn/start') inOwnTurn = true;
        if (!inOwnTurn) continue;
        const item = event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data.message : null;
        if (item && (item.role === 'assistant' || item.source?.kind === 'user')) messages.push({id: item.id || `legacy-${event.seq}`, role: item.role, text: textOf(item)});
      }
      record = {version: 1, sideChatId: `side-chat-${randomUUID()}`, creationKey: tabKey ? `${agent.id}:${tabKey}` : `legacy:${sessionId}`,
        sourceSessionId: agent.id, sourceTitle: this.ctx.sessionTitle.get(agent.session)?.title || '', sourceSeq: ticket.sourceSeq ?? -1,
        config: this.configuration(agent, decoded), context: modelContext(decoded), toolHistory: clone(decoded.toolHistory()),
        environment: {cwd: inspection.meta.cwd, preset: inspection.meta.agentPreset}, messages, replies: [], legacySessionId: sessionId, createdAt: Date.now()};
      await this.save(record); // Preserve the actual side turns BEFORE archiving the ordinary session.
    }
    await this.ctx.workspaceRegistry.archiveSession(sessionId); // Refuses running activity; never force-stop or delete.
    return this.view(record);
  }
  async cleanupLegacy(agent, signal) {
    if (!this.cleanups.has(agent.id)) {
      const task = (async () => {
        for (const id of legacySideChats(agent.session).keys()) await this.migrate(agent, id, undefined, signal);
      })();
      this.cleanups.set(agent.id, task);
      task.catch(() => {if (this.cleanups.get(agent.id) === task) this.cleanups.delete(agent.id);});
    }
    await this.cleanups.get(agent.id);
  }
  async perform(agent, raw = {}, signal) {
    const request = requestObject(raw); const action = request.action || 'create';
    this.requireSource(agent); signal?.throwIfAborted(); await this.ready();
    if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 200)) throw new Error('limit must be 1–200.');
    if (request.offset !== undefined && (!Number.isInteger(request.offset) || request.offset < 0)) throw new Error('offset must be non-negative.');
    if (action === 'create') {await this.cleanupLegacy(agent, signal); return this.create(agent, request, signal);}
    if (action === 'migrate') return this.migrate(agent, request.sessionId, request.tabKey, signal);
    const record = this.owned(agent, request.sideChatId);
    if (action === 'get') return this.view(record, request);
    if (action === 'stop') {this.running.get(record.sideChatId)?.controller.abort(); return this.view(record);}
    throw new Error('Unknown Side Chat action.');
  }
  async *send(agent, raw, signal) {
    const request = requestObject(raw); this.requireSource(agent); await this.ready(); signal?.throwIfAborted();
    const record = this.owned(agent, request.sideChatId);
    if (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 20000) throw new Error('Enter a question of at most 20,000 characters.');
    if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(request.requestId)) throw new Error('A unique request identity is required.');
    if (this.running.has(record.sideChatId)) throw new Error('A reply is already running in this side chat.');
    const previous = record.messages.find(item => item.role === 'user' && item.requestId === request.requestId);
    if (previous && previous.text !== request.text.trim()) throw new Error('A request identity cannot be reused for different text.');
    if (previous && record.lastRequest?.requestId !== request.requestId) throw new Error('Only the latest failed reply can be retried.');
    if (previous && !record.error) {yield {kind: 'state', view: this.view(record)}; return;}
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let resolveDone;
    const done = new Promise(resolve => {resolveDone = resolve;});
    this.pending.add(done);
    const active = {controller}; this.running.set(record.sideChatId, active);
    const retrying = record.error && record.lastRequest?.requestId === request.requestId;
    if (retrying) {
      const last = record.messages.at(-1);
      if (last?.role === 'assistant' && last.requestId === request.requestId) record.messages.pop();
      if (record.replies.at(-1)?.role === 'assistant' && record.replies.at(-1)?.requestId === request.requestId) record.replies.pop();
    } else {
      const user = message('user', request.text.trim(), {kind: 'user'});
      record.messages.push({id: user.id, role: 'user', text: request.text.trim(), requestId: request.requestId});
      record.replies.push({...user, requestId: request.requestId});
    }
    record.error = null; record.lastRequest = {requestId: request.requestId, text: request.text.trim()};
    record.pendingRequestId = request.requestId;
    const assistant = {id: `msg-${randomUUID()}`, role: 'assistant', text: '', requestId: request.requestId};
    record.messages.push(assistant);
    const blocks = new Map(); let finish, replayState;
    try {
      await this.save(record); yield {kind: 'state', view: this.view(record)};
      const prepared = await this.ctx.llm.prepareCall(record.config, combined);
      const options = {...prepared.config, messages: [...record.context, ...record.replies.map(({requestId: _id, ...item}) => item)],
        tools: [], toolHistory: record.toolHistory, signal: combined};
      // No Agent prompt, no native Session, no goal loop, and no tool executor.
      const iterator = prepared.stream(options)[Symbol.asyncIterator]();
      let exhausted = false;
      try {for (;;) {
        const step = await this.ctx.agents.withoutInitiator(() => iterator.next());
        if (step.done) {exhausted = true; break;}
        const chunk = step.value;
        if (chunk.type === 'block-start') blocks.set(chunk.index, {type: chunk.blockType, text: ''});
        if (chunk.type === 'text-delta') {assistant.text += chunk.text; const block = blocks.get(chunk.index) || {type: 'text', text: ''}; block.text += chunk.text; blocks.set(chunk.index, block); yield {kind: 'delta', text: chunk.text};}
        if (chunk.type === 'reasoning-delta') {const block = blocks.get(chunk.index) || {type: 'reasoning', text: ''}; block.text += chunk.text; blocks.set(chunk.index, block);}
        if (chunk.type === 'block-end') blocks.set(chunk.index, clone(chunk.block));
        if (chunk.type === 'finish') {finish = chunk.reason; replayState = chunk.replayState;}
      }} finally {
        if (!exhausted) {controller.abort(); await this.ctx.agents.withoutInitiator(() => iterator.return?.());}
      }
      if (!finish) throw new Error('The model stream ended without a completion status.');
      if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure?.message || 'Reply stopped.');
      if (finish.kind === 'tool-calls') throw new Error('This side chat answers questions only; tools are not executed.');
      if (finish.kind === 'max-tokens') record.error = 'The reply reached the model output limit.';
      const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block).filter(block => block.type === 'text' || block.type === 'reasoning');
      if (!content.some(block => block.type === 'text')) content.push({type: 'text', text: assistant.text});
      assistant.text = textOf({content});
      record.replies.push({id: assistant.id, role: 'assistant', content, source: {kind: 'model', provider: record.config.provider, model: record.config.model, ...(replayState ? {replayState} : {})}, requestId: request.requestId});
    } catch (error) {
      record.error = combined.aborted ? 'Reply stopped.' : error.message || String(error);
      if (assistant.text) record.replies.push({...message('assistant', assistant.text, {kind: 'model', provider: record.config.provider, model: record.config.model}), requestId: request.requestId});
    } finally {
      if (!finish && !record.error) record.error = 'Reply stopped.';
      if (assistant.text && !record.replies.some(item => item.role === 'assistant' && item.requestId === request.requestId)) record.replies.push({...message('assistant', assistant.text, {kind: 'model', provider: record.config.provider, model: record.config.model}), requestId: request.requestId});
      delete record.pendingRequestId;
      if (this.running.get(record.sideChatId) === active) this.running.delete(record.sideChatId);
      try {await this.save(record);} finally {resolveDone(); this.pending.delete(done);}
    }
    yield {kind: 'state', view: this.view(record)};
  }
  async dispose() {
    this.stopped = true;
    for (const {controller} of this.running.values()) controller.abort();
    await Promise.allSettled([...this.pending]);
    if (this.opening) {try {await this.opening; await this.unit?.close();} catch { /* Opening failures have already reached callers. */ }}
  }
}

const codec = (name, parse, jsonSchema) => ({mode: 'strict', typeSymbol: `@local/dsh-side-chat#${name}`, create: () => ({parse}), jsonSchema});
export function remoteContribution() {
  const identity = {...codec('SessionId', value => {if (typeof value !== 'string' || !value) throw new Error('Invalid session identity'); return value;}, {type: 'string'}), typeSymbol: '@deepseek-ai/dsh-session/types#SessionId'};
  const request = codec('Request', requestObject, {type: 'object'});
  const output = codec('Reply', value => clone(value), {type: 'object'});
  const input = codec('NamedInput', value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['agentId', 'request'].includes(key))) throw new Error('Invalid named Side Chat input.');
    return {agentId: identity.create().parse(value.agentId), request: requestObject(value.request)};
  }, {type: 'object', properties: {agentId: {type: 'string'}, request: {type: 'object'}}, required: ['agentId', 'request'], additionalProperties: false});
  const invocation = (method, stream) => ({id: `@local/dsh-side-chat#localSideChat/${method}`, service: 'localSideChat', namespace: 'localSideChat', method,
    invocation: {kind: 'direct'}, scope: {context: 'agent', wire: 'agentId'}, ...(stream ? {mode: 'stream'} : {}),
    parameters: [{name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: identity, strictCodec: identity}, {name: 'request', wire: 'request', source: 'json', codec: request, strictCodec: request}],
    cancellation: {parameter: 'signal'}, result: output, input: () => input,
    invoke: (remote, named, signal) => remote.localSideChat[method](named.agentId, named.request, signal),
    description: stream ? 'Stream one private side-chat answer.' : 'Create, read, migrate or stop a private side chat.'});
  return {package: '@local/dsh-side-chat', face: 'host', schemas: [],
    model: {services: [{key: 'localSideChat', exportName: 'SideChatService', members: [{kind: 'method', name: 'perform', signature: 'perform(agent: Agent, request: SideChatRequest, signal?: AbortSignal): Promise<SideChatView>'}, {kind: 'method', name: 'send', signature: 'send(agent: Agent, request: SideChatRequest, signal?: AbortSignal): AsyncIterable<SideChatFrame>'}], types: []}], events: [], objects: []},
    invocations: [invocation('perform', false), invocation('send', true)]};
}

export function apply(ctx) {
  const service = new SideChatService(ctx);
  ctx.effect(() => ctx.reflect.provide('localSideChat', service));
  ctx.effect(() => ctx.typert.register(remoteContribution()));
  ctx.effect(() => () => service.dispose());
  ctx.effect(() => ctx.tools.register({name: 'side_chat', description: 'Ask private side questions using the current main conversation’s model context and model settings. No session-list entry, main-history replay, tool execution, or messages back to the main conversation.',
    parameters: {type: 'object', properties: {action: {type: 'string', enum: ['create', 'get', 'send', 'stop', 'migrate']}, sideChatId: {type: 'string', description: 'Returned side-chat ID; required except for create or migrate.'}, text: {type: 'string', maxLength: 20000, description: 'Question for send.'}, requestId: {type: 'string', description: 'Unique send identity; reuse only to retry a failed reply.'}, sessionId: {type: 'string', description: 'Earlier plugin-created session to migrate and archive, only for migrate.'}, offset: {type: 'integer', minimum: 0}, limit: {type: 'integer', minimum: 1, maximum: 200}}, required: ['action'], additionalProperties: false},
    output: {schema: {type: 'object', additionalProperties: true}, render: (_args, value) => [{type: 'text', text: JSON.stringify(value)}]}, isConcurrencySafe: () => false,
    execute: async (request, exec) => {
      if (request.action === 'send') {let view; for await (const frame of service.send(exec.agent, request, exec.signal)) if (frame.kind === 'state') view = frame.view; return {...view, messages: view.messages.slice(-12), omittedMessages: Math.max(0, view.messages.length - 12)};}
      return service.perform(exec.agent, request.action === 'get' ? {limit: 12, ...request} : request, exec.signal);
    }}));
}
