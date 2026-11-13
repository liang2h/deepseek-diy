import test from 'node:test';
import assert from 'node:assert/strict';
import {renderInstructions, validateRequest, performInstructions, registerPersonalization, SECTION, MAX_LENGTH} from '../core.js';

function fixture(approve = async () => 'allowed-once') {
  let value = {enabled: true, instructions: ''}, revision = 0;
  const writes = [], approvals = [];
  const ctx = {
    settings: {
      describe: () => [{ns: 'local-personalization', value: {...value}, revision}],
      update: async (ns, patch, expected) => {
        assert.equal(ns, 'local-personalization');
        if (expected !== revision) throw new Error('SETTINGS_CONFLICT');
        value = {...value, ...patch}; revision++; writes.push({...patch});
      },
    },
    get: () => ({request: async req => {approvals.push(req); return approve(req);}}),
  };
  return {ctx, writes, approvals, edit: next => {value = {...value, ...next}; revision++;},
    exec: {agent: {id: 'session-test'}, signal: new AbortController().signal, callId: 'call-test'}};
}

test('disabled, blank and whitespace-only preferences contribute no prompt text', () => {
  for (const text of ['', ' ', '\r\n\t']) assert.equal(renderInstructions(true, text), '');
  assert.equal(renderInstructions(false, 'saved text'), '');
});
test('literal braces, Unicode, Markdown and newlines survive unchanged', () => {
  const text = '  中文\n{{unknown}} {{}}\n```ts\nconst x = "</instructions>";\n```\n';
  assert.ok(renderInstructions(true, text).endsWith(text));
  assert.match(renderInstructions(true, text), /do not grant permissions/);
});
test('length boundary is validated before side effects', () => {
  assert.doesNotThrow(() => validateRequest({action: 'update', instructions: 'a'.repeat(MAX_LENGTH)}));
  assert.throws(() => validateRequest({action: 'update', instructions: 'a'.repeat(MAX_LENGTH + 1)}));
});
test('strict request shape and types', () => {
  for (const raw of [null, [], {}, {action: 'delete'}, {action: 'get', enabled: true}, {action: 'update'},
    {action: 'update', enabled: 'true'}, {action: 'update', instructions: 1}, {action: 'update', x: 'x'},
    {action: 'update', enabled: true, expectedRevision: -1}, {action: 'update', enabled: true, expectedRevision: 0.2}]) assert.throws(() => validateRequest(raw));
});
test('get reads the same persisted values as the Settings UI without approval', async () => {
  const f = fixture(); f.edit({instructions: 'hello'});
  const result = await performInstructions(f.ctx, {action: 'get'});
  assert.deepEqual(result, {enabled: true, instructions: 'hello', active: true, revision: 1, scope: 'current-profile', applies: 'next-model-request'});
  assert.equal(f.approvals.length, 0); assert.equal(f.writes.length, 0);
});
test('approved partial update preserves omitted fields and uses Settings.update', async () => {
  const f = fixture(); f.edit({instructions: 'keep me'});
  const result = await performInstructions(f.ctx, {action: 'update', enabled: false}, f.exec);
  assert.equal(result.instructions, 'keep me'); assert.equal(result.active, false);
  assert.deepEqual(f.writes, [{enabled: false}]);
  assert.match(f.approvals[0].reason, /every conversation/);
  assert.match(f.approvals[0].reason, /"enabled":false/);
});
test('empty string clears and re-enabling keeps saved content', async () => {
  const f = fixture(); f.edit({enabled: false, instructions: 'saved'});
  const enabled = await performInstructions(f.ctx, {action: 'update', enabled: true}, f.exec);
  assert.equal(enabled.instructions, 'saved'); assert.equal(enabled.active, true);
  const cleared = await performInstructions(f.ctx, {action: 'update', instructions: ''}, f.exec);
  assert.equal(cleared.active, false); assert.equal(cleared.enabled, true);
});
for (const outcome of ['rejected', 'cancelled', 'unavailable', 'allowed']) test(`approval ${outcome} never writes`, async () => {
  const f = fixture(async () => outcome);
  await assert.rejects(performInstructions(f.ctx, {action: 'update', instructions: 'x'}, f.exec), /not changed/);
  assert.equal(f.writes.length, 0);
});
test('no approval service and no live agent fail closed', async () => {
  const f = fixture(); f.ctx.get = () => undefined;
  await assert.rejects(performInstructions(f.ctx, {action: 'update', enabled: false}, f.exec), /unavailable/);
  await assert.rejects(performInstructions(f.ctx, {action: 'update', enabled: false}), /live conversation/);
  assert.equal(f.writes.length, 0);
});
test('invalid update never even asks for approval', async () => {
  const f = fixture();
  await assert.rejects(performInstructions(f.ctx, {action: 'update', instructions: 123}, f.exec));
  assert.equal(f.approvals.length, 0); assert.equal(f.writes.length, 0);
});
test('stale revision and edits while approval is pending cannot overwrite a human edit', async () => {
  const f = fixture(async () => {f.edit({instructions: 'human edit'}); return 'allowed-once';});
  await assert.rejects(performInstructions(f.ctx, {action: 'update', instructions: 'agent edit'}, f.exec), /CONFLICT/);
  assert.equal(f.writes.length, 0);
  const got = await performInstructions(f.ctx, {action: 'get'});
  assert.equal(got.instructions, 'human edit');
});
test('caller mutations during approval cannot change the approved patch', async () => {
  const raw = {action: 'update', instructions: 'approved'};
  const f = fixture(async () => {raw.instructions = 'not approved'; return 'allowed-once';});
  const result = await performInstructions(f.ctx, raw, f.exec);
  assert.equal(result.instructions, 'approved');
});
test('cancellation after approval leaves settings untouched', async () => {
  const controller = new AbortController();
  const f = fixture(async () => {controller.abort(); return 'allowed-once';}); f.exec.signal = controller.signal;
  await assert.rejects(performInstructions(f.ctx, {action: 'update', enabled: false}, f.exec));
  assert.equal(f.writes.length, 0);
});
test('global section re-reads refs for existing and future scopes and disposes cleanly', () => {
  let enabled = true, instructions = 'one', section, tool;
  const effects = [];
  const ctx = {
    effect: cb => {const off = cb(); effects.push(off); return off;},
    systemPrompt: {section: next => {section = next; return () => {section = undefined;};}},
    tools: {register: next => {tool = next; return () => {tool = undefined;};}},
    inject: (_keys, cb) => cb(ctx),
  };
  registerPersonalization(ctx, {enabled: {get: () => enabled}, instructions: {get: () => instructions}});
  assert.equal(section.name, SECTION); assert.equal(section.interpolate, false); assert.equal(section.complete, undefined);
  const existingScope = {};
  assert.ok(section.text({scope: existingScope}).endsWith('one'));
  instructions = '{{two}}';
  assert.ok(section.text({scope: existingScope}).endsWith('{{two}}'));
  assert.ok(section.text({scope: {}}).endsWith('{{two}}'));
  enabled = false; assert.equal(section.text({scope: existingScope}), '');
  assert.equal(tool.isConcurrencySafe({action: 'get'}), true); assert.equal(tool.isConcurrencySafe({action: 'update'}), false);
  for (const off of effects.reverse()) off();
  assert.equal(section, undefined); assert.equal(tool, undefined);
});
