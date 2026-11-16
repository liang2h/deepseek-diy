/** Shared, JSON-only Client Remote contract. No Harness Client imports or UI emulation. */
export const PACKAGE = '@local/dsh-next-input';
export const NAMESPACE = 'localNextInput';
const codec = (typeSymbol, parse = value => value) => ({mode: 'strict', typeSymbol, create: () => ({parse})});

export function parseReply(value) {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.endSeq) || value.endSeq < 0
    || !['ready', 'none', 'error', 'stale'].includes(value.status)
    || !(value.suggestion === null || typeof value.suggestion === 'string' && Array.from(value.suggestion).length <= 280)
    || (value.status === 'ready' ? !value.suggestion?.trim() : value.suggestion !== null)) throw new TypeError('Invalid suggestion reply.');
  return {endSeq: value.endSeq, status: value.status, suggestion: value.suggestion,
    ...(typeof value.reason === 'string' && /^[a-z0-9-]{1,64}$/.test(value.reason) ? {reason: value.reason} : {})};
}

export function clientContribution() {
  const identity = codec('@deepseek-ai/dsh-session/types#SessionId', value => {
    if (typeof value !== 'string' || !value) throw new TypeError('Invalid session identity.');
    return value;
  });
  const request = codec(`${PACKAGE}#Request`, value => {
    if (!value || !Number.isSafeInteger(value.endSeq) || value.endSeq < 0 || Object.keys(value).some(key => key !== 'endSeq')) throw new TypeError('Invalid suggestion request.');
    return value;
  });
  return {package: PACKAGE, descriptors: [{
    id: `${PACKAGE}#${NAMESPACE}/generate`, service: NAMESPACE, namespace: NAMESPACE, method: 'generate',
    invocation: {kind: 'direct'}, scope: {context: 'agent', wire: 'agentId'},
    parameters: [
      {name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: identity, strictCodec: identity},
      {name: 'request', wire: 'request', source: 'json', codec: request, strictCodec: request},
    ], cancellation: {parameter: 'signal'}, result: codec(`${PACKAGE}#Reply`, parseReply),
  }]};
}

function failure(code) {
  const error = new Error('Next input request unavailable.');
  error.code = code;
  return error;
}

/**
 * A borrowed Session Context has its own dependency guards. Use public get() on
 * the traced namespace, and unwrap RemoteResult before validating business data.
 * Gateway deliberately does NOT run result.create().parse() in the browser.
 */
export async function requestSuggestion(scope, endSeq, signal) {
  const api = scope?.get(`remote.${NAMESPACE}`);
  if (!api || typeof api.generate !== 'function') throw failure('remote-unavailable');
  const result = await api.generate({endSeq}, signal);
  if (!result || result.ok !== true) throw failure(signal?.aborted ? 'cancelled' : 'remote-failed');
  let reply;
  try {reply = parseReply(result.value);} catch {throw failure('invalid-reply');}
  if (reply.endSeq !== endSeq) throw failure('stale-reply');
  return reply;
}
