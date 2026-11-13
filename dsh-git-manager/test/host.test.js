import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { apply, GitWorkbenchService, parameters, RPC_ENDPOINT } from '../index.js';

// These are real-Git adapter integration tests, NOT the live DSH tools pipeline,
// HTTP transport/authentication, approval audit service, or an enforcing OS sandbox test.
const workspace = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const execFileAsync = promisify(execFile);
const cleanEnvironment = () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
};
async function git(cwd, ...args) {
  return (await execFileAsync('git', ['--no-pager', ...args], { cwd, env: cleanEnvironment(), encoding: 'utf8' })).stdout;
}

async function fixture(body) {
  const root = await mkdtemp(path.join(workspace, '.dsh-git-host-'));
  const token = randomUUID();
  const marker = path.join(root, '.host-test-owner');
  await writeFile(marker, token);
  const harnesses = [];
  try {
    const repo = path.join(root, 'repo');
    await mkdir(repo);
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.name', 'Host Integration');
    await git(repo, 'config', 'user.email', 'host-integration@example.invalid');
    await git(repo, 'config', 'commit.gpgsign', 'false');
    await git(repo, 'config', 'core.fsmonitor', 'false');
    await mkdir(path.join(root, 'empty-hooks'));
    await git(repo, 'config', 'core.hooksPath', path.join(root, 'empty-hooks'));
    await writeFile(path.join(repo, 'tracked.txt'), 'initial\n');
    await git(repo, 'add', '--', 'tracked.txt');
    await git(repo, 'commit', '-m', 'initial');
    const makeHost = (options) => {
      const host = createHost(repo, options);
      harnesses.push(host);
      return host;
    };
    return await body({ root, repo, makeHost });
  } finally {
    try {
      for (const host of harnesses.reverse()) await host.dispose();
    } finally {
      // Verify the *resolved absolute target* and an unguessable ownership marker
      // immediately before recursive deletion. Never delete shared tmp roots.
      const target = await realpath(root);
      assert.equal(path.dirname(target), await realpath(workspace));
      assert.match(path.basename(target), /^\.dsh-git-host-[A-Za-z0-9]+$/);
      assert.equal((await lstat(root)).isSymbolicLink(), false);
      assert.equal(await readFile(marker, 'utf8'), token);
      await rm(target, { recursive: true, force: false });
      await assert.rejects(access(target), { code: 'ENOENT' });
    }
  }
}

