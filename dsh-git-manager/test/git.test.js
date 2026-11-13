import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, realpath, lstat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitManager, READ_ACTIONS } from '../git.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePrefix = '.git-manager-fixture-';
const ownedFixtures = new Set();
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
Object.assign(env, {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  // Fixtures live inside this checkout: never discover its parent repository.
  GIT_CEILING_DIRECTORIES: testDirectory,
  GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_NAME: 'Git Engine Test', GIT_AUTHOR_EMAIL: 'git-engine@example.invalid',
  GIT_COMMITTER_NAME: 'Git Engine Test', GIT_COMMITTER_EMAIL: 'git-engine@example.invalid',
});
const gitFlags = ['--literal-pathspecs', '-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'protocol.file.allow=always', '-c', 'core.autocrlf=false'];

/** The test adapter deliberately uses execFile, never a shell or a user repository. */
function run(cwd, args, { signal, stdin, allowedExitCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...gitFlags, ...args], { cwd, env, signal, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !Number.isInteger(error.code)) { reject(error); return; }
        const exitCode = error?.code ?? 0;
        const result = { stdout, stderr, exitCode };
        if (!allowedExitCodes.includes(exitCode)) {
          reject(Object.assign(new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderr || stdout}`), { code: 'GIT_ERROR', args, ...result }));
        } else resolve(result);
      });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

async function fixture(callback) {
  const root = await mkdtemp(path.join(testDirectory, fixturePrefix));
  ownedFixtures.add(root);
  try { return await callback(root); } finally {
    // Cleanup may only delete this exact, uniquely created, workspace-owned root.
    const absolute = path.resolve(root);
    const relative = path.relative(testDirectory, absolute);
    assert(ownedFixtures.has(absolute), 'cleanup target must belong to this test fixture');
    assert(path.isAbsolute(absolute));
    assert(relative.startsWith(fixturePrefix) && !relative.includes(path.sep) && relative !== '..');
    assert.equal(await realpath(absolute), absolute, 'cleanup target must not be a symlink');
    assert((await lstat(absolute)).isDirectory());
    await rm(absolute, { recursive: true, force: false });
    ownedFixtures.delete(root);
  }
}
async function init(root, name = 'repo') {
  const repo = path.join(root, name);
  await mkdir(repo);
  await run(repo, ['init']);
  return repo;
}
async function commitFile(repo, name, content, message = 'fixture commit') {
  await writeFile(path.join(repo, name), content);
  await run(repo, ['add', '--', name]);
  await run(repo, ['commit', '-m', message]);
  return (await run(repo, ['rev-parse', 'HEAD'])).stdout.trim();
}
const execute = (manager, repo, action, extra = {}) => manager.execute({ action, ...extra }, { cwd: repo });
const summary = (manager, repo) => execute(manager, repo, 'summary');

test('read action contract and executor validation', async () => {
  assert.deepEqual([...READ_ACTIONS], ['summary', 'history', 'diff']);
  assert.throws(() => new GitManager(null), TypeError);
  await assert.rejects(new GitManager(async () => ({})).execute({ action: 'summary' }, { cwd: testDirectory }), { code: 'INVALID_EXECUTOR_RESULT' });
});

test('stage, unstage, commit, history pagination, tracked/staged/revision diff', () => fixture(async (root) => {
  const repo = await init(root);
  const manager = new GitManager(run);
  const empty = await summary(manager, repo);
  assert.equal(empty.repo, repo);
  assert.equal(empty.branch, 'main');
  assert.equal(empty.head, null);
  assert.equal(empty.upstream, null);
  assert.deepEqual(await execute(manager, repo, 'history'), { commits: [], hasMore: false });
  await writeFile(path.join(repo, 'hello.txt'), 'first\n');
  const untracked = (await summary(manager, repo)).files[0];
  assert.equal(untracked.path, 'hello.txt');
  assert.equal(untracked.untracked, true);
  assert.match((await execute(manager, repo, 'diff', { path: 'hello.txt' })).text, /\+first/);
  await execute(manager, repo, 'stage', { paths: ['hello.txt'] });
  assert.equal((await summary(manager, repo)).files[0].staged, true);
  assert.match((await execute(manager, repo, 'diff', { staged: true })).text, /\+first/);
  const first = await execute(manager, repo, 'commit', { message: 'first message\n\nbody' });
  assert.match(first.hash, /^[0-9a-f]{40,64}$/);
  assert.equal(first.action, 'commit');
  assert.equal(first.exitCode, 0);
  await writeFile(path.join(repo, 'hello.txt'), 'second\n');
  assert.match((await execute(manager, repo, 'diff')).text, /\+second/);
  await execute(manager, repo, 'stage', { paths: ['hello.txt'] });
  await execute(manager, repo, 'unstage', { paths: ['hello.txt'] });
  assert.equal((await summary(manager, repo)).files[0].staged, false);
  assert.equal((await summary(manager, repo)).files[0].unstaged, true);
  await execute(manager, repo, 'stage', { paths: ['hello.txt'] });
  const second = await execute(manager, repo, 'commit', { message: 'second message' });
  const page = await execute(manager, repo, 'history', { limit: 1 });
  assert.equal(page.hasMore, true);
  assert.equal(page.commits[0].hash, second.hash);
  assert.equal(page.commits[0].subject, 'second message');
  assert.deepEqual(page.commits[0].parents, [first.hash]);
  assert.equal(page.commits[0].author, 'Git Engine Test');
  assert.match(page.commits[0].date, /^\d{4}-/);
  assert.equal(typeof page.commits[0].refs, 'string');
  assert.deepEqual((await execute(manager, repo, 'history', { limit: 1, skip: 1 })).commits[0].parents, []);
  assert.equal((await execute(manager, repo, 'history', { skip: 2 })).hasMore, false);
  assert.match((await execute(manager, repo, 'diff', { revision: first.hash.slice(0, 10) })).text, /first message/);
}));

test('initial unstage leaves content intact, including worktree changes after staging', () => fixture(async (root) => {
  const repo = await init(root);
  const manager = new GitManager(run);
  await writeFile(path.join(repo, 'initial.txt'), 'index version\n');
  await execute(manager, repo, 'stage', { paths: ['initial.txt'] });
  await writeFile(path.join(repo, 'initial.txt'), 'working version\n');
  await execute(manager, repo, 'unstage', { paths: ['initial.txt'] });
  assert.equal(await readFile(path.join(repo, 'initial.txt'), 'utf8'), 'working version\n');
  const file = (await summary(manager, repo)).files[0];
  assert.equal(file.untracked, true);
  assert.equal(file.staged, false);
  assert.deepEqual(await execute(manager, repo, 'history'), { commits: [], hasMore: false });
}));

test('NUL status preserves Chinese, spaces, newline, leading dash and literal pathspec names', () => fixture(async (root) => {
  const repo = await init(root);
  const manager = new GitManager(run);
  const names = ['中文 空格.txt', 'line\nbreak.txt', '--help', ':(glob)*', '[abc].txt', 'back\\slash.txt'];
  for (const name of names) await writeFile(path.join(repo, name), `contents of ${name}\n`);
  assert.deepEqual(new Set((await summary(manager, repo)).files.map((file) => file.path)), new Set(names));
  await execute(manager, repo, 'stage', { paths: [':(glob)*'] });
  assert.deepEqual((await summary(manager, repo)).files.filter((file) => file.staged).map((file) => file.path), [':(glob)*']);
  for (const name of names) {
    assert.match((await execute(manager, repo, 'diff', { path: name, staged: name === ':(glob)*' })).text, /contents of/);
  }
  await execute(manager, repo, 'stage', { paths: names });
  await execute(manager, repo, 'commit', { message: '特殊路径' });
  assert.deepEqual((await summary(manager, repo)).files, []);
}));

test('rename status and unstage expand either side without deleting files', () => fixture(async (root) => {
  const repo = await init(root);
  const manager = new GitManager(run);
  await commitFile(repo, '原始\nname.txt', 'same content\n');
  await rename(path.join(repo, '原始\nname.txt'), path.join(repo, 'renamed 中文.txt'));
  await execute(manager, repo, 'stage', { paths: ['原始\nname.txt', 'renamed 中文.txt'] });
  const renamed = (await summary(manager, repo)).files[0];
  assert.equal(renamed.index, 'R');
  assert.equal(renamed.path, 'renamed 中文.txt');
  assert.equal(renamed.originalPath, '原始\nname.txt');
  await execute(manager, repo, 'unstage', { paths: ['renamed 中文.txt'] });
  assert.equal((await run(repo, ['diff', '--cached', '--name-only'])).stdout, '');
  assert.equal(await readFile(path.join(repo, 'renamed 中文.txt'), 'utf8'), 'same content\n');
  await execute(manager, repo, 'stage', { paths: ['.'] });
  await execute(manager, repo, 'unstage', { paths: ['原始\nname.txt'] });
  assert.equal((await run(repo, ['diff', '--cached', '--name-only'])).stdout, '');
}));

test('branch creation/switch, ordinary merge and safe deletion refuse unmerged work', () => fixture(async (root) => {
  const repo = await init(root);
  const manager = new GitManager(run);
  await commitFile(repo, 'base', 'base\n');
  await execute(manager, repo, 'createBranch', { branch: 'feature/中文' });
  assert.equal((await summary(manager, repo)).branch, 'main');
  await execute(manager, repo, 'switch', { branch: 'feature/中文' });
  await commitFile(repo, 'feature', 'feature\n');
  await execute(manager, repo, 'switch', { branch: 'main' });
  await assert.rejects(execute(manager, repo, 'deleteBranch', { branch: 'feature/中文' }), (error) => error.exitCode !== 0 && /not fully merged/.test(error.stderr));
  assert((await summary(manager, repo)).branches.some((branch) => branch.name === 'feature/中文'));
  await execute(manager, repo, 'merge', { branch: 'feature/中文' });
  await execute(manager, repo, 'deleteBranch', { branch: 'feature/中文' });
  assert(!(await summary(manager, repo)).branches.some((branch) => branch.name === 'feature/中文'));
}));

test('history covers divergent branches and preserves merge parents in topological order', () => fixture(async (root) => {
  const repo = await init(root);
  const manager = new GitManager(run);
  const base = await commitFile(repo, 'base', 'base\n');
  await execute(manager, repo, 'createBranch', { branch: 'side' });
  const main = await commitFile(repo, 'main-only', 'main\n');
  await execute(manager, repo, 'switch', { branch: 'side' });
  const side = await commitFile(repo, 'side-only', 'side\n');
  await execute(manager, repo, 'switch', { branch: 'main' });
  const before = (await execute(manager, repo, 'history')).commits;
  assert(before.some((commit) => commit.hash === side), 'history must include commits from non-current branches');
  await execute(manager, repo, 'merge', { branch: 'side' });
  const commits = (await execute(manager, repo, 'history')).commits;
  assert.deepEqual(commits[0].parents, [main, side]);
  assert.equal(commits.at(-1).hash, base);
  const positions = new Map(commits.map((commit, index) => [commit.hash, index]));
  for (const commit of commits) for (const parent of commit.parents) {
    if (positions.has(parent)) assert(positions.get(commit.hash) < positions.get(parent));
  }
}));

test('fetch/pull ff-only/push operate only on configured upstream with a local bare remote', () => fixture(async (root) => {
  const remote = path.join(root, 'remote.git');
  await mkdir(remote);
  await run(remote, ['init', '--bare']);
  const repo = await init(root);
  const manager = new GitManager(run);
  await commitFile(repo, 'base', 'base\n');
  await run(repo, ['remote', 'add', 'origin', remote]);
  await assert.rejects(execute(manager, repo, 'push'), { code: 'NO_UPSTREAM' });
  await run(repo, ['push', '-u', 'origin', 'main']);
  const clone = path.join(root, 'clone');
  await run(root, ['clone', '--', remote, clone]);
  await commitFile(clone, 'remote change', 'remote\n');
  await run(clone, ['push']);
  await execute(manager, repo, 'fetch', { remote: 'origin' });
  let state = await summary(manager, repo);
  assert.equal(state.upstream, 'origin/main');
  assert.equal(state.behind, 1);
  assert.equal(state.ahead, 0);
  assert.deepEqual(state.remotes, [{ name: 'origin', url: remote }]);
  assert(state.branches.some((branch) => branch.remote && branch.name === 'origin/main'));
  await execute(manager, repo, 'pull');
  assert.equal(await readFile(path.join(repo, 'remote change'), 'utf8'), 'remote\n');
  await commitFile(repo, 'local change', 'local\n');
  assert.equal((await summary(manager, repo)).ahead, 1);
  await execute(manager, repo, 'push');
  assert.equal((await summary(manager, repo)).ahead, 0);
  await commitFile(clone, 'remote divergence', 'remote divergence\n');
  await run(clone, ['pull', '--no-rebase', '--no-edit']);
  await run(clone, ['push']);
  await commitFile(repo, 'local divergence', 'local divergence\n');
  const head = (await summary(manager, repo)).head;
  await assert.rejects(execute(manager, repo, 'pull'), (error) => error.exitCode !== 0 && /fast-forward|diverg/i.test(error.stderr));
  assert.equal((await summary(manager, repo)).head, head, 'ff-only failure must not rewrite local HEAD');
  await assert.rejects(execute(manager, repo, 'push'), (error) => error.exitCode !== 0);
  await assert.rejects(execute(manager, repo, 'fetch', { remote: '--upload-pack=malicious' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(execute(manager, repo, 'fetch', { remote: path.join(root, 'not-configured') }), { code: 'INVALID_REQUEST' });
}));

test('stash includes only tracked files; stash pop restores content and reports conflicts', () => fixture(async (root) => {
  const repo = await init(root);
  const manager = new GitManager(run);
  await commitFile(repo, 'tracked', 'base\n');
  await writeFile(path.join(repo, 'tracked'), 'stashed\n');
  await writeFile(path.join(repo, 'untracked'), 'must stay\n');
  await execute(manager, repo, 'stash', { message: '中文 stash' });
  let state = await summary(manager, repo);
  assert.equal(state.stashes.length, 1);
  assert.equal(state.stashes[0].ref, 'stash@{0}');
  assert.match(state.stashes[0].hash, /^[0-9a-f]{40,64}$/);
  assert.match(state.stashes[0].subject, /中文 stash/);
  assert.equal(await readFile(path.join(repo, 'untracked'), 'utf8'), 'must stay\n');
  assert.equal(await readFile(path.join(repo, 'tracked'), 'utf8'), 'base\n');
  await execute(manager, repo, 'stashPop');
  assert.equal(await readFile(path.join(repo, 'tracked'), 'utf8'), 'stashed\n');
  assert.equal((await summary(manager, repo)).stashes.length, 0);
  await execute(manager, repo, 'stash');
  await commitFile(repo, 'tracked', 'conflicting commit\n');
  await assert.rejects(execute(manager, repo, 'stashPop'), (error) => {
    assert.equal(error.code, 'GIT_CONFLICT');
    assert.equal(error.exitCode, 1);
    assert.deepEqual(error.conflicts, ['tracked']);
    assert.match(error.message, /manual resolution/);
    return true;
  });
  state = await summary(manager, repo);
  assert.equal(state.files.find((file) => file.path === 'tracked').conflict, true);
  assert.equal(state.stashes.length, 1, 'conflicting pop keeps stash');
}));

test('merge conflicts are explicit and status parses unmerged NUL records', () => fixture(async (root) => {
  const repo = await init(root);
  const manager = new GitManager(run);
  await commitFile(repo, '冲突\nfile', 'base\n');
  await execute(manager, repo, 'createBranch', { branch: 'other' });
  await commitFile(repo, '冲突\nfile', 'main\n');
  await execute(manager, repo, 'switch', { branch: 'other' });
  await commitFile(repo, '冲突\nfile', 'other\n');
  await execute(manager, repo, 'switch', { branch: 'main' });
  await assert.rejects(execute(manager, repo, 'merge', { branch: 'other' }), { code: 'GIT_CONFLICT', conflicts: ['冲突\nfile'] });
  const conflict = (await summary(manager, repo)).files[0];
  assert.equal(conflict.path, '冲突\nfile');
  assert.equal(conflict.index, 'U');
  assert.equal(conflict.worktree, 'U');
  assert.equal(conflict.conflict, true);
}));

test('non-repositories are explicit; init requires explicit empty directory and forbids nesting', () => fixture(async (root) => {
  const manager = new GitManager(run);
  await assert.rejects(execute(manager, root, 'summary'), { code: 'NOT_GIT_REPOSITORY', exitCode: 128 });
  await assert.rejects(execute(manager, root, 'init'), { code: 'INVALID_REQUEST' });
  const repo = path.join(root, 'new');
  await mkdir(repo);
  const initialized = await manager.execute({ action: 'init', repo });
  assert.equal(initialized.repo, repo);
  await assert.rejects(manager.execute({ action: 'init', repo }), { code: 'NESTED_REPOSITORY' });
  const nested = path.join(repo, 'nested');
  await mkdir(nested);
  await assert.rejects(manager.execute({ action: 'init', repo: nested }), { code: 'NESTED_REPOSITORY' });
  const parentOfRepo = path.join(root, 'parent');
  await mkdir(parentOfRepo);
  await init(parentOfRepo, 'child');
  await assert.rejects(manager.execute({ action: 'init', repo: parentOfRepo }), { code: 'INIT_NOT_EMPTY' });
  const sub = path.join(repo, 'sub');
  await mkdir(sub);
  assert.equal((await summary(manager, sub)).repo, repo);
}));

test('strict request validation rejects malicious paths/options/revisions without executing Git', async () => {
  const calls = [];
  const manager = new GitManager(async (...args) => { calls.push(args); throw new Error('must not execute'); });
  const requests = [
    { action: 'discard' }, { action: 'reset' }, { action: 'rebase' }, { action: 'clean' },
    { action: 'stage', paths: [] }, { action: 'stage' }, { action: 'stage', paths: ['../secret'] },
    { action: 'stage', paths: ['safe/../../secret'] }, { action: 'stage', paths: ['/etc/passwd'] },
    { action: 'stage', paths: ['C:\\secret'] }, { action: 'stage', paths: ['x\0y'] },
    { action: 'stage', paths: ['a', 1] }, { action: 'stage', paths: Array(201).fill('a') },
    { action: 'switch', branch: '--discard-changes' }, { action: 'switch', branch: 'name\nother' },
    { action: 'createBranch' }, { action: 'deleteBranch', branch: 'valid', force: true },
    { action: 'push', force: true }, { action: 'fetch', remote: '-x' },
    { action: 'diff', revision: 'HEAD~1' }, { action: 'diff', revision: '--output=/tmp/x' },
    { action: 'diff', revision: '1234567', staged: true }, { action: 'diff', staged: 'yes' },
    { action: 'diff', path: 'a', paths: ['b'] }, { action: 'diff', path: '../a' },
    { action: 'commit', message: '' }, { action: 'commit', message: '  ' }, { action: 'commit', message: 'a\0b' },
    { action: 'history', limit: 0 }, { action: 'history', limit: 201 }, { action: 'history', limit: 1.1 },
    { action: 'history', limit: null }, { action: 'history', skip: null }, { action: {} },
    { action: 'history', skip: -1 }, { action: 'history', skip: 100001 },
    { action: 'summary', repo: 'relative' }, { action: 'summary', repo: '/tmp/a\0b' },
    { action: 'summary', arbitraryShell: 'touch x' }, null, [], 'summary',
  ];
  for (const request of requests) await assert.rejects(manager.execute(request, { cwd: testDirectory }), { code: 'INVALID_REQUEST' }, JSON.stringify(request));
  await assert.rejects(manager.execute({ action: 'summary' }), { code: 'INVALID_REQUEST' });
  assert.equal(calls.length, 0);
});

test('Git validates branch syntax; failures retain exit code and diagnostics', () => fixture(async (root) => {
  const repo = await init(root);
  const manager = new GitManager(run);
  await commitFile(repo, 'base', 'base\n');
  for (const branch of ['invalid..name', 'a:b', 'a lock', '@{-1}']) {
    await assert.rejects(execute(manager, repo, 'createBranch', { branch }), (error) => error.code === 'INVALID_REQUEST' || (error.exitCode !== 0 && typeof error.stderr === 'string'));
  }
  await assert.rejects(execute(manager, repo, 'commit', { message: 'nothing staged' }), (error) => error.exitCode !== 0 && /nothing to commit/.test(error.stdout));
  await assert.rejects(execute(manager, repo, 'diff', { revision: 'abcdef0' }), (error) => error.exitCode !== 0 && /bad object|bad revision|unknown revision|ambiguous/i.test(error.stderr));
  assert.equal((await summary(manager, repo)).branch, 'main');
}));

test('untracked symlink diff does not read the link target outside the repository', () => fixture(async (root) => {
  const repo = await init(root);
  const manager = new GitManager(run);
  const outside = path.join(root, 'private-outside-repo');
  const secret = 'OUTSIDE_CONTENT_MUST_NEVER_APPEAR_4e9d7c';
  await writeFile(outside, secret);
  await symlink(outside, path.join(repo, 'link'));
  const diff = await execute(manager, repo, 'diff', { path: 'link' });
  assert.match(diff.text, /120000/);
  assert(diff.text.includes(outside));
  assert(!diff.text.includes(secret), 'Git must diff the symlink itself, not its target contents');
}));

test('diff is bounded and binary recognition remains Git-owned', () => fixture(async (root) => {
  const repo = await init(root);
  const manager = new GitManager(run);
  await writeFile(path.join(repo, 'binary'), Buffer.from([0, 1, 2, 3]));
  const binary = await execute(manager, repo, 'diff', { path: 'binary' });
  assert.match(binary.text, /Binary files/);
  await writeFile(path.join(repo, 'large'), 'large line\n'.repeat(25_000));
  const large = await execute(manager, repo, 'diff', { path: 'large' });
  assert.equal(large.truncated, true);
  assert.equal(large.text.length, 200_000);
  const capped = new GitManager(async (cwd, args, options) => {
    const result = await run(cwd, args, options);
    return args[0] === 'diff' ? { ...result, truncated: true } : result;
  });
  assert.equal((await execute(capped, repo, 'diff')).truncated, true);
  const invalidSummary = new GitManager(async (cwd, args, options) => ({ ...await run(cwd, args, options), truncated: true }));
  await assert.rejects(summary(invalidSummary, repo), { code: 'GIT_OUTPUT_TRUNCATED' });
}));

test('per-manager transactions serialize, snapshot inputs and recover after a failed request', () => fixture(async (root) => {
  const repo = await init(root);
  let active = 0;
  const observed = [];
  const manager = new GitManager(async (cwd, args, options) => {
    assert.equal(active, 0, 'commands from concurrent transactions must not overlap');
    active++;
    observed.push(args[0]);
    try { return await run(cwd, args, options); } finally { active--; }
  });
  await writeFile(path.join(repo, 'a'), 'a\n');
  const request = { action: 'stage', paths: ['a'] };
  const staged = manager.execute(request, { cwd: repo });
  request.paths[0] = 'wrong';
  const committed = execute(manager, repo, 'commit', { message: 'queued commit' });
  await Promise.all([staged, committed]);
  assert.equal((await execute(manager, repo, 'history')).commits[0].subject, 'queued commit');
  await assert.rejects(execute(manager, repo, 'commit', { message: 'expected failure' }));
  assert.deepEqual((await summary(manager, repo)).files, []);
  assert(observed.indexOf('add') < observed.indexOf('commit'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(manager.execute({ action: 'summary' }, { cwd: repo, signal: controller.signal }), { name: 'AbortError' });
}));
