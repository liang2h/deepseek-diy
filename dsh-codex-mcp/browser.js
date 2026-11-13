import open from 'open';

/** Human-login-only OS handoff. Never fetch a page, submit a form, or wait for browser exit. */
export async function openAuthorizationBrowser(value, {signal, openFn = open, timeoutMs = 3000} = {}) {
  if (signal?.aborted) return {state: 'manual', reason: 'cancelled'};
  let target;
  try {
    if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x20"'`$\\<>]/.test(value)) throw new Error();
    const url = new URL(value);
    if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) throw new Error();
    target = url.href;
  } catch {return {state: 'manual', reason: 'invalid_url'};}
  let timer, abort;
  const interrupted = new Promise(resolve => {
    timer = setTimeout(() => resolve({state: 'manual', reason: 'open_timeout'}), timeoutMs);
    abort = () => resolve({state: 'manual', reason: 'cancelled'});
    signal?.addEventListener('abort', abort, {once: true});
  });
  const launching = (async () => {
    try {
      if (signal?.aborted) return {state: 'manual', reason: 'cancelled'};
      const child = await openFn(target, {wait: false});
      // open(wait:false) returns its native launcher before exit; always contain
      // later spawn errors and discard output instead of leaking a URL to logs.
      child?.stdout?.resume(); child?.stderr?.resume();
      return await new Promise(resolve => {
        const failed = () => resolve({state: 'manual', reason: 'open_failed'});
        child?.once?.('error', failed);
        if (child?.pid) resolve({state: 'requested'});
        else if (child?.once) child.once('spawn', () => resolve({state: 'requested'}));
        else resolve({state: 'manual', reason: 'open_failed'});
      });
    } catch {return {state: 'manual', reason: 'open_failed'};}
  })();
  try {return await Promise.race([launching, interrupted]);}
  finally {clearTimeout(timer); signal?.removeEventListener('abort', abort);}
}
