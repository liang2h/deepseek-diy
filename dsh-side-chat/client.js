import {renderMarkdown} from './markdown.js';

window.__ModuleLoader__.load({
  id: '@local/dsh-side-chat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ID = '@local/dsh-side-chat';
    const NS = 'localSideChat';
    const KIND = 'local-side-chat';
    const STORAGE = 'dsh.local-side-chat.v1.';
    const en = {
      title: 'Side Chat', open: 'Open side chat', new: 'New side chat', subtitle: 'Ask a side question without interrupting your main conversation',
      hint: 'The main conversation’s committed context and model settings are inherited, but its history is not shown here. Side Chat answers questions only; it cannot run tools or edit files.',
      inherited: 'Context inherited · Q&A only', snapshot: 'Uses a snapshot of the main conversation when opened. Later messages stay separate.',
      ask: 'Ask in side chat', add: 'Add to conversation', quote: 'Quoted from conversation', source: 'Main conversation', sourceOpen: 'Return to main conversation',
      loading: 'Preparing context…', unavailable: 'The side-chat interface is not ready. Refresh and try again.', retry: 'Retry response', reload: 'Restore chat', failed: 'Unable to open side chat', noSession: 'Select a conversation first',
      selected: 'Selected text', tooLong: 'Select up to 20,000 characters.', storage: 'Browser storage is unavailable; your draft and tab link may not recover after reload.',
      copied: 'Quote added to draft', insertFailed: 'The draft changed or is not editable. You can retry adding the quote.',
      placeholder: 'Ask about the main conversation…', send: 'Send', stop: 'Stop', stopping: 'Stopping…', thinking: 'Answering…', you: 'You', assistant: 'Assistant',
      composerHint: 'Enter to send · Shift+Enter for a new line', toolsOff: 'Q&A only · No tools or file changes', empty: 'What would you like to ask?',
      streamEnded: 'The connection ended before the final state arrived. Restore the chat, or stop a response that is still running.', invalid: 'The server returned an invalid side-chat response.',
      commandDescription: 'Private side questions with inherited model context; no session-list entry', table: 'Table'
    };
    const zh = {
      title: '侧边聊天', open: '打开侧边聊天', new: '新建侧聊', subtitle: '支线问题在旁边聊，主会话继续进行',
      hint: '已继承主会话已提交的上下文与模型设置，这里不重复显示主会话历史。侧聊仅用于问答，不执行工具，也不修改文件。',
      inherited: '已继承上下文 · 仅问答', snapshot: '使用打开时的主会话快照，之后的消息互不影响。',
      ask: '在侧边聊天中提问', add: '添加到对话', quote: '来自会话的引用', source: '关联主会话', sourceOpen: '返回关联主会话',
      loading: '正在准备主会话上下文…', unavailable: '侧聊接口尚未就绪，请刷新后重试。', retry: '重试回复', reload: '恢复聊天', failed: '无法打开侧边聊天', noSession: '请先选择一个会话',
      selected: '已选文字', tooLong: '最多选取 20,000 个字符。', storage: '浏览器存储不可用，刷新后草稿及此标签关联可能无法恢复。',
      copied: '引用已添加到草稿', insertFailed: '草稿已变化或当前不可编辑，可以重试添加引用。',
      placeholder: '就主会话中的内容提问…', send: '发送', stop: '停止', stopping: '正在停止…', thinking: '正在回答…', you: '你', assistant: '助手',
      composerHint: 'Enter 发送 · Shift+Enter 换行', toolsOff: '仅问答 · 不执行工具或修改文件', empty: '想了解主会话中的什么？',
      streamEnded: '连接在最终状态返回前结束。可以恢复聊天，或停止仍在运行的回复。', invalid: '服务端返回的侧聊数据格式不正确。',
      commandDescription: '私有侧聊问答，继承主会话模型上下文，不创建列表会话', table: '表格'
    };
    const css = `
.sc-root{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit;container-type:inline-size}.sc-root *,.sc-menu *{box-sizing:border-box}
.sc-button,.sc-launch{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}.sc-button:hover:not(:disabled),.sc-launch:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.sc-button:disabled,.sc-launch:disabled{opacity:.45;cursor:not-allowed}.sc-button:focus-visible,.sc-launch:focus-visible,.sc-source:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.sc-launch{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}.sc-primary{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.sc-head{display:flex;align-items:center;gap:8px;flex:none;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}.sc-head-copy{flex:1;min-width:0}.sc-title{font-size:13px;font-weight:600}.sc-sub{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px}.sc-head .sc-button{min-width:30px;padding:5px}.sc-source{display:block;flex:none;width:100%;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:8px 14px;cursor:pointer}.sc-source:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary)}
.sc-messages{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:16px 14px;display:flex;flex-direction:column;gap:20px;scrollbar-gutter:stable}.sc-empty{margin:auto;max-width:360px;padding:24px 8px;text-align:center;font-size:13px}.sc-empty p{color:var(--dsw-alias-label-secondary);line-height:1.8;margin:10px 0}.sc-empty h2{font-size:16px;margin:14px 0 8px}.sc-message{min-width:0;flex:none;overflow-wrap:anywhere;font-size:13px;line-height:1.7}.sc-message-user{margin-left:16px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}.sc-role{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:5px}.sc-markdown p{white-space:pre-wrap;margin:0 0 12px}.sc-markdown p:last-child,.sc-markdown pre:last-child{margin-bottom:0}.sc-markdown code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em;background:var(--dsw-alias-bg-layer-1);border-radius:4px;padding:1px 4px}.sc-markdown pre{max-width:100%;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin:0 0 12px;padding:10px 12px;line-height:1.6;tab-size:2}.sc-markdown pre code{background:transparent;padding:0;border-radius:0;white-space:pre;overflow-wrap:normal}.sc-code-language{font-size:10px;color:var(--dsw-alias-label-tertiary);margin-bottom:5px}.sc-markdown blockquote{white-space:pre-wrap;margin:0 0 12px;padding-left:10px;border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}.sc-user-text{white-space:pre-wrap}.sc-pending{font-size:12px;color:var(--dsw-alias-label-secondary)}
.sc-markdown{min-width:0;max-width:100%}.sc-markdown>:last-child{margin-bottom:0}.sc-markdown h1,.sc-markdown h2,.sc-markdown h3,.sc-markdown h4,.sc-markdown h5,.sc-markdown h6{line-height:1.5;font-weight:600;margin:18px 0 10px}.sc-markdown>:first-child{margin-top:0}.sc-markdown h1{font-size:20px}.sc-markdown h2{font-size:18px}.sc-markdown h3{font-size:16px}.sc-markdown h4,.sc-markdown h5,.sc-markdown h6{font-size:14px}.sc-markdown ul,.sc-markdown ol{margin:0 0 12px;padding-left:24px}.sc-markdown ul{list-style:disc}.sc-markdown ol{list-style:decimal}.sc-markdown li{margin:4px 0}.sc-markdown li p{margin-bottom:6px}.sc-markdown li>ul,.sc-markdown li>ol{margin:6px 0}.sc-markdown .sc-task-item{list-style:none}.sc-task-item>input{margin:0 6px 0 -18px;vertical-align:middle}.sc-markdown a{color:var(--dsw-alias-brand-primary);text-decoration:underline;text-underline-offset:2px}.sc-markdown hr{height:0;border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:16px 0}.sc-table-scroll{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;margin:0 0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}.sc-table-scroll:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.sc-markdown table{width:100%;border-collapse:collapse;font:inherit;line-height:1.6}.sc-markdown th,.sc-markdown td{min-width:7em;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);border-right:1px solid var(--dsw-alias-border-l1);text-align:left;vertical-align:top;white-space:normal;overflow-wrap:anywhere}.sc-markdown th{font-weight:600;background:var(--dsw-alias-bg-layer-1)}.sc-markdown th:last-child,.sc-markdown td:last-child{border-right:0}.sc-markdown tbody tr:last-child td{border-bottom:0}.sc-code-block{margin:0 0 12px}.sc-code-block pre{margin-bottom:0}
.sc-composer{flex:none;padding:10px 12px 12px;border-top:1px solid var(--dsw-alias-border-l1)}.sc-composer textarea{display:block;resize:vertical;width:100%;min-height:88px;max-height:240px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6}.sc-composer textarea::placeholder{color:var(--dsw-alias-label-tertiary)}.sc-composer textarea:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}.sc-composer textarea:disabled{opacity:.55}.sc-composer-controls{display:flex;align-items:center;gap:8px;margin-top:8px}.sc-model{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary)}.sc-composer-hint{font-size:10px;color:var(--dsw-alias-label-tertiary);margin-top:7px;line-height:1.6}.sc-note{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);padding:7px 14px;flex:none;border-top:1px solid var(--dsw-alias-border-l1)}.sc-error-box{flex:none;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}.sc-error{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.6}.sc-error-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
.sc-menu{position:fixed;z-index:1000;pointer-events:auto;display:flex;gap:2px;align-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-overlay);padding:4px;max-width:calc(100vw - 16px);box-shadow:0 4px 18px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);font:inherit}.sc-menu .sc-button{border:0;background:transparent;min-height:30px}.sc-menu .sc-button:hover{background:var(--dsw-alias-bg-layer-2)}.sc-divider{height:18px;width:1px;background:var(--dsw-alias-border-l1)}.sc-live{position:fixed;inset:auto 16px 18px auto;pointer-events:auto;max-width:360px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);padding:10px 14px;font-size:12px}
@container(max-width:340px){.sc-head{padding:10px}.sc-sub{font-size:10px}.sc-messages{padding:12px 10px}.sc-message-user{margin-left:6px}.sc-composer{padding:9px}.sc-composer-hint{font-size:9px}}
`;
    function ChatIcon({size = 18}) {
      return h('svg', {viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true},
        h('rect', {x: 3, y: 4, width: 18, height: 16, rx: 4}), h('path', {d: 'M13 4v16M6.5 8h3M6.5 12h3M16 9h2M16 13h2'}));
    }
    const Markdown = React.memo(function Markdown({value, tableLabel}) {
      return React.useMemo(() => renderMarkdown(value, h, tableLabel), [value, tableLabel]);
    });
    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'uiWorkspace', 'remote'],
      async apply(ctx) {
        // Dynamic bundles have no generated ./remote artifact. Mount the same wire
        // contract explicitly; scoped calls bind the main Session's agentId.
        const codec = (typeSymbol, parse = value => value) => ({mode: 'strict', typeSymbol, create: () => ({parse})});
        const identity = codec('@deepseek-ai/dsh-session/types#SessionId', value => {
          if (typeof value !== 'string' || !value) throw new Error('Invalid session identity.');
          return value;
        });
        const request = codec('@local/dsh-side-chat#Request', value => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Side Chat request.');
          return value;
        });
        const result = codec('@local/dsh-side-chat#Reply');
        const descriptor = (method, stream = false) => ({
          id: `${ID}#localSideChat/${method}`, service: 'localSideChat', namespace: 'localSideChat', method,
          invocation: {kind: 'direct'}, scope: {context: 'agent', wire: 'agentId'}, ...(stream ? {mode: 'stream'} : {}),
          parameters: [{name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: identity, strictCodec: identity},
            {name: 'request', wire: 'request', source: 'json', codec: request, strictCodec: request}],
          cancellation: {parameter: 'signal'}, result
        });
        // $mount owns registration and withdrawal; do not register remotes twice.
        await ctx.remote.$mount({package: ID, descriptors: [descriptor('perform'), descriptor('send', true)]});
        ctx.effect(() => ctx.locale.register(NS, {en, zh}));
        const t = ctx.locale.bind(NS);
        const flights = new Map();
        const memory = new Map();
        const mainInputs = new Map();
        const live = {value: '', listeners: new Set()};
        function notice(value) { live.value = value; for (const fn of live.listeners) fn(); }
        function useMounted() {
          return React.useSyncExternalStore(fn => ctx.sidebarRight.mounted.subscribe(fn), () => ctx.sidebarRight.mounted.getSnapshot());
        }
        function readRecord(key) {
          if (memory.has(key)) return memory.get(key);
          try {
            const value = JSON.parse(localStorage.getItem(STORAGE + key) || 'null');
            if ((value?.version === 1 || value?.version === 2) && typeof value.sessionId === 'string' || value?.version === 3 && typeof value.sideChatId === 'string') {
              memory.set(key, value); return value;
            }
          } catch { /* Keep durable Host records and recoverable legacy records untouched. */ }
          return null;
        }
        function saveRecord(key, value) {
          memory.set(key, value);
          try { localStorage.setItem(STORAGE + key, JSON.stringify(value)); return true; }
          catch { return false; }
        }
        function open(quote = '', reveal = false) {
          const sessionId = ctx.sidebarRight.mounted.getSnapshot();
          if (!sessionId) { notice(t('noSession')); return; }
          if (quote.length > 20000) { notice(t('tooLong')); return; }
          try { ctx.sidebarRight.openTab(KIND, {params: {quote}, revealIfOpened: reveal}); }
          catch (error) { notice(error.message || t('failed')); }
        }
        // Keep selection-to-main-draft working without a visible header launcher.
        function MainInputBinding({sessionId, inputActions}) {
          React.useEffect(() => {
            if (!sessionId || !inputActions) return;
            mainInputs.set(sessionId, inputActions);
            return () => {if (mainInputs.get(sessionId) === inputActions) mainInputs.delete(sessionId);};
          }, [sessionId, inputActions]);
          return null;
        }
        function Body(props) {
          const {tab} = props.useTabInfo();
          const storageKey = `${props.sessionId}.${tab.id}`;
          return h(SideChat, {...props, tab, storageKey, key: storageKey});
        }
        function SideChat({tab, storageKey: key, sessionId, t: text}) {
          const [record, setRecord] = React.useState(() => readRecord(key));
          const recordRef = React.useRef(record);
          const [view, setView] = React.useState(null);
          const viewRef = React.useRef(null);
          const [error, setError] = React.useState('');
          const [storageFailed, setStorageFailed] = React.useState(false);
          const [attempt, setAttempt] = React.useState(0);
          const loadedAttempt = React.useRef(-1);
          const [sending, setSending] = React.useState(false);
          const [stopping, setStopping] = React.useState(false);
          const [transportRetry, setTransportRetry] = React.useState(null);
          const transportRetryRef = React.useRef(null);
          const taskRef = React.useRef(null);
          const mountedRef = React.useRef(false);
          const composingRef = React.useRef(false);
          const scrollRef = React.useRef(null);
          const atBottom = React.useRef(true);
          const draft = typeof record?.draft === 'string' ? record.draft : '';
          const busy = sending || !!view?.busy;
          const ready = record?.version === 3 && !!view;
          const remote = () => {
            const scope = ctx.sessions.scope(sessionId);
            if (!scope) throw new Error(text('noSession'));
            // A borrowed Session Context does not inherit this plugin's inject list.
            // Public get() preserves the scoped caller without a guarded property read.
            const api = scope.get('remote.localSideChat');
            if (!api) throw new Error(text('unavailable'));
            return api;
          };
          const unwrap = result => {
            if (!result?.ok) throw new Error(result?.error?.message || text('failed'));
            return result.value;
          };
          const validateView = value => {
            if (typeof value?.sideChatId !== 'string' || value.sourceSessionId !== sessionId || !Array.isArray(value.messages) ||
              !value.messages.every(message => typeof message.id === 'string' && (message.role === 'user' || message.role === 'assistant') && typeof message.text === 'string')) throw new Error(text('invalid'));
            return value;
          };
          const publish = value => {
            viewRef.current = value;
            if (mountedRef.current) setView(value);
          };
          const persist = patch => {
            const previous = recordRef.current;
            if (!previous || previous.version !== 3) return;
            const next = {version: 3, sideChatId: previous.sideChatId, sourceSessionId: previous.sourceSessionId,
              quote: typeof previous.quote === 'string' ? previous.quote : '', draft: typeof previous.draft === 'string' ? previous.draft : '', ...patch};
            recordRef.current = next;
            setRecord(next);
            if (!saveRecord(key, next)) setStorageFailed(true);
          };
          React.useEffect(() => {
            mountedRef.current = true;
            return () => {mountedRef.current = false; taskRef.current?.controller.abort();};
          }, []);
          React.useEffect(() => {
            let active = true;
            if (!tab.visible || tab.signal.aborted || viewRef.current && loadedAttempt.current === attempt) return;
            setError('');
            if (!flights.has(key)) {
              const pending = (async () => {
                const saved = readRecord(key);
                const request = saved?.version === 3 ? {action: 'get', sideChatId: saved.sideChatId} :
                  saved?.sessionId ? {action: 'migrate', sessionId: saved.sessionId, tabKey: key} : {action: 'create', tabKey: key};
                const value = validateView(unwrap(await remote().perform(request, tab.signal)));
                const latest = readRecord(key) || saved;
                const next = {version: 3, sideChatId: value.sideChatId, sourceSessionId: value.sourceSessionId,
                  quote: latest ? typeof latest.quote === 'string' ? latest.quote : '' : typeof tab.navigation.params?.quote === 'string' ? tab.navigation.params.quote : '',
                  draft: typeof latest?.draft === 'string' ? latest.draft : ''};
                return {view: value, record: next, stored: saveRecord(key, next)};
              })();
              flights.set(key, pending);
              pending.finally(() => {if (flights.get(key) === pending) flights.delete(key);}).catch(() => {});
            }
            flights.get(key).then(value => {
              if (!active) return;
              loadedAttempt.current = attempt;
              recordRef.current = value.record;
              setRecord(value.record); setStorageFailed(previous => previous || !value.stored); publish(value.view);
            }, failure => {if (active) setError(failure.message || String(failure));});
            return () => {active = false;};
          }, [key, tab.visible, attempt]);
          React.useEffect(() => {
            const current = recordRef.current;
            if (!ready || !current?.quote) return;
            const quoted = `${text('quote')}：\n${current.quote.split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
            const priorDraft = typeof current.draft === 'string' ? current.draft : '';
            // Persist draft insertion and quote consumption together, so reload cannot repeat it.
            persist({quote: '', draft: priorDraft + (priorDraft && !priorDraft.endsWith('\n\n') ? '\n\n' : '') + quoted});
          }, [ready, record?.quote]);
          React.useLayoutEffect(() => {
            if (tab.visible && atBottom.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }, [view?.messages, tab.visible]);
          React.useEffect(() => {
            // A reload may recover an already-running response without owning its stream.
            // Read snapshots only in that case, while visible; never poll an idle chat.
            if (!view?.busy || sending || !tab.visible || tab.signal.aborted) return;
            let active = true;
            const snapshot = view;
            const timer = setTimeout(async () => {
              if (taskRef.current) return;
              try {
                const restored = validateView(unwrap(await remote().perform({action: 'get', sideChatId: snapshot.sideChatId}, tab.signal)));
                if (active && !taskRef.current && viewRef.current === snapshot) publish(restored);
              } catch (failure) {if (active && !taskRef.current) setError(failure.message || String(failure));}
            }, 1200);
            return () => {active = false; clearTimeout(timer);};
          }, [view, sending, tab.visible]);
          async function recover(sideChatId) {
            const restored = validateView(unwrap(await remote().perform({action: 'get', sideChatId}, tab.signal)));
            if (mountedRef.current) publish(restored);
            return restored;
          }
          async function send(explicitRetry) {
            const current = recordRef.current;
            const currentView = viewRef.current;
            if (!current || current.version !== 3 || !currentView || taskRef.current || currentView.busy) return;
            const raw = typeof current.draft === 'string' ? current.draft : '';
            const pending = explicitRetry || (transportRetryRef.current?.text === raw ? transportRetryRef.current : null) ||
              (currentView.retry?.text === raw ? currentView.retry : null);
            const value = pending?.text ?? raw;
            if (!value.trim()) return;
            const requestId = pending?.requestId || crypto.randomUUID();
            const controller = new AbortController();
            const task = {controller, stopped: false};
            const abort = () => controller.abort(tab.signal.reason);
            if (tab.signal.aborted) return;
            tab.signal.addEventListener('abort', abort, {once: true});
            taskRef.current = task;
            setSending(true); setError(''); setTransportRetry(null); transportRetryRef.current = null;
            atBottom.current = true;
            let accepted = false;
            try {
              const stream = await remote().send({sideChatId: current.sideChatId, text: value, requestId}, controller.signal);
              for await (const frame of stream) {
                if (controller.signal.aborted || !mountedRef.current) break;
                // Generated Remote streams yield business frames directly and throw
                // terminal RemoteErrors; only unary perform returns RemoteResult.
                if (frame?.kind === 'state') {
                  const next = validateView(frame.view);
                  if (next.sideChatId !== current.sideChatId) throw new Error(text('invalid'));
                  publish(next);
                  if (!accepted) {
                    accepted = true;
                    if (!explicitRetry && recordRef.current?.draft === raw) persist({draft: ''});
                  }
                } else if (frame?.kind === 'delta' && typeof frame.text === 'string') {
                  if (!accepted) throw new Error(text('invalid'));
                  const before = viewRef.current;
                  const messages = before.messages.slice();
                  const last = messages[messages.length - 1];
                  if (!last || last.role !== 'assistant') throw new Error(text('invalid'));
                  messages[messages.length - 1] = {...last, text: last.text + frame.text};
                  publish({...before, messages});
                } else throw new Error(text('invalid'));
              }
              if (!controller.signal.aborted && mountedRef.current && viewRef.current?.busy) {
                setError(text('streamEnded'));
                const retry = {requestId, text: value};
                transportRetryRef.current = retry; setTransportRetry(retry);
                await recover(current.sideChatId);
              }
            } catch (failure) {
              if (mountedRef.current && !task.stopped && !tab.signal.aborted) {
                setError(failure.message || String(failure));
                const retry = {requestId, text: value};
                transportRetryRef.current = retry; setTransportRetry(retry);
                try {await recover(current.sideChatId);} catch { /* Preserve draft, partial answer, and the original failure. */ }
              }
            } finally {
              tab.signal.removeEventListener('abort', abort);
              if (taskRef.current === task) taskRef.current = null;
              if (mountedRef.current) setSending(false);
            }
          }
          async function stop() {
            const current = recordRef.current;
            if (stopping || !current?.sideChatId) return;
            const task = taskRef.current;
            if (task) {task.stopped = true; task.controller.abort();}
            setStopping(true); setError('');
            try {publish(validateView(unwrap(await remote().perform({action: 'stop', sideChatId: current.sideChatId}, tab.signal))));}
            catch (failure) {if (mountedRef.current) setError(failure.message || String(failure));}
            finally {if (mountedRef.current) setStopping(false);}
          }
          const failure = error || view?.error;
          const retry = view?.retry || transportRetry;
          const sourceId = view?.sourceSessionId || record?.sourceSessionId || sessionId;
          const model = [view?.config?.model, view?.config?.reasoningEffort].filter(Boolean).join(' · ');
          return h('section', {className: 'sc-root', 'aria-label': text('title')}, h('style', null, css),
            h('header', {className: 'sc-head'}, h(ChatIcon), h('div', {className: 'sc-head-copy'}, h('div', {className: 'sc-title'}, text('title')), h('div', {className: 'sc-sub', title: text('snapshot')}, text('inherited'))),
              h('button', {type: 'button', className: 'sc-button', title: text('new'), 'aria-label': text('new'), onClick: () => open()}, '+')),
            h('button', {type: 'button', className: 'sc-source', title: `${text('sourceOpen')} · ${sourceId}`, onClick: () => ctx.uiWorkspace.openSession(sourceId)}, text('source'), '：', view?.sourceTitle || sourceId),
            h('div', {className: 'sc-messages', ref: scrollRef, role: 'log', 'aria-label': text('title'), 'aria-live': busy ? 'off' : 'polite', 'aria-busy': busy,
              onScroll: event => {const node = event.currentTarget; atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60;}},
              view?.messages?.length ? view.messages.map(message => h('article', {key: message.id, className: `sc-message sc-message-${message.role}`},
                h('div', {className: 'sc-role'}, text(message.role === 'user' ? 'you' : 'assistant')),
                message.role === 'assistant' ? message.text ? h(Markdown, {value: message.text, tableLabel: text('table')}) : h('span', {className: 'sc-pending'}, busy ? text('thinking') : '…') : h('div', {className: 'sc-user-text'}, message.text))) :
                h('div', {className: 'sc-empty'}, h(ChatIcon, {size: 32}), h('h2', null, text(ready ? 'empty' : error ? 'failed' : 'loading')), h('p', null, text('hint')))),
            failure && h('div', {className: 'sc-error-box', role: 'alert'}, h('div', {className: 'sc-error'}, failure),
              h('div', {className: 'sc-error-actions'}, retry && h('button', {type: 'button', className: 'sc-button', disabled: busy || stopping, onClick: () => send(retry)}, text('retry')),
                h('button', {type: 'button', className: 'sc-button', disabled: sending || stopping, onClick: () => {loadedAttempt.current = -1; setAttempt(value => value + 1);}}, text('reload')))),
            h('form', {className: 'sc-composer', onSubmit: event => {event.preventDefault(); send();}},
              h('textarea', {value: draft, rows: 3, disabled: !ready, 'aria-label': text('placeholder'), placeholder: text('placeholder'),
                onChange: event => persist({draft: event.target.value}), onCompositionStart: () => {composingRef.current = true;}, onCompositionEnd: () => {composingRef.current = false;},
                onKeyDown: event => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !composingRef.current && !event.nativeEvent?.isComposing && event.keyCode !== 229) {event.preventDefault(); send();}
                }}),
              h('div', {className: 'sc-composer-controls'}, h('span', {className: 'sc-model', title: [view?.config?.provider, model].filter(Boolean).join(' / ')}, model || text('loading')),
                busy ? h('button', {type: 'button', className: 'sc-button', disabled: stopping, onClick: stop}, text(stopping ? 'stopping' : 'stop')) :
                  h('button', {type: 'submit', className: 'sc-button sc-primary', disabled: !ready || !draft.trim() || stopping}, text('send'))),
              h('div', {className: 'sc-composer-hint'}, text('composerHint'), h('br'), text('toolsOff'))),
            storageFailed && h('div', {className: 'sc-note', role: 'status'}, text('storage')));
        }
        function SelectionMenu(props) {
          const mounted = useMounted();
          const [selection, setSelection] = React.useState(null);
          const [message, setMessage] = React.useState('');
          const menuRef = React.useRef(null);
          const ownerRef = React.useRef(null);
          React.useEffect(() => {
            const update = () => setMessage(live.value);
            live.listeners.add(update);
            return () => live.listeners.delete(update);
          }, []);
          React.useEffect(() => {
            let frame;
            function capture() {
              frame = undefined;
              const value = window.getSelection();
              if (!mounted || !value || value.isCollapsed || !value.rangeCount) {setSelection(null); return;}
              const range = value.getRangeAt(0);
              const element = node => node?.nodeType === 1 ? node : node?.parentElement;
              const start = element(range.startContainer);
              const end = element(range.endContainer);
              // Only the user's selected transcript is read; no transcript scraping or layout guessing.
              if (!start || !end || start.closest('input,textarea,[contenteditable="true"],[role="dialog"],.sc-root') || end.closest('input,textarea,[contenteditable="true"],[role="dialog"],.sc-root')) {setSelection(null); return;}
              const root = start.closest('[data-chat-flow]');
              const content = start.closest('[data-conversation-content]');
              const region = start.closest('[data-conversation-region]');
              if (!root || root !== end.closest('[data-chat-flow]') || content?.dataset.conversationSession !== mounted || region?.dataset.conversationRegion !== 'chat' || start.closest('[data-sidebar-right-session]')) {setSelection(null); return;}
              const quote = value.toString().trim();
              if (!quote || quote.length > 20000) {setSelection(null); return;}
              const rectangles = range.getClientRects();
              const rect = rectangles.length ? rectangles[0] : range.getBoundingClientRect();
              if (!rect.width && !rect.height || rect.bottom < 0 || rect.top > window.innerHeight) {setSelection(null); return;}
              ownerRef.current = {sessionId: mounted, range: range.cloneRange()};
              setSelection({quote, x: Math.max(8, Math.min(rect.left, window.innerWidth - 300)), y: Math.max(8, rect.top - 44)});
            }
            function schedule() {if (frame === undefined) frame = requestAnimationFrame(capture);}
            function pointer(event) {if (!menuRef.current?.contains(event.target)) setMessage('');}
            function key(event) {if (event.key === 'Escape') {setSelection(null); setMessage('');}}
            document.addEventListener('selectionchange', schedule);
            document.addEventListener('pointerup', schedule);
            document.addEventListener('pointerdown', pointer, true);
            document.addEventListener('keydown', key);
            window.addEventListener('scroll', schedule, true);
            window.addEventListener('resize', schedule);
            return () => {
              if (frame !== undefined) cancelAnimationFrame(frame);
              document.removeEventListener('selectionchange', schedule); document.removeEventListener('pointerup', schedule);
              document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('keydown', key);
              window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule);
              ownerRef.current = null;
            };
          }, [mounted]);
          React.useLayoutEffect(() => {
            if (!selection || !menuRef.current) return;
            const rect = menuRef.current.getBoundingClientRect();
            const x = Math.max(8, Math.min(selection.x, window.innerWidth - rect.width - 8));
            const y = Math.max(8, Math.min(selection.y, window.innerHeight - rect.height - 8));
            if (x !== selection.x || y !== selection.y) setSelection({...selection, x, y});
          }, [selection]);
          function action(side) {
            if (!selection || ownerRef.current?.sessionId !== ctx.sidebarRight.mounted.getSnapshot()) {setSelection(null); return;}
            if (side) open(selection.quote);
            else {
              const input = mainInputs.get(mounted);
              if (!input) {notice(t('insertFailed')); return;}
              const span = input.captureInsertion();
              const result = input.insertText(`> ${selection.quote.replace(/\n/g, '\n> ')}\n\n`, span);
              if (!result) {notice(t('insertFailed')); return;}
            }
            setSelection(null);
            window.getSelection()?.removeAllRanges();
          }
          return h(React.Fragment, null, h('style', null, css),
            selection && h('div', {className: 'sc-menu', ref: menuRef, style: {left: selection.x, top: selection.y}, role: 'group', 'aria-label': t('selected'), onPointerDown: event => event.preventDefault()},
              h('button', {type: 'button', className: 'sc-button', onClick: () => action(false)}, t('add')),
              h('span', {className: 'sc-divider'}),
              h('button', {type: 'button', className: 'sc-button sc-primary', onClick: () => action(true)}, h(ChatIcon, {size: 15}), t('ask'))),
            message && h('div', {className: 'sc-live', role: 'status', onClick: () => setMessage('')}, message));
        }
        ctx.effect(() => ctx.sidebarRightTabs.register({id: ID, kind: KIND, title: () => t('title'), multiple: true, keepMounted: true,
          guide: [{id: 'side-chat', title: () => t('title'), description: () => t('subtitle'), icon: ChatIcon, order: 15}]}));
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({name: 'sidebar.right.pane.tab', key: ID, locale: NS}, Body));
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({name: 'conversation.input.overlay', id: 'local-side-chat-input-binding'}, MainInputBinding));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({name: 'shell.overlay', id: 'local-side-chat-selection', order: 50, locale: NS}, SelectionMenu));
        // A client contribution gives /side-chat the same localized label/name row
        // as first-party commands; the Host command is intentionally absent to avoid
        // the documented host/contribution name collision.
        ctx.inject(['commandUi'], scope => {
          scope.effect(() => scope.commandUi.register({
            name: 'side-chat',
            label: () => t('title'),
            description: () => t('commandDescription'),
            icon: ChatIcon,
            available: () => !!ctx.sidebarRight.mounted.getSnapshot(),
            ui: {kind: 'action', run: session => {if (ctx.sidebarRight.mounted.getSnapshot() === session.sessionId) open('', true);}}
          }), 'ui-side-chat: /side-chat command');
        });
        ctx.effect(() => () => {memory.clear(); mainInputs.clear(); flights.clear(); live.listeners.clear();});
      }
    };
  }
});
