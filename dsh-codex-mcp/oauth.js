import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { auth, computeScopeUnion, extractWWWAuthenticateParams } from '@modelcontextprotocol/client';
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials';
import {OAuthError, SAFE_OAUTH_ERRORS, safeError, oauthFailureDetails, networkFailure} from './oauth-errors.js';
export {OAuthError} from './oauth-errors.js';
import {oauthGrant} from './oauth-record.js';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const EXPIRY_SKEW_MS = 30_000;
const CALLBACK_PATH = '/oauth/callback';

export class NeedAuthError extends OAuthError {
  constructor() {
    super('need_auth');
    this.name = 'NeedAuthError';
  }
}

function secureURL(value) {
  const url = new URL(value);
  if (url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
        ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw new OAuthError();
  }
  return url;
}

/** The hash hides project paths/server URLs in the credential directory. */
export async function oauthCredentialKey(projectRoot, server) {
  const root = await realpath(projectRoot);
  const url = secureURL(server.url).href;
  if (typeof server.name !== 'string' || !server.name) throw new OAuthError();
  const identity = [root, server.name, url, server.oauth?.clientId ?? null,
    server.oauth?.clientSecretEnvVar ?? null, [...new Set(server.scopes ?? [])].sort()];
  const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  // Both key segments must start with a letter, not an arbitrary hash digit.
  return credentialKey('codex-mcp', `project-${id}`);
}

function payloadOf(record) {
  return record?.kind === 'grant' && record.payload?.version === 1
    ? structuredClone(record.payload) : { version: 1 };
}

