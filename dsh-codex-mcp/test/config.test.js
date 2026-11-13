import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  parseProjectConfig, publicToolName, isToolEnabled, configDigest, redactError,
} from '../config.js';

const fixture = await readFile(new URL('./fixtures/redacted.toml', import.meta.url), 'utf8');
const stdio = (fields = '') => `[mcp_servers.example]\ncommand = "example-program"\n${fields}`;
const http = (fields = '') => `[mcp_servers.example]\nurl = "https://mcp.example.test/mcp"\n${fields}`;
const onlyServer = (text) => parseProjectConfig(text).servers[0];
const rejected = (text, pattern) => assert.throws(() => parseProjectConfig(text), (error) => {
  assert.equal(error.name, 'ProjectConfigError');
  assert.equal(error.code, 'INVALID_PROJECT_CONFIG');
  assert.equal(error.cause, undefined);
  assert.equal(error.codeblock, undefined);
  if (pattern) assert.match(error.message, pattern);
  return true;
});

test('redacted nine-server fixture retains five stdio and four HTTP configurations', () => {
  const { servers } = parseProjectConfig(fixture);
  assert.equal(servers.length, 9);
  assert.deepEqual(servers.map((server) => server.name), [
    'dms-mcp-server', 'dms-mcp-server-test', 'observability_prod', 'observability_test',
    'yunxiao_devops', 'codegraph', 'codegraph_test', 'engineering_context', 'agentlens',
  ]);
  assert.equal(servers.filter((server) => server.transport === 'stdio').length, 5);
  assert.equal(servers.filter((server) => server.transport === 'streamable-http').length, 4);
  assert.deepEqual(servers[0].args, ['alibabacloud-dms-mcp-server@latest']);
  assert.equal(servers[0].command, 'uvx');
  assert.equal(servers[0].toolApprovals.executeScript, 'approve');
  assert.equal(servers[1].toolApprovals.executeScript, undefined);
  assert.deepEqual(Object.keys(servers[2].toolApprovals), [
    'sls_text_to_sql', 'sls_execute_sql', 'sls_list_logstores', 'sls_log_explore',
  ]);
  assert.equal(servers[2].startupTimeoutMs, 30000);
  assert.equal(servers[3].startupTimeoutMs, 30000);
  assert.equal(servers[4].command, 'npx');
  assert.deepEqual(servers[4].args, ['-y', 'alibabacloud-devops-mcp-server']);
  assert.equal(servers[4].toolApprovals.get_file_blobs, 'approve');
  assert.equal(servers[4].toolApprovals.get_repository, 'approve');
  assert.equal(servers[5].startupTimeoutMs, 10000);
  assert.equal(servers[5].toolTimeoutMs, 60000);
  assert.equal(servers[7].url, 'https://eng-mcp.example.test/mcp');
  assert.equal(servers[8].enabledTools.length, 5);
  for (const server of servers) {
    for (const value of Object.values(server.env)) assert.match(value, /^FAKE_/);
  }
});

test('empty or non-MCP Codex config returns an empty server list', () => {
  for (const source of ['', '# nothing here\n', 'model="example"\n[projects."/example"]\ntrust_level="trusted"', '[mcp_servers]']) {
    assert.deepEqual(parseProjectConfig(source), { servers: [] });
  }
});

test('normalizes defaults without reading environment variables', () => {
  assert.deepEqual(onlyServer(stdio()), {
    name: 'example', transport: 'stdio', command: 'example-program', args: [],
    env: {}, envVars: [], headers: {}, envHeaders: {}, enabled: true,
    startupTimeoutMs: 10000, toolTimeoutMs: 60000, enabledTools: undefined,
    disabledTools: [], toolApprovals: {}, defaultApproval: 'auto', scopes: [],
  });
  const server = onlyServer(http());
  assert.equal(server.command, undefined);
  assert.equal(server.transport, 'streamable-http');
  assert.deepEqual(server.args, []);
  assert.deepEqual(server.env, {});
  assert.equal(server.oauth, undefined);
});

