import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAuthManager, NeedAuthError, oauthCredentialKey } from '../oauth.js';
import {OAuthError, oauthFailureDetails} from '../oauth-errors.js';
import {commandErrorText} from '../runtime.js';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import {createRequire} from 'node:module';
import {mkdtemp, realpath, readFile, rm, stat} from 'node:fs/promises';
import {join, basename, dirname} from 'node:path';
import {tmpdir} from 'node:os';
const providerRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-credentials-local'));
const {Context} = await import(providerRequire.resolve('@deepseek-ai/cordis'));

async function localCredentials(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-mcp-credentials-')));
  const path = join(root, 'test-credentials.yaml');
  const fibers = [];
  const reopen = async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(LocalCredentialProvider, {path, dshHome: root, watch: false});
    fibers.push(fiber); await fiber;
    return ctx.credentials;
  };
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    const target = await realpath(root);
    assert.equal(target, root); assert.equal(dirname(target), await realpath(tmpdir()));
    assert.match(basename(target), /^codex-mcp-credentials-/);
    await rm(target, {recursive: true, force: true});
  });
  return {credentials: await reopen(), path, reopen};
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const server = { name: 'example', url: 'https://mcp.example/mcp', scopes: ['read'] };
const ISSUER = 'https://issuer.example';
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** In-memory credential seam with the same per-key transaction semantics. */
class Credentials {
  records = new Map();
  queues = new Map();
  references = new Map();
  async exclusive(key, action) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const done = deferred();
    this.queues.set(key, done.promise);
    await previous;
    try { return await action(); }
    finally { done.resolve(); }
  }
  async modifyRecord(key, mutate) {
    return this.exclusive(key, async () => {
      const value = await mutate(structuredClone(this.records.get(key)));
      if (value !== undefined) {
        assert.deepEqual(value, JSON.parse(JSON.stringify(value)), 'grant payload must round-trip through JSON like the real DSH store');
        this.records.set(key, structuredClone(value));
      }
      return structuredClone(this.records.get(key));
    });
  }
  async readRecord(key) {
    return this.exclusive(key, async () => structuredClone(this.records.get(key)));
  }
  async deleteRecord(key) {
    return this.exclusive(key, async () => { this.records.delete(key); });
  }
  async resolve(ref) {
    return this.references.has(ref) ? { value: this.references.get(ref), source: 'test' } : undefined;
  }
}

/** All SDK discovery, DCR and token HTTP calls are intercepted, never sent. */
function mockOAuth() {
  const calls = { registration: [], code: [], refresh: [], discovery: [] };
  let refreshFailure;
  let refreshHook;
  let registrationFailure;
  let metadataIssuer = ISSUER;
  const fetchFn = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/.well-known/oauth-protected-resource')) {
      calls.discovery.push(url);
      return json({ resource: server.url, authorization_servers: [ISSUER], scopes_supported: ['read'] });
    }
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      calls.discovery.push(url);
      return json({
        issuer: metadataIssuer,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url === `${ISSUER}/register`) {
      calls.registration.push(JSON.parse(init.body));
      if (registrationFailure) return registrationFailure();
      return json({ ...JSON.parse(init.body), client_id: 'public-test-client' });
    }
    if (url === `${ISSUER}/token`) {
      const body = new URLSearchParams(init.body);
      if (body.get('grant_type') === 'authorization_code') {
        calls.code.push(body);
        return json({ access_token: 'access-1-SECRET', refresh_token: 'refresh-1-SECRET', token_type: 'Bearer', expires_in: 3600 });
      }
      assert.equal(body.get('grant_type'), 'refresh_token');
      calls.refresh.push(body);
      if (refreshHook) await refreshHook(init);
      if (refreshFailure) return refreshFailure();
      return json({ access_token: 'access-2-SECRET', refresh_token: 'refresh-2-SECRET', token_type: 'Bearer', expires_in: 3600 });
    }
    throw new Error('Unexpected mock OAuth request (URL deliberately omitted).');
  };
  return {
    calls, fetchFn,
    setRefreshFailure(value) { refreshFailure = value; },
    setRefreshHook(value) { refreshHook = value; },
    setRegistrationFailure(value) { registrationFailure = value; },
    setMetadataIssuer(value) { metadataIssuer = value; },
  };
}

