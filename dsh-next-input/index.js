import {explicitFollowup, followupSuppressed} from './suggestion-policy.js';
import {PROJECTION_VERSION} from './version.js';
import {installHostDiagnostics} from './diagnostics.js';
import Schema from '@deepseek-ai/schemastery';
import {z} from 'zod';
import {LIMITS, DEFAULT_CONFIG, CONFIG_RANGES, normalizeConfig, initialState, reduceState,
  buildInput, SYSTEM_PROMPT, bytes, parseSuggestion, requestObject} from './core.js';

export const inject = ['llm', 'agents', 'sessionProjections', 'typert'];
export const Config = Schema.object(Object.fromEntries(Object.entries(CONFIG_RANGES).map(([key, [min, max]]) =>
  [key, Schema.natural().min(min).max(max).default(DEFAULT_CONFIG[key])])));
export {DEFAULT_CONFIG, normalizeConfig};
const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const viewSchema = z.object({endSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER), turn: seq, eligible: z.boolean()}).strict();
const boundedText = max => z.string().max(max).refine(value => bytes(value) <= max);
export const stateSchema = z.object({view: viewSchema, inheritedEventCount: seq, activeTurn: seq,
  lastAssistantTurn: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER), firstTask: boundedText(LIMITS.firstTaskBytes),
  firstTaskSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  recent: z.array(z.object({seq, role: z.enum(['user', 'assistant']), text: boundedText(LIMITS.messageBytes)}).strict()).max(LIMITS.messages)
    .refine(recent => recent.reduce((total, item) => total + bytes(item.text), 0) <= LIMITS.inputBytes)}).strict();
