import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** Read actions never intentionally change the index, worktree, refs, or remotes. */
export const READ_ACTIONS = new Set(['summary', 'history', 'diff']);

const FIELDS = {
  summary: [], history: ['limit', 'skip'], diff: ['path', 'paths', 'staged', 'revision'],
  stage: ['paths'], unstage: ['paths'], commit: ['message'], switch: ['branch'],
  createBranch: ['branch'], deleteBranch: ['branch'], fetch: ['remote'],
  pull: ['remote'], push: ['remote'], stash: ['message'], stashPop: [],
  merge: ['branch'], init: [],
};
const MAX_DIFF = 200_000;
const MAX_PATHS = 200;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const line = (text) => text.replace(/\r?\n$/, '');

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}
function string(value, field, max = 4096) {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0')) {
    throw failure('INVALID_REQUEST', `${field} must be a nonempty string without NUL (maximum ${max} characters).`);
  }
  return value;
}
function relativePath(value) {
  string(value, 'path');
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)
      || value.split(/[\\/]/).includes('..')) {
    throw failure('INVALID_REQUEST', 'Paths must be repository-relative and must not contain .. components.');
  }
  return value;
}
function absolutePath(value, field) {
  string(value, field);
  if (!path.isAbsolute(value)) throw failure('INVALID_REQUEST', `${field} must be an absolute path.`);
  return path.resolve(value);
}
function validate(request, cwd) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(request))) {
    throw failure('INVALID_REQUEST', 'request must be a plain object.');
  }
  if (typeof request.action !== 'string' || !own(FIELDS, request.action)) throw failure('INVALID_REQUEST', 'Unsupported Git action.');
  const allowed = new Set(['action', 'repo', ...FIELDS[request.action]]);
  for (const key of Object.keys(request)) {
    if (!allowed.has(key)) throw failure('INVALID_REQUEST', `Unexpected field for ${request.action}: ${key}`);
  }
  const result = { ...request };
  result.cwd = absolutePath(request.repo ?? cwd, request.repo === undefined ? 'cwd' : 'repo');
  if (own(request, 'repo')) absolutePath(request.repo, 'repo');
  if (request.action === 'init' && !own(request, 'repo')) {
    throw failure('INVALID_REQUEST', 'init requires an explicit absolute repo and an existing empty directory.');
  }
  if (own(request, 'paths')) {
    if (!Array.isArray(request.paths) || !request.paths.length || request.paths.length > MAX_PATHS) {
      throw failure('INVALID_REQUEST', `paths must contain between 1 and ${MAX_PATHS} relative paths.`);
    }
    result.paths = [...new Set(request.paths.map(relativePath))];
  }
  if (own(request, 'path')) result.path = relativePath(request.path);
  if (own(request, 'path') && own(request, 'paths')) throw failure('INVALID_REQUEST', 'Use path or paths, not both.');
  if (['stage', 'unstage'].includes(request.action) && !result.paths) {
    throw failure('INVALID_REQUEST', `${request.action} requires explicit paths (use ["."] for all files).`);
  }
  if (own(request, 'staged') && typeof request.staged !== 'boolean') {
    throw failure('INVALID_REQUEST', 'staged must be a boolean.');
  }
  if (own(request, 'revision')) {
    if (typeof request.revision !== 'string' || !/^[a-fA-F0-9]{7,64}$/.test(request.revision)) {
      throw failure('INVALID_REQUEST', 'revision must be a hexadecimal commit hash of 7–64 characters.');
    }
    if (request.staged) throw failure('INVALID_REQUEST', 'revision and staged cannot be combined.');
  }
  for (const field of ['branch', 'remote']) {
    if (own(request, field)) {
      string(request[field], field, 255);
      if (request[field].startsWith('-') || /[\r\n]/.test(request[field])) {
        throw failure('INVALID_REQUEST', `${field} must not begin with - or contain newlines.`);
      }
    }
  }
  if (['switch', 'createBranch', 'deleteBranch', 'merge'].includes(request.action) && !own(request, 'branch')) {
    throw failure('INVALID_REQUEST', `${request.action} requires a branch name.`);
  }
  if (own(request, 'message')) string(request.message, 'message', 65_536);
  if (request.action === 'commit' && (!own(request, 'message') || !request.message.trim())) {
    throw failure('INVALID_REQUEST', 'commit requires a nonblank message.');
  }
  if (request.action === 'history') {
    result.limit = own(request, 'limit') ? request.limit : 60;
    result.skip = own(request, 'skip') ? request.skip : 0;
    if (!Number.isSafeInteger(result.limit) || result.limit < 1 || result.limit > 200
        || !Number.isSafeInteger(result.skip) || result.skip < 0 || result.skip > 100_000) {
      throw failure('INVALID_REQUEST', 'history limit must be 1–200 and skip must be 0–100000.');
    }
  }
  return result;
}