function callbackURL(login, overrides = {}) {
  const authorization = new URL(login.url);
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.searchParams.set('code', 'test-authorization-code');
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  callback.searchParams.set('iss', ISSUER);
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) callback.searchParams.delete(name);
    else callback.searchParams.set(name, value);
  }
  return callback;
}

function fixture(t, options = {}) {
  const credentials = options.credentials ?? new Credentials();
  const mock = mockOAuth();
  const completed = deferred();
  let clock = 1_800_000_000_000;
  let completions = 0;
  const manager = new OAuthManager({
    credentials, projectRoot, server,
    fetchFn: mock.fetchFn,
    nowFn: () => clock,
    onAuthorized: () => { ++completions; completed.resolve(); },
    ...options,
  });
  t.after(() => manager.dispose());
  return {
    manager, credentials, mock, completed,
    advance(ms) { clock += ms; },
    get completions() { return completions; },
    async login() {
      const login = await manager.startLogin();
      const response = await fetch(callbackURL(login));
      assert.equal(response.status, 200);
      await response.text();
      await completed.promise;
      return login;
    },
  };
}

function assertSecretFree(value) {
  const output = JSON.stringify(value);
  for (const secret of ['access-1-SECRET', 'refresh-1-SECRET', 'access-2-SECRET', 'refresh-2-SECRET', 'UPSTREAM-SECRET']) {
    assert.ok(!output.includes(secret), 'public result must omit secret material');
  }
}

test('credential key binds canonical project root, server name and canonical URL', async () => {
  const key = await oauthCredentialKey(projectRoot, server);
  assert.match(key, /^codex-mcp\/project-[a-f0-9]{64}$/);
  assert.equal(key, await oauthCredentialKey(resolve(projectRoot, 'test', '..'), server));
  assert.equal(key, await oauthCredentialKey(projectRoot, { ...server, url: 'https://MCP.EXAMPLE:443/mcp' }));
  assert.notEqual(key, await oauthCredentialKey(projectRoot, { ...server, name: 'other' }));
  assert.notEqual(key, await oauthCredentialKey(projectRoot, { ...server, url: `${server.url}/other` }));
  assert.notEqual(key, await oauthCredentialKey(resolve(projectRoot, '..'), server));
  assert.ok(!key.includes('mcp.example'));
  assert.notEqual(key, await oauthCredentialKey(projectRoot, { ...server, oauth: { clientId: 'another' } }));
  assert.notEqual(key, await oauthCredentialKey(projectRoot, { ...server, oauth: { clientSecretEnvVar: 'ANOTHER_SECRET' } }));
  assert.notEqual(key, await oauthCredentialKey(projectRoot, { ...server, scopes: ['write'] }));
  assert.equal(
    await oauthCredentialKey(projectRoot, { ...server, scopes: ['read', 'write'] }),
    await oauthCredentialKey(projectRoot, { ...server, scopes: ['write', 'read', 'read'] }),
  );
});

test('background provider never invokes auth, registration, callback or browser on 401', async t => {
  let authCalls = 0;
  const f = fixture(t, {
    authFn: async () => { ++authCalls; throw new Error('must not execute'); },
    createServerFn: () => { throw new Error('must not listen'); },
  });
  const provider = await f.manager.provider();
  assert.deepEqual(Object.keys(provider).sort(), ['onUnauthorized', 'token']);
  assert.equal(await provider.token(), undefined);
  await assert.rejects(provider.onUnauthorized({}), error => error instanceof NeedAuthError && error.code === 'need_auth');
  await assert.rejects(f.manager.authorize(), { code: 'need_auth' });
  assert.deepEqual(await f.manager.status(), { state: 'need_auth', error: 'need_auth', safeErrorCode: 'need_auth' });
  assert.equal(authCalls, 0);
});

