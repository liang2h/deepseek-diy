import {VERSION, PROJECTION_VERSION} from './version.js';
import {explicitFollowup, followupSuppressed} from './suggestion-policy.js';

const boolean = {type: 'boolean'}, integer = {type: 'integer'}, string = {type: 'string'};
function registration(properties, query) {
  return {
    manifest: {id: 'NextInput', description: 'Read-only next-input version and decision diagnostics; no conversation text or model calls.', methods: [{
      name: 'status', description: 'Read the requesting Session\'s loaded code version, eligibility and cached result state.',
      inputSchema: {type: 'object', properties: {}, additionalProperties: false},
      outputSchema: {type: 'object', properties, required: Object.keys(properties), additionalProperties: false},
    }]},
    async query(method, _input, context) {
      if (method !== 'status') throw new Error('Unknown NextInput inspection method.');
      context.signal.throwIfAborted();
      return query(context);
    },
  };
}

export function installHostDiagnostics(ctx, service, projection) {
  ctx.inject(['cordisInspect'], inspectCtx => {
    inspectCtx.effect(() => inspectCtx.cordisInspect.register(registration({
      version: string, projectionVersion: integer, agentStatus: string,
      eligible: boolean, endSeq: integer, turn: integer, hasTaskExcerpt: boolean,
      hasFinalAnswer: boolean, explicitOpenItems: boolean, intentionalStop: boolean,
      generating: boolean, cacheStatus: string, reason: string,
    }, ({agent}) => {
      const session = agent.session, state = projection.stateOf(session), view = state.view;
      const row = service.cache.get(service.cacheKey(session, view.endSeq));
      const cached = row?.session.deref() === session ? row.result : undefined;
      return {version: VERSION, projectionVersion: PROJECTION_VERSION, agentStatus: agent.status,
        eligible: view.eligible, endSeq: view.endSeq, turn: view.turn, hasTaskExcerpt: !!state.firstTask,
        hasFinalAnswer: state.lastAssistantTurn === state.activeTurn,
        explicitOpenItems: explicitFollowup(state) !== null, intentionalStop: followupSuppressed(state),
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
    }, ({sessionId}) => {
      const result = {version: VERSION, mounted: false, eligible: false, endSeq: -1, canOffer: false,
        hasDraft: false, hasAttachments: false, sessionRunning: false, pendingSubmission: false,
        dismissed: false, subagent: false, openState: 'unmounted', allowed: false, replyStatus: 'none', reason: ''};
      const report = readReport(sessionId) || {};
      for (const key of Object.keys(result)) if (key !== 'version' && report[key] !== undefined) result[key] = report[key];
      result.reason = /^[a-z0-9-]{1,64}$/.test(result.reason) ? result.reason : '';
      return result;
    })), 'next-input: Client read-only diagnostics');
  });
}
