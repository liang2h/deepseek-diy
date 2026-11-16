import {VERSION, PROJECTION_VERSION} from './version.js';
import {explicitFollowup, deferredWorkflowFollowup, followupSuppressed} from './suggestion-policy.js';

const boolean = {type: 'boolean'}, integer = {type: 'integer'}, string = {type: 'string'};
function registration(properties, query) {
  return {
    manifest: {id: 'NextInput', description: 'Read-only next-input version and decision diagnostics; no conversation text or model calls.', methods: [{
      name: 'status', description: 'Read loaded code version and flags for the caller or an explicitly addressed resident/mounted Session.',
      inputSchema: {type: 'object', properties: {sessionId: {type: 'string'}}, additionalProperties: false},
      outputSchema: {type: 'object', properties, required: Object.keys(properties), additionalProperties: false},
    }]},
    async query(method, _input, context) {
      if (method !== 'status') throw new Error('Unknown NextInput inspection method.');
      context.signal.throwIfAborted();
      const input = _input || {};
      // The native Inspect schema is a strict subset: validate lengths here,
      // not via unsupported minLength/maxLength manifest keywords.
      if (input.sessionId !== undefined && (typeof input.sessionId !== 'string'
        || input.sessionId.length < 1 || input.sessionId.length > 128)) throw new TypeError('Invalid session identity.');
      return query(context, input);
    },
  };
}

export function installHostDiagnostics(ctx, service, projection) {
  ctx.inject(['cordisInspect'], inspectCtx => {
    inspectCtx.effect(() => inspectCtx.cordisInspect.register(registration({
      version: string, projectionVersion: integer, available: boolean, agentStatus: string,
      eligible: boolean, endSeq: integer, turn: integer, hasTaskExcerpt: boolean,
      hasFinalAnswer: boolean, explicitOpenItems: boolean, deferredOperation: boolean, intentionalStop: boolean,
      generating: boolean, cacheStatus: string, reason: string,
    }, ({agent: requester}, input) => {
      // Look up an already resident Agent only; never resume/open another Session.
      const agent = input.sessionId && input.sessionId !== requester.session.id
        ? service.ctx?.get('agents')?.get(input.sessionId) : requester;
      if (!agent) return {version: VERSION, projectionVersion: PROJECTION_VERSION, available: false, agentStatus: 'unavailable',
        eligible: false, endSeq: -1, turn: 0, hasTaskExcerpt: false, hasFinalAnswer: false,
        explicitOpenItems: false, deferredOperation: false, intentionalStop: false, generating: false, cacheStatus: 'miss', reason: 'not-resident'};
      const session = agent.session, state = projection.stateOf(session), view = state.view;
      const row = service.cache.get(service.cacheKey(session, view.endSeq));
      const cached = row?.session.deref() === session ? row.result : undefined;
      return {version: VERSION, projectionVersion: PROJECTION_VERSION, available: true, agentStatus: agent.status,
        eligible: view.eligible, endSeq: view.endSeq, turn: view.turn, hasTaskExcerpt: !!state.firstTask,
        hasFinalAnswer: state.lastAssistantTurn === state.activeTurn,
        explicitOpenItems: explicitFollowup(state) !== null, deferredOperation: deferredWorkflowFollowup(state) !== null,
        intentionalStop: followupSuppressed(state),
        generating: service.running.has(session), cacheStatus: cached?.status || 'miss',
        reason: /^[a-z0-9-]{1,64}$/.test(cached?.reason || '') ? cached.reason : ''};
    })), 'next-input: Host read-only diagnostics');
  });
}

export function installClientDiagnostics(ctx, readReport) {
  ctx.inject(['cordisInspect'], inspectCtx => {
    inspectCtx.effect(() => inspectCtx.cordisInspect.register(registration({
      version: string, mounted: boolean, eligible: boolean, endSeq: integer, canOffer: boolean,
      hasDraft: boolean, hasAttachments: boolean, sessionRunning: boolean, pendingSubmission: boolean,
      dismissed: boolean, subagent: boolean, openState: string, allowed: boolean, replyStatus: string, reason: string,
    }, ({sessionId}, input) => {
      const result = {version: VERSION, mounted: false, eligible: false, endSeq: -1, canOffer: false,
        hasDraft: false, hasAttachments: false, sessionRunning: false, pendingSubmission: false,
        dismissed: false, subagent: false, openState: 'unmounted', allowed: false, replyStatus: 'none', reason: ''};
      const report = readReport(input.sessionId || sessionId) || {};
      for (const key of Object.keys(result)) if (key !== 'version' && report[key] !== undefined) result[key] = report[key];
      result.reason = /^[a-z0-9-]{1,64}$/.test(result.reason) ? result.reason : '';
      return result;
    })), 'next-input: Client read-only diagnostics');
  });
}
