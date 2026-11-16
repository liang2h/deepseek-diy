import {localFollowup} from './suggestion-policy.js';
export {PROMPT_VERSION, SYSTEM_PROMPT} from './suggestion-policy.js';

// Bounded, committed recent text only: this is not a complete replay/audit log.
export const LIMITS = Object.freeze({messages: 8, messageBytes: 6 * 1024, inputBytes: 24 * 1024,
  firstTaskBytes: 2 * 1024, outputBytes: 4096, suggestionChars: 280, cacheEntries: 128});
export const DEFAULT_CONFIG = Object.freeze({timeoutMs: 30000, maxInputBytes: LIMITS.inputBytes, maxTokens: 512, maxConcurrent: 2});
export const CONFIG_RANGES = Object.freeze({timeoutMs: [1, 30000], maxInputBytes: [1024, LIMITS.inputBytes], maxTokens: [128, 2048], maxConcurrent: [1, 2]});
export function normalizeConfig(config = {}) {
  const result = {...DEFAULT_CONFIG};
  for (const [key, [min, max]] of Object.entries(CONFIG_RANGES)) {
    const value = config[key] ?? result[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${key}: expected integer ${min}–${max}.`);
    result[key] = value;
  }
  return result;
}
export const bytes = value => Buffer.byteLength(value, 'utf8');
/** Cut on Unicode code-point boundaries (never decode partial UTF-8 bytes). */
export function cutText(text, limit, tail = true) {
  if (bytes(text) <= limit) return text;
  let used = 0;
  if (!tail) {
    let end = 0;
    for (const point of text) {const size = bytes(point); if (used + size > limit) break; used += size; end += point.length;}
    return text.slice(0, end);
  }
  let start = text.length;
  while (start > 0) {
    let previous = start - 1;
    if (previous > 0 && text.charCodeAt(previous) >= 0xdc00 && text.charCodeAt(previous) <= 0xdfff
      && text.charCodeAt(previous - 1) >= 0xd800 && text.charCodeAt(previous - 1) <= 0xdbff) previous--;
    const size = bytes(text.slice(previous, start));
    if (used + size > limit) break;
    used += size; start = previous;
  }
  return text.slice(start);
}
export function textOf(message, limit = LIMITS.messageBytes, tail = true) {
  // Only text blocks; never forward file/image bodies, reasoning, or tool-call arguments.
  let result = '';
  for (const block of message?.content || []) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    result = cutText(result ? `${result}\n${cutText(block.text, limit, tail)}` : block.text, limit, tail);
    if (!tail && bytes(result) >= limit - 3) break;
  }
  return result.trim();
}
// GUI's producer map key is `user-rpc`, but its actual source.kind is `user`.
export function isHumanMessage(message) {return message?.source?.kind === 'user';}
const cursor = (state, changes) => {
  const next = {...state.view, ...changes};
  return Object.keys(next).every(key => next[key] === state.view[key]) ? state.view : next;
};
export function initialState(_header, inheritedEventCount = 0) {
  return {view: {endSeq: -1, turn: 0, eligible: false}, inheritedEventCount, activeTurn: 0,
    lastAssistantTurn: -1, firstTask: '', firstTaskSeq: -1, recent: []};
}
function recentWith(state, event, role, text) {
  let remaining = LIMITS.inputBytes;
  return [...state.recent, {seq: event.seq, role, text}].slice(-LIMITS.messages).reverse().map(item => {
    const bounded = {...item, text: cutText(item.text, Math.min(remaining, LIMITS.messageBytes))};
    remaining -= bytes(bounded.text); return bounded;
  }).filter(item => item.text).reverse();
}
export function reduceState(state, event) {
  // Normal SystemPromptProjection commits replace just one system node (DSH 0.2.2-rc.3,
  // agent-loop/src/runtime-context.ts:116-120). Only a range touching retained text
  // invalidates this text-only fold; the replacer's role cannot prove range contents.
  if (event.surfaceOp?.op === 'replace') {
    const {startSeq, endSeq} = event.surfaceOp;
    const contains = seq => seq >= startSeq && seq <= endSeq;
    const touchesText = state.firstTaskSeq >= 0 && contains(state.firstTaskSeq)
      || state.recent.some(item => contains(item.seq));
    return touchesText ? {...state, view: cursor(state, {eligible: false}),
      firstTask: '', firstTaskSeq: -1, recent: [], lastAssistantTurn: -1} : state;
  }
  if (event.type === 'turn/start') return {...state, activeTurn: event.data.turn, lastAssistantTurn: -1,
    view: cursor(state, {turn: event.data.turn, eligible: false})};
  if (event.type === 'user/message') {
    const text = isHumanMessage(event.data) ? textOf(event.data) : '';
    const firstTask = state.firstTask || (isHumanMessage(event.data) ? textOf(event.data, LIMITS.firstTaskBytes, false) : '');
    return {...state, view: cursor(state, {eligible: false}), lastAssistantTurn: -1,
      firstTask, firstTaskSeq: state.firstTask ? state.firstTaskSeq : firstTask ? event.seq : -1,
      recent: text ? recentWith(state, event, 'user', text) : state.recent};
  }
  if (event.type === 'assistant/message') {
    const text = textOf(event.data.message);
    return {...state, lastAssistantTurn: text && !event.data.interrupted ? event.data.turn : -1,
      recent: text ? recentWith(state, event, 'assistant', text) : state.recent};
  }
  if (event.type === 'turn/end') return {...state, view: cursor(state, {endSeq: event.seq, turn: event.data.turn,
    eligible: event.seq >= state.inheritedEventCount && event.data.reason?.kind === 'completed'
      && event.data.turn === state.activeTurn && event.data.turn === state.lastAssistantTurn
      // Compaction can retire the original human excerpt. A new finalized
      // answer with open items or a deferred next stage still supports a safe planning input.
      && (!!state.firstTask || localFollowup(state) !== null)})};
  return state;
}
/** JSON data, not chat instructions. The exact serialized payload also respects the byte budget. */
export function buildInput(state, maxBytes = DEFAULT_CONFIG.maxInputBytes) {
  const payload = {version: 1, initialTaskExcerpt: cutText(state.firstTask, LIMITS.firstTaskBytes, false),
    recent: state.recent.slice(-LIMITS.messages).map(({role, text}) => ({role, text: cutText(text, LIMITS.messageBytes)}))};
  const encode = () => JSON.stringify(payload);
  // JSON escaping can expand text: shrink oldest context first, preserving the newest answer.
  while (bytes(encode()) > maxBytes && payload.recent.length > 1) payload.recent.shift();
  while (bytes(encode()) > maxBytes) {
    if (payload.initialTaskExcerpt) payload.initialTaskExcerpt = cutText(payload.initialTaskExcerpt, Math.floor(bytes(payload.initialTaskExcerpt) / 2), false);
    else if (payload.recent[0]?.text) payload.recent[0].text = cutText(payload.recent[0].text, Math.floor(bytes(payload.recent[0].text) / 2));
    else throw new RangeError('Input budget is too small.');
  }
  return encode();
}
export function parseSuggestion(text) {
  const bad = reason => ({suggestion: null, status: 'error', reason});
  if (typeof text !== 'string' || bytes(text) > LIMITS.outputBytes) return bad('invalid-output');
  let value;
  try {value = JSON.parse(text);} catch {return bad('invalid-json');}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'hasGap') || !Object.hasOwn(value, 'suggestion')) return bad('invalid-output');
  if (value.hasGap === false && value.suggestion === null) return {suggestion: null, status: 'none'};
  if (value.hasGap !== true || typeof value.suggestion !== 'string') return bad('invalid-output');
  const suggestion = value.suggestion.trim();
  if (!suggestion || Array.from(suggestion).length > LIMITS.suggestionChars || /[\r\n\u0000-\u001f\u007f]|```|<\/?tool[_-]?call\b/i.test(suggestion)) return bad('invalid-suggestion');
  return {suggestion, status: 'ready'};
}
export function requestObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || Object.keys(value)[0] !== 'endSeq'
    || !Number.isSafeInteger(value.endSeq) || value.endSeq < 0 || Object.is(value.endSeq, -0)) throw new TypeError('Expected {endSeq: non-negative safe integer}.');
  return {endSeq: value.endSeq};
}