export function projectionDefinition() {
  return {key: 'localNextInput', stateVersion: PROJECTION_VERSION, stateSchema, init: initialState, apply: reduceState,
    wire: {viewSchema, view: state => state.view, summary: false}};
}
const reply = (endSeq, status, reason) => ({endSeq, suggestion: null, status, ...(reason ? {reason} : {})});
/** Race uncooperative adapters against cancellation; always observe their eventual rejection. */
function abortable(value, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Aborted.'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {cleanup(); reject(signal.reason || new Error('Aborted.'));};
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, {once: true});
    Promise.resolve(value).then(result => {cleanup(); resolve(result);}, error => {cleanup(); reject(error);});
  });
}
/** No Agent creation, Session mutation, prompt injection, tool registration, or tool executor. */
export class NextInputService {
  get typertRemote() {return {service: this, serviceKey: 'localNextInput', namespace: 'localNextInput'};}
  constructor(ctx, projection, config = {}) {
    this.ctx = ctx; this.projection = projection; this.config = normalizeConfig(config);
    this.running = new Map(); this.cache = new Map(); this.disposed = new WeakSet(); this.stopped = false;
  }
  current(agent, session, endSeq, turn) {
    if (this.stopped || this.disposed.has(session) || agent.session !== session || agent.status !== 'idle'
      || this.ctx.agents.get(agent.id) !== agent) return false;
    const view = this.projection.stateOf(session).view;
    return view.eligible && view.endSeq === endSeq && (turn === undefined || view.turn === turn);
  }
  cacheKey(session, endSeq) {return `${session.id}:${endSeq}`;}
  remember(session, result) {
    const key = this.cacheKey(session, result.endSeq);
    // WeakRef prevents completed entries from retaining Session objects or their full logs.
    this.cache.delete(key); this.cache.set(key, {session: new WeakRef(session), result: {...result}});
    while (this.cache.size > LIMITS.cacheEntries) this.cache.delete(this.cache.keys().next().value);
  }
  cancel(session, reason = 'stale') {this.running.get(session)?.controller.abort(reason);}
  disposeSession(session) {
    this.disposed.add(session); this.cancel(session, 'stale');
    for (const [key, entry] of this.cache) if (!entry.session.deref() || entry.session.deref() === session) this.cache.delete(key);
  }
  async generate(agent, raw, signal) {
    const {endSeq} = requestObject(raw);
    if (signal?.aborted) return reply(endSeq, 'none', 'cancelled');
    const session = agent?.session;
    if (!session || !this.current(agent, session, endSeq)) return reply(endSeq, 'stale', 'cursor-changed');
    const state = this.projection.stateOf(session), turn = state.view.turn;
    const cached = this.cache.get(this.cacheKey(session, endSeq));
    if (cached?.session.deref() === session) return {...cached.result};
    if (followupSuppressed(state)) {
      const result = reply(endSeq, 'none', 'intentional-stop'); this.remember(session, result); return result;
    }
    // Strong explicit open-item sections use a safe, non-executing local
    // planning template. They must not disappear because an auxiliary model
    // interprets a completed TODO list or a permission denial as task closure.
    const local = explicitFollowup(state);
    if (local) {const result = {endSeq, ...local}; this.remember(session, result); return result;}
    let flight = this.running.get(session);
    if (flight && (flight.endSeq !== endSeq || flight.turn !== turn)) {this.cancel(session); return reply(endSeq, 'none', 'busy');}
    if (!flight) {
      if (this.running.size >= this.config.maxConcurrent) {
        const result = reply(endSeq, 'none', 'busy'); this.remember(session, result); return result;
      }
      const route = session.requestHeader()?.config;
      if (!route?.provider || !route?.model) {const result = reply(endSeq, 'error', 'missing-model'); this.remember(session, result); return result;}
      flight = {endSeq, turn, controller: new AbortController(), promise: null};
      this.running.set(session, flight);
      // The shared call survives an individual effect unmount/caller abort. Each observer can
      // stop waiting independently; boundary/dispose/unload/timeout cancels the shared call.
      flight.promise = Promise.resolve().then(() => this.run(agent, session, state, {provider: route.provider, model: route.model}, flight));
    }
    try {return {...(signal ? await abortable(flight.promise, signal) : await flight.promise)};}
    catch {return reply(endSeq, 'none', 'cancelled');}
  }
  async run(agent, session, state, route, flight) {
    const {controller, endSeq, turn} = flight, signal = controller.signal;
    const without = operation => this.ctx.agents.withoutInitiator(operation);
    let iterator, exhausted = false, timer;
    try {
      timer = setTimeout(() => controller.abort('timeout'), this.config.timeoutMs);
      signal.throwIfAborted();
      const llm = agent.ctx?.get('llm') || this.ctx.llm;
      const call = await abortable(without(() => llm.prepareCall({...route, maxTokens: this.config.maxTokens}, signal,
        (controls, model) => {
          const effort = model.reasoning?.efforts?.[0];
          return effort ? {...controls, reasoningEffort: effort.id} : controls;
        })), signal);
      signal.throwIfAborted();
      iterator = without(() => call.stream({...call.config, system: SYSTEM_PROMPT,
        messages: [{role: 'user', content: [{type: 'text', text: buildInput(state, this.config.maxInputBytes)}]}],
        signal, purpose: 'local-next-input'})[Symbol.asyncIterator]());
      const blocks = new Map(); let finish, invalid = false;
      for (;;) {
        const step = await abortable(without(() => iterator.next()), signal);
        signal.throwIfAborted();
        if (step.done) {exhausted = true; break;}
        const chunk = step.value;
        if (chunk.type === 'finish') {if (finish) invalid = true; finish = chunk.reason; continue;}
        if (chunk.type === 'usage') continue;
        if (finish) {invalid = true; break;}
        if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && !['text', 'reasoning'].includes(chunk.blockType))
          || (chunk.type === 'block-end' && !['text', 'reasoning'].includes(chunk.block?.type))) {invalid = true; break;}
        if (chunk.type === 'block-start') blocks.set(chunk.index, {type: chunk.blockType, text: ''});
        if (chunk.type === 'text-delta') {
          const block = blocks.get(chunk.index) || {type: 'text', text: ''};
          if (block.type !== 'text') {invalid = true; break;}
          block.text += chunk.text; blocks.set(chunk.index, block);
        }
        if (chunk.type === 'block-end' && chunk.block.type === 'text') blocks.set(chunk.index, {type: 'text', text: chunk.block.text});
        if (blocks.size > 16 || [...blocks.values()].reduce((total, block) => total + bytes(block.text), 0) > LIMITS.outputBytes) {invalid = true; break;}
      }
      const text = [...blocks.entries()].sort(([a], [b]) => a - b).filter(([, block]) => block.type === 'text').map(([, block]) => block.text).join('');
      const parsed = invalid ? {suggestion: null, status: 'error', reason: 'invalid-output'}
        : finish?.kind !== 'stop' ? {suggestion: null, status: 'error', reason: 'non-stop-finish'} : parseSuggestion(text);
      if (!this.current(agent, session, endSeq, turn)) return reply(endSeq, 'stale', 'cursor-changed');
      const result = {endSeq, ...parsed}; this.remember(session, result); return result;
    } catch {
      if (!this.current(agent, session, endSeq, turn) || (signal.aborted && signal.reason !== 'timeout')) return reply(endSeq, 'stale', 'cursor-changed');
      const result = reply(endSeq, 'error', signal.reason === 'timeout' ? 'timeout' : 'generation-failed');
      this.remember(session, result); return result;
    } finally {
      clearTimeout(timer);
      if (!exhausted && iterator) {
        controller.abort('cleanup');
        // Do not await an adapter's hung return behind a hung next. It receives the aborted
        // signal, runs without the main initiator, and any late rejection is consumed.
        try {Promise.resolve(without(() => iterator.return?.())).catch(() => {});} catch { /* Cleanup failure is not a suggestion. */ }
      }
      if (this.running.get(session) === flight) this.running.delete(session);
    }
  }
  async dispose() {
    this.stopped = true;
    const pending = [...this.running.values()];
    for (const flight of pending) flight.controller.abort('unload');
    await Promise.allSettled(pending.map(flight => flight.promise));
    this.cache.clear(); this.running.clear();
  }
}

