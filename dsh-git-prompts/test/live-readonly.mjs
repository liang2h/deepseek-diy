// Inspect the already-running local DSH Host. No browser launch, model request,
// profile/config change, Git invocation, or new Session is performed here.
import assert from 'node:assert/strict';

async function connect() {
  const response = await fetch('http://127.0.0.1:9230/json/list', {signal: AbortSignal.timeout(4000)});
  assert.ok(response.ok);
  const targets = await response.json();
  const target = targets.find(item => item.url === 'dsh://host');
  assert.ok(target?.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:9230/'), 'No existing local Host Inspector.');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map(); let serial = 0;
  socket.addEventListener('message', ({data}) => {
    const result = JSON.parse(data); const item = pending.get(result.id); if (!item) return;
    pending.delete(result.id); clearTimeout(item.timer);
    result.error ? item.reject(new Error(JSON.stringify(result.error))) : item.resolve(result.result);
  });
  await new Promise((resolve, reject) => {socket.addEventListener('open', resolve, {once: true}); socket.addEventListener('error', reject, {once: true});});
  return {close: () => socket.close(), call: (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial; const timer = setTimeout(() => {pending.delete(id); reject(new Error('Inspector timeout'));}, 12000);
    pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params}));
  })};
}

async function inspect({sourceId}) {
  const check = (condition, message) => {if (!condition) throw new Error(message);};
  const descriptor = this.get('settings').describe().find(row => row.ns === 'local-git-prompts');
  check(descriptor, 'No live Git settings descriptor');
  const agent = this.get('agents').get(sourceId); check(agent, 'No live source Agent');
  const prompt = agent.ctx.get('systemPrompt') || this.get('systemPrompt');
  const assembly = await prompt.assemble({scope: agent});
  const system = assembly.sections.map(section => section.text).join('\n');
  const schemas = this.get('tools').schemas(agent);
  const schemaText = JSON.stringify(schemas);
  const rules = [descriptor.value.commitInstructions, descriptor.value.prInstructions].filter(text => text.trim());
  for (const rule of rules) {check(!system.includes(rule), 'Instruction body leaked into system sections'); check(!schemaText.includes(rule), 'Instruction body leaked into standing tool schemas');}
  check(schemas.some(tool => tool.name === 'prepare_git_operation'), 'Preparation tool unavailable');
  check(schemas.some(tool => tool.name === 'git_prompt_settings'), 'Settings tool unavailable');
  const events = agent.session.snapshotEvents();
  const contexts = events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'local-git-prompts');
  const visible = agent.session.deriveMessages();
  const preparations = contexts.map(event => {
    const source = event.data.source;
    const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const admittedStep = events.filter(candidate => candidate.seq < event.seq && candidate.type === 'step/start').at(-1);
    const generated = events.find(candidate => candidate.seq > event.seq && candidate.type === 'assistant/message');
    return {operation: source.operation, revision: source.revision, messageId: event.data.id, seq: event.seq,
      sameSession: source.sessionId === agent.id, visibleInDerivedHistory: visible.some(message => message.id === event.data.id),
      preparedAtStepSeq: source.preparedAtStepSeq ?? null, admittedStepSeq: admittedStep?.seq ?? null, generatedAssistantSeq: generated?.seq ?? null,
      nextStepConsumption: Number.isInteger(source.preparedAtStepSeq) && admittedStep?.seq > source.preparedAtStepSeq && generated?.seq > event.seq,
      literalBracesPreserved: !text.includes('DSH_GIT_PROMPTS_VERIFY_COMMIT') || text.includes('{{literal}}')};
  });
  const editor = this.get('configEditor');
  const ownConfig = editor?.configuration().find(row => row.entry.options?.id === 'local-git-prompts' || row.entry.id === 'include:local-git-prompts');
  return {sourceId, descriptor: {enabled: descriptor.value.enabled, revision: descriptor.revision,
    commitCharacters: descriptor.value.commitInstructions.length, prCharacters: descriptor.value.prInstructions.length},
    bodiesAbsentFromSystemAndToolSchemas: true, toolsVisible: true, preparations,
    persistedOwnOverride: ownConfig ? {fields: Object.keys(ownConfig.override),
      commitMatches: ownConfig.override.commitInstructions === descriptor.value.commitInstructions,
      prMatches: ownConfig.override.prInstructions === descriptor.value.prInstructions} : null,
    evidence: 'Host assembly and reconstructed durable Session history; not a provider network capture.'};
}

const sourceId = process.argv[2] || process.env.DSH_SESSION_ID;
assert.ok(sourceId?.startsWith('session-'), 'Pass a currently live source Session ID.');
const inspector = await connect();
try {
  const {root} = await inspector.call('DOM.getDocument', {depth: 3});
  const {object} = await inspector.call('DOM.resolveNode', {nodeId: root.children[0].children[0].nodeId});
  const outcome = await inspector.call('Runtime.callFunctionOn', {objectId: object.objectId, functionDeclaration: inspect.toString(),
    arguments: [{value: {sourceId}}], awaitPromise: true, returnByValue: true});
  if (outcome.exceptionDetails) throw new Error(JSON.stringify(outcome.exceptionDetails));
  console.log(JSON.stringify(outcome.result.value, null, 2));
} finally {inspector.close();}