test('official SDK DCR + PKCE login returns copyable URL before callback; validates state/issuer', async t => {
  const f = fixture(t);
  const login = await f.manager.startLogin();
  assert.deepEqual(Object.keys(login).sort(), ['expiresAt', 'url']);
  assert.equal(f.completions, 0);
  assert.equal(f.mock.calls.code.length, 0);
  assert.deepEqual(await f.manager.status(), { state: 'pending', expiresAt: login.expiresAt });
  const authURL = new URL(login.url);
  assert.equal(authURL.origin, ISSUER);
  assert.equal(authURL.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authURL.searchParams.get('response_type'), 'code');
  assert.equal(authURL.searchParams.get('client_id'), 'public-test-client');
  assert.ok(authURL.searchParams.get('state').length >= 32);
  const redirect = new URL(authURL.searchParams.get('redirect_uri'));
  assert.equal(redirect.hostname, '127.0.0.1');
  assert.equal(redirect.protocol, 'http:');
  assert.ok(Number(redirect.port) > 0);
  assert.equal(f.mock.calls.registration.length, 1);
  assert.equal(f.mock.calls.registration[0].token_endpoint_auth_method, 'none');
  assert.equal(f.mock.calls.registration[0].application_type, 'native');
  assert.deepEqual(f.mock.calls.registration[0].grant_types, ['authorization_code', 'refresh_token']);
  await assert.rejects(f.manager.startLogin(), { code: 'login_in_progress' });

  for (const overrides of [{ state: 'wrong' }, { state: null }, { iss: 'https://attacker.example' }, { iss: null }]) {
    const response = await fetch(callbackURL(login, overrides));
    assert.equal(response.status, 400);
    await response.text();
  }
  const duplicate = callbackURL(login);
  duplicate.searchParams.append('code', 'second-code');
  const duplicateResponse = await fetch(duplicate);
  assert.equal(duplicateResponse.status, 400);
  await duplicateResponse.text();
  const post = await fetch(callbackURL(login), { method: 'POST' });
  assert.equal(post.status, 400);
  await post.text();
  const wrongPath = callbackURL(login);
  wrongPath.pathname = '/wrong';
  const pathResponse = await fetch(wrongPath);
  assert.equal(pathResponse.status, 400);
  await pathResponse.text();
  assert.equal(f.mock.calls.code.length, 0);

  const response = await fetch(callbackURL(login));
  assert.equal(response.status, 200);
  assertSecretFree(await response.text());
  await f.completed.promise;
  assert.equal(f.completions, 1);
  assert.equal(f.mock.calls.code.length, 1);
  const verifier = f.mock.calls.code[0].get('code_verifier');
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), authURL.searchParams.get('code_challenge'));
  assert.equal(f.mock.calls.code[0].get('redirect_uri'), redirect.href);
  assert.equal((await f.manager.provider()).tokens, undefined);
  assert.equal(await (await f.manager.provider()).token(), 'access-1-SECRET');
  assert.deepEqual(await f.manager.status(), { state: 'authorized' });
  assertSecretFree(await f.manager.status());
  const record = await f.credentials.readRecord(await f.manager.credentialKey());
  assert.equal(record.kind, 'grant');
  assert.equal(record.payload.pendingLogin, undefined);
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes(verifier), 'PKCE verifier stays only in memory');
  assert.ok(!serialized.includes(authURL.searchParams.get('state')), 'state stays only in memory');
});

test('expired token refresh is one SDK read-decide-write transaction across managers', async t => {
  const f = fixture(t);
  await f.login();
  f.advance(3_600_000);
  // Same clock, same record, different Agent/manager instances.
  const other = new OAuthManager({
    credentials: f.credentials, projectRoot, server, fetchFn: f.mock.fetchFn,
    nowFn: () => 1_800_003_600_000,
  });
  t.after(() => other.dispose());
  const a = await f.manager.provider();
  const b = await other.provider();
  const tokens = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).token()));
  assert.ok(tokens.every(token => token === 'access-2-SECRET'));
  assert.equal(f.mock.calls.refresh.length, 1);
  assert.equal(f.mock.calls.refresh[0].get('refresh_token'), 'refresh-1-SECRET');
  assert.equal(f.mock.calls.registration.length, 1, 'refresh must not dynamically register');
  const stored = await f.credentials.readRecord(await f.manager.credentialKey());
  assert.equal(stored.payload.tokens.refresh_token, 'refresh-2-SECRET');
  assert.deepEqual(await other.authorize(), { state: 'authorized' });
});

