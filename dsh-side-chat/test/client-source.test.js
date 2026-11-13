import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('private client has no native Session transcript or left-footer launcher', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /NativeChat|SessionProvider|ctx\.sessions\.retain|sidebar\.footer\.action|dangerouslySetInnerHTML/);
  assert.match(source, /localSideChat/); assert.match(source, /version: 3/);
  assert.doesNotMatch(source, /conversation\.session\.header\.utilities|function Launcher/);
  assert.match(source, /ctx\.slots\.inject\('conversation\.input\.overlay'/);
  assert.match(source, /function MainInputBinding\(\{sessionId, inputActions\}\)/);
  assert.match(source, /mainInputs\.set\(sessionId, inputActions\)/);
  assert.match(source, /return null;\s*\}\s*function Body/);
  assert.match(source, /id: 'local-side-chat-selection'/);
  assert.match(source, /guide: \[\{id: 'side-chat'/);
});

test('private client preserves old records until migration and consumes quotes into its own draft', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(source, /action: 'migrate'/); assert.match(source, /action: 'create'/);
  assert.match(source, /persist\(\{quote: '', draft:/);
  assert.match(source, /requestId/); assert.match(source, /isComposing/);
  assert.match(source, /frame\?\.kind === 'delta'/);
  assert.match(source, /await ctx\.remote\.\$mount\(/);
  assert.match(source, /for await \(const frame of stream\)/);
  assert.doesNotMatch(source, /const frame = unwrap\(/);
  assert.doesNotMatch(source, /scope\.remote\.localSideChat/);
  assert.match(source, /scope\.commandUi\.register\(\{/);
  assert.match(source, /name: 'side-chat'/);
  assert.match(source, /label: \(\) => t\('title'\)/);
  assert.match(source, /description: \(\) => t\('commandDescription'\)/);
  assert.match(source, /kind: 'action', run: session =>/);
  assert.doesNotMatch(source, /ctx\.commands\.register/);
});

async function resolver(sessions) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const start = source.indexOf('const remote = () => {');
  const end = source.indexOf('const unwrap = result =>', start);
  assert.ok(start > 0 && end > start, 'Locate the actual client transport resolver');
  // Exercise only the transport closure: no React, DOM, component renderer or preview.
  return new Function('ctx', 'sessionId', 'text', `${source.slice(start, end)}; return remote;`)(
    {sessions}, 'source-session', key => key);
}

test('borrowed Session Context resolves namespace via public get, not guarded property access', async () => {
  const api = {perform() {}, send() {}}; const keys = [];
  const scope = {
    remote: {get localSideChat() {throw new Error('cannot get property "remote.localSideChat" without inject');}},
    get(key) {keys.push(key); return api;}
  };
  const remote = await resolver({scope: id => {assert.equal(id, 'source-session'); return scope;}});
  assert.equal(remote(), api);
  assert.deepEqual(keys, ['remote.localSideChat']);
});

test('missing Session scope or withdrawn namespace produces an explicit recoverable error', async () => {
  assert.throws(await resolver({scope: () => undefined}), /noSession/);
  assert.throws(await resolver({scope: () => ({get: () => undefined})}), /unavailable/);
});

test('transport re-resolves the current Session generation instead of retaining a stale namespace', async () => {
  let api = {generation: 1};
  const remote = await resolver({scope: () => ({get: () => api})});
  assert.equal(remote().generation, 1);
  api = {generation: 2};
  assert.equal(remote().generation, 2);
});