test('supports cwd, env_vars, environment overrides and disabled servers', () => {
  const server = onlyServer(stdio(`args = ["", "argument with spaces", "--json"]
    cwd = "/example/project"
    enabled = false
    env_vars = ["HOME", "EXPLICIT_CREDENTIAL"]
    env = { TOKEN = "FAKE_TOKEN", EMPTY = "" }
  `));
  assert.deepEqual(server.args, ['', 'argument with spaces', '--json']);
  assert.equal(server.cwd, '/example/project');
  assert.equal(server.enabled, false);
  assert.deepEqual(server.env, { TOKEN: 'FAKE_TOKEN', EMPTY: '' });
  assert.deepEqual(server.envVars, ['HOME', 'EXPLICIT_CREDENTIAL']);
  assert.equal(Object.hasOwn(server.env, 'HOME'), false);
});

test('supports static and env-backed HTTP headers, scopes and OAuth references', () => {
  const server = onlyServer(http(`
    http_headers = { Authorization = "Bearer FAKE_TOKEN", "X-Empty" = "" }
    env_http_headers = { "X-Api-Key" = "EXPLICIT_API_KEY" }
    bearer_token_env_var = "EXPLICIT_BEARER"
    scopes = ["mcp:read", "mcp:write"]
    [mcp_servers.example.oauth]
    client_id = "example-client"
    client_secret_env_var = "EXPLICIT_CLIENT_SECRET"
  `));
  assert.deepEqual(server.headers, { Authorization: 'Bearer FAKE_TOKEN', 'X-Empty': '' });
  assert.deepEqual(server.envHeaders, { 'X-Api-Key': 'EXPLICIT_API_KEY' });
  assert.equal(server.bearerTokenEnvVar, 'EXPLICIT_BEARER');
  assert.deepEqual(server.scopes, ['mcp:read', 'mcp:write']);
  assert.deepEqual(server.oauth, { clientId: 'example-client', clientSecretEnvVar: 'EXPLICIT_CLIENT_SECRET' });
});

test('each normalized parse owns its mutable arrays and maps', () => {
  const first = onlyServer(stdio());
  first.args.push('changed');
  first.env.TOKEN = 'FAKE_CHANGED';
  first.disabledTools.push('changed');
  first.toolApprovals.changed = 'prompt';
  const second = onlyServer(stdio());
  assert.deepEqual(second.args, []);
  assert.deepEqual(second.env, {});
  assert.deepEqual(second.disabledTools, []);
  assert.deepEqual(second.toolApprovals, {});
});

test('supports all exact per-tool approval modes and arbitrary raw tool identities', () => {
  const server = onlyServer(stdio(`
    [mcp_servers.example.tools."ns.read"]
    approval_mode = "approve"
    [mcp_servers.example.tools."ns/write"]
    approval_mode = "prompt"
    [mcp_servers.example.tools.auto_tool]
    approval_mode = "auto"
    [mcp_servers.example.tools.write_tool]
    approval_mode = "writes"
  `));
  assert.deepEqual(server.toolApprovals, { 'ns.read': 'approve', 'ns/write': 'prompt', auto_tool: 'auto', write_tool: 'writes' });
  assert.equal(server.defaultApproval, 'auto');
});

test('server names have a 1-32 character ASCII namespace', () => {
  for (const name of ['x', '_-09Az', 'a'.repeat(32)]) {
    assert.equal(onlyServer(`[mcp_servers."${name}"]\ncommand="example"`).name, name);
  }
  for (const name of ['', 'a'.repeat(33), 'a.b', 'a/b', 'with space', '中文']) {
    rejected(`[mcp_servers."${name}"]\ncommand="example"`, /name/);
  }
});

test('MCP root and server definitions must be tables', () => {
  for (const source of [
    'mcp_servers = false', 'mcp_servers = []', 'mcp_servers = "example"',
    'mcp_servers = 1979-05-27T07:32:00Z', '[mcp_servers]\nexample = []',
    '[mcp_servers]\nexample = "command"', '[[mcp_servers]]\ncommand="example"',
  ]) rejected(source, /mcp_servers/);
});

test('exactly one command or URL is required, even when disabled', () => {
  rejected('[mcp_servers.example]\nenabled = false', /command or url/);
  rejected(stdio('url="https://example.test"'), /command or url/);
  for (const value of ['false', '7', '[]', '{}', '""', '"   "']) {
    rejected(`[mcp_servers.example]\ncommand=${value}`, /command/);
    rejected(`[mcp_servers.example]\nurl=${value}`, /url/);
  }
});

