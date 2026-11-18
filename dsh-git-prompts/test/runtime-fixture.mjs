// Shared isolated contract: real SDK pipeline/session/projection; fake settings/working-directory/Git backends.
import assert from 'node:assert/strict';
import {apply} from '../index.js';
import {NAMESPACE, PREPARE_TOOL, SETTINGS_TOOL, SOURCE, MAX_DIFF} from '../core.js';

export async function exerciseRuntime(runtime) {
  const {Context} = runtime('@deepseek-ai/cordis');
  const {SystemPrompt} = runtime('@deepseek-ai/dsh-system-prompt');
  const {ToolsService} = runtime('@deepseek-ai/dsh-tools');
  const {ToolExecutionPipeline} = runtime('@deepseek-ai/dsh-tools/pipeline');
  const {NativeToolExecutor} = runtime('@deepseek-ai/dsh-tool-executor-native');
  const {Session} = runtime('@deepseek-ai/dsh-session');
  const {SessionProjectionRegistry} = runtime('@deepseek-ai/dsh-session-projection');
  const {createAssistantMessage, createToolResultMessage, createUserMessage} = runtime('@deepseek-ai/dsh-llm');

  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolsService(ctx);
  new SessionProjectionRegistry(ctx);
  const executor = new NativeToolExecutor(ctx);
  ctx.tools.setExecutor(executor);
  let revision = 3;
  const rules = 'Conventional Commits. description 使用中文。保留 {{literal}}。';
  let value = {enabled: true, commitInstructions: rules, prInstructions: 'PR 用中文。'};
  ctx.reflect.provide('settings', {configure: () => () => {}, describe: () => [{ns: NAMESPACE, value, revision}], update: () => {throw new Error('No profile writes in this fixture.');}});
  ctx.reflect.provide('workingDirectory', {get: () => '/fixture/repo'});
  const observations = [];
  ctx.reflect.provide('gitWorkbench', {execute: async (_agent, input) => {
    observations.push(input.action);
    if (input.action === 'summary') return {repo: '/fixture/repo', branch: 'fixture', head: null, files: [{staged: true, conflict: false}]};
    assert.equal(input.action, 'diff'); assert.equal(input.staged, true);
    return {text: 'x'.repeat(MAX_DIFF + 10), truncated: false};
  }});
  await apply(ctx);
  let fakeWrites = 0;
  ctx.tools.register({name: 'git_workbench', parameters: {type: 'object'}, output: {schema: {type: 'object'}, render: (_args, result) => [{type: 'text', text: JSON.stringify(result)}]},
    execute: async () => {fakeWrites++; return {fixtureOnly: true};}});
  const pipeline = new ToolExecutionPipeline(ctx);
  const session = Session.create('git-prompts-isolated-fixture');
  const agent = {id: session.id, session};
  const source = {provider: 'fixture', model: 'no-model-called'};
  const appendAssistant = (step, id, name, args) => session.append('assistant/message', {turn: 1, step,
    message: createAssistantMessage({source, content: [{type: 'tool-call', id, name, arguments: JSON.stringify(args)}]}), stream: []}, {surfaceOp: 'append'});
  const execute = async (name, args, callId, rootCallId) => {
    const prepared = await pipeline.prepare({name, arguments: args, callId, rootCallId, agent, signal: AbortSignal.timeout(4000)});
    const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared;
    return pipeline.complete(prepared.exec, outcome);
  };
  const appendResult = (step, callId, result) => {
    session.append('tool/result', {turn: 1, step, message: createToolResultMessage({callId, content: result.content, isError: result.isError})}, {surfaceOp: 'append'});
  };

  const before = await ctx.systemPrompt.assemble({scope: agent});
  assert.ok(!before.sections.some(section => section.text.includes(rules)));
  assert.deepEqual(ctx.tools.schemas(agent).filter(tool => [PREPARE_TOOL, SETTINGS_TOOL].includes(tool.name)).map(tool => tool.name).sort(), [SETTINGS_TOOL, PREPARE_TOOL].sort());
  session.append('turn/start', {turn: 1}); session.append('step/start', {turn: 1, step: 0});
  assert.deepEqual(ctx.tools.get(PREPARE_TOOL, agent).parameters.required, []);
  // Regression: this exact empty PTC/native argument used to abort the whole program.
  appendAssistant(0, 'prepare-call', PREPARE_TOOL, {});
  const preparation = await execute(PREPARE_TOOL, {}, 'prepare-call');
  assert.equal(preparation.isError, false, JSON.stringify(preparation));
  assert.equal(preparation.value.operation, 'commit');
  assert.equal(preparation.additionalContexts.length, 1);
  assert.equal(preparation.additionalContexts[0].source.kind, SOURCE);
  assert.ok(preparation.additionalContexts[0].content[0].text.includes(rules));
  assert.equal(preparation.value.git.truncated, true);
  assert.deepEqual(observations, ['summary', 'diff']);
  // The nested call cannot see preparation until the outer result is appended AND a new model step generates a call.
  const premature = await execute('git_workbench', {action: 'commit', message: 'fix: fixture'}, 'inner-premature', 'prepare-call');
  assert.equal(premature.isError, true); assert.equal(fakeWrites, 0);
  appendResult(0, 'prepare-call', preparation);
  const sameStep = await execute('git_workbench', {action: 'commit', message: 'fix: fixture'}, 'inner-same-step', 'prepare-call');
  assert.equal(sameStep.isError, true); assert.equal(fakeWrites, 0);
  session.append('step/end', {turn: 1, step: 0}); session.append('step/start', {turn: 1, step: 1});
  // Actual AgentLoop admission commits deferred contexts after the NEW step/start.
  for (const context of preparation.additionalContexts) session.append('user/message', context, {surfaceOp: 'append'});
  appendAssistant(1, 'commit-generated-later', 'git_workbench', {action: 'commit', message: 'fix: 隔离测试'});
  const allowed = await execute('git_workbench', {action: 'commit', message: 'fix: 隔离测试'}, 'commit-generated-later');
  assert.equal(allowed.isError, false, JSON.stringify(allowed)); assert.equal(fakeWrites, 1);
  const preparedMessage = preparation.additionalContexts[0];
  assert.equal(session.deriveMessages().find(message => message.id === preparedMessage.id)?.source.kind, SOURCE);
  const after = await ctx.systemPrompt.assemble({scope: agent});
  assert.deepEqual(after.sections, before.sections, 'Preparation must not mutate system prompt sections.');
  revision++;
  assert.equal((await execute('git_workbench', {action: 'commit', message: 'fix: stale'}, 'commit-generated-later')).isError, true);
  assert.equal(fakeWrites, 1);
  revision--;
  // Replacing the rule context with an ordinary summary invalidates the previously prepared state.
  const preparedSeq = session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === preparedMessage.id).seq;
  session.append('user/message', createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'Compacted fixture summary'}]}),
    {surfaceOp: {op: 'replace', startSeq: preparedSeq, endSeq: preparedSeq}, sourceEventSeqs: [preparedSeq]});
  assert.equal((await execute('git_workbench', {action: 'commit', message: 'fix: compacted'}, 'commit-generated-later')).isError, true);
  assert.equal(fakeWrites, 1);
  value = {...value, enabled: false};
  assert.equal((await execute('git_workbench', {action: 'commit', message: 'fix: paused'}, 'commit-generated-later')).isError, false);
  assert.equal(fakeWrites, 2);
  return {
    isolatedNativePipeline: true, emptyArgumentsDefaultToCommit: true, realSessionAndProjection: true, sourceContextRoundTrip: true,
    sameBatchAndSameStepDenied: true, nextModelStepAllowed: true, revisionAndCompactionDenied: true,
    systemSectionsUnchanged: true, readOnlyObservations: observations, actualGitWrites: 0, modelRequests: 0
  };
}
