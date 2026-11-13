window.__ModuleLoader__.load({
  id: '@local/dsh-personalization',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'localPersonalization';
    const ENTRY = 'local-personalization';
    const MAX = 20000;
    const en = {
      nav: 'Personalization', title: 'Personalization', subtitle: 'One set of instructions, across your conversations.',
      enabled: 'Use personal instructions', enabledHint: 'Pause without deleting your saved instructions.',
      label: 'Personal instructions', hint: 'Describe your preferred language, response style, coding conventions, or background.',
      placeholder: 'For example:\nReply in Simplified Chinese.\nStart with the conclusion and keep explanations concise.\nPrefer TypeScript for code examples.',
      scope: 'Saved changes apply to new and existing conversations in this profile from their next model request. Requests already in progress are unchanged.',
      caveat: 'Custom presets that replace the entire system prompt are not supported. These preferences do not replace system rules or task-specific instructions.',
      privacy: 'This text is included in model requests. Do not store passwords, API keys, or other secrets here.',
      save: 'Save changes', saving: 'Saving…', discard: 'Discard changes', saved: 'Saved. Applies from the next model request.',
      dirty: 'Unsaved changes', active: 'Instructions enabled', paused: 'Instructions paused', empty: 'No instructions configured',
      loading: 'Loading settings…', unavailable: 'Personalization settings are unavailable.', retry: 'Reload settings',
      failed: 'Could not save. Your draft was kept. Reload the latest settings before trying again.',
      conflict: 'Settings changed in another window or conversation. Reload the latest settings before saving; reloading discards this draft.',
      latest: 'Load latest settings', readonly: 'This connection cannot edit settings.', counter: 'characters',
    };
    const zh = {
      nav: '个性化', title: '个性化', subtitle: '一份专属指令，统一用于各个会话。',
      enabled: '使用个性化指令', enabledHint: '关闭后暂停使用，已保存的内容仍会保留。',
      label: '个性化指令', hint: '告诉助手你偏好的语言、回答风格、代码规范，或需要了解的背景。',
      placeholder: '例如：\n默认使用简体中文回答。\n先给结论，再给必要的解释，保持简洁。\n代码示例优先使用 TypeScript。',
      scope: '保存后，当前配置文件（profile）中的新会话与已有会话将从下一次模型请求起使用这些指令，已发出的请求不受影响。',
      caveat: '完整替换系统提示词的自定义预设不适用。这些偏好不会替代系统规则或当前任务的明确指令。',
      privacy: '这些内容会发送给模型，请勿填写密码、API Key 等敏感信息。',
      save: '保存更改', saving: '正在保存…', discard: '放弃更改', saved: '已保存，将从下一次模型请求起生效。',
      dirty: '有未保存的更改', active: '个性化指令已启用', paused: '个性化指令已暂停', empty: '尚未设置个性化指令',
      loading: '正在加载设置…', unavailable: '个性化设置暂不可用。', retry: '重新加载设置',
      failed: '保存失败，草稿已保留。请载入最新设置后重试。',
      conflict: '设置已在其他窗口或会话中更改。请先载入最新设置；载入会放弃当前草稿。',
      latest: '载入最新设置', readonly: '当前连接无权修改设置。', counter: '字符',
    };
    const css = `
.dsh-prefs{font-family:inherit;font-size:14px;line-height:1.6;color:var(--dsw-alias-label-primary);max-width:680px;width:100%;min-width:0;padding:0 0 24px;box-sizing:border-box}
.dsh-prefs *{box-sizing:border-box}.dsh-prefs h2{font-size:18px;line-height:1.4;font-weight:600;margin:0 0 6px}.dsh-prefs p{margin:0}.dsh-prefs-subtitle,.dsh-prefs-help{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}.dsh-prefs-subtitle{margin-bottom:24px!important}
.dsh-prefs-row{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:22px}.dsh-prefs-label{display:block;font-weight:500;margin-bottom:4px}.dsh-prefs-switch{flex:none;width:36px;height:20px;border:0;border-radius:999px;background:var(--dsw-alias-border-l2);padding:3px;cursor:pointer;display:flex;align-items:center}.dsh-prefs-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}.dsh-prefs-switch span{display:block;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base)}.dsh-prefs-switch[aria-checked=true] span{margin-left:auto}
.dsh-prefs textarea{display:block;resize:vertical;width:100%;min-height:230px;max-height:60vh;margin-top:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;line-height:1.65}.dsh-prefs textarea::placeholder{color:var(--dsw-alias-label-secondary)}.dsh-prefs button{font:inherit}.dsh-prefs textarea:focus-visible,.dsh-prefs button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.dsh-prefs button:disabled,.dsh-prefs textarea:disabled{opacity:.5;cursor:not-allowed}
.dsh-prefs-meta{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:8px 0 18px;color:var(--dsw-alias-label-secondary);font-size:12px}.dsh-prefs-note{border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:1.7;margin-bottom:12px}.dsh-prefs-note p+p{margin-top:8px}.dsh-prefs-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:22px}.dsh-prefs-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 14px;min-height:34px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);cursor:pointer}.dsh-prefs-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}.dsh-prefs-btn.primary{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}.dsh-prefs-status{font-size:13px;color:var(--dsw-alias-label-secondary);margin-top:14px!important}.dsh-prefs-error{color:var(--dsw-alias-state-error-primary);font-size:13px;margin:14px 0!important;overflow-wrap:anywhere}.dsh-prefs-success{color:var(--dsw-alias-state-success-primary)}
`;
    const from = snapshot => ({...snapshot.value, revision: snapshot.revision, original: {...snapshot.value}});
    const changed = draft => Boolean(draft && (draft.enabled !== draft.original.enabled || draft.instructions !== draft.original.instructions));
    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {en, zh}));
        const form = ctx.configForms.get(ENTRY);
        const mirror = ctx.configForms.describe();
        const t = ctx.locale.bind(NS);
        // Keep an unsaved draft if the user switches settings sections or closes the dialog.
        let retainedDraft = null;
        function Personalization() {
          React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
          const snapshot = React.useSyncExternalStore(fn => form.subscribe(fn), () => form.getSnapshot());
          const mirrorSnapshot = React.useSyncExternalStore(fn => mirror.subscribe(fn), () => mirror.getSnapshot());
          const [draft, setDraftState] = React.useState(() => retainedDraft);
          const [saving, setSaving] = React.useState(false);
          const [message, setMessage] = React.useState('');
          const [error, setError] = React.useState('');
          const lock = React.useRef(false);
          const mounted = React.useRef(true);
          React.useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
          function setDraft(value) {retainedDraft = value; setDraftState(value);}
          const dirty = changed(draft);
          React.useEffect(() => {
            if (snapshot.status === 'ready' && (!draft || (!changed(draft) && snapshot.revision !== draft.revision))) setDraft(from(snapshot));
          }, [snapshot, draft]);
          function edit(patch) {setDraft({...draft, ...patch}); setMessage(''); setError('');}
          function reload() {if (snapshot.status === 'ready') setDraft(from(snapshot)); setMessage(''); setError('');}
          const conflict = Boolean(draft && snapshot.revision !== draft.revision);
          async function save() {
            if (lock.current || !dirty || conflict || !snapshot.writable) return;
            lock.current = true; setSaving(true); setError(''); setMessage('');
            try {
              const accepted = await form.mutate([
                {op: 'set', path: ['enabled'], value: draft.enabled},
                {op: 'set', path: ['instructions'], value: draft.instructions},
              ], draft.revision);
              if (!accepted) throw new Error(t('failed'));
              const next = from(form.getSnapshot());
              retainedDraft = next;
              if (mounted.current) {setDraftState(next); setMessage('saved');}
            } catch (err) {
              if (mounted.current) setError(err?.message || t('failed'));
            } finally {lock.current = false; if (mounted.current) setSaving(false);}
          }
          const title = h(React.Fragment, null, h('h2', null, t('title')), h('p', {className: 'dsh-prefs-subtitle'}, t('subtitle')));
          if (snapshot.status !== 'ready' || !draft) return h('section', {className: 'dsh-prefs'}, h('style', null, css), title,
            h('p', {role: mirrorSnapshot.error ? 'alert' : 'status'}, mirrorSnapshot.error?.message || (snapshot.status === 'unavailable' ? t('unavailable') : t('loading'))),
            h('button', {type: 'button', className: 'dsh-prefs-btn', onClick: () => mirror.load()}, t('retry')));
          const currentStatus = !snapshot.value.enabled ? 'paused' : snapshot.value.instructions.trim() ? 'active' : 'empty';
          return h('section', {className: 'dsh-prefs', 'aria-label': t('title'), onKeyDown: event => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {event.preventDefault(); void save();}
          }}, h('style', null, css), title,
            h('div', {className: 'dsh-prefs-row'}, h('div', null, h('span', {className: 'dsh-prefs-label', id: 'dsh-prefs-enabled-label'}, t('enabled')), h('p', {className: 'dsh-prefs-help'}, t('enabledHint'))),
              h('button', {type: 'button', className: 'dsh-prefs-switch', role: 'switch', 'aria-checked': draft.enabled, 'aria-labelledby': 'dsh-prefs-enabled-label', disabled: saving || !snapshot.writable, onClick: () => edit({enabled: !draft.enabled})}, h('span'))),
            h('label', {htmlFor: 'dsh-prefs-instructions', className: 'dsh-prefs-label'}, t('label')),
            h('p', {id: 'dsh-prefs-hint', className: 'dsh-prefs-help'}, t('hint')),
            h('textarea', {id: 'dsh-prefs-instructions', value: draft.instructions, placeholder: t('placeholder'), maxLength: MAX, spellCheck: false,
              'aria-describedby': 'dsh-prefs-hint dsh-prefs-privacy', disabled: saving || !snapshot.writable, onChange: event => edit({instructions: event.target.value})}),
            h('div', {className: 'dsh-prefs-meta'}, h('span', null, t(currentStatus)), h('span', null, `${draft.instructions.length.toLocaleString()} / 20,000 ${t('counter')}`)),
            h('div', {className: 'dsh-prefs-note'}, h('p', null, t('scope')), h('p', {className: 'dsh-prefs-help'}, t('caveat'))),
            h('p', {className: 'dsh-prefs-help', id: 'dsh-prefs-privacy'}, t('privacy')),
            !snapshot.writable && h('p', {className: 'dsh-prefs-error', role: 'alert'}, t('readonly')),
            conflict && h('p', {className: 'dsh-prefs-error', role: 'alert'}, t('conflict')),
            error && h('p', {className: 'dsh-prefs-error', role: 'alert'}, error),
            h('div', {className: 'dsh-prefs-actions'},
              h('button', {type: 'button', className: 'dsh-prefs-btn primary', disabled: saving || !dirty || conflict || !snapshot.writable, onClick: save}, t(saving ? 'saving' : 'save')),
              h('button', {type: 'button', className: 'dsh-prefs-btn', disabled: saving || (!dirty && !conflict), onClick: reload}, t(conflict ? 'latest' : 'discard'))),
            h('p', {role: 'status', 'aria-live': 'polite', className: `dsh-prefs-status${message && !dirty ? ' dsh-prefs-success' : ''}`}, dirty ? t('dirty') : message ? t(message) : ''));
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: ENTRY, order: 5, label: () => t('nav'), locale: NS,
        }, Personalization));
      },
    };
  },
});