test('unknown MCP options fail closed while unrelated top-level Codex tables are ignored', () => {
  assert.equal(parseProjectConfig(`other_option = true\n[unrelated]\nunknown = 10\n${stdio()}`).servers.length, 1);
  for (const source of [
    stdio('unknown_option = "FAKE_SECRET"'),
    stdio('transport = "stdio"'),
    stdio('startup_timeout_ms = 1000'),
    stdio('[mcp_servers.example.tools.read]\napproval_mode="auto"\nunknown="FAKE_SECRET"'),
    http('[mcp_servers.example.oauth]\nclient_id="example"\nclient_secret="FAKE_SECRET"'),
  ]) rejected(source, /Unsupported field/);
});

test('transport-specific options are rejected instead of silently ignored', () => {
  for (const fields of [
    'http_headers={}', 'env_http_headers={}', 'bearer_token_env_var="TOKEN"', 'scopes=[]', 'oauth={}',
  ]) rejected(stdio(fields), /transport/);
  for (const fields of ['args=[]', 'env={}', 'env_vars=[]', 'cwd="/example"']) {
    rejected(http(fields), /transport/);
  }
});

test('args require an array of strings (including explicit empty arguments)', () => {
  for (const value of ['false', '"--arg"', '{}', '[1]', '["ok", false]', '[[]]', '[{ a = "b" }]']) {
    rejected(stdio(`args=${value}`), /args/);
  }
  assert.deepEqual(onlyServer(stdio('args=["", "--arg"]')).args, ['', '--arg']);
  rejected(stdio('args=["\\u0000"]'), /args/);
});

test('env requires valid variable names and string values; strings are never coerced', () => {
  for (const value of ['false', '[]', '"TOKEN"', '{ TOKEN = 1 }', '{ TOKEN = true }', '{ TOKEN = [] }', '{ "BAD-NAME" = "value" }', '{ "" = "value" }', '{ "1NAME" = "value" }']) {
    rejected(stdio(`env=${value}`), /env/);
  }
  rejected(stdio('env={ TOKEN = "\\u0000" }'), /env/);
});

test('strict booleans, cwd and environment variable references', () => {
  for (const value of ['"false"', '0', '[]', '{}']) rejected(stdio(`enabled=${value}`), /enabled/);
  for (const value of ['false', '[]', '""']) rejected(stdio(`cwd=${value}`), /cwd/);
  for (const value of ['"TOKEN"', '[1]', '[""]', '["BAD-NAME"]']) rejected(stdio(`env_vars=${value}`), /env_vars/);
  for (const value of ['1', '""', '"BAD-NAME"']) {
    rejected(http(`bearer_token_env_var=${value}`), /bearer_token_env_var/);
    rejected(http(`env_http_headers={ "X-Token"=${value} }`), /env_http_headers/);
    rejected(http(`oauth={ client_secret_env_var=${value} }`), /client_secret_env_var/);
  }
});

test('HTTP header tables reject invalid names, values and newline injection', () => {
  for (const value of ['[]', 'false', '{ Authorization = 123 }', '{ "Bad Header" = "value" }', '{ "" = "value" }', '{ Authorization = "FAKE\\r\\nInjected: yes" }']) {
    rejected(http(`http_headers=${value}`), /http_headers/);
  }
  rejected(http('env_http_headers={ "Bad Header"="TOKEN" }'), /env_http_headers/);
  assert.equal(onlyServer(http('http_headers={ "X-Tab"="a\\tb" }')).headers['X-Tab'], 'a\tb');
});

test('OAuth and scopes have strict table and string types', () => {
  for (const value of ['false', '[]', '"auto"']) rejected(http(`oauth=${value}`), /oauth/);
  for (const value of ['false', '[]', '""']) rejected(http(`oauth={client_id=${value}}`), /client_id/);
  for (const value of ['false', '"read"', '[1]', '[""]']) rejected(http(`scopes=${value}`), /scopes/);
  assert.deepEqual(onlyServer(http('oauth={}')).oauth, {});
});

