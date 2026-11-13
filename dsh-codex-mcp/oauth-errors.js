// Only locally constructed, allow-listed diagnostics can cross the model/UI boundary.
const details = new WeakMap();
export const SAFE_OAUTH_ERRORS = new Set([
  'invalid_request', 'invalid_client', 'unauthorized_client', 'invalid_grant',
  'invalid_scope', 'unsupported_grant_type', 'access_denied', 'server_error',
  'temporarily_unavailable', 'invalid_dpop_proof', 'use_dpop_nonce',
  'invalid_redirect_uri', 'invalid_client_metadata', 'invalid_target', 'unsupported_response_type',
]);
const codes = new Set(['oauth_failed', 'need_auth', 'login_in_progress', 'cancelled', 'timeout', 'disposed']);
const stages = new Set(['listen', 'credential_read', 'credential_write', 'discovery',
  'protected_resource_metadata', 'authorization_server_metadata', 'client_registration',
  'authorization_request', 'token_exchange', 'token_refresh', 'callback']);
const reasons = new Set(['operation_failed', 'network_error', 'http_error', 'invalid_json',
  'sdk_validation', 'issuer_mismatch', 'credential_store', 'listen_failed', 'protocol_validation', 'url_rejected']);
const networkCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID']);

export class OAuthError extends Error {
  constructor(code = 'oauth_failed', input = {}) {
    code = codes.has(code) ? code : 'oauth_failed';
    super({need_auth: 'OAuth authorization is required; use the explicit login command.',
      login_in_progress: 'An OAuth login is already pending.', cancelled: 'OAuth login was cancelled.',
      timeout: 'OAuth login timed out.', disposed: 'OAuth manager has been disposed.'}[code] ?? 'OAuth authorization failed.');
    this.name = 'OAuthError'; this.code = code;
    const safe = {code};
    if (stages.has(input.stage)) safe.stage = input.stage;
    if (reasons.has(input.reason)) safe.reason = input.reason;
    if (Number.isInteger(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599) safe.httpStatus = input.httpStatus;
    if (SAFE_OAUTH_ERRORS.has(input.oauthError)) safe.oauthError = input.oauthError;
    if (networkCodes.has(input.networkCode)) safe.networkCode = input.networkCode;
    details.set(this, Object.freeze(safe));
  }
}

export function oauthFailureDetails(error) {
  const safe = error && typeof error === 'object' ? details.get(error) : undefined;
  return safe ? {...safe} : undefined;
}

export function safeError(error, fallback = {}) {
  return new OAuthError(oauthFailureDetails(error)?.code, {...fallback, ...oauthFailureDetails(error)});
}

export function oauthFailureText(error) {
  const safe = oauthFailureDetails(error);
  if (!safe) return undefined;
  return `OAuth 操作未完成：${Object.entries(safe).map(([key, value]) => `${key}=${value}`).join(', ')}。请查看 /codex-mcp status。`;
}

export function networkFailure(error, stage) {
  return new OAuthError('oauth_failed', {stage, reason: 'network_error', networkCode: error?.cause?.code ?? error?.code});
}