function createHost(repo, { mode = 'workspace-write' } = {}) {
  const cleanups = [];
  const tools = new Map();
  const commands = new Map();
  const rpcChannels = new Map();
  const provided = new Map();
  const running = new Set();
  const records = { approvals: [], policies: [], confinements: [], spawns: [], resolutions: [], directories: [], agentResolutions: [] };
  const agent = { id: randomUUID(), session: { id: randomUUID(), header: { cwd: repo } } };
  let outcome = 'allowed-once';
  let disposed = false;
  let nextOutput;
  const policy = Object.freeze({ mode, workspaceRoot: repo, sessionId: agent.session.id });
  function register(map, definition) {
    assert.equal(map.has(definition.name), false);
    map.set(definition.name, definition);
    return () => map.delete(definition.name);
  }
  // ctx.services is the backing service map; ctx exposes Cordis-style properties.
  const services = {
    commands: { register: definition => register(commands, definition) },
    connection: { fetch: { register(route) {
      assert.equal(rpcChannels.has(route.path), false);
      assert.equal(route.path, '/api/' + RPC_ENDPOINT);
      assert.deepEqual(route.methods, ['POST']);
      assert.equal(route.requestBody, 'buffered');
      rpcChannels.set(route.path, route);
      return () => rpcChannels.delete(route.path);
    } } },
    sessionController: { async resolveAgent(sessionId) {
      records.agentResolutions.push(sessionId);
      return sessionId === agent.session.id ? {agent} : {error: new Error('Session not found')};
    } },
    tools: { register: definition => register(tools, definition) },
    workingDirectory: { async ensure(value, signal) {
      records.directories.push({ agent: value, signal });
      signal.throwIfAborted();
      assert.equal(value, agent);
      return repo;
    } },
    approval: { async request(request) { records.approvals.push(request); return outcome; } },
    sandboxPolicy: { resolve(request) {
      records.policies.push(request);
      // Never approve/escalate a mode on the plugin's behalf.
      assert.deepEqual(request, { session: agent.session });
      return policy;
    } },
    sandbox: { async confine(argv, requestedPolicy, signal) {
      signal.throwIfAborted();
      records.confinements.push({ argv: [...argv], policy: requestedPolicy, signal });
      // Deliberately recording-only: passthrough is NOT real confinement.
      return { argv: [...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] };
    } },
    subprocess: {
      async resolveExecutable(command, env, signal) {
        signal.throwIfAborted();
        records.resolutions.push({ command, env, signal });
        assert.equal(command, 'git');
        return (await execFileAsync('/usr/bin/which', ['git'], { env: cleanEnvironment(), encoding: 'utf8' })).stdout.trim();
      },
      spawn(spec) {
        spec.signal?.throwIfAborted();
        records.spawns.push(spec);
        assert.equal(spec.graceMs, 1000);
        assert.equal(spec.stdio.stdout.maxBytes, 2 * 1024 * 1024);
        assert.equal(spec.stdio.stderr.maxBytes, 128 * 1024);
        const child = spawn(spec.argv[0], spec.argv.slice(1), {
          cwd: spec.cwd, env: spec.env, detached: true,
          stdio: [spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
        const streams = {};
        for (const name of ['stdout', 'stderr']) {
          const state = streams[name] = { data: Buffer.alloc(0), bytes: 0 };
          child[name].on('data', chunk => {
            state.bytes += chunk.length;
            const remaining = spec.stdio[name].maxBytes - state.data.length;
            if (remaining > 0) state.data = Buffer.concat([state.data, chunk.subarray(0, remaining)]);
            nextOutput?.(name, chunk.toString('utf8'));
          });
        }
        let killTimer;
        const killGroup = signal => {
          try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        };
        const terminate = () => {
          killGroup('SIGTERM');
          killTimer ??= setTimeout(() => killGroup('SIGKILL'), spec.graceMs);
          killTimer.unref();
        };
        const done = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (exitCode, signal) => {
            clearTimeout(killTimer);
            spec.signal?.removeEventListener('abort', terminate);
            running.delete(handle);
            resolve({ exitCode, signal });
          });
        });
        const handle = {
          done, terminate, pid: child.pid,
          collected: Object.fromEntries(['stdout', 'stderr'].map(name => [name, {
            readFrom(offset) {
              const state = streams[name];
              return { text: state.data.subarray(offset).toString('utf8'), nextOffset: state.data.length, lossy: state.bytes > state.data.length };
            },
          }])),
          waitForExit: () => done.then(() => true),
        };
        running.add(handle);
        spec.signal?.addEventListener('abort', terminate, { once: true });
        if (spec.signal?.aborted) terminate();
        if (child.stdin) {
          child.stdin.on('error', error => { if (error.code !== 'EPIPE') throw error; });
          child.stdin.end(spec.stdio.stdin.data);
        }
        return handle;
      },
    },
  };
  const ctx = {
    services, ...services,
    effect(callback) { const cleanup = callback(); assert.equal(typeof cleanup, 'function'); cleanups.push(cleanup); return cleanup; },
    reflect: { provide(key, service) { provided.set(key, service); return () => provided.delete(key); } },
  };
  apply(ctx);
  const service = provided.get('gitWorkbench');
  assert.ok(service instanceof GitWorkbenchService);
  const tool = tools.get('git_workbench');
  const route = rpcChannels.get('/api/' + RPC_ENDPOINT);
  assert.equal(typeof route?.fetch, 'function');
  assert.equal(commands.size, 0, 'Git Workbench must not advertise a slash command');
  const toolCall = (request, signal = new AbortController().signal) => tool.execute(request, { agent, signal, callId: 'host-test-call' });
  const rpcCall = async (payload, {method = RPC_ENDPOINT, signal = new AbortController().signal, rawBody} = {}) => {
    const request = new Request('http://dsh.test/api/' + RPC_ENDPOINT, {method: 'POST', headers: {'content-type': 'application/json'},
      body: rawBody ?? JSON.stringify({type: 'client-request', rpcId: 'host-test-rpc', method, payload}), signal});
    const response = await route.fetch(request);
    const envelope = await response.json();
    assert.equal(envelope.type, 'server-response');
    if (envelope.result.ok) assert.equal(envelope.rpcId, 'host-test-rpc');
    return envelope.result;
  };
  const uiCall = (request, signal = new AbortController().signal) => rpcCall({sessionId: agent.session.id, request}, {signal});
  async function dispose() {
    if (disposed) return;
    disposed = true;
    // Call every effect disposer before awaiting; Cordis cleanup must abort work
    // and then await the transaction tail, rather than strand live processes.
    const pending = cleanups.map(cleanup => cleanup());
    await Promise.all(pending);
    for (const child of running) child.terminate();
    await Promise.all([...running].map(child => child.done));
    assert.equal(running.size, 0);
    assert.equal(tools.size, 0);
    assert.equal(commands.size, 0);
    assert.equal(rpcChannels.size, 0);
    assert.equal(provided.size, 0);
  }
  return { ctx, agent, records, policy, service, tool, commands, rpcChannels, toolCall, rpcCall, uiCall, running, dispose,
    setApproval(value) { outcome = value; },
    onOutput(callback) { nextOutput = callback; },
  };
}