for (const code of ['invalid_grant', 'invalid_client']) {
  test(`failed refresh ${code} becomes need_auth without DCR, callback or leaking upstream errors`, async t => {
    const f = fixture(t);
    await f.login();
    f.advance(3_600_000);
    f.mock.setRefreshFailure(() => json({ error: code, error_description: 'UPSTREAM-SECRET', token: 'UPSTREAM-SECRET' }, 400));
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => { warnings.push(args.join(' ')); });
    await assert.rejects((await f.manager.provider()).token(), error => {
      assertSecretFree({ message: error.message, code: error.code, stack: error.stack });
      return error.code === 'need_auth';
    });
    assert.equal((await f.manager.status()).state, 'need_auth');
    assertSecretFree(warnings);
    assert.equal(f.mock.calls.registration.length, 1);
    assert.equal(f.mock.calls.code.length, 1);
    assert.equal(f.mock.calls.refresh.length, 1);
    const stored = await f.credentials.readRecord(await f.manager.credentialKey());
    assert.equal(stored.payload.tokens, undefined);
    if (code === 'invalid_client') assert.equal(stored.payload.clientInformation, undefined);
  });
}

test('explicit cancellation and AbortSignal withdraw the random-port listener', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const login = await f.manager.startLogin({ signal: controller.signal });
  controller.abort();
  await f.manager.cancel();
  assert.equal((await f.manager.status()).state, 'need_auth');
  assert.equal((await f.manager.status()).error, 'cancelled');
  await assert.rejects(fetch(callbackURL(login)));
  assert.equal(f.mock.calls.code.length, 0);
  await assert.rejects(f.manager.startLogin({ signal: controller.signal }), { code: 'cancelled' });
});

test('five-minute timeout clears listener/ephemeral state and removes pending marker', async t => {
  let timeout;
  let cleared = 0;
  const f = fixture(t, {
    timers: {
      setTimeout(fn, delay) { assert.equal(delay, 300_000); timeout = fn; return 123; },
      clearTimeout(id) { assert.equal(id, 123); ++cleared; },
    },
  });
  const login = await f.manager.startLogin();
  timeout();
  await f.manager.cancel();
  assert.equal((await f.manager.status()).error, 'timeout');
  await assert.rejects(fetch(callbackURL(login)));
  const stored = await f.credentials.readRecord(await f.manager.credentialKey());
  assert.equal(stored.payload.pendingLogin, undefined);
  assert.equal(cleared, 1);
});

test('dispose cancels callback but retains committed credentials; logout deletes the record', async t => {
  const f = fixture(t);
  await f.login();
  const pending = await f.manager.startLogin();
  await f.manager.dispose();
  assert.deepEqual(await f.manager.status(), { state: 'disposed' });
  await assert.rejects(fetch(callbackURL(pending)));
  await assert.rejects(f.manager.startLogin(), { code: 'disposed' });
  assert.ok(await f.credentials.readRecord(await f.manager.credentialKey()));
  const other = new OAuthManager({ credentials: f.credentials, projectRoot, server, fetchFn: f.mock.fetchFn });
  t.after(() => other.dispose());
  assert.deepEqual(await other.logout(), { state: 'need_auth' });
  assert.equal(await f.credentials.readRecord(await other.credentialKey()), undefined);
});

test('logout serializes behind an in-flight refresh and prevents credential resurrection', async t => {
  const f = fixture(t);
  await f.login();
  f.advance(3_600_000);
  const entered = deferred();
  const release = deferred();
  f.mock.setRefreshHook(async () => { entered.resolve(); await release.promise; });
  const refreshing = (await f.manager.provider()).token();
  // Install rejection handling before releasing the intentionally blocked auth.
  const rejected = assert.rejects(refreshing, { code: 'need_auth' });
  await entered.promise;
  const logout = f.manager.logout();
  release.resolve();
  await Promise.all([logout, rejected]);
  assert.equal(await f.credentials.readRecord(await f.manager.credentialKey()), undefined);
  assert.equal((await f.manager.status()).state, 'need_auth');
});

