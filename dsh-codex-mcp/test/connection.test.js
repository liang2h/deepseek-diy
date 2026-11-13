import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import test from 'node:test';
import { publicToolName } from '../config.js';
import {
  LONG_NAME, connection, stdioConnection, httpFixture, invoke, textValue,
  waitForRecord, waitForState,
} from './helpers.js';

const TEST_TIMEOUT = { timeout: 10000 };

test('real SDK stdio connects, discovers filtered tools and invokes the exact raw long name', TEST_TIMEOUT, async (t) => {
  const handle = await stdioConnection(t, { fields: `enabled_tools=${JSON.stringify(['echo', LONG_NAME, 'not-advertised'])}\ndisabled_tools=["echo"]` });
  await handle.value.connect();
  assert.equal(handle.value.state, 'ready');
  const publicName = publicToolName('test_stdio', LONG_NAME);
  assert.match(publicName, /^[A-Za-z0-9_-]{64}$/);
  assert.deepEqual([...handle.ctx.registered.keys()], [publicName]);
  assert.deepEqual(handle.value.status().missingTools, ['not-advertised']);
  const result = textValue(await invoke(handle.value, LONG_NAME, { query: 'local synthetic request' }));
  assert.equal(result.name, LONG_NAME);
  assert.deepEqual(result.arguments, { query: 'local synthetic request' });
  assert.equal(result.cwd, await realpath(handle.root));
  assert.equal(handle.ctx.resolvedExecutables[0].command, process.execPath);
  const records = await handle.records();
  assert.equal(records.filter((item) => item.method === 'initialize').length, 1);
  assert.equal(records.filter((item) => item.method === 'tools/list').length, 1);
  assert.equal(records.filter((item) => item.method === 'tools/call').length, 1);
  assert.equal(records.find((item) => item.method === 'tools/call').params.name, LONG_NAME);
  await handle.value.dispose();
  assert.equal(handle.ctx.registered.size, 0);
  assert.equal(handle.value.state, 'stopped');
});

test('real SDK HTTP uses initialize/list/call and tolerates GET 405 without SSE', TEST_TIMEOUT, async (t) => {
  const fixture = await httpFixture(t);
  const handle = connection(t, fixture.config(`enabled_tools=${JSON.stringify([LONG_NAME])}`));
  await handle.value.connect();
  assert.equal(handle.value.state, 'ready');
  const result = textValue(await invoke(handle.value, LONG_NAME, { value: 7 }));
  assert.deepEqual(result, { name: LONG_NAME, arguments: { value: 7 } });
  const get = await fixture.waitForRequest((item) => item.method === 'GET');
  assert.equal(get.method, 'GET');
  assert.equal(fixture.requests.filter((item) => item.message?.method === 'initialize').length, 1);
  assert.equal(fixture.requests.filter((item) => item.message?.method === 'tools/list').length, 1);
  assert.equal(fixture.requests.filter((item) => item.message?.method === 'tools/call').length, 1);
  assert.equal(handle.ctx.resolvedExecutables.length, 0);
  await handle.value.dispose();
});

test('stdio scrubs ambient secrets and DSH facts while keeping explicit env and credential references', TEST_TIMEOUT, async (t) => {
  const previous = { FAKE_SECRET: process.env.FAKE_SECRET, DSH_TEST_MARKER: process.env.DSH_TEST_MARKER };
  process.env.FAKE_SECRET = 'FAKE_AMBIENT_SECRET_MUST_NOT_REACH_CHILD';
  process.env.DSH_TEST_MARKER = 'FAKE_AMBIENT_DSH_FACT';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const handle = await stdioConnection(t, {
    fields: 'env={TEST_VALUE="explicit-value",TEST_SECRET="FAKE_EXPLICIT_SECRET"}\nenv_vars=["EXPLICIT_CREDENTIAL"]',
    credentials: { EXPLICIT_CREDENTIAL: 'FAKE_EXPLICIT_REFERENCE_VALUE', UNREQUESTED_SECRET: 'FAKE_NOT_RESOLVED' },
  });
  await handle.value.connect();
  assert.equal(handle.value.state, 'ready');
  const result = textValue(await invoke(handle.value, 'echo'));
  assert.deepEqual(result.env, {
    TEST_VALUE: 'explicit-value', TEST_SECRET: 'FAKE_EXPLICIT_SECRET', FAKE_SECRET: null,
    DSH_TEST_MARKER: null, EXPLICIT_CREDENTIAL: 'FAKE_EXPLICIT_REFERENCE_VALUE',
  });
  assert.deepEqual(handle.ctx.resolvedCredentials, ['EXPLICIT_CREDENTIAL']);
  assert.equal(handle.ctx.logs.length, 0);
  assert.equal(JSON.stringify(handle.states).includes('FAKE_'), false);
});