function equalState(received, expected) {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One manager per project/server. No files, browser launch, UI, or protocol
 * implementation: discovery, DCR, S256 PKCE and token exchange belong to SDK auth.
 *
 * authFn/nowFn/timers/createServerFn are injection seams for offline tests. The
 * production defaults always use official @modelcontextprotocol/client auth.
 * onAuthorized is a runtime-owned closure: it must check the configuration
 * fingerprint before reconnecting a server whose config may have changed.
 */
export class OAuthManager {
  #credentials;
  #server;
  #key;
  #fetch;
  #auth;
  #now;
  #timers;
  #createServer;
  #onAuthorized;
  #attempt;
  #disposed = false;
  #needAuth = false;
  #lastError;
  #lastFailure;
  #epoch = 0;
  #transportProvider;
  #challenge = {};
  #lifetime = new AbortController();
  #closing = new Set();
  #refreshes = new Set();
  #disposal;

  constructor({ credentials, projectRoot, server, fetchFn = globalThis.fetch,
    onAuthorized, authFn = auth, nowFn = Date.now,
    timers = { setTimeout, clearTimeout }, createServerFn = createServer }) {
    this.#credentials = credentials;
    this.#server = structuredClone(server);
    this.#key = oauthCredentialKey(projectRoot, server);
    // Defer initialization failures to public methods without an unhandled rejection.
    this.#key.catch(() => {});
    this.#fetch = fetchFn;
    this.#auth = authFn;
    this.#now = nowFn;
    this.#timers = timers;
    this.#createServer = createServerFn;
    this.#onAuthorized = onAuthorized;
    this.#transportProvider = Object.freeze({
      token: () => this.#token(),
      onUnauthorized: async ctx => {
        this.#needAuth = true;
        this.#lastError = 'need_auth'; this.#lastFailure = undefined;
        // Read the challenge only; never discover/register/prompt from a 401.
        this.#challenge = {};
        try {
          const challenge = extractWWWAuthenticateParams(ctx.response);
          this.#challenge = {
            ...(challenge.resourceMetadataUrl
              ? { resourceMetadataUrl: secureURL(challenge.resourceMetadataUrl).href } : {}),
            ...(challenge.scope ? { scope: challenge.scope } : {}),
          };
        } catch { /* malformed challenge stays need_auth, with no raw diagnostics */ }
        throw new NeedAuthError();
      },
    });
  }

  async credentialKey() {
    try { return await this.#key; } catch { throw new OAuthError(); }
  }

  /** Minimal AuthProvider, NOT OAuthClientProvider: 401 must never auto-login. */
  async provider() {
    this.#assertLive();
    await this.credentialKey();
    return this.#transportProvider;
  }

  async status() {
    if (this.#disposed) return { state: 'disposed' };
    if (this.#attempt) return { state: 'pending', expiresAt: this.#attempt.expiresAt };
    try {
      const draft = payloadOf(await this.#credentials.readRecord(await this.credentialKey()));
      const canUse = draft.tokens?.access_token &&
        (this.#usable(draft) || draft.tokens.refresh_token);
      return {
        state: !this.#needAuth && canUse ? 'authorized' : 'need_auth',
        ...(this.#lastError ? { error: this.#lastError, safeErrorCode: this.#lastError } : {}),
        ...(this.#lastFailure ? {failure: {...this.#lastFailure}} : {}),
      };
    } catch { throw new OAuthError(); }
  }

  /** Proactive expiry check/refresh; safe for background callers (never DCR). */
  async authorize() {
    if (!await this.#token()) throw new NeedAuthError();
    return { state: 'authorized' };
  }

  #assertLive() {
    if (this.#disposed) throw new OAuthError('disposed');
  }

  #active(attempt) {
    if (this.#disposed || this.#attempt !== attempt || attempt.controller.signal.aborted) {
      throw new OAuthError(this.#disposed ? 'disposed' : attempt.reason ?? 'cancelled');
    }
    if (this.#now() >= attempt.expiresAt) throw new OAuthError('timeout');
  }

  #usable(draft) {
    return !!draft.tokens?.access_token &&
      (draft.tokenExpiresAt == null || draft.tokenExpiresAt > this.#now() + EXPIRY_SKEW_MS);
  }

  async #token() {
    this.#assertLive();
    if (this.#needAuth) throw new NeedAuthError();
    const epoch = this.#epoch;
    let token;
    let failure;
    try {
      const operation = this.#credentials.modifyRecord(await this.credentialKey(), async current => {
        this.#assertLive();
        const draft = payloadOf(current);
        if (this.#usable(draft)) {
          token = draft.tokens.access_token;
          return undefined;
        }
        if (!draft.tokens?.refresh_token ||
            (!draft.clientInformation && !this.#server.oauth?.clientId)) {
          // Anonymous servers can still connect; an actual 401 becomes need_auth.
          if (draft.tokens) failure = new NeedAuthError();
          return undefined;
        }
        try {
          const result = await this.#auth(this.#sdkProvider(draft), {
            serverUrl: secureURL(this.#server.url),
            scope: computeScopeUnion(this.#server.scopes?.join(' '), draft.challengeScope),
            resourceMetadataUrl: draft.discoveryState?.resourceMetadataUrl
              ? new URL(draft.discoveryState.resourceMetadataUrl) : undefined,
            fetchFn: this.#safeFetch(undefined, AbortSignal.any([
              this.#lifetime.signal, AbortSignal.timeout(15_000),
            ])),
          });
          if (result !== 'AUTHORIZED' || !draft.tokens?.access_token ||
              (draft.tokenExpiresAt != null && draft.tokenExpiresAt <= this.#now())) throw new NeedAuthError();
          token = draft.tokens.access_token;
        } catch {
          // Preserve SDK invalidations, but never return/print its potentially
          // sensitive error message, response body, metadata or request details.
          failure = new NeedAuthError();
          delete draft.tokens;
          delete draft.tokenExpiresAt;
        }
        this.#assertLive();
        return oauthGrant(draft);
      });
      this.#refreshes.add(operation);
      try { await operation; } finally { this.#refreshes.delete(operation); }
    } catch (error) { throw safeError(error); }
    if (epoch !== this.#epoch) throw new NeedAuthError();
    if (failure) {
      this.#needAuth = true;
      this.#lastError = 'need_auth';
      throw failure;
    }
    return token;
  }

  /**
   * All SDK storage methods mutate this lock-local draft, never call the store
   * recursively. refresh auth/read/decide/write is one modifyRecord transaction.
   */
  #sdkProvider(draft, attempt) {
    const manager = this;
    const configured = this.#server.oauth;
    const provider = {
      get redirectUrl() { return attempt?.redirectUrl ?? draft.redirectUrl; },
      get clientMetadata() {
        return {
          client_name: 'DSH Codex MCP',
          redirect_uris: [this.redirectUrl].filter(Boolean),
          application_type: 'native',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: configured?.clientSecretEnvVar ? 'client_secret_post' : 'none',
          ...(manager.#server.scopes?.length ? { scope: manager.#server.scopes.join(' ') } : {}),
        };
      },
      async clientInformation(ctx) {
        if (configured?.clientId) {
          let secret;
          if (configured.clientSecretEnvVar) {
            secret = (await manager.#credentials.resolve(credentialRef(configured.clientSecretEnvVar)))?.value;
            if (!secret) throw new NeedAuthError();
          }
          return {
            client_id: configured.clientId,
            issuer: ctx?.issuer,
            token_endpoint_auth_method: secret ? 'client_secret_post' : 'none',
            ...(secret ? { client_secret: secret } : {}),
          };
        }
        if (attempt) { attempt.stage = draft.clientInformation ? 'authorization_request' : 'client_registration'; attempt.request = undefined; }
        return draft.clientInformation;
      },
      tokens: async () => draft.tokens,
      async saveTokens(tokens) {
        if (attempt) manager.#active(attempt);
        draft.tokens = structuredClone(tokens);
        draft.tokenExpiresAt = typeof tokens.expires_in === 'number'
          ? manager.#now() + Math.max(0, tokens.expires_in) * 1000 : null;
      },
      discoveryState: async () => draft.discoveryState,
      async saveDiscoveryState(state) {
        draft.discoveryState = structuredClone(state);
        if (attempt) attempt.metadata = state.authorizationServerMetadata;
      },
      async invalidateCredentials(scope) {
        if (scope === 'all' || scope === 'client') delete draft.clientInformation;
        if (scope === 'all' || scope === 'tokens') {
          delete draft.tokens;
          delete draft.tokenExpiresAt;
        }
        if (scope === 'all' || scope === 'discovery') delete draft.discoveryState;
        if (scope === 'all' || scope === 'verifier') {
          if (attempt) attempt.codeVerifier = undefined;
        }
      },
      state: async () => {
        if (!attempt) throw new NeedAuthError();
        manager.#active(attempt);
        return attempt.state;
      },
      async saveCodeVerifier(value) {
        if (!attempt) throw new NeedAuthError();
        manager.#active(attempt);
        attempt.codeVerifier = value;
      },
      async codeVerifier() {
        if (!attempt?.codeVerifier) throw new OAuthError();
        manager.#active(attempt);
        return attempt.codeVerifier;
      },
      async redirectToAuthorization(url) {
        if (!attempt) throw new NeedAuthError();
        manager.#active(attempt);
        attempt.stage = 'authorization_request'; attempt.request = undefined;
        const parsed = secureURL(url);
        if (parsed.searchParams.get('state') !== attempt.state ||
            parsed.searchParams.get('code_challenge_method') !== 'S256' ||
            !parsed.searchParams.get('code_challenge') ||
            parsed.searchParams.get('redirect_uri') !== attempt.redirectUrl) throw new OAuthError();
        attempt.url = parsed.href;
      },
    };
    // Absence is intentional in background mode. SDK refuses DCR before making
    // its request if the client is absent/mismatched and cannot be saved.
    if (attempt) provider.saveClientInformation = async info => {
      manager.#active(attempt);
      const { client_secret: _secret, ...publicInfo } = info;
      draft.clientInformation = { ...structuredClone(publicInfo), token_endpoint_auth_method: 'none' };
    };
    return provider;
  }

  #failure(error, attempt) {
    const request = attempt?.request?.stage === attempt?.stage ? attempt.request : undefined;
    const stage = attempt?.stage;
    const reason = stage === 'listen' ? 'listen_failed' :
      ['credential_read', 'credential_write'].includes(stage) ? 'credential_store' :
      request && request.httpStatus >= 400 ? 'http_error' : 'sdk_validation';
    return safeError(error, {stage, reason, ...request});
  }

  /** Prevent upstream OAuth error bodies/network exceptions entering SDK logs. */
  #safeFetch(attempt, operationSignal = this.#lifetime.signal) {
    return async (input, init = {}) => {
      let stage = attempt?.stage ?? 'discovery';
      try {
        if (attempt) this.#active(attempt);
        const url = secureURL(input instanceof Request ? input.url : String(input));
        const metadata = attempt?.metadata;
        if (url.href === metadata?.registration_endpoint) stage = 'client_registration';
        else if (url.href === metadata?.token_endpoint) stage = attempt ? 'token_exchange' : 'token_refresh';
        else if (url.href === attempt?.resourceMetadataUrl || url.pathname.includes('/.well-known/oauth-protected-resource')) stage = 'protected_resource_metadata';
        else if (url.pathname.includes('/.well-known/')) stage = 'authorization_server_metadata';
        if (attempt) {attempt.stage = stage; attempt.request = undefined;}
        const signal = AbortSignal.any([
          operationSignal, ...(attempt ? [attempt.controller.signal] : []),
          ...(init.signal ? [init.signal] : []),
        ]);
        let response;
        try { response = await this.#fetch(url, { ...init, signal, redirect: 'error' }); }
        catch (error) { throw networkFailure(error, stage); }
        let json;
        if (attempt) attempt.request = {stage, httpStatus: response.status};
        try { json = await response.clone().json(); } catch {
          if (response.ok) throw new OAuthError('oauth_failed', {stage, httpStatus: response.status, reason: 'invalid_json'});
        }
        if (!response.ok || (json && typeof json === 'object' && Object.hasOwn(json, 'error'))) {
          const standardCode = SAFE_OAUTH_ERRORS.has(json?.error) ? json.error : undefined;
          if (attempt && standardCode) attempt.request.oauthError = standardCode;
          return new Response(JSON.stringify({ error: standardCode ?? 'server_error', error_description: 'OAuth request failed.' }), {
            status: response.status,
            headers: { 'content-type': 'application/json' },
          });
        }
        return response;
      } catch (error) { throw safeError(error, {stage, reason: 'operation_failed'}); }
    };
  }

  /** Explicit human command only. Returns before the user visits the callback. */
  async startLogin({ signal } = {}) {
    this.#assertLive();
    if (this.#attempt) throw new OAuthError('login_in_progress');
    if (signal?.aborted) throw new OAuthError('cancelled');
    const attempt = {
      id: randomBytes(24).toString('hex'),
      state: randomBytes(32).toString('base64url'),
      expiresAt: this.#now() + LOGIN_TIMEOUT_MS,
      controller: new AbortController(),
      finishing: false,
      stage: 'listen',
    };
    this.#attempt = attempt;
    this.#lastError = undefined; this.#lastFailure = undefined;
    attempt.abortListener = () => { void this.cancel().catch(() => {}); };
    signal?.addEventListener('abort', attempt.abortListener, { once: true });
    attempt.callerSignal = signal;
    attempt.timer = this.#timers.setTimeout(() => {
      void this.#stop(attempt, 'timeout').catch(() => {});
    }, LOGIN_TIMEOUT_MS);
    attempt.timer?.unref?.();
    try {
      const listener = this.#createServer((request, response) => {
        void this.#callback(attempt, request, response).catch(() => {
          if (!response.writableEnded) this.#reply(response, 400, 'OAuth authorization failed.');
          void this.#stop(attempt, 'oauth_failed', response).catch(() => {});
        });
      });
      attempt.listener = listener;
      attempt.listening = new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => {
          listener.removeListener('error', reject);
          resolve();
        });
      });
      await attempt.listening;
      listener.on('error', () => { void this.#stop(attempt, 'oauth_failed').catch(() => {}); });
      this.#active(attempt);
      attempt.redirectUrl = `http://127.0.0.1:${listener.address().port}${CALLBACK_PATH}`;
      attempt.stage = 'credential_read';
      await this.#credentials.modifyRecord(await this.credentialKey(), async current => {
        this.#active(attempt);
        const draft = payloadOf(current);
        attempt.stage = 'discovery'; attempt.metadata = draft.discoveryState?.authorizationServerMetadata;
        // Explicit login may register again when the AS requires an exact URI
        // rather than RFC 8252's variable-port native loopback matching.
        if (!this.#server.oauth?.clientId && draft.clientInformation &&
            !draft.clientInformation.redirect_uris?.includes(attempt.redirectUrl)) {
          delete draft.clientInformation;
        }
        attempt.resourceMetadataUrl = this.#challenge.resourceMetadataUrl ?? draft.discoveryState?.resourceMetadataUrl;
        attempt.scope = computeScopeUnion(this.#server.scopes?.join(' '), draft.challengeScope, this.#challenge.scope);
        if (this.#challenge.resourceMetadataUrl &&
            this.#challenge.resourceMetadataUrl !== draft.discoveryState?.resourceMetadataUrl) {
          delete draft.discoveryState;
        }
        draft.challengeScope = attempt.scope;
        draft.redirectUrl = attempt.redirectUrl;
        const result = await this.#auth(this.#sdkProvider(draft, attempt), {
          serverUrl: secureURL(this.#server.url),
          scope: attempt.scope,
          resourceMetadataUrl: attempt.resourceMetadataUrl ? new URL(attempt.resourceMetadataUrl) : undefined,
          fetchFn: this.#safeFetch(attempt),
          forceReauthorization: true,
        });
        this.#active(attempt);
        if (result !== 'REDIRECT' || !attempt.url || !attempt.codeVerifier) throw new OAuthError();
        const discovery = draft.discoveryState;
        attempt.issuer = discovery?.authorizationServerMetadata?.issuer ?? discovery?.authorizationServerUrl;
        attempt.requireIssuer = discovery?.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true;
        if (!attempt.issuer) throw new OAuthError();
        draft.pendingLogin = { id: attempt.id, expiresAt: attempt.expiresAt };
        attempt.stage = 'credential_write'; attempt.request = undefined;
        return oauthGrant(draft);
      });
      this.#active(attempt);
      return { url: attempt.url, expiresAt: attempt.expiresAt };
    } catch (error) {
      const failure = this.#failure(error, attempt);
      this.#lastFailure = oauthFailureDetails(failure);
      await this.#stop(attempt, failure.code).catch(() => {});
      throw failure;
    }
  }

  #reply(response, status, text) {
    response.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      connection: 'close',
    });
    response.end(text);
  }

  async #callback(attempt, request, response) {
    if (this.#attempt !== attempt || attempt.controller.signal.aborted) {
      return this.#reply(response, 410, 'OAuth login is no longer active.');
    }
    const expected = new URL(attempt.redirectUrl);
    let callback;
    try { callback = new URL(request.url, expected.origin); } catch {
      return this.#reply(response, 400, 'Invalid OAuth callback.');
    }
    if (request.method !== 'GET' || request.headers.host !== expected.host ||
        callback.origin !== expected.origin || callback.pathname !== CALLBACK_PATH ||
        request.url.length > 8192) return this.#reply(response, 400, 'Invalid OAuth callback.');
    for (const name of ['state', 'code', 'iss', 'error', 'error_description', 'error_uri']) {
      if (callback.searchParams.getAll(name).length > 1) return this.#reply(response, 400, 'Invalid OAuth callback.');
    }
    if (!equalState(callback.searchParams.get('state'), attempt.state)) {
      return this.#reply(response, 400, 'Invalid OAuth state.');
    }
    const iss = callback.searchParams.get('iss') ?? undefined;
    if ((attempt.requireIssuer && !iss) || (iss !== undefined && iss !== attempt.issuer)) {
      return this.#reply(response, 400, 'Invalid OAuth issuer.');
    }
    if (attempt.finishing) return this.#reply(response, 409, 'OAuth callback is already being processed.');
    const code = callback.searchParams.get('code');
    if (!code || callback.searchParams.has('error')) {
      this.#reply(response, 400, 'OAuth authorization was not completed.');
      await this.#stop(attempt, 'oauth_failed', response);
      return;
    }
    attempt.finishing = true; attempt.stage = 'credential_read'; attempt.request = undefined;
    try {
      await this.#credentials.modifyRecord(await this.credentialKey(), async current => {
        this.#active(attempt);
        const draft = payloadOf(current);
        if (draft.pendingLogin?.id !== attempt.id) throw new OAuthError('cancelled');
        attempt.stage = 'token_exchange'; attempt.metadata = draft.discoveryState?.authorizationServerMetadata;
        const result = await this.#auth(this.#sdkProvider(draft, attempt), {
          serverUrl: secureURL(this.#server.url),
          authorizationCode: code,
          iss,
          scope: attempt.scope,
          resourceMetadataUrl: attempt.resourceMetadataUrl ? new URL(attempt.resourceMetadataUrl) : undefined,
          fetchFn: this.#safeFetch(attempt),
        });
        this.#active(attempt);
        if (result !== 'AUTHORIZED' || !draft.tokens?.access_token) throw new OAuthError();
        delete draft.pendingLogin;
        attempt.stage = 'credential_write'; attempt.request = undefined;
        return oauthGrant(draft);
      });
      this.#active(attempt);
      this.#needAuth = false;
      this.#lastError = undefined; this.#lastFailure = undefined;
      this.#reply(response, 200, 'OAuth authorization completed. You can close this window.');
      await this.#release(attempt, response);
      // A reconnect failure does not undo an already committed grant and must
      // not leak a runtime/client error through an unhandled rejection.
      try { if (!this.#disposed) await this.#onAuthorized?.(); } catch { /* runtime owns reconnect diagnostics */ }
    } catch (error) {
      const failure = this.#failure(error, attempt); this.#lastFailure = oauthFailureDetails(failure);
      this.#reply(response, 400, 'OAuth authorization failed.');
      await this.#stop(attempt, failure.code, response);
    }
  }

  #release(attempt, response) {
    if (attempt.closed) return attempt.closed;
    this.#timers.clearTimeout(attempt.timer);
    attempt.callerSignal?.removeEventListener('abort', attempt.abortListener);
    attempt.controller.abort();
    attempt.codeVerifier = undefined;
    attempt.state = '';
    attempt.url = undefined;
    if (this.#attempt === attempt) this.#attempt = undefined;
    attempt.closed = (async () => {
      // Cancellation can race listen(0)'s asynchronous bind. Close only after
      // that bind settles, so a cancelled start cannot leave a late listener.
      await attempt.listening?.catch(() => {});
      const listener = attempt.listener;
      if (!listener) return;
      await new Promise(resolve => {
        listener.close(() => resolve());
        listener.closeIdleConnections?.();
        const closeConnections = () => listener.closeAllConnections?.();
        // Drain our own fixed reply; cancel/dispose destroys even incomplete
        // HTTP requests. The close callback confirms all sockets are closed.
        if (response && !response.writableFinished) response.once('finish', closeConnections);
        else closeConnections();
      });
    })();
    this.#closing.add(attempt.closed);
    attempt.closed.then(() => this.#closing.delete(attempt.closed));
    return attempt.closed;
  }

  async #stop(attempt, reason, response) {
    if (this.#attempt !== attempt) { await attempt.closed; return; }
    attempt.reason = reason;
    this.#lastError = reason;
    if (reason !== this.#lastFailure?.code) this.#lastFailure = undefined;
    await this.#release(attempt, response);
    try {
      await this.#credentials.modifyRecord(await this.credentialKey(), async current => {
        const draft = payloadOf(current);
        if (draft.pendingLogin?.id !== attempt.id) return undefined;
        delete draft.pendingLogin;
        return oauthGrant(draft);
      });
    } catch { /* never surface raw credential-store exceptions */ }
  }

  async cancel() {
    if (this.#attempt) await this.#stop(this.#attempt, 'cancelled');
    await Promise.all([...this.#closing]);
  }

  async logout() {
    this.#assertLive();
    ++this.#epoch;
    this.#needAuth = true;
    await this.cancel();
    try { await this.#credentials.deleteRecord(await this.credentialKey()); }
    catch { throw new OAuthError(); }
    this.#lastError = undefined; this.#lastFailure = undefined;
    return { state: 'need_auth' };
  }

  async dispose() {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    ++this.#epoch;
    this.#lifetime.abort();
    this.#disposal = (async () => {
      await this.cancel();
      await Promise.allSettled([...this.#refreshes]);
    })();
    return this.#disposal;
  }
}
