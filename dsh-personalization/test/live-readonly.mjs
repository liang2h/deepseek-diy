// Read-only verification against the already running DSH Host Inspector.
// Never launches a browser, changes profile settings, or starts model requests.
import assert from 'node:assert/strict';

async function connect() {
  const response = await fetch('http://127.0.0.1:9230/json/list', {signal: AbortSignal.timeout(4000)});
  const [target] = await response.json();
  assert.equal(target?.url, 'dsh://host');
  assert.ok(target.webSocketDebuggerUrl.startsWith('ws://127.0.0.1:9230/'));
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map(); let serial = 0;
  socket.addEventListener('message', ({data}) => {
    const value = JSON.parse(data);
    if (!value.id) return;
    const item = pending.get(value.id); if (!item) return;
    pending.delete(value.id); clearTimeout(item.timer);
    value.error ? item.reject(new Error(JSON.stringify(value.error))) : item.resolve(value.result);
  });
  await new Promise((resolve, reject) => {socket.addEventListener('open', resolve, {once: true}); socket.addEventListener('error', reject, {once: true});});
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {pending.delete(id); reject(new Error(`Inspector timeout: ${method}`));}, 12000);
    pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params}));
  });
  return {call, close: () => socket.close()};
}

async function verify({sourceId}) {
  const check = (condition, message) => {if (!condition) throw new Error(message);};
  const settings = this.get('settings');
  const descriptor = settings.describe().find(row => row.ns === 'local-personalization');
  check(descriptor, 'No live personalization descriptor');
  const source = this.get('agents').get(sourceId);
  check(source, 'No source agent');
  const agents = this.get('agents').list();
  const expectedText = descriptor.value.enabled && descriptor.value.instructions.trim() ? descriptor.value.instructions : '';
  const scopes = [];
  let sourceAssembly;
  for (const agent of agents) {
    const prompt = agent.ctx.get('systemPrompt') || this.get('systemPrompt');
    const assembly = await prompt.assemble({scope: agent});
    const section = assembly.sections.find(item => item.name === 'local:personalization');
    if (agent === source) sourceAssembly = assembly;
    if (section) {
      check(section.interpolate === false, 'User text would interpolate');
      check(expectedText ? section.text.endsWith(expectedText) : section.text === '', 'Scope saw stale instruction text');
      scopes.push({sessionId: agent.id, visible: true});
    } else scopes.push({sessionId: agent.id, visible: false});
  }
  check(scopes.find(item => item.sessionId === sourceId)?.visible, 'Source scope lost personalization section');
  const tools = this.get('tools');
  const result = await tools.execute({name: 'global_instructions', arguments: {action: 'get'}, agent: source,
    callId: `verify-personalization-${crypto.randomUUID()}`, signal: AbortSignal.timeout(8000)});
  check(!result.isError, 'Tool get failed: ' + JSON.stringify(result));
  check(JSON.stringify(result.value.instructions) === JSON.stringify(descriptor.value.instructions), 'Tool and UI Settings values differ');
  const schema = tools.schemas(source).find(item => item.name === 'global_instructions');
  check(schema, 'Tool not visible in source scope');
  const meter = this.get('tokenMeter');
  const serialized = include => {
    const sections = sourceAssembly.sections.filter(item => include || item.name !== 'local:personalization').map(item => item.text).filter(Boolean).join('\n\n');
    const schemas = sourceAssembly.tools.filter(item => include || item.name !== 'global_instructions');
    return {role: 'system', content: [{type: 'text', text: sections + '\n' + JSON.stringify(schemas)}]};
  };
  const baseline = meter.estimateMessage(serialized(false));
  const after = meter.estimateMessage(serialized(true));
  // Routes supporting in-history prompt updates retain older system nodes.
  // Verify the LATEST authoritative prompt, not a concatenation of old epochs.
  const latestPrompt = source.session.deriveMessages().filter(item => item.source?.kind === 'system-prompt').at(-1);
  check(latestPrompt, 'No committed system-prompt message');
  const effectiveSystemText = latestPrompt.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  return {descriptor: {enabled: descriptor.value.enabled, characters: descriptor.value.instructions.length, revision: descriptor.revision, applies: descriptor.applies},
    currentScope: sourceId, scopes, literalInterpolationDisabled: true, toolMatchesSettings: true,
    latestModelPromptMatchesSavedState: expectedText ? effectiveSystemText.includes(expectedText) : !effectiveSystemText.includes('# User personalization'),
    firstStepTokenEstimate: {withoutPlugin: baseline, withPlugin: after, delta: after - baseline}};
}

const sourceId = process.argv[2] || process.env.DSH_SESSION_ID;
assert.ok(sourceId?.startsWith('session-'), 'Pass the currently live source Session ID');
const cdp = await connect();
try {
  const {root} = await cdp.call('DOM.getDocument', {depth: 3});
  const {object} = await cdp.call('DOM.resolveNode', {nodeId: root.children[0].children[0].nodeId});
  const outcome = await cdp.call('Runtime.callFunctionOn', {objectId: object.objectId, functionDeclaration: verify.toString(),
    arguments: [{value: {sourceId}}], awaitPromise: true, returnByValue: true});
  if (outcome.exceptionDetails) throw new Error(JSON.stringify(outcome.exceptionDetails));
  console.log(JSON.stringify(outcome.result.value, null, 2));
} finally {cdp.close();}