test('configured client reads secret only from credential references and never persists it', async t => {
  const credentials = new Credentials();
  credentials.references.set('TEST_CLIENT_SECRET', 'fixed-client-secret-PRIVATE');
  const f = fixture(t, {
    credentials,
    server: { ...server, oauth: { clientId: 'fixed-client', clientSecretEnvVar: 'TEST_CLIENT_SECRET' } },
  });
  await f.login();
  assert.equal(f.mock.calls.registration.length, 0);
  assert.equal(f.mock.calls.code[0].get('client_id'), 'fixed-client');
  assert.equal(f.mock.calls.code[0].get('client_secret'), 'fixed-client-secret-PRIVATE');
  const stored = await credentials.readRecord(await f.manager.credentialKey());
  assert.ok(!JSON.stringify(stored).includes('fixed-client-secret-PRIVATE'));
});

test('registration failures and error callbacks contain no request/response secrets', async t => {
  const f = fixture(t);
  f.mock.setRegistrationFailure(() => json({ error: 'invalid_request', error_description: 'UPSTREAM-SECRET' }, 400));
  await assert.rejects(f.manager.startLogin(), error => {
    assertSecretFree({ message: error.message, stack: error.stack });
    return error.code === 'oauth_failed';
  });
  assert.equal((await f.manager.status()).state, 'need_auth');
  f.mock.setRegistrationFailure(undefined);
  const login = await f.manager.startLogin();
  const errorURL = callbackURL(login, { code: null, error: 'access_denied', error_description: 'UPSTREAM-SECRET' });
  const response = await fetch(errorURL);
  assert.equal(response.status, 400);
  assertSecretFree(await response.text());
  assert.equal(f.mock.calls.code.length, 0);
  assertSecretFree(await f.manager.status());
});

test('WWW-Authenticate custom metadata URL and challenged scopes reach explicit SDK login only', async t => {
  const base = mockOAuth();
  const requested = [];
  const custom = 'https://mcp.example/agentlens/.well-known/oauth-protected-resource/mcp';
  const f = fixture(t, {
    fetchFn: async (input, init) => {
      requested.push(String(input));
      if (String(input) === custom) return json({ resource: server.url, authorization_servers: [ISSUER] });
      return base.fetchFn(input, init);
    },
  });
  const provider = await f.manager.provider();
  await assert.rejects(provider.onUnauthorized({ response: new Response('', {
    status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${custom}", scope="write read"` },
  }) }), { code: 'need_auth' });
  assert.equal(requested.length, 0, '401 performs no discovery/network activity');
  const login = await f.manager.startLogin();
  assert.ok(requested.includes(custom));
  assert.ok(!requested.some(url => url.includes('/.well-known/oauth-protected-resource') && url !== custom));
  assert.deepEqual(new Set(new URL(login.url).searchParams.get('scope').split(' ')), new Set(['read', 'write']));
  const response = await fetch(callbackURL(login));
  assert.equal(response.status, 200);
  await response.text();
  await f.completed.promise;
  const stored = await f.credentials.readRecord(await f.manager.credentialKey());
  assert.equal(stored.payload.discoveryState.resourceMetadataUrl, custom);
  f.advance(3_600_000);
  assert.equal(await provider.token(), 'access-2-SECRET');
  assert.equal(base.calls.refresh.length, 1);
});

test('new random callback port re-registers public client only during explicit login', async t => {
  const f = fixture(t);
  const first = await f.login();
  const second = await f.manager.startLogin();
  const redirect1 = new URL(first.url).searchParams.get('redirect_uri');
  const redirect2 = new URL(second.url).searchParams.get('redirect_uri');
  assert.notEqual(redirect1, redirect2);
  assert.equal(f.mock.calls.registration.length, 2);
  assert.deepEqual(f.mock.calls.registration[1].redirect_uris, [redirect2]);
  await f.manager.cancel();
});