test('env_vars explicit inline values take precedence and missing references fail without echoing secrets', TEST_TIMEOUT, async (t) => {
  const explicit = await stdioConnection(t, {
    fields: 'env={EXPLICIT_CREDENTIAL="FAKE_INLINE_VALUE"}\nenv_vars=["EXPLICIT_CREDENTIAL"]',
    credentials: { EXPLICIT_CREDENTIAL: 'FAKE_REFERENCE_VALUE' },
  });
  await explicit.value.connect();
  assert.equal(textValue(await invoke(explicit.value, 'echo')).env.EXPLICIT_CREDENTIAL, 'FAKE_INLINE_VALUE');
  const missing = await stdioConnection(t, { fields: 'env_vars=["FAKE_MISSING_SECRET_REF"]' });
  await missing.value.connect();
  assert.equal(missing.value.state, 'error');
  assert.equal(missing.ctx.resolvedExecutables.length, 0);
  assert.equal((await missing.records()).length, 0);
  assert.equal(JSON.stringify(missing.states).includes('FAKE_MISSING_SECRET_REF'), false);
  assert.equal(missing.ctx.logs.length, 0);
});

for (const mode of ['startup-hang', 'list-hang']) {
  test(`stdio bounds ${mode} with startup timeout and drains secret-bearing stderr`, TEST_TIMEOUT, async (t) => {
    const handle = await stdioConnection(t, { fields: `startup_timeout_sec=0.3\nenv={TEST_MODE="${mode}"}` });
    const began = Date.now();
    await handle.value.connect();
    assert.equal(handle.value.state, 'error');
    assert.ok(Date.now() - began < 2500, 'startup and discovery must both be bounded');
    assert.match(handle.value.diagnostic, /超时|取消/);
    assert.equal(handle.ctx.registered.size, 0);
    assert.equal(handle.ctx.logs.length, 0);
    assert.equal(JSON.stringify(handle.states).includes('TEST_STDERR_FAKE_SECRET'), false);
    const records = await handle.records();
    assert.equal(records.filter((item) => item.event === 'spawn').length, 1);
    assert.equal(records.filter((item) => item.method === 'tools/call').length, 0);
    await handle.value.dispose();
    assert.equal(handle.value.timer?._destroyed ?? true, true);
  });
}

test('stdio call timeout sends cancellation, does not replay, and leaves other tools usable', TEST_TIMEOUT, async (t) => {
  const handle = await stdioConnection(t, { fields: 'tool_timeout_sec=0.12' });
  await handle.value.connect();
  const failed = assert.rejects(invoke(handle.value, 'slow', { marker: 'one-attempt' }), /未自动重放/);
  const request = await waitForRecord(handle.eventLog, (item) => item.method === 'tools/call' && item.params.name === 'slow');
  await failed;
  await waitForRecord(handle.eventLog, (item) => item.method === 'notifications/cancelled' && item.params.requestId === request.id);
  assert.equal(handle.value.state, 'ready');
  assert.equal(textValue(await invoke(handle.value, 'echo', { afterTimeout: true })).arguments.afterTimeout, true);
  assert.equal((await handle.records()).filter((item) => item.method === 'tools/call' && item.params.name === 'slow').length, 1);
});

test('stdio caller abort sends cancellation and never repeats the original business request', TEST_TIMEOUT, async (t) => {
  const handle = await stdioConnection(t);
  await handle.value.connect();
  const controller = new AbortController();
  const failed = assert.rejects(invoke(handle.value, 'slow', { marker: 'abort' }, controller.signal), /未自动重放/);
  const request = await waitForRecord(handle.eventLog, (item) => item.method === 'tools/call' && item.params.name === 'slow');
  controller.abort(new Error('FAKE_ABORT_SECRET_DO_NOT_SURFACE'));
  await failed;
  await waitForRecord(handle.eventLog, (item) => item.method === 'notifications/cancelled' && item.params.requestId === request.id);
  assert.equal((await handle.records()).filter((item) => item.method === 'tools/call').length, 1);
  assert.equal(JSON.stringify(handle.states).includes('FAKE_ABORT_SECRET'), false);
});

