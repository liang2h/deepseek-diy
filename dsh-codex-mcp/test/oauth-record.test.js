import test from 'node:test';
import assert from 'node:assert/strict';
import {oauthGrant} from '../oauth-record.js';
import {oauthFailureDetails} from '../oauth-errors.js';

test('OAuth grant serialization omits only undefined object fields at every nesting level', () => {
  const draft = {version: 1, challengeScope: undefined, discoveryState: {resourceMetadataUrl: undefined,
    authorizationServerUrl: 'https://issuer.example', resourceMetadata: {scopes_supported: ['read']}},
  clientInformation: {client_id: 'FAKE_ID', issuer: 'https://issuer.example', optional: undefined},
  tokens: {access_token: 'FAKE_ACCESS', refresh_token: 'FAKE_REFRESH', issuer: 'https://issuer.example', expires_in: 60},
  extras: [null, false, 0, '', {a: undefined, b: [true, 1]}]};
  const expected = JSON.parse(JSON.stringify(draft));
  const grant = oauthGrant(draft);
  assert.deepEqual(grant, {kind: 'grant', payload: expected});
  assert.deepEqual(grant, JSON.parse(JSON.stringify(grant)));
  assert.equal(Object.hasOwn(draft, 'challengeScope'), true);
  assert.equal(Object.hasOwn(draft.discoveryState, 'resourceMetadataUrl'), true);
  assert.notEqual(grant.payload.tokens, draft.tokens);
});

test('OAuth grant serialization preserves JSON property names without prototype pollution', () => {
  const source = JSON.parse('{"__proto__":{"notAPollution":true},"constructor":"value"}');
  const plain = Object.assign(Object.create(null), {kept: 'yes', omitted: undefined});
  const grant = oauthGrant({source, plain});
  assert.equal(Object.getPrototypeOf(grant.payload.source), Object.prototype);
  assert.equal(Object.hasOwn(grant.payload.source, '__proto__'), true);
  assert.equal(grant.payload.source.__proto__.notAPollution, true);
  assert.equal(({}).notAPollution, undefined);
  assert.deepEqual(grant.payload.plain, {kept: 'yes'});
});

test('OAuth grant serialization rejects values requiring lossy or executable conversion', () => {
  const cyclic = {}; cyclic.loop = cyclic;
  let invoked = 0;
  const accessor = Object.defineProperty({}, 'get', {enumerable: true, get() {++invoked; return 'FAKE_SECRET';}});
  const hidden = Object.defineProperty({}, 'hidden', {value: 1});
  assert.throws(() => oauthGrant(undefined));
  for (const unsupported of [NaN, Infinity, 1n, new Date(), new (class {})(), [undefined], Array(1),
    cyclic, {[Symbol('key')]: 1}, () => {}, accessor, hidden, {toJSON() {++invoked; return 1;}}]) {
    assert.throws(() => oauthGrant({nested: unsupported}), error => {
      assert.deepEqual(oauthFailureDetails(error), {code: 'oauth_failed', stage: 'credential_write', reason: 'protocol_validation'});
      assert.equal(error.message.includes('FAKE_SECRET'), false); return true;
    });
  }
  assert.equal(invoked, 0);
});

test('OAuth grant serialization permits repeated references but bounds excessive nesting', () => {
  const shared = {value: 1};
  assert.deepEqual(oauthGrant({left: shared, right: shared}).payload, {left: {value: 1}, right: {value: 1}});
  let nested = {};
  for (let i = 0; i < 150; ++i) nested = {nested};
  assert.throws(() => oauthGrant(nested));
});