test('cancel racing asynchronous listen bind awaits complete socket cleanup', async t => {
  let listener;
  const f = fixture(t, {
    createServerFn: handler => { listener = createServer(handler); return listener; },
  });
  const controller = new AbortController();
  const starting = f.manager.startLogin({ signal: controller.signal });
  const rejected = assert.rejects(starting, { code: 'cancelled' });
  controller.abort();
  await Promise.all([rejected, f.manager.cancel()]);
  assert.equal(listener.listening, false);
  assert.equal(f.mock.calls.registration.length, 0);
});

for (const cause of ['timeout', 'dispose']) {
  test(`background SDK refresh ${cause} aborts fetch and releases record lock`, async t => {
    const f = fixture(t);
    await f.login();
    f.advance(3_600_000);
    const timedOut = new AbortController();
    t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 15_000); return timedOut.signal; });
    t.mock.method(console, 'warn', () => {});
    const entered = deferred();
    f.mock.setRefreshHook(init => new Promise((_resolve, reject) => {
      assert.ok(init.signal instanceof AbortSignal);
      init.signal.addEventListener('abort', () => reject(new Error('UPSTREAM-SECRET')), { once: true });
      entered.resolve();
    }));
    const refresh = (await f.manager.provider()).token();
    const rejected = assert.rejects(refresh, error => {
      assertSecretFree({ message: error.message, stack: error.stack });
      return error.code === (cause === 'dispose' ? 'disposed' : 'need_auth');
    });
    await entered.promise;
    if (cause === 'dispose') await f.manager.dispose();
    else timedOut.abort();
    await rejected;
    // A second credential operation confirms the first no longer owns the lock.
    await f.credentials.readRecord(await f.manager.credentialKey());
    if (cause === 'dispose') assert.deepEqual(await f.manager.status(), { state: 'disposed' });
    else assert.equal((await f.manager.status()).safeErrorCode, 'need_auth');
  });
}

test('injected auth finishing after dispose cannot persist tokens or notify reconnect', async t => {
  const entered = deferred();
  const release = deferred();
  let listener;
  const f = fixture(t, {
    createServerFn: handler => { listener = createServer(handler); return listener; },
    authFn: async (provider, options) => {
      if (options.authorizationCode) {
        entered.resolve();
        await release.promise;
        await provider.saveTokens({ access_token: 'access-1-SECRET', token_type: 'Bearer', expires_in: 3600 });
        return 'AUTHORIZED';
      }
      await provider.saveDiscoveryState({ authorizationServerUrl: ISSUER });
      await provider.saveClientInformation({ client_id: 'injected', redirect_uris: [provider.redirectUrl] });
      await provider.saveCodeVerifier('injected-verifier');
      const url = new URL(`${ISSUER}/authorize`);
      url.searchParams.set('state', await provider.state());
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('code_challenge', 'injected-challenge');
      url.searchParams.set('redirect_uri', provider.redirectUrl);
      await provider.redirectToAuthorization(url);
      return 'REDIRECT';
    },
  });
  const login = await f.manager.startLogin();
  const callback = fetch(callbackURL(login)).catch(() => undefined);
  await entered.promise;
  const disposing = f.manager.dispose();
  release.resolve();
  await Promise.all([disposing, callback]);
  assert.equal(listener.listening, false);
  assert.equal(f.completions, 0);
  const stored = await f.credentials.readRecord(await f.manager.credentialKey());
  assert.equal(stored.payload.tokens, undefined);
  assert.equal(stored.payload.pendingLogin, undefined);
});

test('SDK rejects metadata issuer mismatch before DCR with secret-free diagnostics', async t => {
  const f = fixture(t);
  f.mock.setMetadataIssuer('https://UPSTREAM-SECRET.invalid');
  await assert.rejects(f.manager.startLogin(), error => {
    assertSecretFree({ message: error.message, stack: error.stack });
    return error.code === 'oauth_failed';
  });
  assert.equal(f.mock.calls.registration.length, 0);
  assert.equal(f.mock.calls.code.length, 0);
});

