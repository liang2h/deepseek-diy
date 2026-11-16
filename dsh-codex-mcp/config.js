import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const APPROVAL_MODES = new Set(['approve', 'prompt', 'auto', 'writes']);
const SERVER_FIELDS = new Set([
  'command', 'args', 'env', 'env_vars', 'cwd', 'url', 'http_headers',
  'env_http_headers', 'bearer_token_env_var', 'enabled', 'startup_timeout_sec',
  'tool_timeout_sec', 'enabled_tools', 'disabled_tools', 'tools', 'scopes', 'oauth',
]);
const STDIO_FIELDS = ['command', 'args', 'env', 'env_vars', 'cwd'];
const HTTP_FIELDS = ['url', 'http_headers', 'env_http_headers', 'bearer_token_env_var', 'scopes', 'oauth'];
// Only errors made here are trusted. A third-party Error can forge name/code/message.
const safeErrors = new WeakMap();

function invalid(field, reason = 'Invalid field') {
  const error = new Error(`${reason}: ${field}`);
  error.name = 'ProjectConfigError';
  error.code = 'INVALID_PROJECT_CONFIG';
  safeErrors.set(error, error.message);
  return error;
}

function has(object, key) {
  return Object.hasOwn(object, key);
}

function table(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw invalid(field, 'Expected a table');
  }
  return value;
}

function allowedFields(value, allowed, field) {
  // Unknown keys can themselves contain secrets, so never interpolate them.
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalid(field, 'Unsupported field in table');
  }
}

function string(value, field, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && value.trim().length === 0) || value.includes('\0')) {
    throw invalid(field, 'Expected a string');
  }
  return value;
}

function envName(value, field) {
  if (typeof value !== 'string' || !ENV_NAME.test(value)) {
    throw invalid(field, 'Expected an environment variable name');
  }
  return value;
}

function strings(value, field, item = (entry) => string(entry, field)) {
  if (!Array.isArray(value)) throw invalid(field, 'Expected a string array');
  return value.map((entry) => item(entry));
}

function stringMap(value, field, { header = false, reference = false } = {}) {
  table(value, field);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (header ? !HEADER_NAME.test(key) : !ENV_NAME.test(key)) {
      throw invalid(field, header ? 'Invalid header name' : 'Invalid environment variable name');
    }
    const result = reference ? envName(entry, field) : string(entry, field, { empty: true });
    if (header && /[\x00-\x08\x0a-\x1f\x7f]/.test(result)) {
      throw invalid(field, 'Invalid HTTP header value');
    }
    return [key, result];
  }));
}

function timeout(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw invalid(field, 'Expected positive seconds within the timer limit');
  }
  const ms = value * 1000;
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_TIMEOUT_MS) {
    throw invalid(field, 'Expected positive seconds within the timer limit');
  }
  return ms;
}

function serverUrl(value, field) {
  string(value, field);
  let url;
  try {
    url = new URL(value);
  } catch {
    // URL errors include the input, which may contain credentials or query tokens.
    throw invalid(field, 'Invalid URL');
  }
  const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (!authority || /[\s\\]/.test(value) || authority.includes('@') || url.username || url.password) {
    throw invalid(field, 'URL credentials or ambiguous URL syntax are not allowed');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw invalid(field, 'Expected HTTPS or loopback HTTP');
  }
  return value;
}

function approvalMap(value, field) {
  table(value, field);
  return Object.fromEntries(Object.entries(value).map(([rawName, options], index) => {
    const path = `${field}[${index}]`;
    string(rawName, path);
    table(options, path);
    allowedFields(options, new Set(['approval_mode']), path);
    if (!APPROVAL_MODES.has(options.approval_mode)) {
      throw invalid(`${path}.approval_mode`, 'Invalid approval mode');
    }
    return [rawName, options.approval_mode];
  }));
}

