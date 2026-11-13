import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {OAuthManager} from '../oauth.js';
import {ServerConnection} from '../connection.js';
import {parseProjectConfig} from '../config.js';

function memoryStore() {
  const records = new Map(); let queue = Promise.resolve();
  const exclusive = fn => { const work = queue.then(fn); queue = work.catch(() => {}); return work; };
  return {readRecord: key => exclusive(() => structuredClone(records.get(key))),
    modifyRecord: (key, fn) => exclusive(async () => { const value = await fn(structuredClone(records.get(key))); if (value !== undefined) records.set(key, structuredClone(value)); return structuredClone(records.get(key)); }),
    deleteRecord: key => exclusive(() => records.delete(key)), resolve: async () => undefined};
}

test('end-to-end HTTP 401 challenge -> explicit DCR+PKCE login -> tool discovery -> refresh -> logout', async t => {
  let origin, registration, authorization, access = 'LOCAL-ACCESS-1', refreshes = 0, calls = 0, oauthRequests = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const url = new URL(req.url, origin);
    const json = (value, status = 200) => {res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(value));};
    if (url.pathname === '/mcp') {
      if (req.headers.authorization !== `Bearer ${access}`) {
        res.setHeader('www-authenticate', `Bearer resource_metadata="${origin}/custom-resource-metadata", scope="mcp:read"`);
        return json({error: 'invalid_token'}, 401);
      }
      if (req.method === 'GET') return json({error: 'No GET stream'}, 405);
      const message = JSON.parse(body);
      if (!Object.hasOwn(message, 'id')) {res.writeHead(202); res.end(); return;}
      let result;
      if (message.method === 'initialize') result = {protocolVersion: '2025-11-25', capabilities: {tools: {}}, serverInfo: {name: 'local-auth-mcp', version: '1'}};
      else if (message.method === 'tools/list') result = {tools: [{name: 'safe_echo', description: 'Local echo', inputSchema: {type: 'object', properties: {}}, annotations: {readOnlyHint: true}}]};
      else if (message.method === 'tools/call') {++calls; result = {content: [{type: 'text', text: 'local success'}]};}
      else result = {};
      return json({jsonrpc: '2.0', id: message.id, result});
    }
    ++oauthRequests;
    if (url.pathname === '/custom-resource-metadata') return json({resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['mcp:read']});
    if (url.pathname === '/.well-known/oauth-authorization-server') return json({issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true});
    if (url.pathname === '/register') {registration = JSON.parse(body); return json({...registration, client_id: 'local-public-client'});}
    if (url.pathname === '/authorize') {
      authorization = url.searchParams;
      assert.equal(authorization.get('code_challenge_method'), 'S256');
      assert.equal(authorization.get('client_id'), 'local-public-client');
      const callback = new URL(authorization.get('redirect_uri'));
      assert.equal(registration.redirect_uris[0], callback.href);
      callback.searchParams.set('code', 'local-code'); callback.searchParams.set('state', authorization.get('state')); callback.searchParams.set('iss', origin);
      res.writeHead(302, {location: callback.href}); res.end(); return;
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        assert.equal(form.get('code'), 'local-code');
        assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), authorization.get('code_challenge'));
      } else {
        assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), 'LOCAL-REFRESH-1');
        ++refreshes; access = 'LOCAL-ACCESS-2';
      }
      return json({access_token: access, refresh_token: 'LOCAL-REFRESH-1', token_type: 'Bearer', expires_in: 3600, scope: 'mcp:read'});
    }
    return json({error: 'not_found'}, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {server.closeAllConnections(); return new Promise(resolve => server.close(resolve));});
  const config = parseProjectConfig(`[mcp_servers.local]\nurl="${origin}/mcp"\nenabled_tools=["safe_echo"]`).servers[0];
  const credentials = memoryStore(), registered = new Map();
  const ctx = {credentials, get: () => undefined, tools: {register: tool => {registered.set(tool.name, tool); return () => registered.delete(tool.name);}}};
  let reconnect; const reconnected = new Promise(resolve => {reconnect = resolve;}); let connection;
  const oauth = new OAuthManager({credentials, projectRoot: fileURLToPath(new URL('..', import.meta.url)), server: config,
    onAuthorized: async () => {await connection.connect(); reconnect();}});
  connection = new ServerConnection({ctx, server: config, projectRoot: fileURLToPath(new URL('..', import.meta.url)), oauth, validate: async () => {}});
  t.after(async () => {await connection.dispose(); await oauth.dispose();});
  await connection.connect(); assert.equal(connection.state, 'needs-login'); assert.equal(oauthRequests, 0);
  const login = await oauth.startLogin();
  const callbackResponse = await fetch(login.url);
  assert.equal(callbackResponse.status, 200); await reconnected;
  assert.equal(connection.state, 'ready'); assert.equal(registered.size, 1);
  const tool = registered.get('mcp__local__safe_echo');
  assert.equal((await tool.execute({}, {signal: new AbortController().signal})).content[0].text, 'local success');
  const key = await oauth.credentialKey();
  await credentials.modifyRecord(key, async record => ({...record, payload: {...record.payload, tokenExpiresAt: Date.now() - 1}}));
  await tool.execute({}, {signal: new AbortController().signal});
  assert.equal(refreshes, 1); assert.equal(calls, 2);
  await connection.dispose(); await oauth.logout(); assert.equal(registered.size, 0);
  assert.equal(await credentials.readRecord(key), undefined);
});
