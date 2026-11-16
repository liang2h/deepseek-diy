import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {apply, compatibleReviewRequest} from '../index.js';

const providers = new Set(['openai-codex']);
const request = (extra = {}) => Object.freeze({provider: 'openai-codex', model: 'synthetic-model',
  purpose: 'auto-review', temperature: 0, system: 'SYNTHETIC_REVIEW_POLICY',
  messages: Object.freeze([]), sessionId: 'synthetic-session', ...extra});

test('omit only temperature without mutating frozen reviewer inputs or references', () => {
  const controller = new AbortController();
  const original = request({signal: controller.signal, tools: Object.freeze([]), stop: Object.freeze(['STOP']),
    reasoningEffort: 'synthetic-effort', maxTokens: 128, extensionField: Object.freeze({keep: true})});
  const clean = compatibleReviewRequest(original, providers);
  assert.notEqual(clean, original); assert.ok(Object.isFrozen(clean));
  assert.equal(Object.hasOwn(clean, 'temperature'), false);
  assert.equal(original.temperature, 0); assert.equal(Object.hasOwn(original, 'temperature'), true);
  for (const key of Object.keys(original).filter(key => key !== 'temperature')) assert.equal(clean[key], original[key], key);
  assert.throws(() => { clean.provider = 'another-provider'; }, TypeError);
});

test('route and purpose are exact; model names, aliases and other auxiliary calls cannot broaden the fix', () => {
  for (const extra of [{purpose: undefined}, {purpose: 'session-title'}, {purpose: 'AUTO-REVIEW'},
    {provider: 'openai'}, {provider: 'custom-openai-codex'}, {provider: 'OpenAI-Codex'},
    {provider: 'deepseek', model: 'openai-codex'}, {temperature: undefined}]) {
    const original = request(extra);
    assert.equal(compatibleReviewRequest(original, providers), original);
  }
  const alias = request({provider: 'explicit-codex-alias'});
  assert.equal(compatibleReviewRequest(alias, providers), alias);
  assert.equal(Object.hasOwn(compatibleReviewRequest(alias, new Set(['explicit-codex-alias'])), 'temperature'), false);
});

test('invalid temperatures retain validation failures rather than silently becoming a valid review', () => {
  for (const temperature of [null, '0', false, NaN, Infinity, -Infinity, -1, 3]) {
    const original = request({temperature});
    assert.equal(compatibleReviewRequest(original, providers), original);
  }
});

test('the event receiver owns redispatch; one adapter path, no outer next, no swallowed failure', async () => {
  let handler;
  apply({on(name, callback) {assert.equal(name, 'llm/stream'); handler = callback;}}, {providers: [...providers]});
  const failure = Object.freeze({type: 'finish', reason: {kind: 'error', failure: {code: 'PI_AI_ERROR', message: 'synthetic error'}}});
  let redispatches = 0, adapters = 0, outerNext = 0;
  const terminal = (async function* () {yield failure;})();
  const receiver = {stream(clean) {
    assert.equal(this, receiver); ++redispatches;
    assert.equal(Object.hasOwn(clean, 'temperature'), false);
    return handler.call(this, clean, () => {++adapters; return terminal;});
  }};
  const chunks = [];
  for await (const chunk of handler.call(receiver, request(), () => {++outerNext; throw new Error('outer adapter must not execute');})) chunks.push(chunk);
  assert.equal(redispatches, 1); assert.equal(adapters, 1); assert.equal(outerNext, 0);
  assert.deepEqual(chunks, [failure]); assert.equal(chunks[0], failure);
  const original = request({purpose: undefined});
  assert.equal(handler.call(receiver, original, () => {++outerNext; return terminal;}), terminal);
  assert.equal(redispatches, 1); assert.equal(outerNext, 1);
});

test('receiver dispatch exceptions are not changed into approval or a retry', () => {
  let handler;
  apply({on(_name, callback) {handler = callback;}}, {providers: ['openai-codex']});
  const sentinel = new Error('synthetic middleware failure'); let calls = 0;
  assert.throws(() => handler.call({stream() {++calls; throw sentinel;}}, request(), () => assert.fail('outer next')), error => error === sentinel);
  assert.equal(calls, 1);
});

test('packaging exports an original bounded icon and bilingual description; all DSH test versions match rc.3', async () => {
  const root = new URL('..', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(manifest.engines.dsh, '0.2.2-rc.3');
  for (const [name, spec] of Object.entries({...manifest.peerDependencies, ...manifest.devDependencies})) {
    if (name.startsWith('@deepseek-ai/dsh-')) {
      assert.equal(spec, manifest.engines.dsh);
      const installed = JSON.parse(await readFile(new URL(import.meta.resolve(`${name}/package.json`)), 'utf8'));
      assert.equal(installed.version, manifest.engines.dsh);
    }
  }
  for (const file of ['index.js', 'cordis.patch.yml', 'README.md', 'icon.svg', 'locale/en.json', 'locale/zh.json']) {
    assert.ok((await stat(new URL(file, root))).isFile(), file);
  }
  assert.equal(manifest.exports['./icon'], './icon.svg');
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(await readFile(new URL(`locale/${locale}.json`, root), 'utf8')).meta;
    assert.ok(meta.title); assert.ok(meta.description);
  }
  const icon = await readFile(new URL('icon.svg', root), 'utf8');
  assert.match(icon, /viewBox="0 0 36 36"/); assert.ok(Buffer.byteLength(icon) < 256 * 1024);
  assert.doesNotMatch(icon, /<script|<style|<image|foreignObject|href=|onload=/);
});