function normalizeServer(name, value, index) {
  // Index paths, rather than input-controlled server/raw-tool/env names, keep all
  // validation errors safe even if a secret was accidentally used as a key.
  const path = `mcp_servers[${index}]`;
  if (!SERVER_NAME.test(name)) throw invalid(`${path}.name`, 'Invalid server name');
  table(value, path);
  allowedFields(value, SERVER_FIELDS, path);
  if (has(value, 'command') === has(value, 'url')) {
    throw invalid(path, 'Exactly one of command or url is required');
  }
  const transport = has(value, 'command') ? 'stdio' : 'streamable-http';
  const incompatible = transport === 'stdio' ? HTTP_FIELDS : STDIO_FIELDS;
  if (incompatible.some((key) => has(value, key))) {
    throw invalid(path, 'Unsupported field for transport');
  }
  if (has(value, 'enabled') && typeof value.enabled !== 'boolean') {
    throw invalid(`${path}.enabled`, 'Expected a boolean');
  }
  const server = {
    name,
    transport,
    args: has(value, 'args') ? strings(value.args, `${path}.args`, (entry) => string(entry, `${path}.args`, { empty: true })) : [],
    env: has(value, 'env') ? stringMap(value.env, `${path}.env`) : {},
    envVars: has(value, 'env_vars') ? strings(value.env_vars, `${path}.env_vars`, (entry) => envName(entry, `${path}.env_vars`)) : [],
    headers: has(value, 'http_headers') ? stringMap(value.http_headers, `${path}.http_headers`, { header: true }) : {},
    envHeaders: has(value, 'env_http_headers') ? stringMap(value.env_http_headers, `${path}.env_http_headers`, { header: true, reference: true }) : {},
    enabled: value.enabled ?? true,
    startupTimeoutMs: timeout(value.startup_timeout_sec, 10000, `${path}.startup_timeout_sec`),
    toolTimeoutMs: timeout(value.tool_timeout_sec, 60000, `${path}.tool_timeout_sec`),
    enabledTools: has(value, 'enabled_tools') ? strings(value.enabled_tools, `${path}.enabled_tools`) : undefined,
    disabledTools: has(value, 'disabled_tools') ? strings(value.disabled_tools, `${path}.disabled_tools`) : [],
    toolApprovals: has(value, 'tools') ? approvalMap(value.tools, `${path}.tools`) : {},
    defaultApproval: 'auto',
    scopes: has(value, 'scopes') ? strings(value.scopes, `${path}.scopes`) : [],
  };
  if (transport === 'stdio') {
    server.command = string(value.command, `${path}.command`);
    if (has(value, 'cwd')) server.cwd = string(value.cwd, `${path}.cwd`);
  } else {
    server.url = serverUrl(value.url, `${path}.url`);
    if (has(value, 'bearer_token_env_var')) {
      server.bearerTokenEnvVar = envName(value.bearer_token_env_var, `${path}.bearer_token_env_var`);
    }
    if (has(value, 'oauth')) {
      const oauth = table(value.oauth, `${path}.oauth`);
      allowedFields(oauth, new Set(['client_id', 'client_secret_env_var']), `${path}.oauth`);
      server.oauth = {};
      if (has(oauth, 'client_id')) server.oauth.clientId = string(oauth.client_id, `${path}.oauth.client_id`);
      if (has(oauth, 'client_secret_env_var')) {
        server.oauth.clientSecretEnvVar = envName(oauth.client_secret_env_var, `${path}.oauth.client_secret_env_var`);
      }
    }
  }
  return server;
}

/**
 * Parse project-local Codex TOML without reading files or environment variables.
 * Unrelated top-level Codex options are ignored; unsupported MCP options fail
 * closed. Every error omits input values and the original parser error/cause.
 */
export function parseProjectConfig(text) {
  if (typeof text !== 'string') throw invalid('document', 'Expected TOML text');
  let document;
  try {
    document = parse(text);
  } catch (error) {
    const location = Number.isSafeInteger(error?.line) && error.line > 0
      && Number.isSafeInteger(error?.column) && error.column > 0
      ? `line ${error.line}, column ${error.column}` : 'document';
    throw invalid(location, 'Invalid TOML');
  }
  if (!has(document, 'mcp_servers')) return { servers: [] };
  const servers = table(document.mcp_servers, 'mcp_servers');
  return { servers: Object.entries(servers).map(([name, value], index) => normalizeServer(name, value, index)) };
}

/** Exact naming algorithm reverified in installed DSH 0.2.2-rc.3 dsh-mcp-client bridge. */
export function publicToolName(server, raw) {
  const joined = `mcp__${server}__${raw}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (normalized === joined && normalized.length <= 64) return normalized;
  const hash = createHash('sha256').update(`${server}\0${raw}`).digest('hex').slice(0, 12);
  return `${normalized.slice(0, 51)}_${hash}`;
}

/** Server enablement and raw-name filters; explicit deny takes precedence. */
export function isToolEnabled(server, raw) {
  return server.enabled !== false
    && !server.disabledTools.includes(raw)
    && (server.enabledTools === undefined || server.enabledTools.includes(raw));
}

/** SHA-256 over the exact source text (UTF-8), not the normalized config. */
export function configDigest(text) {
  if (typeof text !== 'string') throw invalid('document', 'Expected TOML text');
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Return a log-safe string, never an Error (so no stack/cause can be logged).
 * Only validation errors created by this module retain their safe field/location
 * message. All third-party errors are deliberately opaque: URLs, args, headers,
 * process stderr and OAuth responses may hold unknown or encoded secrets. The
 * optional configsOrSecrets argument is accepted for callers' convenience, but
 * is intentionally not inspected; safety does not depend on a complete list.
 */
export function redactError(error, _configsOrSecrets) {
  return error !== null && typeof error === 'object' && safeErrors.has(error)
    ? safeErrors.get(error) : 'MCP operation failed (details redacted)';
}
