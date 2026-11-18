import { GitManager, READ_ACTIONS, normalizeAction, validateRequest } from './git.js';

export const inject = ['connection', 'sessionController', 'tools', 'subprocess', 'sandbox', 'sandboxPolicy', 'workingDirectory', 'approval'];

export const RPC_ENDPOINT = 'local-git-workbench/execute';

export const parameters = {
  type: 'object', additionalProperties: false, required: ['action'],
  properties: {
    action: {type: 'string', enum: ['summary', 'status', 'history', 'diff', 'stage', 'unstage', 'commit', 'switch', 'createBranch', 'deleteBranch', 'fetch', 'pull', 'push', 'stash', 'stashPop', 'merge', 'init'], description: 'status is a read-only alias of summary.'},
    repo: {type: 'string', maxLength: 4096, description: 'Absolute repository directory; defaults to the current session directory. init requires an explicit existing empty directory.'},
    paths: {type: 'array', minItems: 1, maxItems: 200, items: {type: 'string', maxLength: 4096}, description: 'Required for stage/unstage; optional for commit: 1–200 repository-relative literal paths, no traversal. With commit, stage these paths then commit ALL staged content under one approval (including any previously staged changes). Omit to commit only existing staged content. Use ["."] explicitly for all files.'},
    path: {type: 'string', maxLength: 4096, description: 'Repository-relative file path for diff, no traversal; omit for the full diff.'},
    staged: {type: 'boolean', description: 'For diff, compare staged changes against HEAD instead of the working tree.'},
    revision: {type: 'string', description: 'For diff, show a commit identified by a 7–64 character hexadecimal hash.'},
    message: {type: 'string', maxLength: 65536, description: 'Required nonblank commit message, or optional stash description (maximum 65536 characters).'},
    branch: {type: 'string', maxLength: 255, description: 'Local branch name for switch/createBranch/deleteBranch/merge (maximum 255 characters). Delete is non-forced.'},
    remote: {type: 'string', maxLength: 255, description: 'Existing remote name. Fetch defaults to origin or a sole remote; pull/push use the current upstream and reject other remotes.'},
    limit: {type: 'integer', minimum: 1, maximum: 200, description: 'History page size (1–200), default 60.'},
    skip: {type: 'integer', minimum: 0, maximum: 100000, description: 'Number of history commits to skip (0–100000), default 0.'}
  }
};

/** One application service shared by the sidebar's authenticated RPC and agent tool. */
export class GitWorkbenchService {
  constructor(ctx, lifetime) { this.ctx = ctx; this.lifetime = lifetime; this.tail = Promise.resolve(); }
  async execute(agent, request, signal, source = 'tool', callId) {
    if (!agent?.session) throw new Error('A live DSH session is required.');
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Expected a Git request object.');
    const action = normalizeAction(request.action);
    if (!parameters.properties.action.enum.includes(action)) throw new Error('Unsupported Git action.');
    for (const key of Object.keys(request)) if (key !== 'confirmed' && !Object.hasOwn(parameters.properties, key)) throw new Error(`Unexpected Git request field: ${key}`);
    const readOnly = READ_ACTIONS.has(action);
    const clean = structuredClone({...Object.fromEntries(Object.keys(parameters.properties).filter(key => request[key] !== undefined).map(key => [key, request[key]])), action});
    const operationSignal = AbortSignal.any([signal ?? new AbortController().signal, this.lifetime.signal, AbortSignal.timeout(120000)]);
    operationSignal.throwIfAborted();
    const cwd = await this.ctx.workingDirectory.ensure(agent, operationSignal);
    // Reject invalid requests before asking the user; no Git command or write has run.
    const checked = validateRequest(clean, cwd);
    if (!readOnly && source === 'tool') {
      const detail = JSON.stringify({...clean, repo: checked.cwd});
      const combinedCommit = action === 'commit' && clean.paths !== undefined;
      const outcome = await this.ctx.approval.request({agent, toolName: 'git_workbench', callId, signal: operationSignal,
        reason: combinedCommit ? `Stage the specified paths and commit ALL staged changes, including existing staged content, as one local operation: ${detail}` : `Git operation will modify repository or remote: ${detail}`,
        displayReason: {en: combinedCommit ? `Confirm once: stage the specified paths, then commit all staged changes (including existing staged content): ${detail}` : `Confirm Git operation: ${detail}`, zh: combinedCommit ? `一次确认：暂存指定路径后提交全部已暂存内容（包括原先已暂存的更改）：${detail}` : `确认 Git 仓库操作：${detail}`}});
      if (outcome !== 'allowed-once') throw new Error(`Git operation not approved (${outcome}).`);
    }
    if (!readOnly && source === 'ui' && request.confirmed !== true) throw new Error('Confirm this write operation in Git Workbench before continuing.');
    const execute = async () => {
      operationSignal.throwIfAborted();
      const executable = await this.ctx.subprocess.resolveExecutable('git', undefined, operationSignal);
      const policy = this.ctx.sandboxPolicy.resolve({session: agent.session});
      // Reads never acquire optional Git locks, and are confined read-only even in full-access sessions.
      const effective = readOnly ? {...policy, mode: 'read-only'} : policy;
      const run = async (directory, args, options = {}) => {
        const childSignal = AbortSignal.any([operationSignal, ...(options.signal ? [options.signal] : [])]);
        childSignal.throwIfAborted();
        let argv = [executable, '--no-pager', '--literal-pathspecs', '-c', 'color.ui=false', '-c', 'core.quotepath=false', ...args];
        if (effective.mode !== 'danger-full-access') argv = (await this.ctx.sandbox.confine(argv, effective, childSignal)).argv;
        const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !key.startsWith('GIT_') && value !== undefined));
        Object.assign(env, {GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: '', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no'});
        const child = this.ctx.subprocess.spawn({argv, cwd: directory, env, signal: childSignal, graceMs: 1000,
          stdio: {stdin: options.stdin === undefined ? 'ignore' : {data: options.stdin}, stdout: {maxBytes: 2 * 1024 * 1024}, stderr: {maxBytes: 128 * 1024}}});
        const result = await child.done;
        childSignal.throwIfAborted();
        const stdout = child.collected.stdout?.readFrom(0);
        const stderr = child.collected.stderr?.readFrom(0);
        const output = {stdout: stdout?.text ?? '', stderr: stderr?.text ?? '', exitCode: result.exitCode ?? -1, truncated: !!(stdout?.lossy || stderr?.lossy)};
        if (!(options.allowedExitCodes ?? [0]).includes(output.exitCode)) {
          const error = new Error(output.stderr.trim() || `git ${args[0]} failed (exit ${output.exitCode}${result.signal ? `, ${result.signal}` : ''}).`);
          Object.assign(error, {code: 'GIT_FAILED', ...output}); throw error;
        }
        return output;
      };
      return new GitManager(run).execute(clean, {cwd, signal: operationSignal});
    };
    // Serialize complete transactions, including reads, across all session and repository aliases.
    const pending = this.tail.then(execute, execute);
    this.tail = pending.catch(() => {});
    return pending;
  }
}

