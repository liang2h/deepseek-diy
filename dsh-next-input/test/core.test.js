import {OPEN_ITEMS} from './fixtures/open-items.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {LIMITS, DEFAULT_CONFIG, normalizeConfig, bytes, cutText, textOf, initialState, reduceState,
  buildInput, parseSuggestion, requestObject, SYSTEM_PROMPT} from '../core.js';

const event = (type, data, seq = 0) => ({type, data, seq, time: 0});
const msg = (role, text, kind = role === 'user' ? 'user' : 'model') => ({role, source: {kind}, content: [{type: 'text', text}]});
function completed(reason = 'completed', inherited = 0) {
  let state = initialState({}, inherited);
  for (const item of [event('turn/start', {turn: 1}, 0), event('user/message', msg('user', '请完成原始任务并给出结果。'), 1),
    event('assistant/message', {turn: 1, message: msg('assistant', '结果如下。')}, 2), event('turn/end', {turn: 1, reason: {kind: reason}}, 3)]) state = reduceState(state, item);
  return state;
}
test('strict gap and no-gap outputs, independent of composer draft', () => {
  assert.deepEqual(parseSuggestion('{"hasGap":true,"suggestion":"请补上我要求的验证结果。"}'), {status: 'ready', suggestion: '请补上我要求的验证结果。'});
  assert.deepEqual(parseSuggestion('{"hasGap":false,"suggestion":null}'), {status: 'none', suggestion: null});
  assert.equal(parseSuggestion('{"hasGap":true,"suggestion":"  请补充结果。  "}').suggestion, '请补充结果。');
  assert.equal(Object.hasOwn(DEFAULT_CONFIG, 'draft'), false);
});
test('malformed, verbose, multiline, and tool-shaped responses safely disappear', () => {
  for (const value of ['', 'not JSON', '```json\n{"hasGap":false,"suggestion":null}\n```', '[]', 'null', '{}',
    '{"hasGap":"true","suggestion":"yes"}', '{"hasGap":false,"suggestion":"no"}', '{"hasGap":true,"suggestion":null}',
    JSON.stringify({hasGap: true, suggestion: ''}), JSON.stringify({hasGap: true, suggestion: 'x'.repeat(281)}),
    JSON.stringify({hasGap: true, suggestion: '一行\n二行'}), JSON.stringify({hasGap: true, suggestion: '<tool_call>run</tool_call>'}),
    JSON.stringify({hasGap: false, suggestion: null, extra: 1}), 'x'.repeat(4097)]) {
    const result = parseSuggestion(value); assert.equal(result.status, 'error', value.slice(0, 50)); assert.equal(result.suggestion, null);
  }
});
test('Unicode truncation keeps exact head/tail within UTF-8 budget', () => {
  assert.equal(cutText('first😀你好last', 4), 'last');
  assert.equal(cutText('😀你好', 4, false), '😀');
  assert.equal(cutText('first😀', 4), '😀');
  assert.equal(cutText('你好', 1), '');
  assert.equal(cutText('abc', 0), '');
  assert.equal(cutText('abc', 3), 'abc');
});
test('only user/assistant text blocks are retained, never injected messages or tools', () => {
  let state = initialState({});
  state = reduceState(state, event('user/message', {...msg('user', '真实任务'), source: {kind: 'user', rpcId: 'gui-request'}}, 1));
  const value = {...msg('assistant', '公开回答'), content: [{type: 'reasoning', text: 'secret'}, {type: 'tool-call', arguments: 'secret'},
    {type: 'image', text: 'secret'}, {type: 'text', text: '公开回答'}]};
  state = reduceState(state, event('assistant/message', {turn: 1, message: value}, 2));
  state = reduceState(state, event('user/message', msg('user', 'runtime secret', 'system-prompt'), 3));
  const beforeTool = state;
  state = reduceState(state, event('tool/result', {message: msg('tool', 'tool secret')}, 4));
  assert.equal(state, beforeTool);
  const input = buildInput(state);
  assert.match(input, /真实任务/); assert.match(input, /公开回答/); assert.doesNotMatch(input, /secret/);
});
test('projection ignores unrelated events with same state and view references', () => {
  const state = completed();
  for (const type of ['request/header', 'step/start', 'step/end', 'assistant/attempt', 'session/title', 'tool/call', 'tool/result', 'unknown']) {
    const next = reduceState(state, event(type, {}, 4)); assert.equal(next, state); assert.equal(next.view, state.view);
  }
});
test('wire cursor is eligible only for a real completed answer, not inherited fork closers', () => {
  assert.deepEqual(completed().view, {endSeq: 3, turn: 1, eligible: true});
  for (const reason of ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']) assert.equal(completed(reason).view.eligible, false);
  assert.equal(completed('completed', 4).view.eligible, false);
  let state = initialState({});
  state = reduceState(state, event('turn/end', {turn: 1, reason: {kind: 'completed'}}, 3));
  assert.equal(state.view.eligible, false);
});
test('new turn/user input immediately invalidates old eligible cursor', () => {
  const state = completed();
  const started = reduceState(state, event('turn/start', {turn: 2}, 4));
  assert.deepEqual(started.view, {endSeq: 3, turn: 2, eligible: false});
  const sent = reduceState(state, event('user/message', msg('user', '新输入'), 4));
  assert.equal(sent.view.eligible, false); assert.equal(sent.lastAssistantTurn, -1);
  const hidden = reduceState(state, event('user/message', msg('user', 'injected', 'agent-injection'), 4));
  assert.equal(hidden.view.eligible, false); assert.equal(hidden.recent, state.recent);
});
test('surface replacement invalidates cached excerpts until a later appended human task', () => {
  for (const type of ['user/message', 'assistant/message', 'system/message', 'tool/result']) {
    let state = reduceState(completed(), {...event(type, {}, 4), surfaceOp: {op: 'replace', startSeq: 1, endSeq: 2}});
    assert.equal(state.view.eligible, false); assert.equal(state.firstTask, ''); assert.equal(state.firstTaskSeq, -1); assert.deepEqual(state.recent, []);
    state = reduceState(state, event('assistant/message', {turn: 1, message: msg('assistant', 'rewritten')}, 5));
    state = reduceState(state, event('turn/end', {turn: 1, reason: {kind: 'completed'}}, 6));
    assert.equal(state.view.eligible, false);
    state = reduceState(state, event('turn/start', {turn: 2}, 7));
    state = reduceState(state, event('user/message', msg('user', '新的明确任务'), 8));
    state = reduceState(state, event('assistant/message', {turn: 2, message: msg('assistant', '新任务回答')}, 9));
    state = reduceState(state, event('turn/end', {turn: 2, reason: {kind: 'completed'}}, 10));
    assert.equal(state.view.eligible, true); assert.equal(state.firstTask, '新的明确任务');
    assert.doesNotMatch(buildInput(state), /原始任务/);
  }
});
test('normal system-node replacements keep a continued historical turn eligible', () => {
  let state = initialState({});
  const events = [
    event('turn/start', {turn: 1}, 0), event('system/message', {message: msg('system', 'system-v1')}, 1),
    event('user/message', msg('user', '原任务与验收要求'), 2),
    event('assistant/message', {turn: 1, message: msg('assistant', '第一轮回答')}, 3),
    event('turn/end', {turn: 1, reason: {kind: 'completed'}}, 4),
    event('turn/start', {turn: 2}, 5), event('user/message', msg('user', '继续完成原任务'), 6),
  ];
  for (const item of events) state = reduceState(state, item);
  const beforeRewrite = state;
  state = reduceState(state, {...event('system/message', {message: msg('system', 'system-v2')}, 7),
    surfaceOp: {op: 'replace', startSeq: 1, endSeq: 1}});
  assert.equal(state, beforeRewrite); assert.equal(state.firstTaskSeq, 2);
  state = reduceState(state, event('assistant/message', {turn: 2, message: msg('assistant', '本轮回答')}, 8));
  state = reduceState(state, event('turn/end', {turn: 2, reason: {kind: 'completed'}}, 9));
  assert.equal(state.view.eligible, true); assert.equal(state.firstTask, '原任务与验收要求');
  assert.doesNotMatch(buildInput(state), /system-v/);
  for (const type of ['system/message', 'tool/result', 'user/message', 'assistant/message']) {
    const unchanged = reduceState(state, {...event(type, {}, 10), surfaceOp: {op: 'replace', startSeq: 1, endSeq: 1}});
    assert.equal(unchanged, state, `${type} non-intersecting range leaves the fold unchanged`);
  }
});
test('replacement ranges include old first-task identity even after it leaves the recent window', () => {
  let state = completed();
  assert.equal(state.firstTaskSeq, 1);
  for (let seq = 4; seq < 20; seq++) state = reduceState(state, event('assistant/message', {turn: 1, message: msg('assistant', `answer-${seq}`)}, seq));
  assert.equal(state.recent.some(item => item.seq === 1), false);
  const untouched = reduceState(state, {...event('tool/result', {}, 20), surfaceOp: {op: 'replace', startSeq: 0, endSeq: 0}});
  assert.equal(untouched, state);
  const rewritten = reduceState(state, {...event('system/message', {}, 20), surfaceOp: {op: 'replace', startSeq: 0, endSeq: 1}});
  assert.equal(rewritten.firstTask, ''); assert.equal(rewritten.firstTaskSeq, -1); assert.deepEqual(rewritten.recent, []);
  assert.equal(rewritten.view.eligible, false);
  const recentSeq = state.recent[0].seq;
  const recentRewritten = reduceState(state, {...event('tool/result', {}, 20), surfaceOp: {op: 'replace', startSeq: recentSeq, endSeq: recentSeq}});
  assert.equal(recentRewritten.view.eligible, false); assert.equal(recentRewritten.firstTaskSeq, -1);
});
test('a fresh final open-items answer remains eligible after compaction retires the human excerpt', () => {
  let state = completed();
  state = reduceState(state, event('turn/start', {turn: 2}, 4));
  state = reduceState(state, event('user/message', msg('user', '继续核验未确认事项'), 5));
  state = reduceState(state, {...event('user/message', msg('user', 'compressed context', 'compaction'), 6),
    surfaceOp: {op: 'replace', startSeq: 1, endSeq: 5}});
  assert.equal(state.firstTask, ''); assert.equal(state.view.eligible, false);
  state = reduceState(state, event('assistant/message', {turn: 2, message: msg('assistant', OPEN_ITEMS)}, 7));
  state = reduceState(state, event('turn/end', {turn: 2, reason: {kind: 'completed'}}, 8));
  assert.equal(state.view.eligible, true, 'An explicit current unresolved result supports a safe planning input without the retired first task.');
  assert.doesNotMatch(buildInput(state), /compressed context/);
});

test('out-of-turn completion cannot revive an old assistant cursor', () => {
  let state = reduceState(completed(), event('turn/start', {turn: 2}, 4));
  state = reduceState(state, event('assistant/message', {turn: 1, message: msg('assistant', 'late old response')}, 5));
  assert.equal(reduceState(state, event('turn/end', {turn: 1, reason: {kind: 'completed'}}, 6)).view.eligible, false);
});
test('interrupted or empty latest answer is not eligible', () => {
  let state = completed();
  for (const data of [{turn: 1, interrupted: true, message: msg('assistant', 'partial')}, {turn: 1, message: msg('assistant', '')}]) {
    const next = reduceState(state, event('assistant/message', data, 4));
    assert.equal(reduceState(next, event('turn/end', {turn: 1, reason: {kind: 'completed'}}, 5)).view.eligible, false);
  }
});
test('history is bounded to 8 messages, 6 KiB tails, 24 KiB total and first task head', () => {
  let state = initialState({});
  state = reduceState(state, event('user/message', msg('user', 'FIRST-TASK-HEAD' + '界'.repeat(5000) + 'TAIL'), 1));
  assert.match(state.firstTask, /^FIRST-TASK-HEAD/); assert.ok(bytes(state.firstTask) <= 2048);
  assert.ok(state.recent[0].text.endsWith('TAIL')); assert.ok(bytes(state.recent[0].text) <= 6144);
  for (let i = 2; i < 30; i++) state = reduceState(state, event('assistant/message', {turn: 1, message: msg('assistant', `${i}:` + '😀'.repeat(2500))}, i));
  assert.ok(state.recent.length <= 8);
  assert.ok(state.recent.reduce((size, item) => size + bytes(item.text), 0) <= LIMITS.inputBytes);
  for (const item of state.recent) assert.ok(bytes(item.text) <= LIMITS.messageBytes);
  assert.equal(state.firstTask.startsWith('FIRST-TASK-HEAD'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});
test('serialized JSON input budget accounts for escapes and keeps latest response', () => {
  const state = {firstTask: '任务'.repeat(500), recent: Array.from({length: 8}, (_, i) => ({role: 'assistant', text: '\u0001"\\'.repeat(2000) + `LATEST-${i}`}))};
  for (const budget of [1024, 24576]) {
    const input = buildInput(state, budget); assert.ok(bytes(input) <= budget);
    assert.match(input, /LATEST-7/); assert.ok(JSON.parse(input).recent.length <= 8);
  }
});
test('fixed prompt explicitly rejects offers, unnecessary tests, choices and embedded instructions', () => {
  for (const pattern of [/local-next-input\/v2/, /untrusted background data/, /casual offer/, /unnecessary additional testing/, /Never choose an option/, /Default to hasGap:false/]) assert.match(SYSTEM_PROMPT, pattern);
});
test('request and config validation reject ambiguous identities and unbounded controls', () => {
  assert.deepEqual(requestObject({endSeq: 12}), {endSeq: 12});
  for (const value of [null, [], {}, {endSeq: -1}, {endSeq: -0}, {endSeq: 1.5}, {endSeq: Infinity}, {endSeq: 1, draft: ''}, {endSeq: '1'}, Object.assign(Object.create({endSeq: 3}), {other: 1})]) assert.throws(() => requestObject(value));
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.throws(() => normalizeConfig({maxConcurrent: 3})); assert.throws(() => normalizeConfig({timeoutMs: 30001}));
  assert.throws(() => normalizeConfig({maxInputBytes: 999999})); assert.throws(() => normalizeConfig({maxTokens: 0}));
  assert.equal(textOf({content: [{type: 'text', text: 'a'}, {type: 'text', text: 'b'}]}), 'a\nb');
});