async function uiValue(host, request) {
  const result = await host.uiCall(request);
  assert.equal(result.ok, true, result.error?.message);
  return result.value;
}
async function installWaitingHook(root, repo, host) {
  const hooks = path.join(root, 'waiting-hooks');
  await mkdir(hooks);
  const hook = path.join(hooks, 'pre-commit');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(hook, `#!/bin/sh\nexec ${quote(process.execPath)} -e 'process.stdout.write("HOST_HOOK_READY\\n");setTimeout(()=>{},30000)'\n`);
  await chmod(hook, 0o700);
  await git(repo, 'config', 'core.hooksPath', hooks);
  await writeFile(path.join(repo, 'tracked.txt'), 'waiting commit\n');
  await git(repo, 'add', '--', 'tracked.txt');
  return { ready: new Promise(resolve => host.onOutput((_stream, text) => { if (text.includes('HOST_HOOK_READY')) resolve(); })) };
}

// Sequential because the environment and AbortSignal.timeout are process-global.
test('Host adapter: real Git integration', { timeout: 30000 }, async t => {
  await t.test('tool and sidebar RPC share one service without registering a slash command: read, stage, unstage and commit', async () => fixture(async ({ repo, makeHost }) => {
    const host = makeHost();
    const original = host.service.execute.bind(host.service);
    const sources = [];
    host.service.execute = (...args) => { sources.push(args[3]); return original(...args); };
    for (const [source, call] of [['tool', request => host.toolCall(request)], ['ui', request => uiValue(host, request)]]) {
      const name = `${source} space [literal].txt`;
      await writeFile(path.join(repo, name), `${source} contents\n`);
      const summary = await call({ action: 'summary' });
      assert.equal(summary.repo, repo);
      assert.ok(summary.files.some(file => file.path === name && file.untracked));
      const diff = await call({ action: 'diff', path: name });
      assert.match(diff.text, new RegExp(`${source} contents`));
      await call({ action: 'stage', paths: [name], confirmed: true });
      assert.equal((await git(repo, 'diff', '--cached', '--name-only')).trim(), name);
      await call({ action: 'unstage', paths: [name], confirmed: true });
      assert.equal(await git(repo, 'diff', '--cached', '--name-only'), '');
      await call({ action: 'stage', paths: [name], confirmed: true });
      const result = await call({ action: 'commit', message: `${source} integration commit`, confirmed: true });
      assert.equal(result.action, 'commit');
      assert.equal(result.hash, (await git(repo, 'rev-parse', 'HEAD')).trim());
      assert.equal((await git(repo, 'log', '-1', '--format=%s')).trim(), `${source} integration commit`);
      assert.equal((await call({ action: 'history', limit: 1 })).commits.length, 1);
    }
    assert.ok(sources.includes('tool') && sources.includes('ui'));
    assert.equal(host.records.approvals.length, 4, 'only the four tool writes ask approval');
    for (const request of host.records.approvals) {
      assert.equal(request.agent, host.agent);
      assert.equal(request.toolName, 'git_workbench');
      assert.equal(request.callId, 'host-test-call');
      assert.ok(request.signal instanceof AbortSignal);
      assert.match(request.reason, /modify repository or remote/);
    }
  }));

  await t.test('tool mutations fail closed for every outcome except allowed-once', async () => fixture(async ({ repo, makeHost }) => {
    const host = makeHost();
    await writeFile(path.join(repo, 'tracked.txt'), 'modified\n');
    const initial = await git(repo, 'status', '--porcelain=v1');
    const head = await git(repo, 'rev-parse', 'HEAD');
    for (const outcome of ['rejected', 'cancelled', 'unavailable', 'allowed', true, undefined]) {
      host.setApproval(outcome);
      await assert.rejects(host.toolCall({ action: 'stage', paths: ['tracked.txt'], confirmed: true }), /not approved/);
      assert.equal(await git(repo, 'status', '--porcelain=v1'), initial);
      assert.equal(await git(repo, 'rev-parse', 'HEAD'), head);
    }
    assert.equal(host.records.spawns.length, 0);
    host.setApproval('allowed-once');
    await host.toolCall({ action: 'stage', paths: ['tracked.txt'] });
    assert.equal((await git(repo, 'diff', '--cached', '--name-only')).trim(), 'tracked.txt');
  }));

  await t.test('UI writes need literal confirmed true; errors are RPC results', async () => fixture(async ({ repo, makeHost }) => {
    const host = makeHost();
    await writeFile(path.join(repo, 'tracked.txt'), 'UI modification\n');
    for (const confirmed of [undefined, false, 'true', 1]) {
      const result = await host.uiCall({ action: 'stage', paths: ['tracked.txt'], confirmed });
      assert.equal(result.ok, false);
      assert.match(result.error.message, /Confirm this write operation/);
      assert.equal(await git(repo, 'diff', '--cached', '--name-only'), '');
    }
    assert.equal((await host.uiCall('{broken')).ok, false);
    assert.equal((await host.uiCall({action: 'commit', message: 'x'.repeat(262145)})).ok, false);
    await uiValue(host, { action: 'stage', paths: ['tracked.txt'], confirmed: true });
    assert.equal(host.records.approvals.length, 0, 'human RPC confirmation is not agent-tool approval');
  }));

  await t.test('exact RPC rejects invalid envelopes, methods, payloads, sessions and cancellation before Git', async () => fixture(async ({ makeHost }) => {
    const host = makeHost();
    const payload = {sessionId: host.agent.session.id, request: {action: 'summary'}};
    assert.equal(host.commands.size, 0);
    assert.deepEqual([...host.rpcChannels.keys()], ['/api/' + RPC_ENDPOINT]);
    assert.equal((await host.rpcCall(payload, {method: 'arbitrary'})).ok, false);
    for (const rawBody of ['{broken', '{}', 'null', '[]', '{"type":"client-request","rpcId":4}']) {
      assert.equal((await host.rpcCall(payload, {rawBody})).ok, false);
    }
    for (const invalid of [null, [], 'raw', {}, {...payload, extra: true}, {...payload, sessionId: ''}, {...payload, request: []}]) {
      assert.equal((await host.rpcCall(invalid)).ok, false);
    }
    const cancelled = new AbortController(); cancelled.abort(new Error('RPC cancelled'));
    assert.match((await host.rpcCall(payload, {signal: cancelled.signal})).error.message, /RPC cancelled/);
    assert.equal(host.records.agentResolutions.length, 0);
    assert.match((await host.rpcCall({...payload, sessionId: 'missing-session'})).error.message, /Session not found/);
    assert.equal(host.records.spawns.length, 0);
  }));

  await t.test('read confinement is read-only; writes preserve the resolved session policy without overrides', async () => fixture(async ({ repo, makeHost }) => {
    for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
      const host = makeHost({ mode });
      for (const action of ['summary', 'history', 'diff']) {
        const before = host.records.confinements.length;
        await host.toolCall({ action });
        assert.ok(host.records.confinements.length > before);
        for (const entry of host.records.confinements.slice(before)) {
          assert.equal(entry.policy.mode, 'read-only');
          assert.equal(entry.policy.workspaceRoot, repo);
          assert.equal(entry.policy.sessionId, host.agent.session.id);
        }
      }
      const before = host.records.confinements.length;
      // This test checks policy propagation, NOT enforcement: the recording fake
      // intentionally permits this write even when the recorded policy is read-only.
      await host.toolCall({ action: 'createBranch', branch: `policy-${mode}` });
      const entries = host.records.confinements.slice(before);
      if (mode === 'danger-full-access') assert.equal(entries.length, 0);
      else { assert.ok(entries.length); for (const entry of entries) assert.equal(entry.policy, host.policy); }
      for (const request of host.records.policies) assert.deepEqual(Object.keys(request), ['session']);
      for (const spec of host.records.spawns) {
        assert.deepEqual(spec.argv.slice(1, 7), ['--no-pager', '--literal-pathspecs', '-c', 'color.ui=false', '-c', 'core.quotepath=false']);
        assert.equal(spec.env.GIT_OPTIONAL_LOCKS, '0');
        assert.equal(spec.env.GIT_TERMINAL_PROMPT, '0');
        assert.equal(spec.env.GIT_EDITOR, 'true');
        assert.equal(spec.env.GIT_MERGE_AUTOEDIT, 'no');
      }
    }
  }));

  await t.test('inherited Git repository/config/executable pollution is removed before spawning', async () => fixture(async ({ root, repo, makeHost }) => {
    const host = makeHost();
    const poison = {
      GIT_DIR: path.join(root, 'wrong-git-dir'), GIT_WORK_TREE: root,
      GIT_INDEX_FILE: path.join(root, 'wrong-index'), GIT_OBJECT_DIRECTORY: path.join(root, 'wrong-objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(root, 'wrong-alternates'), GIT_COMMON_DIR: path.join(root, 'wrong-common'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Wrong User',
      GIT_CONFIG_PARAMETERS: "'user.name=Wrong User'", GIT_CONFIG_SYSTEM: path.join(root, 'wrong-config'),
      GIT_CONFIG_GLOBAL: path.join(root, 'wrong-global-config'), GIT_SSH_COMMAND: 'false', GIT_SSH: '/nonexistent/ssh',
      GIT_ASKPASS: '/nonexistent/askpass', GIT_EXEC_PATH: path.join(root, 'wrong-exec-path'), GIT_NAMESPACE: 'wrong-namespace',
    };
    const previous = Object.fromEntries(Object.keys(poison).map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, poison);
      const summary = await host.toolCall({ action: 'summary' });
      assert.equal(summary.repo, repo);
      await writeFile(path.join(repo, 'tracked.txt'), 'environment isolation\n');
      await host.toolCall({ action: 'stage', paths: ['tracked.txt'] });
      await host.toolCall({ action: 'commit', message: 'environment isolated' });
      for (const spec of host.records.spawns) for (const key of Object.keys(poison)) {
        assert.equal(spec.env[key], undefined, `${key} must not reach Git`);
      }
      assert.equal(await access(path.join(root, 'wrong-index')).then(() => true, () => false), false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    assert.equal((await git(repo, 'log', '-1', '--format=%an')).trim(), 'Host Integration');
  }));

  await t.test('pre-abort starts nothing; running Git cancellation drains the real hook process', async () => fixture(async ({ root, repo, makeHost }) => {
    const host = makeHost();
    const pre = new AbortController(); pre.abort(new Error('pre-aborted'));
    await assert.rejects(host.toolCall({ action: 'summary' }, pre.signal), /pre-aborted/);
    assert.equal(host.records.spawns.length, 0);
    const { ready } = await installWaitingHook(root, repo, host);
    const controller = new AbortController();
    const commit = host.toolCall({ action: 'commit', message: 'must abort' }, controller.signal);
    const rejected = assert.rejects(commit, /cancel running Git/);
    await ready;
    controller.abort(new Error('cancel running Git'));
    await rejected;
    assert.equal(host.running.size, 0);
    assert.equal((await git(repo, 'log', '-1', '--format=%s')).trim(), 'initial');
    assert.ok((await host.toolCall({ action: 'summary' })).head, 'failed transaction does not poison queue');
  }));

  await t.test('120-second timeout signal cancels running Git without waiting 120 seconds', async () => fixture(async ({ root, repo, makeHost }) => {
    const host = makeHost();
    const timeout = new AbortController();
    const nativeTimeout = AbortSignal.timeout;
    let requested;
    AbortSignal.timeout = ms => { requested = ms; return timeout.signal; };
    try {
      const { ready } = await installWaitingHook(root, repo, host);
      const commit = host.toolCall({ action: 'commit', message: 'must time out' });
      const rejected = assert.rejects(commit, { name: 'TimeoutError' });
      await ready;
      assert.equal(requested, 120000);
      timeout.abort(new DOMException('Controlled timeout', 'TimeoutError'));
      await rejected;
      assert.equal(host.running.size, 0);
      assert.equal((await git(repo, 'log', '-1', '--format=%s')).trim(), 'initial');
    } finally { AbortSignal.timeout = nativeTimeout; }
  }));

  await t.test('unload aborts active and queued transactions and unregisters all effects', async () => fixture(async ({ root, repo, makeHost }) => {
    const host = makeHost();
    const { ready } = await installWaitingHook(root, repo, host);
    const active = host.toolCall({ action: 'commit', message: 'must unload' });
    const activeRejected = assert.rejects(active, /unloaded/);
    await ready;
    const queued = host.toolCall({ action: 'summary' });
    const queuedRejected = assert.rejects(queued, /unloaded/);
    await host.dispose();
    await Promise.all([activeRejected, queuedRejected]);
    assert.equal(host.running.size, 0);
    await assert.rejects(host.toolCall({ action: 'summary' }), /unloaded/);
    assert.equal((await git(repo, 'log', '-1', '--format=%s')).trim(), 'initial');
  }));

  await t.test('manifest and registered tool schema describe supported bounds and safety contracts', async () => fixture(async ({ makeHost }) => {
    const host = makeHost();
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(manifest.exports['.'], './index.js');
    assert.equal(manifest.exports['./client'], './client.js');
    assert.equal(manifest.dsh.client.platform, 'web');
    assert.equal(host.tool.parameters, parameters);
    assert.equal(parameters.additionalProperties, false);
    assert.deepEqual(parameters.required, ['action']);
    assert.equal(parameters.properties.confirmed, undefined, 'agent tool cannot self-confirm a human command');
    assert.deepEqual(parameters.properties.action.enum, ['summary', 'history', 'diff', 'stage', 'unstage', 'commit', 'switch', 'createBranch', 'deleteBranch', 'fetch', 'pull', 'push', 'stash', 'stashPop', 'merge', 'init']);
    assert.equal(host.tool.timeoutMs, 150000);
    assert.equal(host.tool.isConcurrencySafe({ action: 'summary' }), false);
    assert.match(host.tool.description, /approval/);
    assert.match(host.tool.description, /sandbox/);
    assert.match(host.tool.description, /fast-forward/);
    assert.deepEqual(host.tool.output.render({}, { ok: true }), [{ type: 'text', text: '{"ok":true}' }]);
    const description = key => parameters.properties[key].description || '';
    for (const [key, keyword, bound] of [['repo', 'maxLength', 4096], ['paths', 'minItems', 1], ['paths', 'maxItems', 200], ['path', 'maxLength', 4096], ['message', 'maxLength', 65536], ['branch', 'maxLength', 255], ['remote', 'maxLength', 255], ['limit', 'minimum', 1], ['limit', 'maximum', 200], ['skip', 'minimum', 0], ['skip', 'maximum', 100000]]) {
      assert.equal(parameters.properties[key][keyword], bound, `${key} schema must declare ${keyword} ${bound}`);
    }
    assert.equal(parameters.properties.paths.items.maxLength, 4096);
    assert.match(description('limit'), /1.*200/);
    assert.match(description('limit'), /default 60/i);
    assert.match(description('skip'), /default 0/i);
  }));
});
