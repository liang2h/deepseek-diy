import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {openAuthorizationBrowser} from '../browser.js';
const url = 'https://issuer.example/authorize?response_type=code&state=FAKE_STATE&code_challenge=FAKE_CHALLENGE';
const child = () => Object.assign(new EventEmitter(), {pid: 12345});

test('browser handoff uses the default application exactly once and never waits for browser exit', async () => {
  const calls = [], native = child(); let drained = 0;
  native.stdout = native.stderr = {resume() {++drained;}};
  const result = await openAuthorizationBrowser(url, {openFn: async (...args) => {calls.push(args); return native;}});
  assert.deepEqual(calls, [[url, {wait: false}]]);
  assert.deepEqual(result, {state: 'requested'}); assert.equal(drained, 2);
  assert.doesNotThrow(() => native.emit('error', new Error('FAKE_SECRET_NATIVE_ERROR')));
  assert.equal(JSON.stringify(result).includes('FAKE_SECRET'), false);
});

test('browser handoff permits loopback HTTP OAuth pages but rejects unsafe or shell-interpretable URLs', async () => {
  let opened = 0;
  const openFn = async () => {++opened; return child();};
  for (const target of ['http://127.0.0.1:1234/authorize', 'http://[::1]:1234/authorize', 'http://localhost:1234/authorize'])
    assert.equal((await openAuthorizationBrowser(target, {openFn})).state, 'requested');
  for (const target of ['file:///tmp/authorize', 'javascript:alert(1)', 'ftp://issuer.example/auth',
    'http://issuer.example/auth', 'http://localhost.evil/auth', 'https://user:FAKE_SECRET@issuer.example/auth',
    'https://issuer.example/auth#fragment', 'https://issuer.example/$(command)', 'https://issuer.example/`command`',
    'https://issuer.example/"command"', 'https://issuer.example/\ncommand', 'https://issuer.example/\\command',
    'https://issuer.example/' + 'a'.repeat(16384)]) {
    assert.deepEqual(await openAuthorizationBrowser(target, {openFn}), {state: 'manual', reason: 'invalid_url'});
  }
  assert.equal(opened, 3);
});

test('browser handoff preserves percent-encoded OAuth state rather than reinterpreting it as shell data', async () => {
  const target = 'https://issuer.example/auth?state=%24%28FAKE%29%22%60%27&scope=mcp%3Aread';
  let opened;
  assert.equal((await openAuthorizationBrowser(target, {openFn: async value => {opened = value; return child();}})).state, 'requested');
  assert.equal(opened, target);
});

test('browser launcher rejection and spawn errors produce secret-free manual fallback', async () => {
  assert.deepEqual(await openAuthorizationBrowser(url, {openFn: async () => {throw new Error('FAKE_SECRET_' + url);}}),
    {state: 'manual', reason: 'open_failed'});
  const native = new EventEmitter();
  assert.deepEqual(await openAuthorizationBrowser(url, {openFn: async () => {
    setImmediate(() => native.emit('error', new Error('FAKE_SECRET_NATIVE_ERROR'))); return native;
  }}), {state: 'manual', reason: 'open_failed'});
});

test('browser handoff deadline falls back without occupying the OAuth five-minute callback window', async () => {
  assert.deepEqual(await openAuthorizationBrowser(url, {timeoutMs: 10, openFn: async () => new Promise(() => {})}),
    {state: 'manual', reason: 'open_timeout'});
});

test('browser handoff honors cancellation before launch and during launcher startup', async () => {
  const aborted = new AbortController(); aborted.abort(); let opened = 0;
  assert.deepEqual(await openAuthorizationBrowser(url, {signal: aborted.signal, openFn: async () => {++opened;}}),
    {state: 'manual', reason: 'cancelled'});
  assert.equal(opened, 0);
  const controller = new AbortController(); let finish;
  const pending = openAuthorizationBrowser(url, {signal: controller.signal, openFn: async () => new Promise(resolve => {finish = resolve;})});
  controller.abort(); assert.deepEqual(await pending, {state: 'manual', reason: 'cancelled'});
  finish(child());
});
