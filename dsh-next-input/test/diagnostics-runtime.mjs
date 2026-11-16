// Exercise the exact native validator used by Host/Client Inspect registration.
// Only fixture state is queried: no sockets, personal Session data or model calls.
import assert from 'node:assert/strict';
import {requireRuntime as require} from './npm-runtime.mjs';
import {installHostDiagnostics, installClientDiagnostics} from '../diagnostics.js';
import {initialState} from '../core.js';
import {VERSION} from '../version.js';
const {assertSupportedJsonSchema, validateJsonSchemaValue} = require('@deepseek-ai/dsh-tools');
// Negative controls retain the native subset boundary (the original regression).
for (const keyword of ['minLength', 'maxLength']) {
  assert.throws(() => assertSupportedJsonSchema({type: 'string', [keyword]: 1}), error => error.code === 'UNSUPPORTED_SCHEMA');
}
assert.ok(validateJsonSchemaValue({type: 'integer'}, 'not-a-number', 'input').length > 0);
const registrations = [];
const ctx = {inject(_dependencies, callback) {callback(ctx);}, effect(callback) {callback();}, cordisInspect: {register(provider) {
  for (const method of provider.manifest.methods) {
    assertSupportedJsonSchema(method.inputSchema);
    assertSupportedJsonSchema(method.outputSchema);
  }
  registrations.push(provider); return () => {};
}}};
const session = {id: 'fixture-inspect-session'}, agent = {session, status: 'idle'}, state = initialState({});
const service = {ctx: {get() {return {get: () => undefined};}}, cache: new Map(), running: new Map(), cacheKey: () => 'fixture-key'};
installHostDiagnostics(ctx, service, {stateOf: value => {assert.equal(value, session); return state;}});
installClientDiagnostics(ctx, () => undefined);
assert.equal(registrations.length, 2);
for (const provider of registrations) {
  const method = provider.manifest.methods[0];
  const context = {agent, sessionId: session.id, signal: new AbortController().signal};
  for (const input of [{}, {sessionId: session.id}, {sessionId: 'missing-fixture-session'}]) {
    assert.deepEqual(validateJsonSchemaValue(method.inputSchema, input, 'input'), []);
    const output = await provider.query('status', input, context);
    assert.deepEqual(validateJsonSchemaValue(method.outputSchema, output, 'output'), []);
    assert.equal(output.version, VERSION);
  }
  for (const sessionId of ['', 'x'.repeat(129)]) {
    await assert.rejects(provider.query('status', {sessionId}, context), /Invalid session identity/);
  }
  assert.ok(validateJsonSchemaValue(method.inputSchema, {unexpected: true}, 'input').length > 0);
}
console.log('Native Inspect schema validation passed for both manifests, query outputs and bounded Session identity handling.');