function parseStatus(text) {
  const records = text.split('\0');
  const files = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') throw failure('INVALID_GIT_OUTPUT', 'Invalid porcelain status record.');
    const index = record[0];
    const worktree = record[1];
    const file = {
      path: record.slice(3), index, worktree,
      staged: index !== ' ' && index !== '?' && index !== '!',
      unstaged: worktree !== ' ' && worktree !== '!',
      untracked: index === '?' && worktree === '?',
      conflict: index === 'U' || worktree === 'U' || ['AA', 'DD'].includes(index + worktree),
    };
    // In porcelain v1 -z the destination comes first, then the unquoted original.
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      file.originalPath = records[++i];
      if (!file.originalPath) throw failure('INVALID_GIT_OUTPUT', 'Missing rename source in Git status.');
    }
    files.push(file);
  }
  return files;
}

/**
 * Standalone Git engine. The caller owns approvals, filesystem/network policy,
 * optional-lock suppression, output/process bounds, and --literal-pathspecs.
 * run(cwd, args, {signal, stdin?, allowedExitCodes?}) executes Git, never a shell.
 *
 * execute throws errors (Git failures retain exitCode/stdout/stderr/args). Reads:
 * summary => {repo,branch,head,upstream,ahead,behind,files,branches,remotes,stashes};
 * history => {commits:[{hash,shortHash,parents,author,date,subject,refs}],hasMore};
 * diff => {text,truncated}. branch/head/upstream are null when unavailable;
 * refs is a decoration string, parents is a string array. Mutations return
 * {action,repo,stdout,stderr,exitCode}; commit also returns hash.
 */
export class GitManager {
  #run;
  #tail = Promise.resolve();

  constructor(run) {
    if (typeof run !== 'function') throw new TypeError('GitManager requires a Git parameter executor.');
    this.#run = run;
  }

  execute(request, { cwd, signal } = {}) {
    // Snapshot and validate before queueing so a caller cannot mutate queued input.
    let input;
    try { input = validate(request, cwd); } catch (error) { return Promise.reject(error); }
    const next = this.#tail.then(() => this.#execute(input, signal));
    this.#tail = next.catch(() => {}); // Keep later requests usable; return the original rejecting promise.
    return next;
  }

