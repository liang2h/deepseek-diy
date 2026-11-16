import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isEmptyEditable, canOffer, acceptSuggestion, createSuggestionCache} from '../client-state.js';

const empty = () => ({draft: '', draftRev: 4, phase: 'plain', attachmentIds: []});
const session = () => ({openState: 'open', running: false, removed: false, subagent: null, pendingSubmissions: []});
const cursor = {eligible: true, endSeq: 42, turn: 1};

test('only an exactly empty ordinary editable composer can show a suggestion', () => {
  assert.equal(canOffer({cursor, session: session(), input: empty()}), true);
  for (const patch of [{draft: 'hello'}, {draft: ' '}, {draft: '\n'}, {attachmentIds: ['file']}, {phase: 'sending'}, {phase: 'claimed'}]) {
    assert.equal(isEmptyEditable({...empty(), ...patch}), false);
    assert.equal(canOffer({cursor, session: session(), input: {...empty(), ...patch}}), false);
  }
  for (const patch of [{running: true}, {removed: true}, {subagent: {}}, {openState: 'loading'}, {pendingSubmissions: [{}]}]) {
    assert.equal(canOffer({cursor, session: {...session(), ...patch}, input: empty()}), false);
  }
  assert.equal(canOffer({cursor, session: session(), input: empty(), allowed: false}), false);
  for (const value of [undefined, {eligible: false, endSeq: 42}, {eligible: true, endSeq: -1}, {eligible: true, endSeq: 1.2}]) {
    assert.equal(!!canOffer({cursor: value, session: session(), input: empty()}), false);
  }
});

test('accept inserts exactly one guarded edit and never submits', () => {
  let edits = 0;
  const actions = {captureInsertion: () => ({start: 0, end: 0, draftRev: 4}), insertText(text, span) {
    assert.equal(text, '请补充实际测试结果。'); assert.equal(span.draftRev, 4); edits++; return true;
  }, submit() {throw new Error('must not send');}, setDraft() {throw new Error('must not replace');}};
  assert.equal(acceptSuggestion({text: '请补充实际测试结果。', expectedRev: 4, getInput: empty, actions}), true);
  assert.equal(edits, 1);
});

test('accept rejects draft and attachment races even after capture', () => {
  let current = empty();
  let edits = 0;
  const actions = {captureInsertion() {current = {...current, attachmentIds: ['new']}; return {start: 0, end: 0, draftRev: 4};}, insertText() {edits++; return true;}};
  assert.equal(acceptSuggestion({text: 'suggest', expectedRev: 4, getInput: () => current, actions}), false);
  current = {...empty(), draftRev: 5};
  assert.equal(acceptSuggestion({text: 'suggest', expectedRev: 4, getInput: () => current, actions}), false);
  assert.equal(edits, 0);
});

test('accept refuses stale selection, editor refusal and malformed text', () => {
  for (const span of [{start: 1, end: 1, draftRev: 4}, {start: 0, end: 0, draftRev: 5}]) {
    assert.equal(acceptSuggestion({text: 'suggest', expectedRev: 4, getInput: empty, actions: {captureInsertion: () => span, insertText() {throw new Error('must not insert');}}}), false);
  }
  assert.equal(acceptSuggestion({text: 'suggest', expectedRev: 4, getInput: empty, actions: {captureInsertion: () => ({start: 0, end: 0, draftRev: 4}), insertText: () => false}}), false);
  assert.equal(acceptSuggestion({text: ' ', expectedRev: 4, getInput: empty, actions: {}}), false);
});

test('client cache is bounded and remembers empty outcomes', () => {
  const cache = createSuggestionCache(2);
  cache.remember('a', {suggestion: null}); cache.remember('b', {suggestion: 'text'});
  assert.equal(cache.get('a').suggestion, null);
  cache.remember('c', {});
  assert.equal(cache.get('a'), undefined);
  cache.clear(); assert.equal(cache.get('c'), undefined);
});

test('client uses additive documented slot and contains no DOM or auto-send shortcut', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(source, /name: 'conversation\.input\.dock', id: 'local-next-input-suggestion'/);
  assert.match(source, /acceptSuggestion\(/);
  assert.match(source, /function dismiss\(\)[\s\S]*?binding\(sessionId\) !== binding[\s\S]*?\.focus\(\)/);
  assert.match(source, /role: 'status', 'aria-live': 'polite'/);
  assert.doesNotMatch(source, /-webkit-line-clamp/);
  assert.doesNotMatch(source, /querySelector|MutationObserver|document\.|\.setDraft\(|\.submit\(|addEventListener\(['"]keydown/);
  assert.doesNotMatch(source, /require\(['"]@deepseek-ai\/dsh-client/);
  const tokens = [...source.matchAll(/var\((--[\w-]+)/g)].map(match => match[1]);
  const ownerGeometry = new Set(['--dsh-composer-card-max-width', '--dsh-composer-side-clearance']);
  assert.ok(tokens.length > 0);
  assert.ok(tokens.every(token => token.startsWith('--dsw-alias-') || ownerGeometry.has(token)), 'Only theme aliases and the verified composer width axis may be referenced.');
});

test('notices and suggestions share the native composer width without viewport-wide controls', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.equal([...source.matchAll(/className: 'dni-host'/g)].length, 2, 'Both error and suggestion branches must use the same constrained wrapper.');
  assert.match(source, /max-width:calc\(var\(--dsh-composer-card-max-width,952px\) \+ 2 \* var\(--dsh-composer-side-clearance,16px\)\)/);
  assert.match(source, /margin-inline:auto;padding-inline:var\(--dsh-composer-side-clearance,16px\)/);
  assert.match(source, /className: 'dni-status-text'/);
  assert.match(source, /dismissNotice: '关闭提示'/);
  assert.match(source, /@media \(pointer:coarse\)\{\.dni-dismiss\{width:40px;height:40px\}\}/);
  assert.match(source, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(source, /100vw|justify-content:space-between|position:fixed/);
});

test('metadata and manifest export the real built artifact and complete resources', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(manifest.exports['./client'], './client.bundle.js');
  for (const file of ['client.bundle.js', 'core.js', 'client-state.js', 'icon.svg', 'README.md']) assert.ok(manifest.files.includes(file));
  for (const language of ['zh', 'en']) {
    const {meta} = JSON.parse(await readFile(new URL(`locale/${language}.json`, root), 'utf8'));
    assert.ok(meta.title && meta.description.length > 50); assert.equal(meta.detail, undefined);
  }
  const icon = await readFile(new URL('icon.svg', root), 'utf8');
  assert.match(icon, /width="36" height="36" viewBox="0 0 36 36"/);
  assert.doesNotMatch(icon, /<script|foreignObject|<image|<text/);
});