test('malformed OAuth error at HTTP 200 never reaches SDK warning text verbatim', async t => {
  const f = fixture(t);
  await f.login();
  f.advance(3_600_000);
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  f.mock.setRefreshFailure(() => json({ error: { secret: 'UPSTREAM-SECRET' }, error_description: 'UPSTREAM-SECRET' }));
  await assert.rejects((await f.manager.provider()).token(), { code: 'need_auth' });
  assertSecretFree(warnings);
  assert.equal(f.mock.calls.registration.length, 1);
});

test('dispose awaits closing incomplete callback HTTP connections', { timeout: 2000 }, async t => {
  const f = fixture(t);
  const login = await f.manager.startLogin();
  const redirect = new URL(new URL(login.url).searchParams.get('redirect_uri'));
  const socket = createConnection({ host: redirect.hostname, port: Number(redirect.port) });
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write('GET /oauth/callback HTTP/1.1\r\n'); // Deliberately incomplete headers.
  await Promise.all([f.manager.dispose(), f.manager.dispose()]);
  await closed;
  assert.deepEqual(await f.manager.status(), { state: 'disposed' });
});

for (const [label, reply, expected] of [
  ['DCR rejection', () => json({error: 'invalid_redirect_uri', error_description: 'UPSTREAM-SECRET'}, 400), {reason: 'http_error', httpStatus: 400, oauthError: 'invalid_redirect_uri'}],
  ['unknown OAuth error', () => json({error: 'UPSTREAM-SECRET', error_description: 'UPSTREAM-SECRET'}, 403), {reason: 'http_error', httpStatus: 403}],
  ['malformed success JSON', () => new Response('UPSTREAM-SECRET', {status: 200}), {reason: 'invalid_json', httpStatus: 200}],
  ['invalid client registration schema', () => json({secret: 'UPSTREAM-SECRET'}, 201), {reason: 'sdk_validation', httpStatus: 201}],
  ['network error', () => {throw new TypeError('UPSTREAM-SECRET', {cause: {code: 'ENOTFOUND', message: 'UPSTREAM-SECRET'}});}, {reason: 'network_error', networkCode: 'ENOTFOUND'}],
]) test(`login diagnostics distinguish ${label} without echoing responses`, async t => {
  const f = fixture(t); f.mock.setRegistrationFailure(reply);
  let failure;
  await assert.rejects(f.manager.startLogin(), error => {failure = error; return error.code === 'oauth_failed';});
  const safe = {code: 'oauth_failed', stage: 'client_registration', ...expected};
  assert.deepEqual(oauthFailureDetails(failure), safe);
  assert.deepEqual((await f.manager.status()).failure, safe);
  const text = commandErrorText(failure);
  assert.match(text, /stage=client_registration/);
  assertSecretFree({text, error: {message: failure.message, stack: failure.stack}, status: await f.manager.status()});
});

for (const phase of ['credential_read', 'credential_write', 'listen']) test(`login diagnostics distinguish ${phase} failures`, async t => {
  const credentials = new Credentials();
  if (phase.startsWith('credential')) credentials.modifyRecord = async (_key, mutate) => {
    if (phase === 'credential_write') await mutate(undefined);
    throw new Error('UPSTREAM-SECRET');
  };
  const f = fixture(t, {credentials, ...(phase === 'listen' ? {createServerFn: () => {throw new Error('UPSTREAM-SECRET');}} : {})});
  let failure;
  await assert.rejects(f.manager.startLogin(), error => {failure = error; return error.code === 'oauth_failed';});
  assert.deepEqual(oauthFailureDetails(failure), {code: 'oauth_failed', stage: phase,
    reason: phase === 'listen' ? 'listen_failed' : 'credential_store'});
  assertSecretFree({text: commandErrorText(failure), status: await f.manager.status()});
});