const codec = (name, parse, jsonSchema) => ({mode: 'strict', typeSymbol: `@local/dsh-next-input#${name}`, create: () => ({parse}), jsonSchema});
export function remoteContribution() {
  const identity = {...codec('SessionId', value => {
    if (typeof value !== 'string' || !value) throw new TypeError('Invalid session identity.'); return value;
  }, {type: 'string'}), typeSymbol: '@deepseek-ai/dsh-session/types#SessionId'};
  const requestJSON = {type: 'object', properties: {endSeq: {type: 'integer', minimum: 0}}, required: ['endSeq'], additionalProperties: false};
  const request = codec('Request', requestObject, requestJSON);
  const outputSchema = z.object({endSeq: seq, suggestion: z.string().nullable(), status: z.enum(['ready', 'none', 'error', 'stale']), reason: z.string().optional()}).strict()
    .refine(value => value.status === 'ready' ? !!value.suggestion : value.suggestion === null);
  const output = codec('Reply', value => outputSchema.parse(value), {type: 'object', properties: {
    endSeq: {type: 'integer'}, suggestion: {type: ['string', 'null']}, status: {enum: ['ready', 'none', 'error', 'stale']}, reason: {type: 'string'}}, required: ['endSeq', 'suggestion', 'status'], additionalProperties: false});
  const input = codec('NamedInput', value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['agentId', 'request'].includes(key))) throw new TypeError('Invalid named Next Input input.');
    return {agentId: identity.create().parse(value.agentId), request: requestObject(value.request)};
  }, {type: 'object', properties: {agentId: {type: 'string'}, request: requestJSON}, required: ['agentId', 'request'], additionalProperties: false});
  return {package: '@local/dsh-next-input', face: 'host', schemas: [],
    model: {services: [{key: 'localNextInput', exportName: 'NextInputService', members: [{kind: 'method', name: 'generate',
      signature: "generate(agent: Agent, request: {endSeq: number}, signal?: AbortSignal): Promise<{endSeq: number, suggestion: string | null, status: 'ready' | 'none' | 'error' | 'stale', reason?: string}>"}], types: []}], events: [], objects: []},
    invocations: [{id: '@local/dsh-next-input#localNextInput/generate', service: 'localNextInput', namespace: 'localNextInput', method: 'generate',
      invocation: {kind: 'direct'}, scope: {context: 'agent', wire: 'agentId'},
      parameters: [{name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: identity, strictCodec: identity},
        {name: 'request', wire: 'request', source: 'json', codec: request, strictCodec: request}],
      cancellation: {parameter: 'signal'}, result: output, input: () => input,
      invoke: (remote, named, signal) => remote.localNextInput.generate(named.agentId, named.request, signal),
      description: 'Generate one conservative next-input suggestion for an exact completed turn.'}]};
}
export async function apply(ctx, config = {}) {
  const resolved = normalizeConfig(Config(config));
  const projection = await ctx.sessionProjections.register(projectionDefinition());
  const service = new NextInputService(ctx, projection, resolved);
  ctx.effect(() => ctx.reflect.provide('localNextInput', service));
  ctx.effect(() => ctx.typert.register(remoteContribution()));
  installHostDiagnostics(ctx, service, projection);
  // Observation only: projection owns history folding; these events only cancel sidecar calls.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start' || (event.type === 'user/message' && event.surfaceOp?.op !== 'replace')
      || (event.surfaceOp?.op === 'replace' && !projection.stateOf(session).view.eligible)) service.cancel(session);
  });
  ctx.on('session/disposed', session => service.disposeSession(session));
  ctx.effect(() => async () => {await service.dispose(); await projection.dispose();});
}
