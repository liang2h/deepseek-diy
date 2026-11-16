import {acceptSuggestion, canOffer, createSuggestionCache, suggestionText} from './client-state.js';
import {clientContribution, requestSuggestion} from './remote-contract.js';
import {installClientDiagnostics} from './diagnostics.js';

window.__ModuleLoader__.load({
  id: '@local/dsh-next-input',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const KEY = 'localNextInput';
    const NS = 'local-next-input';
    const en = {label: 'Next input', fill: 'Click to fill, not send', dismiss: 'Dismiss this suggestion', dismissNotice: 'Dismiss notice',
      available: 'A next input suggestion is available above the composer.',
      unavailable: 'Next input suggestion is unavailable for this turn. You can continue normally.',
      insert: 'Fill without sending: {text}', changed: 'Your draft changed. The suggestion was not inserted.'};
    const zh = {label: '下一轮建议', fill: '点击填入，不会发送', dismiss: '忽略本轮建议', dismissNotice: '关闭提示',
      available: '输入框上方有一条新的下一轮建议。',
      unavailable: '本轮建议暂不可用，可继续正常对话。',
      insert: '填入建议但不发送：{text}', changed: '草稿已变化，未填入建议。'};
    // Match the slot owner's shared width axis, not the viewport. These two
    // geometry variables are declared by ConversationRoot and used by InputBar
    // in DSH 0.2.2-rc.3; fallbacks keep this additive contribution contained.
    const css = `
.dni-host{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;width:100%;max-width:calc(var(--dsh-composer-card-max-width,952px) + 2 * var(--dsh-composer-side-clearance,16px));min-width:0;margin-inline:auto;padding-inline:var(--dsh-composer-side-clearance,16px)}
.dni-row,.dni-status{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.dni-row{display:flex;align-items:flex-start;gap:4px;padding:4px}
.dni-fill{display:flex;flex:1;align-items:flex-start;gap:10px;min-width:0;padding:8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:start;cursor:pointer;transition:background-color 120ms ease}
.dni-fill:active{background:var(--dsw-alias-bg-layer-2)}
.dni-fill:focus-visible,.dni-dismiss:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dni-mark{flex:none;margin-top:3px;color:var(--dsw-alias-brand-primary)}
.dni-copy{min-width:0;flex:1}.dni-meta{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:2px;font-size:12px;line-height:18px}.dni-meta strong{font-weight:500}.dni-hint{font-size:11px;font-weight:400}
.dni-text{display:block;overflow-wrap:anywhere;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.dni-dismiss{box-sizing:border-box;flex:none;display:grid;place-items:center;width:30px;height:30px;margin:0;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 120ms ease,color 120ms ease}
.dni-row>.dni-dismiss{margin-top:2px}
.dni-status{display:flex;align-items:center;gap:8px;min-height:38px;padding:4px 6px 4px 12px;font-size:12px;line-height:18px}
.dni-status-icon{display:block;flex:none;width:16px;height:16px}.dni-status-text{flex:1;min-width:0;overflow-wrap:anywhere}
.dni-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
@media (hover:hover){.dni-fill:hover,.dni-dismiss:hover{background:var(--dsw-alias-bg-layer-2)}.dni-dismiss:hover{color:var(--dsw-alias-label-primary)}}
@media (pointer:coarse){.dni-dismiss{width:40px;height:40px}}
@media (prefers-reduced-motion:reduce){.dni-fill,.dni-dismiss{transition:none}}
`;
    function DismissButton({onClick, label}) {
      return h('button', {type: 'button', className: 'dni-dismiss', 'aria-label': label, title: label, onClick},
        h('svg', {width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': true}, h('path', {d: 'm4 4 8 8m0-8-8 8'})));
    }
    function Notice({text, onDismiss, label, reason}) {
      return h('div', {className: 'dni-status', role: 'status', 'data-next-input-state': reason ? 'error' : undefined, 'data-next-input-reason': reason},
        h('svg', {className: 'dni-status-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true},
          h('circle', {cx: 12, cy: 12, r: 9}), h('path', {d: 'M12 11v6m0-10h.01'})),
        h('span', {className: 'dni-status-text'}, text),
        onDismiss && h(DismissButton, {onClick: onDismiss, label}));
    }
    return {
      inject: ['slots', 'locale', 'sessions', 'remote'],
      async apply(ctx) {
        await ctx.remote.$mount(clientContribution());
        ctx.effect(() => ctx.locale.register(NS, {en, zh}));
        const t = ctx.locale.bind(NS);
        const cache = createSuggestionCache();
        const flights = new Map();
        const dismissed = createSuggestionCache();
        const generations = new WeakMap();
        // Only bounded flags/statuses from mounted views, never draft or conversation text.
        const reports = new Map();
        installClientDiagnostics(ctx, sessionId => {
          const rows = reports.get(sessionId);
          return rows ? [...rows.values()].at(-1) : undefined;
        });
        let nextGeneration = 0;
        function identityOf(binding) {
          if (!binding) return 0;
          if (!generations.has(binding)) generations.set(binding, ++nextGeneration);
          return generations.get(binding);
        }
        function acquire(key, scope, endSeq) {
          const existing = cache.get(key);
          if (existing) return {promise: Promise.resolve(existing), release() {}};
          let flight = flights.get(key);
          if (!flight) {
            flight = {controller: new AbortController(), users: 0};
            const current = flight;
            flight.promise = Promise.resolve().then(async () => {
              try {
                const reply = await requestSuggestion(scope, endSeq, current.controller.signal);
                return cache.remember(key, reply);
              } catch (error) {
                // Keep errors distinct from a successful no-gap judgment; never log conversation text.
                const reason = ['remote-unavailable', 'remote-failed', 'invalid-reply', 'stale-reply', 'cancelled'].includes(error?.code) ? error.code : 'request-failed';
                return cache.remember(key, {endSeq, status: reason === 'cancelled' ? 'stale' : 'error', suggestion: null, reason});
              } finally {if (flights.get(key) === current) flights.delete(key);}
            });
            flights.set(key, flight);
          }
          flight.users++;
          let released = false;
          return {promise: flight.promise, release() {
            if (released) return;
            released = true;
            flight.users--;
            // Preserve a shared request through same-tick Strict Mode effect replay.
            queueMicrotask(() => {if (flight.users === 0 && flights.get(key) === flight) flight.controller.abort();});
          }};
        }
        ctx.effect(() => async () => {
          const pending = [...flights.values()];
          for (const flight of pending) flight.controller.abort();
          await Promise.allSettled(pending.map(flight => flight.promise));
          flights.clear(); cache.clear(); dismissed.clear(); reports.clear();
        });
        function Suggestion(props) {
          const {sessionId, session, input, inputActions} = props;
          const cursor = props.useProjection(KEY);
          const allowed = props.useAccess('localNextInput/generate') !== false;
          const offerable = canOffer({cursor, session, input, allowed});
          const binding = ctx.sessions.binding(sessionId);
          const endSeq = cursor?.endSeq ?? -1;
          const key = `${sessionId}:${identityOf(binding)}:${endSeq}`;
          const [reply, setReply] = React.useState(null);
          const [notice, setNotice] = React.useState('');
          const [hidden, setHidden] = React.useState(null);
          React.useEffect(() => {
            setReply(null); setNotice('');
            if (!offerable || !binding) return;
            const scope = ctx.sessions.scope(sessionId);
            if (!scope) return;
            let active = true;
            const ticket = acquire(key, scope, endSeq);
            ticket.promise.then(value => {
              if (active && ctx.sessions.binding(sessionId) === binding && value.endSeq === endSeq) setReply({key, ...value});
            });
            return () => {active = false; ticket.release();};
          }, [key, offerable, binding, endSeq, sessionId]);
          const reportOwner = React.useRef(Symbol('next-input-view'));
          const hasDraft = input.draft !== '';
          const hasAttachments = input.attachmentIds.length > 0;
          const pendingSubmission = session.pendingSubmissions.length > 0;
          React.useEffect(() => {
            let rows = reports.get(sessionId);
            if (!rows) {rows = new Map(); reports.set(sessionId, rows);}
            const owner = reportOwner.current;
            rows.set(owner, {mounted: true, eligible: cursor?.eligible === true, endSeq, canOffer: offerable,
              hasDraft, hasAttachments, sessionRunning: session.running, pendingSubmission,
              dismissed: !!dismissed.get(key) || hidden === key, subagent: !!session.subagent, openState: session.openState, allowed, replyStatus: reply?.key === key ? reply.status : flights.has(key) ? 'pending' : 'none',
              reason: reply?.key === key ? reply.reason || '' : ''});
            return () => {rows.delete(owner); if (!rows.size && reports.get(sessionId) === rows) reports.delete(sessionId);};
          }, [sessionId, cursor?.eligible, endSeq, offerable, hasDraft, hasAttachments, session.running,
            pendingSubmission, session.openState, session.subagent, allowed, reply, key, hidden]);
          const visible = offerable && !dismissed.get(key) && hidden !== key;
          const text = suggestionText({visible, reply, key});
          const availability = h('span', {className: 'dni-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': true}, text ? t('available') : '');
          if (!text) return h(React.Fragment, null, h('style', null, css), availability,
            visible && reply?.key === key && reply.status === 'error' && h('div', {className: 'dni-host'},
              h(Notice, {text: t('unavailable'), reason: reply.reason || 'generation-failed', onDismiss: dismiss, label: t('dismissNotice')})));
          function fill() {
            const current = ctx.sessions.binding(sessionId);
            if (current !== binding) return;
            const scope = ctx.sessions.scope(sessionId);
            const facade = scope?.get('conversation')?.input?.for(scope);
            const currentCursor = current.session.projections.faceOf(KEY).getSnapshot();
            if (!facade || !canOffer({cursor: currentCursor, session: current.session.getSnapshot(), input: facade.state.getSnapshot(), allowed}) || currentCursor.endSeq !== endSeq) return;
            const accepted = acceptSuggestion({text, expectedRev: input.draftRev, actions: inputActions, getInput: () => facade.state.getSnapshot()});
            if (!accepted) {setNotice(t('changed')); return;}
            dismissed.remember(key, true); setHidden(key);
            facade.focus();
          }
          function dismiss() {
            dismissed.remember(key, true); setHidden(key);
            // Explicit keyboard/button dismissal returns focus; automatic disappearance never does.
            if (ctx.sessions.binding(sessionId) !== binding) return;
            const scope = ctx.sessions.scope(sessionId);
            scope?.get('conversation')?.input?.for(scope).focus();
          }
          return h(React.Fragment, null,
            h('style', null, css), availability,
            h('div', {className: 'dni-host'},
              notice && h(Notice, {text: notice}),
              h('div', {className: 'dni-row', role: 'region', 'aria-label': t('label')},
                h('button', {type: 'button', className: 'dni-fill', onClick: fill, title: text, 'aria-label': t('insert', {text})},
                  h('svg', {className: 'dni-mark', width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true}, h('path', {d: 'M4 6h16M4 12h8M4 18h8m4-4 4 4-4 4'})),
                  h('span', {className: 'dni-copy'},
                    h('span', {className: 'dni-meta'}, h('strong', null, t('label')), h('span', {className: 'dni-hint'}, t('fill'))),
                    h('span', {className: 'dni-text'}, text))),
                h(DismissButton, {onClick: dismiss, label: t('dismiss')}))));
        }
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock', id: 'local-next-input-suggestion', order: 30, locale: NS, label: () => t('label'),
        }, Suggestion));
      },
    };
  },
});
