window.__ModuleLoader__.load({
  id: '@local/dsh-git-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'localGitWorkbench';
    const ID = '@local/dsh-git-manager';
    const KIND = 'local-git-workbench';
    const en = {
      title: 'Git Workbench', subtitle: 'Changes, commits and branches', open: 'Open Git Workbench',
      repository: 'Repository', current: 'Current session directory', choose: 'Choose repository', load: 'Open', refresh: 'Refresh',
      changes: 'Changes', history: 'History', branches: 'Branches', staged: 'Staged', unstaged: 'Working tree',
      stage: 'Stage', unstage: 'Unstage', stageAll: 'Stage all', unstageAll: 'Unstage all',
      clean: 'Working tree is clean', empty: 'No files in this group', filter: 'Filter files…',
      commit: 'Commit', commitMessage: 'Commit message', commitHint: 'Only staged changes will be committed. Local Git user.name and user.email are used.',
      fetch: 'Fetch', pull: 'Pull', push: 'Push', newBranch: 'New branch', branchName: 'Branch name',
      createBranch: 'Create branch', switch: 'Switch', deleteBranch: 'Delete branch', merge: 'Merge into current',
      localBranches: 'Local branches', remoteBranches: 'Remote branches', remotes: 'Remotes', stashes: 'Stashes',
      stash: 'Stash tracked changes', stashPop: 'Apply latest stash', stashHint: 'Stash excludes untracked files. Apply can produce conflicts.',
      currentBranch: 'Current', detached: 'Detached HEAD', unborn: 'No commits yet', upstream: 'Upstream',
      noUpstream: 'No upstream; configure tracking in Git before pulling or pushing.', noRemotes: 'No remotes configured',
      ahead: 'ahead', behind: 'behind', selectFile: 'Select a file to inspect its diff', diff: 'Diff', noDiff: 'No textual changes (or binary file).',
      truncated: 'Output limited for performance. Use Git locally for the complete diff.', conflicts: 'Conflicts',
      conflictHint: 'Resolve conflicts in your editor, then stage the resolved files.', loading: 'Loading…', running: 'Running…',
      noRepository: 'Open a Git repository', noRepositoryHint: 'Choose an existing repository or enter its absolute directory. Nothing is initialized automatically.',
      init: 'Initialize empty directory', initHint: 'Only an explicitly selected, existing empty directory can be initialized.',
      success: 'Git operation completed', confirm: 'Confirm Git operation', confirmHint: 'This changes repository or remote state. Session sandbox restrictions still apply.',
      confirmAction: 'Continue', cancel: 'Cancel', operation: 'Operation', files: 'files', more: 'Load older commits',
      noHistory: 'No commits', noBranches: 'No branches', noStashes: 'No stashes', file: 'File',
      safe: 'Safe defaults: fast-forward-only pull · no force push · no hard reset',
      permission: 'Writes outside the session workspace are refused by the sandbox. Open a DSH session in the target repository to manage it.',
      operationFailed: 'Operation failed', closeDiff: 'Close diff', selectedCommit: 'Commit details', author: 'Author',
      mergeHint: 'Merging may create a commit or conflicts. Save or stash local changes first.',
      confirm_stash: 'Store tracked changes in a stash; untracked files remain.',
      confirm_pull: 'Fetch and update the current branch only if it can fast-forward.',
      confirm_push: 'Push the current branch to its configured upstream (never force).',
      confirm_deleteBranch: 'Delete this local branch only if Git considers it safely merged.',
      confirm_stashPop: 'Apply the latest stash and remove it on success; conflicts may require manual resolution.'
    };
    const zh = {
      title: 'Git 工作台', subtitle: '更改、提交与分支管理', open: '打开 Git 工作台',
      repository: '仓库', current: '当前会话目录', choose: '选择仓库', load: '打开', refresh: '刷新',
      changes: '文件状态', history: '提交历史', branches: '分支管理', staged: '已暂存', unstaged: '工作区',
      stage: '暂存', unstage: '取消暂存', stageAll: '全部暂存', unstageAll: '全部取消暂存',
      clean: '工作区干净，所有更改均已提交', empty: '此分组暂无文件', filter: '筛选文件…',
      commit: '提交', commitMessage: '提交说明', commitHint: '仅提交已暂存的更改，使用本地 Git 的 user.name 与 user.email。',
      fetch: '获取', pull: '拉取', push: '推送', newBranch: '新建分支', branchName: '分支名称',
      createBranch: '创建分支', switch: '切换', deleteBranch: '删除分支', merge: '合并到当前分支',
      localBranches: '本地分支', remoteBranches: '远程分支', remotes: '远端', stashes: '储藏',
      stash: '储藏已跟踪更改', stashPop: '应用最新储藏', stashHint: '储藏不包含未跟踪文件；应用储藏可能产生冲突。',
      currentBranch: '当前', detached: '分离 HEAD', unborn: '尚无提交', upstream: '上游',
      noUpstream: '未配置上游，请先用 Git 设置跟踪分支后再拉取或推送。', noRemotes: '尚未配置远端',
      ahead: '领先', behind: '落后', selectFile: '选择文件查看差异', diff: '差异', noDiff: '暂无文本差异（也可能是二进制文件）。',
      truncated: '为保证性能，差异内容已截断；请在本地 Git 查看完整内容。', conflicts: '冲突',
      conflictHint: '请在编辑器中解决冲突，再暂存已解决的文件。', loading: '正在加载…', running: '正在执行…',
      noRepository: '打开一个 Git 仓库', noRepositoryHint: '选择已有仓库，或输入仓库的绝对目录。插件不会自动初始化。',
      init: '初始化空目录', initHint: '仅允许初始化明确选择的、已经存在的空目录。',
      success: 'Git 操作已完成', confirm: '确认 Git 操作', confirmHint: '此操作会更改仓库或远端状态，仍受当前会话沙箱权限限制。',
      confirmAction: '确认执行', cancel: '取消', operation: '操作', files: '个文件', more: '加载更早提交',
      noHistory: '暂无提交', noBranches: '暂无分支', noStashes: '暂无储藏', file: '文件',
      safe: '安全默认：仅快进拉取 · 禁止强制推送 · 无硬重置',
      permission: '会话工作区以外的写入会被沙箱拒绝。如需管理其他仓库，请在该仓库中打开 DSH 会话。',
      operationFailed: '操作失败', closeDiff: '关闭差异', selectedCommit: '提交详情', author: '作者',
      mergeHint: '合并可能创建提交或产生冲突，请先保存或储藏本地更改。',
      confirm_stash: '储藏已跟踪文件的更改，未跟踪文件保持不变。',
      confirm_pull: '获取远程更新，仅当能够快进时更新当前分支。',
      confirm_push: '将当前分支推送到已配置的上游，绝不强制推送。',
      confirm_deleteBranch: '仅在 Git 判定分支已安全合并时删除本地分支。',
      confirm_stashPop: '应用最新储藏，成功后删除该条储藏；可能需要手动解决冲突。'
    };
    const css = `
.gwb{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.5;container-type:inline-size}
.gwb *{box-sizing:border-box}.gwb button,.gwb input,.gwb textarea{font:inherit;color:inherit}.gwb button{cursor:pointer}.gwb button:disabled{opacity:.45;cursor:not-allowed}.gwb button:focus-visible,.gwb input:focus-visible,.gwb textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.gwb-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:5px 10px;display:inline-flex;gap:5px;align-items:center;justify-content:center;white-space:nowrap;line-height:1.4;min-height:30px}.gwb-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.gwb-btn.primary{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}.gwb-btn.danger{color:var(--dsw-alias-state-error-primary)}.gwb-btn.small{padding:2px 7px;min-height:25px;font-size:12px}.gwb-btn.ghost{border-color:transparent;background:none}
.gwb-head{padding:16px 16px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}.gwb-row{display:flex;align-items:center;gap:8px}.gwb-row.wrap{flex-wrap:wrap}.gwb-between{justify-content:space-between}.gwb-title{font-size:15px;font-weight:600;margin:0}.gwb-muted{color:var(--dsw-alias-label-secondary);font-size:12px}.gwb-path{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;margin:7px 0;font:11px/1.6 ui-monospace,monospace;color:var(--dsw-alias-label-secondary)}.gwb-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:12px;max-width:100%;overflow-wrap:anywhere}.gwb-pill.accent{color:var(--dsw-alias-brand-primary)}.gwb-input{width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:7px 9px}.gwb-repo{margin-top:10px}.gwb-toolbar{margin-top:12px;gap:6px;flex-wrap:wrap}.gwb-tabs{padding:0 14px;display:flex;gap:16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}.gwb-tab{border:0;border-bottom:2px solid transparent;background:none;color:var(--dsw-alias-label-secondary);padding:11px 2px;font:inherit;white-space:nowrap}.gwb-tab[aria-selected=true]{border-bottom-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}.gwb-scroll{overflow:auto;min-height:0;flex:1}.gwb-section{padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}.gwb-section h3{font-size:12px;margin:0;font-weight:600}.gwb-section-head{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:9px}.gwb-count{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:6px}.gwb-files{margin:0 -8px}.gwb-file{display:flex;align-items:center;gap:6px;border-radius:7px;padding:3px 6px;min-height:34px}.gwb-file.active,.gwb-file:hover{background:var(--dsw-alias-bg-layer-2)}.gwb-file-name{min-width:0;flex:1;text-align:left;border:0;background:none;padding:4px 0;color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:pre;font:12px/1.5 ui-monospace,monospace;cursor:pointer}.gwb-status{font:600 11px/1 ui-monospace,monospace;color:var(--dsw-alias-state-warn-primary);min-width:17px}.gwb-status.add{color:var(--dsw-alias-state-success-primary)}.gwb-status.del{color:var(--dsw-alias-state-error-primary)}.gwb-status.conflict{color:var(--dsw-alias-state-error-primary)}.gwb-empty{padding:22px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}.gwb-hero{padding:40px 24px;text-align:center}.gwb-hero svg{color:var(--dsw-alias-brand-primary);margin-bottom:14px}.gwb-hero h2{font-size:16px;font-weight:600;margin:0 0 8px}.gwb-hero p{max-width:340px;margin:0 auto 16px}.gwb-commit textarea{min-height:80px;resize:vertical}.gwb-hint{font-size:11px;color:var(--dsw-alias-label-secondary);margin:8px 0}.gwb-notice{padding:9px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;overflow-wrap:anywhere;flex:none}.gwb-notice.error{color:var(--dsw-alias-state-error-primary)}.gwb-notice.success{color:var(--dsw-alias-state-success-primary)}.gwb-confirm{background:var(--dsw-alias-bg-layer-2);padding:14px;border-bottom:1px solid var(--dsw-alias-border-l2)}.gwb-confirm h3{font-size:13px;margin:0 0 7px}.gwb-confirm code{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.gwb-confirm .gwb-row{margin-top:12px;justify-content:flex-end}.gwb-detail{border-top:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;flex:0 1 48%;min-height:160px;max-height:55%;background:var(--dsw-alias-bg-layer-1)}.gwb-detail-head{padding:8px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex:none;font-size:12px}.gwb-detail-title{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}.gwb-diff{margin:0;overflow:auto;font:11px/1.65 ui-monospace,SFMono-Regular,monospace;flex:1;tab-size:4}.gwb-line{display:flex;min-width:max-content;padding-right:12px}.gwb-line.add{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,var(--dsw-alias-bg-layer-1))}.gwb-line.del{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,var(--dsw-alias-bg-layer-1))}.gwb-line.hunk{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}.gwb-line-num{width:40px;text-align:right;padding-right:8px;color:var(--dsw-alias-label-secondary);user-select:none;flex:none}.gwb-line-code{white-space:pre}.gwb-history-row{display:flex;align-items:stretch;width:100%;text-align:left;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:none;padding:0 12px;color:inherit;min-height:50px}.gwb-history-row:hover,.gwb-history-row.active{background:var(--dsw-alias-bg-layer-2)}.gwb-graph{flex:none;overflow:visible}.gwb-history-copy{min-width:0;padding:6px 0 6px 8px;flex:1}.gwb-subject{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;display:block}.gwb-meta{display:block;color:var(--dsw-alias-label-secondary);font-size:10px;margin-top:3px}.gwb-ref{color:var(--dsw-alias-brand-primary);font-size:10px;margin-right:6px}.gwb-branch{padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;gap:7px;flex-wrap:wrap}.gwb-branch:last-child{border:0}.gwb-branch-name{flex:1;min-width:90px;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,monospace}.gwb-footer{padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:10px;color:var(--dsw-alias-label-secondary);flex:none}.gwb-guide{width:100%;padding:16px 20px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);border-radius:20px;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:12px;text-align:left;font:inherit;cursor:pointer}.gwb-guide:hover{background:var(--dsw-alias-bg-layer-2)}.gwb-guide strong{font-size:14px;font-weight:500}.gwb-guide small{display:block;color:var(--dsw-alias-label-secondary);font-size:12px}
@container (max-width:380px){.gwb-head,.gwb-section{padding-left:12px;padding-right:12px}.gwb-tabs{gap:12px}.gwb-btn{padding-left:7px;padding-right:7px}.gwb-toolbar .gwb-btn{font-size:12px}}
`;
    function GitIcon({size = 20}) {
      return h('svg', {width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', 'aria-hidden': true},
        h('path', {d: 'M7 6v12M7 13c0-6 10-2 10-7'}),
        ...[[7,4],[7,20],[17,4]].map(([cx,cy]) => h('circle', {key: `${cx}-${cy}`, cx, cy, r: 2.4})));
    }
    function buildGraph(commits) {
      let lanes = [];
      return commits.map(commit => {
        let index = lanes.indexOf(commit.hash);
        if (index < 0) {index = lanes.length; lanes.push(commit.hash);}
        const before = [...lanes];
        const after = [...lanes];
        after.splice(index, 1);
        for (let p = 0; p < commit.parents.length; p++) {
          if (!after.includes(commit.parents[p])) after.splice(Math.min(index + p, after.length), 0, commit.parents[p]);
        }
        const edges = before.flatMap((hash, lane) => hash === commit.hash
          ? commit.parents.map(parent => ({from: lane, to: after.indexOf(parent), node: true}))
          : [{from: lane, to: after.indexOf(hash), node: false}]);
        lanes = after;
        return {commit, index, edges, width: Math.max(1, before.length, after.length) * 12 + 8};
      });
    }
    function DiffView({value, title, loading, close, t}) {
      let oldLine = 0, newLine = 0;
      const lines = (value?.text || '').split('\n');
      const clipped = value?.truncated || lines.length > 2000;
      return h('section', {className: 'gwb-detail', 'aria-label': t('diff')},
        h('div', {className: 'gwb-detail-head'}, h('strong', {className: 'gwb-detail-title'}, title), h('button', {className: 'gwb-btn small ghost', onClick: close, 'aria-label': t('closeDiff')}, '×')),
        loading ? h('div', {className: 'gwb-empty', role: 'status'}, t('loading')) :
          value?.text ? h('pre', {className: 'gwb-diff', tabIndex: 0}, lines.slice(0, 2000).map((line, i) => {
            const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
            let a = '', b = '', kind = '';
            if (match) {oldLine = +match[1]; newLine = +match[2]; kind = 'hunk';}
            else if (line.startsWith('+') && !line.startsWith('+++')) {b = newLine++; kind = 'add';}
            else if (line.startsWith('-') && !line.startsWith('---')) {a = oldLine++; kind = 'del';}
            else if (line.startsWith(' ') && oldLine) {a = oldLine++; b = newLine++;}
            return h('span', {key: i, className: `gwb-line ${kind}`}, h('span', {className: 'gwb-line-num'}, a), h('span', {className: 'gwb-line-num'}, b), h('span', {className: 'gwb-line-code'}, line || ' '));
          })) : h('div', {className: 'gwb-empty'}, t('noDiff')),
        clipped && h('div', {className: 'gwb-notice'}, t('truncated')));
    }
    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'connection', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {en, zh}));
        const t = ctx.locale.bind(NS);
        function useText() {
          React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
          return t;
        }
        async function call(sessionId, request, signal) {
          signal?.throwIfAborted();
          const response = await ctx.connection.rpc.call('/api', 'local-git-workbench/execute', {sessionId, request}, signal);
          if (!response.ok) throw new Error(response.error?.message || t('operationFailed'));
          if (!response.value) throw new Error(t('operationFailed'));
          return response.value;
        }
        function Body(props) {
          const text = useText();
          const info = props.useTabInfo();
          const [repo, setRepo] = React.useState('');
          const [repoInput, setRepoInput] = React.useState('');
          const [summary, setSummary] = React.useState(null);
          const [view, setView] = React.useState('changes');
          const [history, setHistory] = React.useState({commits: [], hasMore: false});
          const [filter, setFilter] = React.useState('');
          const [message, setMessage] = React.useState('');
          const [branch, setBranch] = React.useState('');
          const [busy, setBusy] = React.useState(false);
          const [notice, setNotice] = React.useState(null);
          const [pending, setPending] = React.useState(null);
          const [selected, setSelected] = React.useState(null);
          const [diff, setDiff] = React.useState(null);
          const [diffLoading, setDiffLoading] = React.useState(false);
          const epoch = React.useRef(0);
          const controllers = React.useRef(new Set());
          const busyRef = React.useRef(false);
          const diffEpoch = React.useRef(0);
          const mounted = React.useRef(true);
          const sessionId = props.sessionId;
          function control() {
            const controller = new AbortController(); controllers.current.add(controller); return controller;
          }
          async function refresh(target = repo, historyToo = view === 'history') {
            const version = ++epoch.current;
            const controller = control();
            setBusy(true); busyRef.current = true;
            try {
              const next = await call(sessionId, {action: 'summary', ...(target ? {repo: target} : {})}, controller.signal);
              if (!mounted.current || version !== epoch.current) return;
              setSummary(next);
              if (historyToo) {
                const nextHistory = await call(sessionId, {action: 'history', repo: next.repo, limit: 60}, controller.signal);
                if (mounted.current && version === epoch.current) setHistory(nextHistory);
              }
            } catch (error) {
              if (!controller.signal.aborted && mounted.current && version === epoch.current) {setSummary(null); setNotice({error: true, text: error.message});}
            } finally {
              controllers.current.delete(controller);
              if (mounted.current && version === epoch.current) {setBusy(false); busyRef.current = false;}
            }
          }
          React.useEffect(() => {
            mounted.current = true;
            return () => {mounted.current = false; ++epoch.current; ++diffEpoch.current; for (const c of controllers.current) c.abort(); controllers.current.clear();};
          }, []);
          React.useEffect(() => {
            setSelected(null); setDiff(null); setNotice(null); setSummary(null); setPending(null); setHistory({commits: [], hasMore: false});
            refresh(repo);
            return () => {++epoch.current; ++diffEpoch.current; for (const c of controllers.current) c.abort();};
          }, [repo, sessionId]);
          React.useEffect(() => {
            if (info.tab.actions.bindCommands) return info.tab.actions.bindCommands({refresh: () => refresh()});
          }, [repo, sessionId, view, info.tab.actions]);
          function ask(action, extra = {}) {
            if (busyRef.current) return;
            setNotice(null); setPending({action, ...(summary?.repo ? {repo: summary.repo} : repo ? {repo} : {}), ...extra});
          }
          async function perform() {
            if (!pending || busyRef.current) return;
            const request = {...pending, confirmed: true};
            setPending(null); setBusy(true); busyRef.current = true;
            const version = ++epoch.current; ++diffEpoch.current;
            const controller = control();
            let resultNotice;
            try {
              await call(sessionId, request, controller.signal);
              if (!mounted.current || controller.signal.aborted || epoch.current !== version) return;
              if (request.action === 'commit') setMessage('');
              if (request.action === 'createBranch') setBranch('');
              setSelected(null); setDiff(null);
              resultNotice = {error: false, text: text('success')};
            } catch (error) {resultNotice = {error: true, text: error.message};}
            finally {
              controllers.current.delete(controller);
              if (mounted.current && !controller.signal.aborted && epoch.current === version) {
                await refresh();
                if (mounted.current && !controller.signal.aborted && epoch.current === version + 1) setNotice(resultNotice);
              }
            }
          }
          async function showDiff(selection) {
            const version = ++diffEpoch.current;
            setSelected(selection); setDiff(null); setDiffLoading(true);
            const controller = control();
            try {
              const value = await call(sessionId, {action: 'diff', repo: summary.repo, ...(selection.hash ? {revision: selection.hash} : {path: selection.path, staged: selection.staged})}, controller.signal);
              if (mounted.current && version === diffEpoch.current) setDiff(value);
            } catch (error) {if (!controller.signal.aborted && mounted.current && version === diffEpoch.current) setNotice({error: true, text: error.message});}
            finally {controllers.current.delete(controller); if (mounted.current && version === diffEpoch.current) setDiffLoading(false);}
          }
          async function choose() {
            try {
              const directory = await ctx.uiWorkspace.pickDirectory();
              if (directory) {setRepoInput(directory); setRepo(directory);}
            } catch (error) {setNotice({error: true, text: error.message});}
          }
          async function changeView(next) {
            setView(next); setSelected(null); ++diffEpoch.current;
            if (next === 'history' && summary && !busyRef.current) await refresh(repo, true);
          }
          async function loadMore() {
            if (busyRef.current || !summary) return;
            setBusy(true); busyRef.current = true;
            const version = epoch.current; const controller = control();
            try {
              const value = await call(sessionId, {action: 'history', repo: summary.repo, skip: history.commits.length, limit: 60}, controller.signal);
              if (mounted.current && epoch.current === version) setHistory(prev => ({commits: [...prev.commits, ...value.commits], hasMore: value.hasMore}));
            } catch (error) {if (!controller.signal.aborted && mounted.current) setNotice({error: true, text: error.message});}
            finally {controllers.current.delete(controller); if (mounted.current && version === epoch.current) {setBusy(false); busyRef.current = false;}}
          }
          function button(key, onClick, disabled = false, extra = {}) {
            return h('button', {type: 'button', className: 'gwb-btn small', onClick, disabled: busy || disabled, ...extra}, text(key));
          }
          function fileGroup(staged) {
            const all = (summary?.files || []).filter(file => staged ? file.staged : file.unstaged || file.untracked || file.conflict);
            const files = all.filter(file => file.path.toLowerCase().includes(filter.toLowerCase()));
            return h('section', {className: 'gwb-section', key: staged ? 'staged' : 'unstaged'},
              h('div', {className: 'gwb-section-head'}, h('h3', null, text(staged ? 'staged' : 'unstaged'), h('span', {className: 'gwb-count'}, all.length)),
                button(staged ? 'unstageAll' : 'stageAll', () => ask(staged ? 'unstage' : 'stage', {paths: ['.']}), !all.length)),
              !files.length ? h('div', {className: 'gwb-empty'}, text('empty')) : h('div', {className: 'gwb-files'}, files.map(file => {
                const status = file.conflict ? 'UU' : file.untracked ? '?' : staged ? file.index : file.worktree;
                return h('div', {key: file.path, className: `gwb-file ${selected?.path === file.path && selected?.staged === staged ? 'active' : ''}`},
                  h('span', {className: `gwb-status ${file.conflict ? 'conflict' : /A|\?/.test(status) ? 'add' : /D/.test(status) ? 'del' : ''}`}, status),
                  h('button', {className: 'gwb-file-name', title: file.originalPath ? `${file.originalPath} → ${file.path}` : file.path, onClick: () => showDiff({path: file.path, staged})}, file.path),
                  button(staged ? 'unstage' : 'stage', () => ask(staged ? 'unstage' : 'stage', {paths: [file.path]})));
              })));
          }
          const graph = buildGraph(history.commits);
          const graphWidth = Math.max(22, ...graph.map(row => row.width));
          const conflicts = summary?.files.filter(file => file.conflict).length || 0;
          const tabId = `gwb-${sessionId}-${info.tab.id}`;
          return h('div', {className: 'gwb', 'aria-label': text('title'), 'aria-busy': busy},
            h('style', null, css),
            h('header', {className: 'gwb-head'},
              h('div', {className: 'gwb-row gwb-between'}, h('div', {className: 'gwb-row'}, h(GitIcon), h('h2', {className: 'gwb-title'}, text('title'))), button('refresh', () => {setNotice(null); refresh();})),
              h('span', {className: 'gwb-path', title: summary?.repo || repo || text('current')}, summary?.repo || repo || text('current')),
              summary && h('div', {className: 'gwb-row wrap'}, h('span', {className: 'gwb-pill accent'}, h(GitIcon, {size: 13}), summary.branch || text('detached')),
                h('span', {className: 'gwb-muted'}, summary.head ? summary.head.slice(0, 8) : text('unborn')),
                !!summary.ahead && h('span', {className: 'gwb-pill'}, `↑ ${summary.ahead} ${text('ahead')}`),
                !!summary.behind && h('span', {className: 'gwb-pill'}, `↓ ${summary.behind} ${text('behind')}`)),
              h('form', {className: 'gwb-row gwb-repo', onSubmit: event => {event.preventDefault(); if (!busyRef.current) {const next = repoInput.trim(); if (next === repo) refresh(); else setRepo(next);}}},
                h('input', {className: 'gwb-input', value: repoInput, onChange: event => setRepoInput(event.target.value), placeholder: text('current'), 'aria-label': text('repository'), disabled: busy}),
                button('load', undefined, false, {type: 'submit'}), button('choose', choose)),
              summary && h('div', {className: 'gwb-row gwb-toolbar'},
                button('fetch', () => ask('fetch'), !summary.remotes.length),
                button('pull', () => ask('pull'), !summary.upstream, {title: summary.upstream || text('noUpstream')}),
                button('push', () => ask('push'), !summary.upstream, {title: summary.upstream || text('noUpstream')}),
                button('stash', () => ask('stash'), !summary.files.some(file => !file.untracked && (file.staged || file.unstaged))))),
            notice && h('div', {className: `gwb-notice ${notice.error ? 'error' : 'success'}`, role: notice.error ? 'alert' : 'status'}, notice.text),
            pending && h('section', {className: 'gwb-confirm', role: 'group', 'aria-label': text('confirm'), onKeyDown: event => {if (event.key === 'Escape') setPending(null);}},
              h('h3', null, text('confirm')), h('p', {className: 'gwb-hint'}, text('confirmHint')),
              h('code', null, `${text(pending.action)} · ${pending.repo || text('current')}${pending.branch ? `\n${pending.branch}` : ''}${pending.paths ? `\n${pending.paths.length} ${text('files')}: ${pending.paths.slice(0, 8).map(path => JSON.stringify(path)).join(', ')}${pending.paths.length > 8 ? '…' : ''}` : ''}${pending.message ? `\n${pending.message}` : ''}`),
              ['stash','pull','push','deleteBranch','stashPop'].includes(pending.action) && h('p', {className: 'gwb-hint'}, text('confirm_' + pending.action)),
              pending.action === 'merge' && h('p', {className: 'gwb-hint'}, text('mergeHint')),
              h('div', {className: 'gwb-row'}, button('cancel', () => setPending(null)), button('confirmAction', perform, false, {className: 'gwb-btn small primary', autoFocus: true}))),
            summary && h('div', {className: 'gwb-tabs', role: 'tablist', 'aria-label': text('title')}, ['changes','history','branches'].map(key => h('button', {key, id: `${tabId}-${key}`, type: 'button', role: 'tab', 'aria-selected': view === key, 'aria-controls': `${tabId}-panel`, className: 'gwb-tab', onClick: () => changeView(key), onKeyDown: event => {if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {event.preventDefault(); const keys = ['changes','history','branches']; const next = keys[(keys.indexOf(key) + (event.key === 'ArrowRight' ? 1 : 2)) % 3]; changeView(next); event.currentTarget.parentElement.querySelector(`[id="${tabId}-${next}"]`)?.focus();}}}, text(key), key === 'changes' ? ` (${summary.files.length})` : ''))),
            h('div', {className: 'gwb-scroll', id: `${tabId}-panel`, role: summary ? 'tabpanel' : undefined, 'aria-labelledby': summary ? `${tabId}-${view}` : undefined},
              !summary ? h('div', {className: 'gwb-hero'}, h(GitIcon, {size: 42}), h('h2', null, busy ? text('loading') : text('noRepository')),
                h('p', {className: 'gwb-muted'}, text('noRepositoryHint')), button('choose', choose),
                repo && h('div', {style: {marginTop: 16}}, button('init', () => ask('init', {repo})), h('p', {className: 'gwb-hint'}, text('initHint')))) :
              view === 'changes' ? h(React.Fragment, null,
                conflicts > 0 && h('div', {className: 'gwb-notice error'}, `${conflicts} ${text('conflicts')} · ${text('conflictHint')}`),
                h('div', {className: 'gwb-section'}, h('input', {className: 'gwb-input', value: filter, onChange: event => setFilter(event.target.value), placeholder: text('filter'), 'aria-label': text('filter')})),
                !summary.files.length && h('div', {className: 'gwb-empty'}, '✓ ', text('clean')),
                fileGroup(true), fileGroup(false),
                h('section', {className: 'gwb-section gwb-commit'}, h('label', {htmlFor: `${tabId}-message`, className: 'gwb-section-head'}, text('commitMessage')),
                  h('textarea', {id: `${tabId}-message`, className: 'gwb-input', value: message, onChange: event => setMessage(event.target.value), placeholder: text('commitMessage'), disabled: busy}),
                  h('p', {className: 'gwb-hint'}, text('commitHint')),
                  h('div', {className: 'gwb-row gwb-between'}, h('span', {className: 'gwb-muted'}, `${summary.files.filter(file => file.staged).length} ${text('files')}`), button('commit', () => ask('commit', {message: message.trim()}), !message.trim() || !summary.files.some(file => file.staged) || conflicts > 0, {className: 'gwb-btn primary'})))) :
              view === 'history' ? h(React.Fragment, null,
                !history.commits.length && h('div', {className: 'gwb-empty'}, busy ? text('loading') : text('noHistory')),
                graph.map(({commit, index, edges}) => h('button', {key: commit.hash, className: `gwb-history-row ${selected?.hash === commit.hash ? 'active' : ''}`, onClick: () => showDiff({hash: commit.hash, subject: commit.subject}), title: `${commit.hash}\n${commit.subject}\n${commit.author} · ${commit.date}`},
                  h('svg', {className: 'gwb-graph', width: graphWidth, height: 50, viewBox: `0 0 ${graphWidth} 50`, 'aria-hidden': true},
                    ...edges.map((edge, i) => h('path', {key: i, d: edge.node ? `M ${8 + edge.from * 12} 25 C ${8 + edge.from * 12} 40, ${8 + edge.to * 12} 36, ${8 + edge.to * 12} 50` : `M ${8 + edge.from * 12} 0 C ${8 + edge.from * 12} 26, ${8 + edge.to * 12} 24, ${8 + edge.to * 12} 50`, stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1.5, fill: 'none'})),
                    h('path', {d: `M ${8 + index * 12} 0 V 25`, stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1.5}),
                    h('circle', {cx: 8 + index * 12, cy: 25, r: 3.5, fill: 'var(--dsw-alias-bg-base)', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1.6})),
                  h('span', {className: 'gwb-history-copy'}, h('span', {className: 'gwb-subject'}, commit.refs && h('span', {className: 'gwb-ref'}, commit.refs), commit.subject), h('span', {className: 'gwb-meta'}, `${commit.shortHash} · ${commit.author} · ${commit.date.slice(0, 10)}`)))),
                history.hasMore && h('div', {className: 'gwb-empty'}, button('more', loadMore))) :
              h(React.Fragment, null,
                h('section', {className: 'gwb-section'}, h('div', {className: 'gwb-section-head'}, h('h3', null, text('newBranch'))),
                  h('div', {className: 'gwb-row'}, h('input', {className: 'gwb-input', value: branch, onChange: event => setBranch(event.target.value), placeholder: text('branchName'), 'aria-label': text('branchName'), disabled: busy}), button('createBranch', () => ask('createBranch', {branch: branch.trim()}), !branch.trim() || !summary.head))),
                ...[false, true].map(remote => h('section', {key: String(remote), className: 'gwb-section'}, h('div', {className: 'gwb-section-head'}, h('h3', null, text(remote ? 'remoteBranches' : 'localBranches'))),
                  !summary.branches.some(item => item.remote === remote) && h('div', {className: 'gwb-empty'}, text('noBranches')),
                  ...summary.branches.filter(item => item.remote === remote).map(item => h('div', {className: 'gwb-branch', key: item.name},
                    h('div', {className: 'gwb-branch-name'}, item.current ? '● ' : '⑂ ', item.name, item.upstream && h('div', {className: 'gwb-muted'}, `${text('upstream')}: ${item.upstream}`)),
                    item.current ? h('span', {className: 'gwb-pill accent'}, text('currentBranch')) : !remote && h(React.Fragment, null,
                      button('switch', () => ask('switch', {branch: item.name})), button('merge', () => ask('merge', {branch: item.name})), button('deleteBranch', () => ask('deleteBranch', {branch: item.name}), false, {className: 'gwb-btn small danger'})))))),
                h('section', {className: 'gwb-section'}, h('div', {className: 'gwb-section-head'}, h('h3', null, text('remotes'))),
                  !summary.remotes.length ? h('div', {className: 'gwb-empty'}, text('noRemotes')) : summary.remotes.map(remote => h('div', {className: 'gwb-branch', key: remote.name}, h('strong', null, remote.name), h('span', {className: 'gwb-path', title: remote.url}, remote.url), button('fetch', () => ask('fetch', {remote: remote.name}))))),
                h('section', {className: 'gwb-section'}, h('div', {className: 'gwb-section-head'}, h('h3', null, text('stashes'), h('span', {className: 'gwb-count'}, summary.stashes.length)), button('stashPop', () => ask('stashPop'), !summary.stashes.length)),
                  h('p', {className: 'gwb-hint'}, text('stashHint')),
                  !summary.stashes.length ? h('div', {className: 'gwb-empty'}, text('noStashes')) : summary.stashes.map(stash => h('div', {className: 'gwb-branch', key: stash.ref}, h('span', {className: 'gwb-branch-name'}, stash.ref, h('div', {className: 'gwb-muted'}, stash.subject))))),
                h('p', {className: 'gwb-section gwb-hint'}, text('permission')))),
            selected && h(DiffView, {value: diff, title: selected.hash ? `${selected.hash.slice(0,8)} · ${selected.subject}` : `${selected.path} · ${text(selected.staged ? 'staged' : 'unstaged')}`, loading: diffLoading, close: () => {++diffEpoch.current; setSelected(null);}, t: text}),
            h('footer', {className: 'gwb-footer', role: 'status'}, busy ? text('running') : text('safe')));
        }
        ctx.effect(() => ctx.sidebarRightTabs.register({id: ID, kind: KIND, title: () => t('title'), keepMounted: true,
          guide: [{id: 'git', title: () => t('title'), description: () => t('subtitle'), icon: GitIcon, order: 35}]}));
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({name: 'sidebar.right.pane.tab', key: ID, locale: NS}, Body));
      }
    };
  }
});