test('command diagnostics reject forged error shapes and ignore mutable Error fields', () => {
  const forged = Object.assign(new Error('UPSTREAM-SECRET'), {name: 'OAuthError', code: 'oauth_failed', stage: 'client_registration', httpStatus: 400});
  assert.equal(oauthFailureDetails(forged), undefined); assertSecretFree(commandErrorText(forged));
  const local = new OAuthError('UPSTREAM-SECRET', {stage: 'UPSTREAM-SECRET', reason: 'UPSTREAM-SECRET', networkCode: 'UPSTREAM-SECRET', oauthError: 'UPSTREAM-SECRET', httpStatus: 'UPSTREAM-SECRET'});
  local.message = 'UPSTREAM-SECRET'; local.code = 'UPSTREAM-SECRET';
  assert.deepEqual(oauthFailureDetails(local), {code: 'oauth_failed'});
  assertSecretFree(commandErrorText(local));
});

for (const challenged of [false, true]) test(`real local credential store accepts SDK login record (${challenged ? 'resource challenge without scope' : 'automatic discovery'})`, async t => {
  const store = await localCredentials(t);
  const f = fixture(t, {credentials: store.credentials, server: {...server, scopes: challenged ? [] : ['read']}});
  if (challenged) {
    const provider = await f.manager.provider();
    await assert.rejects(provider.onUnauthorized({response: new Response(null, {status: 401, headers: {
      'www-authenticate': 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"',
    }})}), {code: 'need_auth'});
  }
  const login = await f.manager.startLogin();
  assert.ok(login.url); assert.equal((await f.manager.status()).state, 'pending');
  const saved = await store.credentials.readRecord(await f.manager.credentialKey());
  assert.deepEqual(saved, JSON.parse(JSON.stringify(saved)));
  assert.equal(Object.hasOwn(saved.payload, 'challengeScope'), !challenged);
  assert.equal(Object.hasOwn(saved.payload.discoveryState, 'resourceMetadataUrl'), challenged);
  assert.equal(saved.payload.clientInformation.client_id, 'public-test-client');
  assert.equal(saved.payload.codeVerifier, undefined); assert.equal(saved.payload.state, undefined);
  if (process.platform !== 'win32') assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  const persisted = await readFile(store.path, 'utf8');
  assert.equal(persisted.includes(new URL(login.url).searchParams.get('state')), false);
  await f.manager.cancel();
  assert.equal((await store.credentials.readRecord(await f.manager.credentialKey())).payload.pendingLogin, undefined);
});

test('real credential provider rejects an undefined payload instead of silently changing it', async t => {
  const store = await localCredentials(t);
  await assert.rejects(store.credentials.modifyRecord('codex-mcp/undefined-regression', async () => ({
    kind: 'grant', payload: {version: 1, discoveryState: {resourceMetadataUrl: undefined}},
  })), error => error instanceof TypeError && error.message.includes('JSON cannot represent'));
  assert.equal(await store.credentials.readRecord('codex-mcp/undefined-regression'), undefined);
});

test('real file store persists official SDK callback, refresh and logout across provider restarts', async t => {
  const store = await localCredentials(t);
  const f = fixture(t, {credentials: store.credentials});
  await f.login();
  const key = await f.manager.credentialKey();
  let reader = await store.reopen();
  const initial = await reader.readRecord(key);
  assert.equal(initial.payload.tokens.access_token, 'access-1-SECRET');
  assert.equal(initial.payload.tokens.issuer, ISSUER);
  assert.equal(initial.payload.clientInformation.issuer, ISSUER);
  assert.equal(initial.payload.pendingLogin, undefined);
  assert.deepEqual(initial, JSON.parse(JSON.stringify(initial)));
  f.advance(3_600_000);
  assert.equal(await (await f.manager.provider()).token(), 'access-2-SECRET');
  assert.equal(f.mock.calls.refresh.length, 1);
  reader = await store.reopen();
  const refreshed = await reader.readRecord(key);
  assert.equal(refreshed.payload.tokens.refresh_token, 'refresh-2-SECRET');
  assert.equal(refreshed.payload.tokens.issuer, ISSUER);
  assert.deepEqual(refreshed, JSON.parse(JSON.stringify(refreshed)));
  await f.manager.logout();
  reader = await store.reopen(); assert.equal(await reader.readRecord(key), undefined);
});
