window.__ModuleLoader__.load({
  id: '@local/dsh-git-prompts',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'localGitPrompts';
    const ENTRY = 'local-git-prompts';
    const MAX = 20000;
    const en = {
      nav: 'Git', title: 'Git prompts', subtitle: 'Commit and PR instructions, loaded only when needed — not part of the system prompt.',
      enabled: 'Use Git prompts', enabledHint: 'Pause without deleting your saved text. You can still edit it while paused.',
      commitLabel: 'Commit instructions', commitHint: 'Optional rules for preparing a commit. Leave blank to add no commit instructions.',
      commitPlaceholder: 'For example: Use Conventional Commits, with a concise title in Simplified Chinese.',
      prLabel: 'PR instructions', prHint: 'Optional rules for preparing a pull request. Leave blank to add no PR instructions.',
      prPlaceholder: 'For example: Briefly describe the changes, verification results, and risks in Simplified Chinese.',
      when: 'The corresponding text is delivered only when the assistant calls prepare_git_operation for commit or pr. It is not added to the system prompt.',
      scope: 'Saved settings apply to the current profile. Unsaved drafts stay in this window when you close Settings or switch sections, but do not survive a page reload.',
      preparation: 'When enabled commit instructions are nonempty, git_workbench(action=commit) requires preparation first, then a newly generated call in a later model step.',
      coverage: 'Manual Git workbench buttons, arbitrary bash / gh commands, and Forge do not automatically use these instructions. This is not a commit or PR format validator.',
      history: 'Text already delivered to the model remains in the conversation history. Pausing or editing does not remove it.',
      privacy: 'These instructions are sent to the model on demand. Do not enter passwords, tokens, or other secrets.',
      save: 'Save changes', saving: 'Saving…', discard: 'Discard changes', saved: 'Saved. The next Git preparation will read these settings.',
      dirty: 'Unsaved changes. This window keeps your draft when you close Settings.',
      active: 'Git prompts enabled', paused: 'Git prompts paused', empty: 'No instructions configured', savedState: 'Saved status:',
      loading: 'Loading settings…', unavailable: 'Git prompt settings are unavailable. Any existing draft has been kept.',
      retry: 'Reload settings', reloading: 'Reloading…', readFailed: 'Could not read the latest settings. Your draft was kept.',
      saveFailed: 'Could not save. Your draft was kept. Reload settings before trying again.',
      conflict: 'Settings changed in another window or conversation. Saving is blocked to protect those changes. Load the latest settings to discard this draft.',
      latest: 'Load latest and discard draft', readonly: 'This connection cannot edit settings. You can read and copy the text, but cannot save changes.',
      counter: 'characters', draftKept: 'Your unsaved draft is still kept in this window.',
    };
    const zh = {
      nav: 'Git', title: 'Git 提示词', subtitle: '提交与 PR 规则按需加载，不常驻系统提示词。',
      enabled: '启用 Git 提示词', enabledHint: '暂停不会删除已保存的文字，暂停时仍可编辑。',
      commitLabel: '提交提示词', commitHint: '准备 commit 时使用的规则，可留空；默认不附加提交规则。',
      commitPlaceholder: '例如：使用 Conventional Commits，标题用中文精简说明。',
      prLabel: 'PR 提示词', prHint: '准备 Pull Request（合并请求）时使用的规则，可留空；默认不附加 PR 规则。',
      prPlaceholder: '例如：用中文简要说明改动、验证结果与风险。',
      when: '仅在助手调用 prepare_git_operation 准备 commit 或 pr 时，才交付对应正文；这些正文不是系统提示词。',
      scope: '保存的设置作用于当前配置文件（profile）。关闭设置或切换分类后，本窗口仍保留未保存的草稿；刷新页面则不会保留。',
      preparation: '启用且提交规则非空时，git_workbench(action=commit) 要求先准备，再由后续模型步骤重新生成提交调用，不能在准备的同一步提交。',
      coverage: '手工 Git 工作台按钮、任意 bash / gh 命令及 Forge 不会自动接入。这也不是提交或 PR 的格式校验器。',
      history: '已交付给模型的内容会保留在会话历史中；暂停或修改不会移除这些内容。',
      privacy: '正文会按需发送给模型，请勿填写密码、令牌等敏感信息。',
      save: '保存更改', saving: '正在保存…', discard: '放弃更改', saved: '已保存，下次准备 Git 操作时读取这些设置。',
      dirty: '有未保存的更改，关闭设置后本窗口仍保留草稿。',
      active: 'Git 提示词已启用', paused: 'Git 提示词已暂停', empty: '尚未设置提示词', savedState: '已保存的状态：',
      loading: '正在加载设置…', unavailable: 'Git 提示词设置暂不可用，已有草稿仍保留。',
      retry: '重新加载设置', reloading: '正在重新加载…', readFailed: '读取最新设置失败，草稿已保留。',
      saveFailed: '保存失败，草稿已保留。请重新加载设置后重试。',
      conflict: '设置已在其他窗口或会话中更改。为避免覆盖，已阻止保存；载入最新设置会放弃当前草稿。',
      latest: '载入最新设置并放弃草稿', readonly: '当前连接无权修改设置。可以阅读和复制正文，但无法保存更改。',
      counter: '字符', draftKept: '未保存的草稿仍保留在本窗口。',
    };
    const css = `
.dsh-git-prompts{font:inherit;font-size:14px;line-height:1.6;color:var(--dsw-alias-label-primary);max-width:760px;width:100%;min-width:0;padding:0 0 24px;box-sizing:border-box;overflow-wrap:anywhere}
.dsh-git-prompts *{box-sizing:border-box}.dsh-git-prompts h2{font-size:18px;line-height:1.4;font-weight:600;margin:0 0 6px}.dsh-git-prompts p{margin:0}.dsh-git-prompts-subtitle,.dsh-git-prompts-help{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.65}.dsh-git-prompts-subtitle{margin-bottom:20px!important}
.dsh-git-prompts-row{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:22px}.dsh-git-prompts-label{display:block;font-weight:500;margin-bottom:4px}.dsh-git-prompts-switch{flex:none;width:36px;height:20px;border:0;border-radius:999px;background:var(--dsw-alias-border-l2);padding:3px;cursor:pointer;display:flex;align-items:center}.dsh-git-prompts-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}.dsh-git-prompts-switch span{display:block;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base)}.dsh-git-prompts-switch[aria-checked=true] span{margin-left:auto}
.dsh-git-prompts-field{margin:0 0 22px}.dsh-git-prompts textarea{display:block;resize:vertical;width:100%;min-height:150px;max-height:70vh;margin-top:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;line-height:1.65}.dsh-git-prompts textarea::placeholder{color:var(--dsw-alias-label-secondary)}.dsh-git-prompts button{font:inherit}.dsh-git-prompts textarea:focus-visible,.dsh-git-prompts button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.dsh-git-prompts button:disabled{opacity:.5;cursor:not-allowed}.dsh-git-prompts textarea:read-only{background:var(--dsw-alias-bg-layer-1)}
.dsh-git-prompts-meta{display:flex;justify-content:flex-end;margin-top:6px;color:var(--dsw-alias-label-secondary);font-size:12px}.dsh-git-prompts-note{border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:1.7;margin:0 0 16px}.dsh-git-prompts-note p+p{margin-top:8px}.dsh-git-prompts-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:22px}.dsh-git-prompts-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 14px;min-height:34px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);cursor:pointer}.dsh-git-prompts-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.dsh-git-prompts-btn.primary{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}.dsh-git-prompts-status{font-size:13px;color:var(--dsw-alias-label-secondary);margin-top:14px!important;min-height:21px}.dsh-git-prompts-error{color:var(--dsw-alias-state-error-primary);font-size:13px;margin:14px 0!important;overflow-wrap:anywhere}.dsh-git-prompts-warning{color:var(--dsw-alias-state-warn-primary);font-size:13px;margin:14px 0!important}.dsh-git-prompts-success{color:var(--dsw-alias-state-success-primary)}
`;
    const fields = value => ({
      enabled: value.enabled,
      commitInstructions: value.commitInstructions,
      prInstructions: value.prInstructions,
    });
    const from = snapshot => ({...fields(snapshot.value), revision: snapshot.revision, original: fields(snapshot.value)});
    const changed = draft => Boolean(draft && ['enabled', 'commitInstructions', 'prInstructions'].some(key => draft[key] !== draft.original[key]));
    const errorText = error => typeof error === 'string' ? error : error?.message || String(error ?? '');
    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {en, zh}));
        const form = ctx.configForms.get(ENTRY);
        const mirror = ctx.configForms.describe();
        const t = ctx.locale.bind(NS);
        // This editor belongs to the plugin, not the section component: drafts and
        // in-flight writes survive section switches and closing the Settings panel.
        let editor = {draft: null, saving: false, reloading: false, error: null, message: ''};
        let disposed = false;
        const listeners = new Set();
        const subscribeEditor = listener => {listeners.add(listener); return () => listeners.delete(listener);};
        const getEditorSnapshot = () => editor;
        const subscribeForm = listener => form.subscribe(listener);
        const getFormSnapshot = () => form.getSnapshot();
        const subscribeMirror = listener => mirror.subscribe(listener);
        const getMirrorSnapshot = () => mirror.getSnapshot();
        const subscribeLocale = listener => ctx.locale.subscribe(listener);
        const getLocaleSnapshot = () => ctx.locale.getSnapshot();
        function update(patch) {
          if (disposed) return;
          editor = {...editor, ...patch};
          for (const listener of listeners) listener();
        }
        ctx.effect(() => () => {disposed = true; listeners.clear();});
        function sync() {
          const snapshot = form.getSnapshot();
          if (snapshot.status !== 'ready' || editor.saving) return;
          if (!editor.draft || (!changed(editor.draft) && snapshot.revision !== editor.draft.revision)) update({draft: from(snapshot)});
        }
        function edit(patch) {
          const snapshot = form.getSnapshot();
          if (!editor.draft || editor.saving || editor.reloading || snapshot.status !== 'ready' || !snapshot.writable) return;
          update({draft: {...editor.draft, ...patch}, error: null, message: ''});
        }
        function discard() {
          const snapshot = form.getSnapshot();
          if (editor.saving || editor.reloading || snapshot.status !== 'ready') return;
          update({draft: from(snapshot), error: null, message: ''});
        }
        async function reload() {
          if (editor.saving || editor.reloading) return;
          update({reloading: true, error: null, message: ''});
          try {
            await mirror.load();
            // The mirror reports read failures as a string; never discard a draft
            // just because a refresh completed with an error or stale values.
            if (!mirror.getSnapshot().error) sync();
          } catch (error) {
            update({error: {key: 'readFailed', detail: errorText(error)}});
          } finally {update({reloading: false});}
        }
        async function save() {
          const snapshot = form.getSnapshot();
          const draft = editor.draft;
          if (editor.saving || editor.reloading || !changed(draft) || snapshot.status !== 'ready' || !snapshot.writable ||
              snapshot.revision !== draft.revision || mirror.getSnapshot().error) return;
          update({saving: true, error: null, message: ''});
          try {
            const accepted = await form.mutate([
              {op: 'set', path: ['enabled'], value: draft.enabled},
              {op: 'set', path: ['commitInstructions'], value: draft.commitInstructions},
              {op: 'set', path: ['prInstructions'], value: draft.prInstructions},
            ], draft.revision);
            if (!accepted) {update({error: {key: 'saveFailed', detail: ''}}); return;}
            const next = form.getSnapshot();
            if (next.status !== 'ready') {update({error: {key: 'saveFailed', detail: ''}}); return;}
            update({draft: from(next), message: 'saved'});
          } catch (error) {
            update({error: {key: 'saveFailed', detail: errorText(error)}});
          } finally {update({saving: false});}
        }
        function GitPrompts() {
          React.useSyncExternalStore(subscribeLocale, getLocaleSnapshot);
          const snapshot = React.useSyncExternalStore(subscribeForm, getFormSnapshot);
          const mirrored = React.useSyncExternalStore(subscribeMirror, getMirrorSnapshot);
          const state = React.useSyncExternalStore(subscribeEditor, getEditorSnapshot);
          const id = React.useId();
          React.useEffect(() => {sync();}, [snapshot, state.saving]);
          const title = h(React.Fragment, null, h('h2', null, t('title')), h('p', {className: 'dsh-git-prompts-subtitle'}, t('subtitle')));
          const readError = mirrored.error ? errorText(mirrored.error) : '';
          const retryButton = h('button', {type: 'button', className: 'dsh-git-prompts-btn', disabled: state.saving || state.reloading, onClick: () => {void reload();}}, t(state.reloading ? 'reloading' : 'retry'));
          const failure = state.error && h('p', {className: 'dsh-git-prompts-error', role: 'alert'}, t(state.error.key), state.error.detail && ` ${state.error.detail}`);
          if (snapshot.status !== 'ready' || !state.draft) return h('section', {className: 'dsh-git-prompts', 'aria-label': t('title')}, h('style', null, css), title,
            h('p', {className: readError ? 'dsh-git-prompts-error' : 'dsh-git-prompts-help', role: readError ? 'alert' : 'status'}, readError ? `${t('readFailed')} ${readError}` : t(snapshot.status === 'unavailable' ? 'unavailable' : 'loading')),
            state.draft && changed(state.draft) && h('p', {className: 'dsh-git-prompts-help'}, t('draftKept')), failure,
            h('div', {className: 'dsh-git-prompts-actions'}, retryButton));
          const draft = state.draft;
          const dirty = changed(draft);
          const conflict = snapshot.revision !== draft.revision;
          const busy = state.saving || state.reloading;
          const savedStatus = !snapshot.value.enabled ? 'paused' : (snapshot.value.commitInstructions.trim() || snapshot.value.prInstructions.trim()) ? 'active' : 'empty';
          function textField(key, label, hint, placeholder) {
            const inputId = `${id}-${key}`;
            return h('div', {className: 'dsh-git-prompts-field'},
              h('label', {htmlFor: inputId, className: 'dsh-git-prompts-label'}, t(label)),
              h('p', {id: `${inputId}-hint`, className: 'dsh-git-prompts-help'}, t(hint)),
              h('textarea', {id: inputId, value: draft[key], placeholder: t(placeholder), rows: 7, maxLength: MAX, spellCheck: false,
                'aria-describedby': `${inputId}-hint ${inputId}-count ${id}-privacy`, readOnly: busy || !snapshot.writable,
                onChange: event => edit({[key]: event.target.value})}),
              h('div', {className: 'dsh-git-prompts-meta', id: `${inputId}-count`}, `${draft[key].length.toLocaleString()} / 20,000 ${t('counter')}`));
          }
          return h('form', {className: 'dsh-git-prompts', 'aria-label': t('title'), onSubmit: event => {event.preventDefault(); void save();}, onKeyDown: event => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {event.preventDefault(); event.stopPropagation(); void save();}
          }}, h('style', null, css), title,
            h('div', {className: 'dsh-git-prompts-note'}, h('p', null, t('when'))),
            h('div', {className: 'dsh-git-prompts-row'},
              h('div', null, h('span', {className: 'dsh-git-prompts-label', id: `${id}-enabled`}, t('enabled')),
                h('p', {className: 'dsh-git-prompts-help', id: `${id}-enabled-hint`}, t('enabledHint')),
                h('p', {className: 'dsh-git-prompts-help'}, t('savedState'), ' ', t(savedStatus))),
              h('button', {type: 'button', className: 'dsh-git-prompts-switch', role: 'switch', 'aria-checked': draft.enabled,
                'aria-labelledby': `${id}-enabled`, 'aria-describedby': `${id}-enabled-hint`, disabled: busy || !snapshot.writable,
                onClick: () => edit({enabled: !draft.enabled})}, h('span'))),
            textField('commitInstructions', 'commitLabel', 'commitHint', 'commitPlaceholder'),
            textField('prInstructions', 'prLabel', 'prHint', 'prPlaceholder'),
            h('div', {className: 'dsh-git-prompts-note'}, h('p', null, t('scope')), h('p', null, t('preparation')),
              h('p', {className: 'dsh-git-prompts-help'}, t('coverage')), h('p', {className: 'dsh-git-prompts-help'}, t('history'))),
            h('p', {className: 'dsh-git-prompts-help', id: `${id}-privacy`}, t('privacy')),
            !snapshot.writable && h('p', {className: 'dsh-git-prompts-warning', role: 'status'}, t('readonly')),
            conflict && !state.saving && h('p', {className: 'dsh-git-prompts-warning', role: 'alert'}, t('conflict')),
            readError && h(React.Fragment, null, h('p', {className: 'dsh-git-prompts-error', role: 'alert'}, t('readFailed'), ' ', readError), retryButton),
            failure,
            state.error && !readError && retryButton,
            h('div', {className: 'dsh-git-prompts-actions'},
              h('button', {type: 'submit', className: 'dsh-git-prompts-btn primary', disabled: busy || !dirty || conflict || !snapshot.writable || Boolean(readError)}, t(state.saving ? 'saving' : 'save')),
              h('button', {type: 'button', className: 'dsh-git-prompts-btn', disabled: busy || (!dirty && !conflict), onClick: discard}, t(conflict ? 'latest' : 'discard'))),
            h('p', {role: 'status', 'aria-live': 'polite', className: `dsh-git-prompts-status${state.message && !dirty ? ' dsh-git-prompts-success' : ''}`}, state.saving ? t('saving') : dirty ? t('dirty') : state.message ? t(state.message) : ''));
        }
        function GitIcon({size = 18}) {
          return h('svg', {width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false'},
            h('path', {d: 'M7 6v11M7 10h5a5 5 0 0 0 5-5'}),
            h('circle', {cx: 7, cy: 4, r: 2}), h('circle', {cx: 7, cy: 19, r: 2}), h('circle', {cx: 17, cy: 3, r: 2}));
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: ENTRY, order: 7, label: () => t('nav'), locale: NS,
        }, GitPrompts));
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon', id: ENTRY, locale: NS,
        }, GitIcon));
      },
    };
  },
});