export function apply(ctx) {
  const lifetime = new AbortController();
  const service = new GitWorkbenchService(ctx, lifetime);
  ctx.effect(() => () => {lifetime.abort(new Error('Git Workbench unloaded')); return service.tail;});
  ctx.effect(() => ctx.reflect.provide('gitWorkbench', service));
  // Connection's exact /api routes apply Host/Origin/authentication and owner-only
  // admission before calling fetch. This does not replace the shared RPC interceptor.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/' + RPC_ENDPOINT, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let rpcId = '';
      let result;
      try {
        if (request.method !== 'POST' || request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          throw new Error('Expected a JSON POST request.');
        }
        const text = await request.text();
        if (text.length > 262144) throw new Error('Git request is too large.');
        const message = JSON.parse(text);
        if (!message || message.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== RPC_ENDPOINT) {
          throw new Error('Invalid Git Workbench RPC envelope.');
        }
        rpcId = message.rpcId;
        const payload = message.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || Object.keys(payload).some(key => key !== 'sessionId' && key !== 'request')
          || typeof payload.sessionId !== 'string' || !payload.sessionId.trim() || payload.sessionId.length > 256
          || !payload.request || typeof payload.request !== 'object' || Array.isArray(payload.request)) {
          throw new Error('Expected a sessionId and Git request object.');
        }
        const operationSignal = AbortSignal.any([request.signal, lifetime.signal]);
        operationSignal.throwIfAborted();
        const resolved = await ctx.sessionController.resolveAgent(payload.sessionId);
        if ('error' in resolved) throw resolved.error;
        operationSignal.throwIfAborted();
        result = {ok: true, value: await service.execute(resolved.agent, payload.request, operationSignal, 'ui')};
      } catch (error) {
        result = {ok: false, error: {code: 'git-workbench/error', message: error.message || String(error), details: {}}};
      }
      return Response.json({type: 'server-response', rpcId, result});
    }
  }));
  ctx.effect(() => ctx.tools.register({
    name: 'git_workbench',
    description: 'Inspect or manage Git repositories: summary/status, history, diffs, staging, commits, branches, remotes and stashes. For one local commit needing staging, use action=commit with paths and message: one approval covers staging the explicit paths and committing all staged content, including existing staged changes. Omit paths to commit only existing staged content. Other mutations retain separate approval; all actions respect the session sandbox. Pull is fast-forward-only; no forced push, hard reset or discard.',
    parameters,
    timeoutMs: 150000,
    isConcurrencySafe: () => false,
    output: {schema: {type: 'object', additionalProperties: true}, render: (_args, value) => [{type: 'text', text: JSON.stringify(value)}]},
    execute: (args, exec) => service.execute(exec.agent, args, exec.signal, 'tool', exec.callId)
  }));
}
