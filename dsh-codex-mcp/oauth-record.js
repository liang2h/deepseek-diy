import {OAuthError} from './oauth-errors.js';

/**
 * SDK OAuth state is a JS object, not necessarily a JSON value: its optional
 * fields may be present with value undefined. Omit only those object members;
 * preserve all other JSON data, and refuse lossy conversions (Date, bigint,
 * NaN, array holes/undefined, cycles, symbols, accessors and class instances).
 */
export function oauthGrant(payload) {
  const visiting = new Set();
  const invalid = () => {throw new OAuthError('oauth_failed', {stage: 'credential_write', reason: 'protocol_validation'});};
  function json(value, depth = 0) {
    if (depth > 128) return invalid();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : invalid();
    if (typeof value !== 'object' || visiting.has(value)) return invalid();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) return invalid();
    if (Reflect.ownKeys(value).some(key => typeof key === 'symbol')) return invalid();
    visiting.add(value);
    try {
      if (array) {
        const entries = [];
        if (Object.keys(value).length !== value.length) return invalid();
        for (let i = 0; i < value.length; ++i) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) return invalid();
          entries.push(json(descriptor.value, depth + 1));
        }
        return entries;
      }
      const entries = [];
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
        if (descriptor.value !== undefined) entries.push([key, json(descriptor.value, depth + 1)]);
      }
      return Object.fromEntries(entries);
    } finally {visiting.delete(value);}
  }
  return {kind: 'grant', payload: json(payload)};
}
