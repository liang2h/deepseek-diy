import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Checks the actual shipped client dependency declaration and source action callbacks.
// No React, DOM, browser, directory dialog or live RPC is simulated/rendered here.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const declaration = source.match(/^\s*inject:\s*\[([^\]]*)\]/m);
assert.ok(declaration, 'Client plugin must declare its service dependencies');
const dependencies = new Set([...declaration[1].matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]));
const callSource = source.match(/        async function call\(sessionId, request, signal\) \{[\s\S]*?(?=        function Body\()/)?.[0];
const chooseSource = source.match(/          async function choose\(\) \{[\s\S]*?(?=          async function changeView\()/)?.[0];
assert.ok(callSource);
assert.ok(chooseSource);

function guardedContext({call, pickDirectory} = {}) {
  return {
    get connection() {
      assert.ok(dependencies.has('connection'), 'cannot get property "connection" without inject');
      return {rpc: {call}};
    },
    get uiWorkspace() {
      assert.ok(dependencies.has('uiWorkspace'), 'cannot get property "uiWorkspace" without inject');
      return {pickDirectory};
    }
  };
}
function makeCall(ctx) {
  return new Function('ctx', 't', `${callSource}\nreturn call;`)(ctx, key => key);
}
function makeChoose(ctx) {
  const state = {input: '', repo: '', notices: []};
  const choose = new Function('ctx', 'setRepoInput', 'setRepo', 'setNotice', `${chooseSource}\nreturn choose;`)(
    ctx, value => {state.input = value;}, value => {state.repo = value;}, value => state.notices.push(value));
  return {state, choose};
}

test('every directly accessed Client service is injected', () => {
  for (const match of source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    const [, root] = match;
    if (root === 'effect') continue;
    assert.ok(dependencies.has(root), `Missing inject: ${root}`);
  }
});

test('package loads Connection and public directory-picker owner without command transport', () => {
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'));
  assert.match(chooseSource, /ctx\.uiWorkspace\.pickDirectory\(\)/);
  assert.doesNotMatch(source, /ctx\.remote\.|\/git-workbench\s/);
});

test('only sidebar guide and tab registrations remain; no header launcher', () => {
  assert.doesNotMatch(source, /conversation\.session\.header\.utilities|function Launcher|gwb-launch/);
  assert.match(source, /ctx\.sidebarRightTabs\.register\(\{id: ID, kind: KIND/);
  assert.match(source, /guide: \[\{id: 'git'/);
  assert.match(source, /ctx\.slots\.register\(\{name: 'sidebar\.right\.pane\.tab', key: ID/);
});

test('Git action callback reaches dedicated RPC with session, request and signal', async () => {
  const signal = new AbortController().signal;
  const request = {action: 'summary', repo: '/tmp/中文 repo'};
  const expected = {repo: request.repo, files: []};
  const ctx = guardedContext({call: async (...args) => {
    assert.deepEqual(args, ['/api', 'local-git-workbench/execute', {sessionId: 'session-contract', request}, signal]);
    return {ok: true, value: expected};
  }});
  assert.deepEqual(await makeCall(ctx)('session-contract', request, signal), expected);
});

test('all Git button operations share the dependency-checked RPC path', async () => {
  const seen = [];
  const ctx = guardedContext({call: async (_channel, _method, {request}) => {
    seen.push(request.action);
    return {ok: true, value: {}};
  }});
  const call = makeCall(ctx);
  const actions = ['summary', 'history', 'diff', 'stage', 'unstage', 'commit', 'switch', 'createBranch', 'deleteBranch', 'fetch', 'pull', 'push', 'stash', 'stashPop', 'merge', 'init'];
  for (const action of actions) await call('session-contract', {action}, new AbortController().signal);
  assert.deepEqual(seen, actions);
});

test('Git callback propagates transport and operation failures instead of masking them', async () => {
  const error = new Error('transport refused');
  await assert.rejects(makeCall(guardedContext({call: async () => {throw error;}}))('s', {action: 'summary'}), value => value === error);
  await assert.rejects(makeCall(guardedContext({call: async () => ({ok: false, error: {message: 'Not a Git repository'}})}))('s', {action: 'summary'}), /Not a Git repository/);
});

test('pre-aborted Git callbacks start no transport request', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled before RPC'));
  let calls = 0;
  await assert.rejects(makeCall(guardedContext({call: async () => {calls++;}}))('s', {action: 'summary'}, controller.signal), /cancelled before RPC/);
  assert.equal(calls, 0);
});

test('directory selection uses public picker string result, not RemoteResult shape', async () => {
  const {choose, state} = makeChoose(guardedContext({pickDirectory: async () => '/tmp/中文 repo'}));
  await choose();
  assert.deepEqual(state, {input: '/tmp/中文 repo', repo: '/tmp/中文 repo', notices: []});
});

test('cancelled directory selection leaves the repository unchanged', async () => {
  const {choose, state} = makeChoose(guardedContext({pickDirectory: async () => null}));
  await choose();
  assert.deepEqual(state, {input: '', repo: '', notices: []});
});

test('directory picker failures produce a visible error notice', async () => {
  const {choose, state} = makeChoose(guardedContext({pickDirectory: async () => {throw new Error('Picker unavailable');}}));
  await choose();
  assert.deepEqual(state.notices, [{error: true, text: 'Picker unavailable'}]);
  assert.equal(state.repo, '');
});
