// Development helper: connects only to the already-running DSH Inspector.
export async function connect() {
  const response = await fetch('http://127.0.0.1:9230/json/list', {signal: AbortSignal.timeout(5000)});
  const [target] = await response.json();
  if (!target?.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:9230/')) throw new Error('Unexpected DSH Inspector target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map(); const events = []; let serial = 0;
  socket.addEventListener('message', ({data}) => {
    const value = JSON.parse(data);
    if (value.id) {const item = pending.get(value.id); if (item) {pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(new Error(JSON.stringify(value.error))) : item.resolve(value.result);}}
    else events.push(value);
  });
  await new Promise((resolve, reject) => {socket.addEventListener('open', resolve, {once: true}); socket.addEventListener('error', reject, {once: true});});
  const call = (method, params = {}, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {pending.delete(id); reject(new Error(`CDP timeout: ${method}`));}, timeoutMs);
    pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params}));
  });
  await call('Runtime.enable');
  return {call, events, close: () => socket.close()};
}
