// Uses the existing Host Inspector and real Gateway; never creates or stops a DSH Session.
import assert from 'node:assert/strict';
import {connect} from './cdp.mjs';

async function verify(options) {
  const check = (condition, message) => {if (!condition) throw new Error(message);};
  const source = this.get('agents').get(options.sourceId);
  check(source, 'Pass the currently live source Session ID');
  const service = this.get('localSideChat');
  const gateway = this.get('typertGateway');
  const signal = AbortSignal.timeout(90000);
  const peer = {id: 'local-side-chat-verification', ctx: this, principal: {kind: 'owner'}, signal, interactions: 'none', dispose: async () => {}};
  const invoke = request => gateway.invoke({namespace: 'localSideChat', method: 'perform', args: {agentId: source.id, request}, peer, signal});
  const stream = request => gateway.stream({namespace: 'localSideChat', method: 'send', args: {agentId: source.id, request}, peer, signal});
  const stringify = value => JSON.stringify(value);
  const initialConfig = stringify(service.configuration(source));
  const initialSeq = source.session.seq;
  const context = stringify(source.session.deriveMessages());
  const originalLength = source.session.deriveMessages().length;
  const nativeBefore = (await this.get('sessionController').list({}, signal)).items.filter(item => item.origin !== 'subagent').map(item => item.sessionId).sort();
  const tabKey = `integration-${crypto.randomUUID()}`;
  let sideChatId;
  try {
    const created = await invoke({action: 'create', tabKey});
    sideChatId = created.sideChatId;
    const same = await invoke({action: 'create', tabKey});
    check(same.sideChatId === sideChatId, 'Concurrent/repeated tab creation is not idempotent');
    check(created.messages.length === 0, 'Main transcript leaked into side-chat display');
    check(!('context' in created) && !('toolHistory' in created), 'Hidden model context leaked over Remote');
    const record = service.records.get(sideChatId);
    check(stringify(record.context.slice(0, originalLength)) === context, 'Native effective model-context prefix differs');
    check(stringify(created.config) === initialConfig, 'Source model settings were not inherited');
    check(source.session.seq === initialSeq, 'Opening a side chat appended source events');

    // Stop before provider inference: advance only the initial state, then cancel the private request.
    const cancelled = await stream({sideChatId, text: 'PRIVATE_SIDE_CHAT_CANCELLATION_TEST', requestId: `cancel-${tabKey}`});
    const iterator = cancelled[Symbol.asyncIterator]();
    const first = await iterator.next();
    check(first.value?.kind === 'state' && first.value.view.busy, 'Remote stream did not expose its initial state');
    await invoke({action: 'stop', sideChatId});
    let stopped;
    for (;;) {const next = await iterator.next(); if (next.done) break; if (next.value.kind === 'state') stopped = next.value.view;}
    check(stopped && !stopped.busy && /stopped/.test(stopped.error), 'Private cancellation did not settle');
    check(source.session.seq === initialSeq, 'Private stop changed source history');

    let answer;
    if (options.send) {
      const frames = await stream({sideChatId, text: '请只用一句简短中文概括主会话用户刚刚明确的两点侧聊要求，不执行工具，不复述实现过程。', requestId: `answer-${tabKey}`});
      let final; let deltas = 0;
      for await (const frame of frames) {if (frame.kind === 'delta') deltas++; if (frame.kind === 'state') final = frame.view;}
      check(final && !final.busy && !final.error, final?.error || 'Remote answer did not finish');
      answer = final.messages.at(-1).text;
      check(answer.length > 0 && deltas > 0, 'No real streamed answer');
      check(final.messages.length === 4, 'Display includes messages beyond the two private requests');
      check(source.session.seq === initialSeq, 'Model answer appended to source history');
    }

    const nativeAfter = (await this.get('sessionController').list({}, signal)).items.filter(item => item.origin !== 'subagent').map(item => item.sessionId).sort();
    check(stringify(nativeAfter) === stringify(nativeBefore), 'Native Session catalog changed');
    check(stringify(service.configuration(source)) === initialConfig, 'Source model settings changed');
    const archived = this.get('workspaceRegistry').archivedSessionIds;
    check(!archived.includes(source.id), 'Main conversation was archived');
    const migrated = [...service.records.values()].filter(item => item.sourceSessionId === source.id && item.legacySessionId);
    check(migrated.every(item => archived.includes(item.legacySessionId)), 'A proven legacy side chat remains in the active list');
    const schema = this.get('tools').schemas().find(item => item.name === 'side_chat');
    const message = text => ({role: 'developer', content: [{type: 'text', text}]});
    const meter = this.get('tokenMeter');
    return {scopedRemoteCreateRead: true, privateStreamStop: true, nativeContextPrefixEqual: true,
      nativeSessionCatalogUnchanged: true, sourceHistoryUnchanged: true, sourceConfigUnchanged: true,
      config: created.config, migratedLegacySessions: migrated.length, legacyArchived: true,
      toolSchemaCharacters: stringify(schema).length,
      toolSchemaTokenEstimate: meter.estimateMessage(message(stringify(schema))) - meter.estimateMessage(message('')),
      ...(answer ? {realRemoteStreamAnswer: answer} : {})};
  } finally {
    // Delete only this freshly generated integration record, never user tabs or native Sessions.
    if (sideChatId) {
      const record = service.records.get(sideChatId);
      check(record?.creationKey === `${source.id}:${tabKey}`, 'Refusing to clean a non-test private record');
      const directory = service.unit.tableDir('chats');
      const target = `${directory}/${sideChatId}.json`;
      check(directory.startsWith('/') && !directory.split('/').some(part => part === '.' || part === '..') && directory === `${service.unit.dir}/chats` && /^side-chat-[a-f0-9-]+$/.test(sideChatId), `Unexpected absolute test-record path: ${target}`);
      await service.unit.deleteRecord('chats', sideChatId);
      service.records.delete(sideChatId);
    }
  }
}

const sourceId = process.argv.slice(2).find(value => value !== '--send') || process.env.DSH_SESSION_ID;
assert.ok(sourceId?.startsWith('session-'), 'Pass the live source Session ID');
const options = {sourceId, send: process.argv.includes('--send')};
const cdp = await connect();
try {
  const {root} = await cdp.call('DOM.getDocument', {depth: 3});
  const {object} = await cdp.call('DOM.resolveNode', {nodeId: root.children[0].children[0].nodeId});
  const outcome = await cdp.call('Runtime.callFunctionOn', {objectId: object.objectId,
    functionDeclaration: verify.toString(), arguments: [{value: options}], awaitPromise: true, returnByValue: true}, 100000);
  if (outcome.exceptionDetails) throw new Error(JSON.stringify(outcome.exceptionDetails));
  console.log(JSON.stringify(outcome.result.value, null, 2));
} finally {cdp.close();}