test('stdio disconnect removes tools, reconnects only the session, and never replays a business call', TEST_TIMEOUT, async (t) => {
  const handle = await stdioConnection(t);
  await handle.value.connect();
  await assert.rejects(invoke(handle.value, 'disconnect', { operationId: 'never-replay-me' }), /未自动重放/);
  await waitForState(handle, (states) => states.filter((item) => item.state === 'ready').length >= 2);
  const disconnected = handle.states.find((item) => item.state === 'disconnected');
  assert.ok(disconnected);
  assert.equal(disconnected.tools, 0);
  const records = await handle.records();
  assert.equal(records.filter((item) => item.event === 'spawn').length, 2);
  assert.equal(records.filter((item) => item.method === 'tools/call' && item.params.name === 'disconnect').length, 1);
  assert.equal(textValue(await invoke(handle.value, 'echo', { reconnected: true })).arguments.reconnected, true);
});

test('dispose aborts pending stdio calls and prevents reconnect or stale definition execution', TEST_TIMEOUT, async (t) => {
  const handle = await stdioConnection(t);
  await handle.value.connect();
  const retained = handle.value.tools.get(publicToolName('test_stdio', 'echo')).definition;
  const failed = assert.rejects(invoke(handle.value, 'slow'), /未自动重放/);
  await waitForRecord(handle.eventLog, (item) => item.method === 'tools/call' && item.params.name === 'slow');
  await handle.value.dispose();
  await failed;
  await assert.rejects(retained.execute({}, { signal: new AbortController().signal }), /未自动重放|not ready/);
  assert.equal(handle.value.state, 'stopped');
  assert.equal(handle.ctx.registered.size, 0);
  await handle.value.connect();
  assert.equal((await handle.records()).filter((item) => item.event === 'spawn').length, 1);
});