test('enabled/disabled tool arrays and approval tables reject malformed types', () => {
  for (const field of ['enabled_tools', 'disabled_tools']) {
    for (const value of ['"read"', 'false', '{}', '[1]', '[""]', '["  "]']) {
      rejected(stdio(`${field}=${value}`), new RegExp(field));
    }
  }
  for (const value of ['[]', 'false', '"read"', '{ read = "approve" }', '{ read = {} }']) {
    rejected(stdio(`tools=${value}`), /tools/);
  }
  for (const value of ['false', '1', '[]', '{}', '"APPROVE"', '"always"', '""']) {
    rejected(stdio(`tools={ read={ approval_mode=${value} } }`), /approval_mode/);
  }
});

test('timeouts accept finite positive floating point seconds within the Node timer limit', () => {
  const server = onlyServer(stdio('startup_timeout_sec=0.0125\ntool_timeout_sec=2147483.647'));
  assert.equal(server.startupTimeoutMs, 12.5);
  assert.equal(server.toolTimeoutMs, 2 ** 31 - 1);
  assert.equal(onlyServer(stdio('startup_timeout_sec=1e-6')).startupTimeoutMs, 0.001);
  for (const field of ['startup_timeout_sec', 'tool_timeout_sec']) {
    for (const value of ['0', '-0.0', '-1', 'nan', 'inf', '-inf', '2147483.648', '1e100', '"10"', 'true', '[]', '{}', '{valueOf="FAKE_SECRET"}']) {
      rejected(stdio(`${field}=${value}`), new RegExp(field));
    }
  }
});

test('HTTPS and loopback-only HTTP URLs are accepted without network requests', () => {
  for (const url of [
    'https://remote.example.test/mcp', 'https://remote.example.test:8443/mcp?token=FAKE_TOKEN',
    'http://localhost:9999/mcp', 'http://127.0.0.1/mcp', 'http://127.42.0.9/mcp',
    'http://[::1]:9999/mcp', 'http://[0:0:0:0:0:0:0:1]/mcp',
  ]) assert.equal(onlyServer(`[mcp_servers.example]\nurl=${JSON.stringify(url)}`).url, url);
});

test('URL credentials, unsafe schemes and non-loopback HTTP are rejected', () => {
  for (const url of [
    'https://user:FAKE_SECRET@example.test/mcp', 'https://FAKE_SECRET@example.test/mcp',
    'https://@example.test/mcp', 'http://user:FAKE_SECRET@localhost/mcp',
    'http://remote.example.test/mcp', 'http://localhost.example.test/mcp',
    'http://127.0.0.1.example.test/mcp', 'http://0.0.0.0/mcp', 'http://[::]/mcp',
    'http://[::ffff:127.0.0.1]/mcp', 'ftp://localhost/mcp', 'file:///example',
    'wss://example.test/mcp', '//example.test/mcp', 'not a url',
    ' https://example.test/mcp', 'https://example.test/mcp ', 'https:\\example.test/mcp',
  ]) rejected(`[mcp_servers.example]\nurl=${JSON.stringify(url)}`, /url/);
});

test('raw-name filters apply explicit deny before allow and respect server enablement', () => {
  const all = onlyServer(stdio());
  assert.equal(isToolEnabled(all, 'any.raw/name'), true);
  const selected = onlyServer(stdio('enabled_tools=["read", "write"]\ndisabled_tools=["write"]'));
  assert.equal(isToolEnabled(selected, 'read'), true);
  assert.equal(isToolEnabled(selected, 'write'), false);
  assert.equal(isToolEnabled(selected, 'other'), false);
  assert.equal(isToolEnabled(selected, publicToolName(selected.name, 'read')), false);
  assert.equal(isToolEnabled(onlyServer(stdio('enabled_tools=[]')), 'read'), false);
  assert.equal(isToolEnabled(onlyServer(stdio('enabled=false')), 'read'), false);
  const agentlens = parseProjectConfig(fixture).servers.at(-1);
  assert.equal(isToolEnabled(agentlens, 'k8s-mcp__execute_kubectl'), true);
  assert.equal(isToolEnabled(agentlens, 'not-enabled'), false);
});

