import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerConnection } from '../connection.js';
import { parseProjectConfig, publicToolName } from '../config.js';

export const LONG_NAME = 'rocketmq-prod__RocketMQ-20220801-ListConsumerGroupSubscriptions';
const stdioFixture = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));

export function testContext(credentials = {}) {
  const registered = new Map(), resolvedCredentials = [], resolvedExecutables = [], logs = [];
  return {
    registered, resolvedCredentials, resolvedExecutables, logs,
    tools: { register(definition) {
      if (registered.has(definition.name)) throw new Error('DUPLICATE_TEST_REGISTRATION');
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    } },
    credentials: { async resolve(ref) {
      const name = String(ref);
      resolvedCredentials.push(name);
      return Object.hasOwn(credentials, name) ? { value: credentials[name] } : undefined;
    } },
    subprocess: { async resolveExecutable(command, env, signal) {
      signal.throwIfAborted();
      resolvedExecutables.push({ command, env: { ...env } });
      return command;
    } },
    logger: Object.fromEntries(['error', 'warn', 'info', 'debug'].map((level) => [level, (...args) => logs.push({ level, args })])),
    get() { return undefined; },
  };
}

export function connection(t, server, options = {}) {
  const states = [], changes = new EventEmitter();
  const ctx = options.ctx ?? testContext(options.credentials);
  const value = new ServerConnection({
    ctx, server, projectRoot: options.projectRoot ?? process.cwd(),
    validate: options.validate ?? (async () => {}), oauth: options.oauth,
    onState() {
      states.push(value.status());
      changes.emit('state');
    },
  });
  t.after(() => value.dispose());
  return { value, ctx, states, changes };
}

export async function stdioConnection(t, { fields = '', overrides = {}, ...options } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-mcp-test-'));
  const eventLog = path.join(root, 'events.jsonl');
  await writeFile(eventLog, '');
  const server = parseProjectConfig(`[mcp_servers.test_stdio]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([stdioFixture])}\n${fields}`).servers[0];
  Object.assign(server, overrides);
  server.env = { ...server.env, TEST_EVENT_LOG: eventLog };
  const handle = connection(t, server, { ...options, projectRoot: root });
  // Stop the child before removing its exclusively-owned test directory.
  t.after(async () => {
    await handle.value.dispose();
    assert.equal(path.dirname(root), os.tmpdir());
    assert.match(path.basename(root), /^dsh-mcp-test-/);
    await rm(root, { recursive: true, force: true });
  });
  return { ...handle, root, eventLog, records: () => readRecords(eventLog) };
}

export async function readRecords(file) {
  const text = await readFile(file, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Event-driven file observation, not polling or arbitrary sleeps. */
export function waitForRecord(file, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const observer = watch(file, () => { void check(); });
    const timer = setTimeout(async () => {
      // macOS may coalesce fs.watch notifications. A final read distinguishes a
      // missed watcher event from a genuinely absent protocol message.
      await check();
      if (!done) finish(new Error('Timed out waiting for local fixture record'));
    }, timeoutMs);
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); observer.close();
      if (error) reject(error); else resolve(value);
    };
    async function check() {
      try {
        const value = (await readRecords(file)).find(predicate);
        if (value) finish(undefined, value);
      } catch (error) { finish(error); }
    }
    void check();
  });
}

export function waitForState(handle, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const check = () => { if (predicate(handle.states, handle.value)) finish(); };
    const timer = setTimeout(() => finish(new Error('Timed out waiting for connection state')), timeoutMs);
    const finish = (error) => {
      clearTimeout(timer); handle.changes.off('state', check);
      if (error) reject(error); else resolve(handle.value.status());
    };
    handle.changes.on('state', check);
    check();
  });
}

export function invoke(connection, raw, args = {}, signal = new AbortController().signal) {
  const definition = connection.tools.get(publicToolName(connection.server.name, raw))?.definition;
  assert.ok(definition, `Missing registered local tool ${raw}`);
  return definition.execute(args, { signal });
}

export function textValue(result) {
  return JSON.parse(result.content[0].text);
}

export async function httpFixture(t, { hangInitialize = false, hangList = false } = {}) {
  const requests = [], events = new EventEmitter(), sockets = new Set();
  const tools = ['echo', LONG_NAME, 'slow', 'disconnect', 'rpc_error'].map((name) => ({
    name, description: `HTTP local ${name}`, inputSchema: { type: 'object', additionalProperties: true },
  }));
  const server = createServer(async (request, response) => {
    try {
      const body = [];
      for await (const chunk of request) body.push(chunk);
      const message = body.length ? JSON.parse(Buffer.concat(body).toString('utf8')) : undefined;
      const record = { method: request.method, headers: { ...request.headers }, message };
      requests.push(record); events.emit('request', record);
      if (request.method === 'GET') { response.writeHead(405); response.end(); return; }
      if (request.method === 'DELETE') { response.writeHead(200); response.end(); return; }
      if (!message || message.id === undefined) { response.writeHead(202); response.end(); return; }
      if ((message.method === 'initialize' && hangInitialize) || (message.method === 'tools/list' && hangList)) return;
      if (message.method === 'tools/call' && message.params.name === 'slow') return;
      if (message.method === 'tools/call' && message.params.name === 'disconnect') { request.socket.destroy(); return; }
      let result;
      switch (message.method) {
        case 'initialize':
          result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'local-http-fixture', version: '1.0.0' } };
          break;
        case 'tools/list': result = { tools }; break;
        case 'tools/call': result = { content: [{ type: 'text', text: JSON.stringify({ name: message.params.name, arguments: message.params.arguments }) }] }; break;
        default: result = {};
      }
      const envelope = message.method === 'tools/call' && message.params.name === 'rpc_error'
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'FAKE_HTTP_REMOTE_SECRET_DO_NOT_SURFACE' } }
        : { jsonrpc: '2.0', id: message.id, result };
      response.writeHead(200, { 'content-type': 'application/json', ...(message.method === 'initialize' ? { 'mcp-session-id': 'local-test-session' } : {}) });
      response.end(JSON.stringify(envelope));
    } catch (error) {
      response.writeHead(500); response.end();
      events.emit('fixture-error', error);
    }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const config = (fields = '') => parseProjectConfig(`[mcp_servers.test_http]\nurl=${JSON.stringify(url)}\n${fields}`).servers[0];
  const waitForRequest = (predicate, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const prior = requests.find(predicate);
    if (prior) { resolve(prior); return; }
    const listener = (record) => { if (predicate(record)) finish(undefined, record); };
    const timer = setTimeout(() => finish(new Error('Timed out waiting for local HTTP request')), timeoutMs);
    const finish = (error, record) => {
      clearTimeout(timer); events.off('request', listener);
      if (error) reject(error); else resolve(record);
    };
    events.on('request', listener);
  });
  return { server, url, requests, config, waitForRequest };
}