  async #git(cwd, args, signal, { allowedExitCodes = [0], stdin, partial = false } = {}) {
    signal?.throwIfAborted();
    const options = { signal, allowedExitCodes };
    if (stdin !== undefined) options.stdin = stdin;
    const result = await this.#run(cwd, args, options);
    if (!result || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
        || !Number.isInteger(result.exitCode)) {
      throw failure('INVALID_EXECUTOR_RESULT', 'Git executor returned an invalid result.');
    }
    if (!allowedExitCodes.includes(result.exitCode)) throw this.#commandError(args, result);
    if (result.truncated && !partial) {
      throw failure('GIT_OUTPUT_TRUNCATED', 'Git output exceeded the execution bound; narrow the request.', { args, ...result });
    }
    return result;
  }

  #commandError(args, result, code = 'GIT_ERROR') {
    return failure(code, `git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || 'no diagnostic output'}`,
      { args: [...args], ...result });
  }

  async #repository(cwd, signal) {
    const args = ['rev-parse', '--show-toplevel'];
    const result = await this.#git(cwd, args, signal, { allowedExitCodes: [0, 128] });
    if (result.exitCode !== 0) {
      if (/not a git repository/i.test(result.stderr)) {
        throw failure('NOT_GIT_REPOSITORY', `Not a Git repository: ${cwd}`, { args, ...result });
      }
      throw this.#commandError(args, result);
    }
    const root = line(result.stdout);
    if (!path.isAbsolute(root)) throw failure('INVALID_GIT_OUTPUT', 'Git returned a nonabsolute repository root.');
    return root;
  }

  async #head(repo, signal) {
    const result = await this.#git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], signal, { allowedExitCodes: [0, 1] });
    return result.exitCode === 0 ? line(result.stdout) : null;
  }

  async #status(repo, signal) {
    return parseStatus((await this.#git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames'], signal)).stdout);
  }

  async #refs(repo, signal) {
    const format = '%(refname)%00%(HEAD)%00%(objectname)%00%(upstream:short)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)';
    const output = (await this.#git(repo, ['for-each-ref', `--format=${format}`, 'refs/heads/', 'refs/remotes/'], signal)).stdout;
    return output.split('\n').filter(Boolean).map((row) => {
      const [ref, current, hash, upstream, upstreamRef, remoteName, remoteRef] = row.split('\0');
      if (!hash || remoteRef === undefined) throw failure('INVALID_GIT_OUTPUT', 'Invalid Git branch record.');
      return { ref, name: ref.replace(/^refs\/(heads|remotes)\//, ''), current: current === '*',
        remote: ref.startsWith('refs/remotes/'), hash, upstream: upstream || null,
        upstreamRef, remoteName, remoteRef };
    });
  }

  async #remoteNames(repo, signal) {
    return (await this.#git(repo, ['remote'], signal)).stdout.split('\n').filter(Boolean);
  }

  async #branch(repo, name, signal) {
    const result = await this.#git(repo, ['check-ref-format', '--branch', name], signal);
    if (line(result.stdout) !== name) throw failure('INVALID_REQUEST', 'Branch shortcuts are not accepted; use an explicit branch name.');
  }

  async #summary(repo, signal) {
    const files = await this.#status(repo, signal);
    const head = await this.#head(repo, signal);
    const symbolic = await this.#git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal, { allowedExitCodes: [0, 1] });
    const branch = symbolic.exitCode === 0 ? line(symbolic.stdout) : null;
    const refs = await this.#refs(repo, signal);
    const current = refs.find((ref) => ref.current && !ref.remote);
    const upstream = current?.upstream ?? null;
    let ahead = 0;
    let behind = 0;
    if (head && current?.upstreamRef) {
      const exists = await this.#git(repo, ['show-ref', '--verify', '--quiet', current.upstreamRef], signal, { allowedExitCodes: [0, 1] });
      if (exists.exitCode === 0) {
        const counts = (await this.#git(repo, ['rev-list', '--left-right', '--count', `HEAD...${current.upstreamRef}`, '--'], signal)).stdout.trim().split(/\s+/).map(Number);
        if (counts.length !== 2 || counts.some((count) => !Number.isSafeInteger(count))) throw failure('INVALID_GIT_OUTPUT', 'Invalid ahead/behind counts.');
        [ahead, behind] = counts;
      }
    }
    const remotes = [];
    for (const name of await this.#remoteNames(repo, signal)) {
      remotes.push({ name, url: line((await this.#git(repo, ['remote', 'get-url', '--', name], signal)).stdout) });
    }
    const stashOutput = (await this.#git(repo, ['stash', 'list', '--format=%gd%x00%H%x00%gs', '-z'], signal)).stdout;
    const parts = stashOutput.split('\0');
    if (parts.at(-1) === '') parts.pop();
    if (parts.length % 3 !== 0) throw failure('INVALID_GIT_OUTPUT', 'Invalid stash list record.');
    const stashes = [];
    for (let i = 0; i < parts.length; i += 3) stashes.push({ ref: parts[i], hash: parts[i + 1], subject: parts[i + 2] });
    return { repo, branch, head, upstream, ahead, behind, files,
      branches: refs.map(({ name, current, remote, hash, upstream }) => ({ name, current, remote, hash, upstream })), remotes, stashes };
  }

  async #history(repo, input, signal) {
    const head = await this.#head(repo, signal);
    if (!head && !(await this.#refs(repo, signal)).length) return { commits: [], hasMore: false };
    const format = '%H%x00%h%x00%P%x00%an%x00%aI%x00%s%x00%D';
    const output = (await this.#git(repo, ['log', '--all', '--topo-order', `--max-count=${input.limit + 1}`, `--skip=${input.skip}`, `--format=${format}`, '-z', ...(head ? ['HEAD'] : []), '--'], signal)).stdout;
    const parts = output.split('\0');
    if (parts.at(-1) === '') parts.pop();
    if (parts.length % 7 !== 0) throw failure('INVALID_GIT_OUTPUT', 'Invalid Git history record.');
    const commits = [];
    for (let i = 0; i < parts.length; i += 7) {
      const [hash, shortHash, parents, author, date, subject, refs] = parts.slice(i, i + 7);
      commits.push({ hash, shortHash, parents: parents ? parents.split(' ') : [], author, date, subject, refs });
    }
    return { commits: commits.slice(0, input.limit), hasMore: commits.length > input.limit };
  }

  async #diff(repo, input, signal) {
    const paths = input.paths ?? (input.path ? [input.path] : []);
    const flags = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames'];
    const args = input.revision
      ? ['show', ...flags, '--format=fuller', `${input.revision}^{commit}`, '--', ...paths]
      : ['diff', ...flags, ...(input.staged ? ['--cached'] : []), '--', ...paths];
    const result = await this.#git(repo, args, signal, { partial: true });
    let text = result.stdout.slice(0, MAX_DIFF);
    let truncated = Boolean(result.truncated || result.stdout.length > MAX_DIFF);
    if (!input.revision && !input.staged && !truncated) {
      const matches = (file) => !paths.length || paths.some((selected) => selected === '.' || file.path === selected || file.path.startsWith(`${selected.replace(/\/$/, '')}/`));
      const untracked = (await this.#status(repo, signal)).filter((file) => file.untracked && matches(file));
      for (const file of untracked.slice(0, MAX_PATHS)) {
        const diff = await this.#git(repo, ['diff', '--no-index', ...flags, '--', '/dev/null', file.path], signal,
          { allowedExitCodes: [0, 1], partial: true });
        const remaining = MAX_DIFF - text.length;
        text += diff.stdout.slice(0, remaining);
        if (diff.truncated || diff.stdout.length > remaining) { truncated = true; break; }
      }
      if (untracked.length > MAX_PATHS) truncated = true;
    }
    return { text, truncated };
  }

  async #network(repo, input, signal) {
    const names = await this.#remoteNames(repo, signal);
    if (input.remote && !names.includes(input.remote)) throw failure('INVALID_REQUEST', 'remote must name an existing repository remote.');
    if (input.action === 'fetch') {
      const remote = input.remote ?? (names.includes('origin') ? 'origin' : names.length === 1 ? names[0] : null);
      if (!remote || remote.startsWith('-')) throw failure('INVALID_REQUEST', 'fetch requires an unambiguous existing remote.');
      return ['fetch', '--', remote];
    }
    const current = (await this.#refs(repo, signal)).find((ref) => ref.current && !ref.remote);
    if (!current?.upstreamRef || !current.remoteName || !current.remoteRef) {
      throw failure('NO_UPSTREAM', `${input.action} requires an existing upstream on the current branch.`);
    }
    if (!names.includes(current.remoteName) || current.remoteName.startsWith('-') || !current.remoteRef.startsWith('refs/heads/')) {
      throw failure('NO_UPSTREAM', 'Upstream must refer to a branch on a configured remote.');
    }
    if (input.remote && input.remote !== current.remoteName) throw failure('INVALID_REQUEST', 'remote must match the current branch upstream.');
    const exists = await this.#git(repo, ['show-ref', '--verify', '--quiet', current.upstreamRef], signal, { allowedExitCodes: [0, 1] });
    if (exists.exitCode !== 0) throw failure('NO_UPSTREAM', 'The configured upstream ref does not exist; fetch it first.');
    return input.action === 'pull'
      ? ['pull', '--ff-only', '--no-rebase', '--', current.remoteName, current.remoteRef]
      : ['push', '--porcelain', '--', current.remoteName, `HEAD:${current.remoteRef}`];
  }

  async #execute(input, signal) {
    signal?.throwIfAborted();
    if (input.action === 'init') {
      try {
        await this.#repository(input.cwd, signal);
      } catch (error) {
        if (error.code !== 'NOT_GIT_REPOSITORY') throw error;
        // Only empty existing directories: prevents both ancestor and descendant nesting.
        if ((await readdir(input.cwd)).length) throw failure('INIT_NOT_EMPTY', 'init requires an existing empty directory to prevent nested repositories.');
        const result = await this.#git(input.cwd, ['init', '--'], signal);
        return { action: input.action, repo: await this.#repository(input.cwd, signal), stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      }
      throw failure('NESTED_REPOSITORY', 'Refusing to initialize an existing repository or a directory inside a repository.');
    }
    const repo = await this.#repository(input.cwd, signal);
    if (input.action === 'summary') return this.#summary(repo, signal);
    if (input.action === 'history') return this.#history(repo, input, signal);
    if (input.action === 'diff') return this.#diff(repo, input, signal);
    if (input.branch) await this.#branch(repo, input.branch, signal);
    let args;
    let stdin;
    switch (input.action) {
      case 'stage':
      case 'unstage': {
        const paths = new Set(input.paths);
        for (const file of await this.#status(repo, signal)) {
          if (file.originalPath && (paths.has(file.path) || paths.has(file.originalPath))) {
            paths.add(file.path); paths.add(file.originalPath);
          }
        }
        args = input.action === 'stage' ? ['add', '-A', '--', ...paths]
          : await this.#head(repo, signal) ? ['restore', '--staged', '--source=HEAD', '--', ...paths]
            : ['rm', '--cached', '-r', '--force', '--ignore-unmatch', '--', ...paths];
        break;
      }
      case 'commit': args = ['commit', '--file=-']; stdin = input.message; break;
      case 'switch': args = ['switch', '--', input.branch]; break;
      case 'createBranch': args = ['branch', '--', input.branch]; break;
      case 'deleteBranch': args = ['branch', '-d', '--', input.branch]; break;
      case 'merge': args = ['merge', '--no-edit', '--', input.branch]; break;
      case 'fetch': case 'pull': case 'push': args = await this.#network(repo, input, signal); break;
      case 'stash': args = ['stash', 'push', ...(input.message ? ['--message', input.message] : [])]; break;
      case 'stashPop': args = ['stash', 'pop']; break;
      default: throw failure('INVALID_REQUEST', 'Unsupported Git action.');
    }
    const conflictAction = input.action === 'stashPop' || input.action === 'merge';
    const result = await this.#git(repo, args, signal, { stdin, allowedExitCodes: conflictAction ? [0, 1] : [0] });
    if (result.exitCode !== 0) {
      const conflicts = (await this.#status(repo, signal)).filter((file) => file.conflict).map((file) => file.path);
      const error = this.#commandError(args, result, conflicts.length ? 'GIT_CONFLICT' : 'GIT_ERROR');
      if (conflicts.length) { error.conflicts = conflicts; error.message += ` Conflicts require manual resolution: ${conflicts.join(', ')}`; }
      throw error;
    }
    const response = { action: input.action, repo, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    if (input.action === 'commit') response.hash = await this.#head(repo, signal);
    return response;
  }
}