test('stdio JSON-RPC errors and isError tool results cannot leak upstream secret messages', TEST_TIMEOUT, async (t) => {
  const handle = await stdioConnection(t);
  await handle.value.connect();
  for (const name of ['rpc_error', 'is_error']) {
    await assert.rejects(invoke(handle.value, name), (error) => {
      assert.match(error.message, /未自动重放/);
      assert.equal(error.message.includes('FAKE_REMOTE_SECRET'), false);
      assert.equal(error.stack.includes('FAKE_REMOTE_SECRET'), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.equal(handle.ctx.logs.length, 0);
});

test('concurrent connect requests share one startup generation', TEST_TIMEOUT, async (t) => {
  const handle = await stdioConnection(t);
  await Promise.all([handle.value.connect(), handle.value.connect(), handle.value.connect()]);
  const records = await handle.records();
  assert.equal(handle.value.state, 'ready');
  assert.equal(records.filter((item) => item.event === 'spawn').length, 1);
  assert.equal(records.filter((item) => item.method === 'initialize').length, 1);
  assert.equal(records.filter((item) => item.method === 'tools/list').length, 1);
});

test('HTTP resolves only explicit header references, sends bearer auth, and avoids OAuth when auth exists', TEST_TIMEOUT, async (t) => {
  const fixture = await httpFixture(t);
  let oauthCalls = 0;
  const handle = connection(t, fixture.config(`http_headers={"X-Static"="local-value"}\nenv_http_headers={"X-Secret"="EXPLICIT_HTTP_SECRET"}\nbearer_token_env_var="EXPLICIT_HTTP_BEARER"`), {
    credentials: { EXPLICIT_HTTP_SECRET: 'FAKE_HEADER_SECRET', EXPLICIT_HTTP_BEARER: 'FAKE_BEARER_VALUE', UNREQUESTED_SECRET: 'FAKE_UNUSED' },
    oauth: { async provider() { oauthCalls++; throw new Error('FAKE_MUST_NOT_BE_CALLED'); } },
  });
  await handle.value.connect();
  assert.equal(handle.value.state, 'ready');
  await invoke(handle.value, 'echo');
  const posts = fixture.requests.filter((item) => item.method === 'POST');
  assert.ok(posts.length >= 3);
  for (const request of posts) {
    assert.equal(request.headers['x-static'], 'local-value');
    assert.equal(request.headers['x-secret'], 'FAKE_HEADER_SECRET');
    assert.equal(request.headers.authorization, 'Bearer FAKE_BEARER_VALUE');
  }
  assert.deepEqual(handle.ctx.resolvedCredentials, ['EXPLICIT_HTTP_SECRET', 'EXPLICIT_HTTP_BEARER']);
  assert.equal(oauthCalls, 0);
  assert.equal(JSON.stringify(handle.states).includes('FAKE_'), false);
  assert.equal(handle.ctx.logs.length, 0);
});

test('HTTP without static Authorization receives the configured OAuth provider once', TEST_TIMEOUT, async (t) => {
  const fixture = await httpFixture(t);
  let providerCalls = 0;
  const handle = connection(t, fixture.config(), {
    oauth: { async provider() {
      providerCalls++;
      return { tokens: async () => undefined, clientInformation: async () => undefined,
        clientMetadata: { client_name: 'local-test', redirect_uris: [] } };
    } },
  });
  await handle.value.connect();
  assert.equal(handle.value.state, 'ready');
  assert.equal(providerCalls, 1);
  assert.equal(textValue(await invoke(handle.value, 'echo')).name, 'echo');
});

for (const phase of ['initialize', 'list']) {
  test(`HTTP ${phase} is bounded by startup timeout without secret diagnostics`, TEST_TIMEOUT, async (t) => {
    const fixture = await httpFixture(t, { hangInitialize: phase === 'initialize', hangList: phase === 'list' });
    const handle = connection(t, fixture.config('startup_timeout_sec=0.2'));
    const began = Date.now();
    await handle.value.connect();
    assert.equal(handle.value.state, 'error');
    assert.ok(Date.now() - began < 2000);
    assert.equal(handle.ctx.registered.size, 0);
    assert.match(handle.value.diagnostic, /超时|取消/);
    await handle.value.dispose();
  });
}

test('HTTP call timeouts, caller aborts and transport failures do not replay tool requests', TEST_TIMEOUT, async (t) => {
  const fixture = await httpFixture(t);
  const handle = connection(t, fixture.config('tool_timeout_sec=0.15'));
  await handle.value.connect();
  assert.equal(handle.value.state, 'ready');
  await assert.rejects(invoke(handle.value, 'slow', { operationId: 'timeout-once' }), /未自动重放/);
  const controller = new AbortController();
  const failed = assert.rejects(invoke(handle.value, 'slow', { operationId: 'abort-once' }, controller.signal), /未自动重放/);
  await fixture.waitForRequest((item) => item.message?.params?.arguments?.operationId === 'abort-once');
  controller.abort(new Error('FAKE_HTTP_ABORT_SECRET'));
  await failed;
  await assert.rejects(invoke(handle.value, 'disconnect', { operationId: 'drop-once' }), /未自动重放/);
  assert.equal(textValue(await invoke(handle.value, 'echo', { usable: true })).arguments.usable, true);
  const calls = fixture.requests.filter((item) => item.message?.method === 'tools/call');
  for (const operationId of ['timeout-once', 'abort-once', 'drop-once']) {
    assert.equal(calls.filter((item) => item.message.params.arguments.operationId === operationId).length, 1);
  }
  assert.equal(handle.ctx.logs.length, 0);
});

test('HTTP JSON-RPC errors and missing credential failures are secret-opaque', TEST_TIMEOUT, async (t) => {
  const fixture = await httpFixture(t);
  const handle = connection(t, fixture.config());
  await handle.value.connect();
  await assert.rejects(invoke(handle.value, 'rpc_error'), (error) => {
    assert.match(error.message, /未自动重放/);
    assert.equal(error.message.includes('FAKE_HTTP_REMOTE_SECRET'), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  const missing = connection(t, fixture.config('bearer_token_env_var="FAKE_MISSING_BEARER_SECRET"'));
  const before = fixture.requests.length;
  await missing.value.connect();
  assert.equal(missing.value.state, 'error');
  assert.equal(fixture.requests.length, before);
  assert.equal(JSON.stringify(missing.states).includes('FAKE_MISSING_BEARER_SECRET'), false);
  assert.equal(missing.ctx.logs.length, 0);
});