test('public tool naming matches installed DSH bridge NUL-separated identity hashing', () => {
  // Reconfirmed by Host read of dsh-mcp-client/lib/index.js:440-445 (0.2.2-rc.2).
  assert.equal(publicToolName('server-name', 'raw_name'), 'mcp__server-name__raw_name');
  assert.equal(publicToolName('s', 'x'.repeat(56)).length, 64);
  for (const [server, raw] of [
    ['server', 'ns.read/write'], ['server', '中文'], ['server', 'x'.repeat(200)],
    ['agentlens', 'rocketmq-prod__RocketMQ-20220801-ListConsumerGroupSubscriptions'],
  ]) {
    const joined = `mcp__${server}__${raw}`;
    const hash = createHash('sha256').update(`${server}\0${raw}`).digest('hex').slice(0, 12);
    const expected = `${joined.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 51)}_${hash}`;
    const name = publicToolName(server, raw);
    assert.equal(name, expected);
    assert.match(name, /^[A-Za-z0-9_-]{1,64}$/);
  }
  assert.notEqual(publicToolName('s', 'a.b'), publicToolName('s', 'a/b'));
  assert.notEqual(publicToolName('s', 'a.b'), publicToolName('s', 'a_b'));
  assert.notEqual(publicToolName('a__b', 'c'), publicToolName('a', 'b__c.x'));
});

test('config digest hashes exact UTF-8 text, including unrelated fields and whitespace', () => {
  assert.equal(configDigest(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(configDigest('中文\n'), createHash('sha256').update('中文\n').digest('hex'));
  assert.match(configDigest(fixture), /^[a-f0-9]{64}$/);
  assert.notEqual(configDigest(stdio()), configDigest(`${stdio()}\n`));
  assert.notEqual(configDigest('model="a"'), configDigest('model="b"'));
});

test('parser syntax errors expose only a position, never source, parser error or cause', () => {
  const secret = 'FAKE_NEVER_LOG_THIS_SECRET';
  for (const source of [
    stdio(`env={ TOKEN="${secret}"\n`),
    `model="${secret}"\n${stdio('args = [invalid]')}`,
    `${stdio()}env={ TOKEN="${secret}" }\ncommand="duplicate"`,
  ]) {
    assert.throws(() => parseProjectConfig(source), (error) => {
      assert.match(error.message, /^Invalid TOML: line \d+, column \d+$/);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.stack.includes(secret), false);
      assert.equal(error.cause, undefined);
      assert.equal(error.codeblock, undefined);
      return true;
    });
  }
});

test('validation never interpolates secret-bearing values or dynamic field names', () => {
  const secret = 'FAKE_NEVER_LOG_THIS_SECRET';
  for (const source of [
    stdio(`unknown_${secret}="value"`),
    `[mcp_servers."${secret}/invalid"]\ncommand="example"`,
    stdio(`env={ "${secret}-invalid"="value" }`),
    stdio(`tools={ "${secret}"={approval_mode="${secret}"} }`),
    `[mcp_servers.example]\nurl="https://user:${secret}@remote.example.test/mcp"`,
  ]) {
    assert.throws(() => parseProjectConfig(source), (error) => {
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.stack.includes(secret), false);
      assert.equal(redactError(error).includes(secret), false);
      return true;
    });
  }
});

test('redactError suppresses all untrusted messages, stacks, causes and forged metadata', () => {
  const secret = 'FAKE_NEVER_LOG_THIS_SECRET';
  const configs = parseProjectConfig(fixture);
  for (const error of [
    new Error(`Bearer ${secret}`, { cause: new Error(secret) }), secret,
    { name: 'ProjectConfigError', code: 'INVALID_PROJECT_CONFIG', message: secret },
    { toString() { throw new Error(secret); } }, null, undefined, 42,
  ]) {
    for (const hints of [undefined, [secret], configs, configs.servers]) {
      assert.equal(redactError(error, hints), 'MCP operation failed (details redacted)');
    }
  }
  let safe;
  try { parseProjectConfig(stdio('args=false')); } catch (error) { safe = error; }
  const message = safe.message;
  assert.match(redactError(safe), /args/);
  safe.message = secret;
  assert.equal(redactError(safe), message, 'trusted safe messages are immutable snapshots');
});

test('non-text parse/digest input errors do not stringify their values', () => {
  const badInput = { toString() { throw new Error('FAKE_SECRET'); } };
  for (const input of [null, undefined, 5, badInput]) {
    assert.throws(() => parseProjectConfig(input), /Expected TOML text: document/);
    assert.throws(() => configDigest(input), /Expected TOML text: document/);
  }
});
