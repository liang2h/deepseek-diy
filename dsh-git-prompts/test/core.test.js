import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  MAX_LENGTH, MAX_DIFF, NAMESPACE, SOURCE, PREPARE_TOOL, SETTINGS_TOOL,
  validateSettingsRequest, validatePreparation, descriptorOf, settingsView,
  performSettings, requestedDirectory, preparationState, foldPreparation,
  preparationDenial, renderPreparation, prepareOperation, fingerprint, textOf,
} from '../core.js';

// These fixtures model only the public shapes used by core.js. They never load
// Harness, start a model, execute a process, touch a repository, or save a profile.
const REPO = '/synthetic/repository';
const RULES = 'Use a short Chinese title. Preserve {{literal}} and {{}} verbatim.';
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'developer/message', 'system/message', 'tool/result']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);

function event(type, data, seq, extra = {}) {
  return {type, seq, time: 0, data, ...(SURFACE_TYPES.has(type) ? {surfaceOp: 'append'} : {}), ...extra};
}

function assistantMessage(ids, {turn = 0, step = 0} = {}) {
  return {turn, step, stream: [], message: {
    id: `assistant-${turn}-${step}`, role: 'assistant', source: {kind: 'model', provider: 'synthetic', model: 'never-called'},
    content: [{type: 'text', text: 'Synthetic tool batch'}, ...ids.map(id => ({type: 'tool-call', id, name: 'git_workbench', arguments: '{}'}))],
  }};
}

function preparedMessage({id = 'prepared-message', sessionId = 'session-a', repo = REPO, revision = 7, turn = 0,
  preparedAtStepSeq = 1, instructions = RULES, text = 'Synthetic prepared instructions', source = {}} = {}) {
  return {id, role: 'user', source: {
    kind: SOURCE, form: 'instructions', version: 1, sessionId, operation: 'commit', repo, revision,
    rulesHash: sha256(instructions), contentHash: sha256(text), turn, preparedAtStepSeq, preparedCallId: 'prepare-call', ...source,
  }, content: [{type: 'text', text}]};
}

function openedState({sessionId = 'session-a', inheritedFloor = 0, turn = 0, step = 0} = {}) {
  let state = preparationState({id: sessionId}, inheritedFloor);
  state = foldPreparation(state, event('turn/start', {turn}, inheritedFloor));
  return foldPreparation(state, event('step/start', {turn, step}, inheritedFloor + 1));
}

function harness(options = {}) {
  const id = options.id ?? 'session-a';
  const settings = {enabled: true, commitInstructions: '', prInstructions: '', ...options.settings};
  let revision = options.revision ?? 7;
  let state = openedState({sessionId: id});
  let sequence = 2;
  const messages = [];
  const deferred = [];
  const gitCalls = [];
  const approvals = [];
  const writeAttempts = [];
  const writes = [];
  const lookups = [];
  const controller = new AbortController();
  const session = {id, deriveMessages: () => [...messages]};
  const agent = {id, session};
  const approval = {async request(input) {
    approvals.push(input);
    await options.onApproval?.(fixture, input);
    return Object.hasOwn(options, 'approvalOutcome') ? options.approvalOutcome : 'allowed-once';
  }};
  const gitWorkbench = {async execute(owner, args, signal) {
    assert.equal(owner, agent);
    assert.equal(signal, controller.signal);
    // A production write action is a test failure, never forwarded anywhere.
    assert.ok(['summary', 'diff'].includes(args.action), `Unexpected Git action: ${args.action}`);
    gitCalls.push(clone(args));
    const custom = await options.onGit?.(fixture, args);
    if (custom !== undefined) return custom;
    if (args.action === 'summary') return {
      repo: REPO, branch: 'topic/synthetic', head: 'abc123', files: [
        {path: 'a.js', staged: true, conflict: false},
        {path: 'b.js', staged: false, conflict: true},
        {path: 'c.js', staged: true, conflict: false},
      ],
    };
    return {text: options.diff ?? 'diff --git a/a.js b/a.js\n+synthetic change', truncated: options.truncated ?? false};
  }};
  const ctx = {
    settings: {
      describe: () => options.missingDescriptor ? [] : [{ns: NAMESPACE, revision, value: {...settings}}],
      async update(namespace, patch, expectedRevision) {
        assert.equal(namespace, NAMESPACE);
        writeAttempts.push({namespace, patch: clone(patch), expectedRevision});
        if (expectedRevision !== revision) throw new Error('Settings revision conflict');
        Object.assign(settings, patch);
        revision += 1;
        writes.push(clone(patch));
      },
    },
    workingDirectory: {get(owner) {assert.equal(owner, session); return options.directory ?? REPO;}},
    get(name) {
      lookups.push(name);
      if (name === 'approval') return options.missingApproval ? undefined : approval;
      if (name === 'gitWorkbench') return options.missingGit ? undefined : gitWorkbench;
      assert.fail(`Unexpected runtime service: ${name}`);
    },
  };
  const projection = {stateOf(owner) {assert.equal(owner, session); return state;}};
  const exec = {name: PREPARE_TOOL, callId: 'prepare-call', rootCallId: 'preparation-root', agent,
    signal: controller.signal, deferContext: message => deferred.push(message)};
  const fixture = {
    ctx, projection, exec, agent, session, settings, controller, messages, deferred, gitCalls, approvals, writeAttempts, writes, lookups,
    get state() {return state;}, set state(value) {state = value;},
    get revision() {return revision;},
    revise(patch = {}) {Object.assign(settings, patch); revision += 1;},
    emit(type, data, extra = {}) {
      const entry = event(type, data, sequence++, extra);
      state = foldPreparation(state, entry);
      if (type === 'user/message') messages.push(data);
      return entry;
    },
    call(ids, step = state.step) {return fixture.emit('assistant/message', assistantMessage(ids, {turn: state.turn, step}));},
    startStep() {return fixture.emit('step/start', {turn: state.turn, step: state.step + 1});},
    nextStep(ids = ['commit-root']) {
      fixture.startStep();
      fixture.call(ids);
    },
    deliver(message = deferred.at(-1)) {assert.ok(message); return fixture.emit('user/message', message);},
    commit(overrides = {}) {return {name: 'git_workbench', callId: 'commit-root', agent, arguments: {action: 'commit', repo: REPO}, signal: controller.signal, ...overrides};},
  };
  return fixture;
}

function assertDenied(result) {
  assert.equal(result?.info?.code, 'GIT_PREPARATION_REQUIRED');
  assert.equal(result.info.name, 'GitPreparationRequired');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
}

async function readyForCommit(options = {}) {
  const fixture = harness({settings: {commitInstructions: RULES}, ...options});
  await prepareOperation(fixture.ctx, fixture.projection, {operation: 'commit'}, fixture.exec);
  // Real inbox delivery occurs after the following step/start, before its model output.
  fixture.startStep();
  fixture.deliver();
  fixture.call(['commit-root']);
  return fixture;
}

test('validateSettingsRequest preserves valid get/update inputs and literal braces', () => {
  for (const input of [{action: 'get'}, {action: 'update', enabled: false}, {action: 'update', commitInstructions: ''},
    {action: 'update', prInstructions: RULES, expectedRevision: 0},
    {action: 'update', enabled: true, commitInstructions: RULES, prInstructions: '{{}}'}]) {
    assert.equal(validateSettingsRequest(input), input);
  }
});

test('validateSettingsRequest enforces UTF-16 limits for both instruction fields', () => {
  for (const key of ['commitInstructions', 'prInstructions']) {
    for (const value of ['a'.repeat(MAX_LENGTH), '😀'.repeat(MAX_LENGTH / 2)]) {
      assert.equal(validateSettingsRequest({action: 'update', [key]: value})[key], value);
    }
    for (const value of ['a'.repeat(MAX_LENGTH + 1), '😀'.repeat(MAX_LENGTH / 2) + 'a']) {
      assert.throws(() => validateSettingsRequest({action: 'update', [key]: value}), /at most|characters/);
    }
  }
});

for (const [name, input] of [
  ['null', null], ['array', []], ['string', 'get'], ['missing action', {}], ['unknown action', {action: 'set'}],
  ['unknown parameter', {action: 'update', enabled: true, surprise: true}],
  ['get with update field', {action: 'get', enabled: true}], ['get with revision', {action: 'get', expectedRevision: 0}],
  ['update without patch', {action: 'update'}], ['revision-only update', {action: 'update', expectedRevision: 1}],
  ['nonboolean enabled', {action: 'update', enabled: 'true'}], ['null instruction', {action: 'update', commitInstructions: null}],
  ['numeric instruction', {action: 'update', prInstructions: 12}], ['negative revision', {action: 'update', enabled: true, expectedRevision: -1}],
  ['fractional revision', {action: 'update', enabled: true, expectedRevision: 1.5}],
  ['unsafe revision', {action: 'update', enabled: true, expectedRevision: Number.MAX_SAFE_INTEGER + 1}],
  ['string revision', {action: 'update', enabled: true, expectedRevision: '1'}],
]) {
  test(`validateSettingsRequest rejects ${name}`, () => assert.throws(() => validateSettingsRequest(input)));
}

test('settings get returns empty defaults, revision and scope without approval or writes', async () => {
  const fixture = harness();
  assert.deepEqual(await performSettings(fixture.ctx, {action: 'get'}), {
    enabled: true, commitInstructions: '', prInstructions: '', revision: 7,
    scope: 'current-profile', delivery: 'on-demand', guardedTool: 'git_workbench(action=commit)',
  });
  assert.equal(settingsView(fixture.ctx).revision, descriptorOf(fixture.ctx).revision);
  assert.deepEqual(fixture.approvals, []);
  assert.deepEqual(fixture.writeAttempts, []);
});

for (const outcome of ['denied', 'cancelled', 'allowed-always', undefined]) {
  test(`settings update without allowed-once approval performs zero writes (${outcome ?? 'missing outcome'})`, async () => {
    const fixture = harness({approvalOutcome: outcome});
    await assert.rejects(performSettings(fixture.ctx, {action: 'update', commitInstructions: RULES}, fixture.exec), /not changed/);
    assert.equal(fixture.approvals.length, 1);
    assert.deepEqual(fixture.writeAttempts, []);
    assert.equal(fixture.settings.commitInstructions, '');
    assert.equal(fixture.revision, 7);
  });
}

test('settings update requests approval, freezes the patch and preserves omitted fields', async () => {
  const request = {action: 'update', commitInstructions: RULES, expectedRevision: 7};
  const fixture = harness({settings: {prInstructions: 'keep PR'}, onApproval(_fixture) {request.commitInstructions = 'mutated while approving';}});
  const result = await performSettings(fixture.ctx, request, fixture.exec);
  assert.deepEqual(fixture.writes, [{commitInstructions: RULES}]);
  assert.equal(result.commitInstructions, RULES);
  assert.equal(result.prInstructions, 'keep PR');
  assert.equal(result.revision, 8);
  const approval = fixture.approvals[0];
  assert.equal(approval.agent, fixture.agent);
  assert.equal(approval.toolName, SETTINGS_TOOL);
  assert.equal(approval.callId, fixture.exec.callId);
  assert.equal(approval.signal, fixture.exec.signal);
  assert.ok(approval.reason.includes('{{literal}}'));
  assert.ok(approval.displayReason.zh.includes('{{}}'));
});

for (const explicit of [false, true]) {
  test(`settings revision captured before approval protects concurrent changes (${explicit ? 'explicit' : 'implicit'} revision)`, async () => {
    const fixture = harness({onApproval(current) {current.revise({commitInstructions: 'concurrent edit'});}});
    await assert.rejects(performSettings(fixture.ctx, {action: 'update', enabled: false,
      ...(explicit ? {expectedRevision: 7} : {})}, fixture.exec), /revision conflict/);
    assert.deepEqual(fixture.writes, []);
    assert.equal(fixture.writeAttempts[0].expectedRevision, 7);
    assert.equal(fixture.settings.commitInstructions, 'concurrent edit');
    assert.equal(fixture.settings.enabled, true);
  });
}

test('settings update rejects missing agent, approval service or descriptor', async () => {
  const fixture = harness();
  await assert.rejects(performSettings(fixture.ctx, {action: 'update', enabled: false}, {}), /live conversation/);
  const noApproval = harness({missingApproval: true});
  await assert.rejects(performSettings(noApproval.ctx, {action: 'update', enabled: false}, noApproval.exec), /Approval service/);
  const noSettings = harness({missingDescriptor: true});
  assert.throws(() => descriptorOf(noSettings.ctx), /unavailable/);
  for (const item of [fixture, noApproval, noSettings]) assert.deepEqual(item.writeAttempts, []);
});

test('settings update honors cancellation before approval and after approval, with zero writes', async () => {
  const before = harness();
  before.controller.abort(new Error('cancelled before approval'));
  await assert.rejects(performSettings(before.ctx, {action: 'update', enabled: false}, before.exec), /cancelled before approval/);
  assert.deepEqual(before.approvals, []);
  const during = harness({onApproval(current) {current.controller.abort(new Error('cancelled during approval'));}});
  await assert.rejects(performSettings(during.ctx, {action: 'update', enabled: false}, during.exec), /cancelled during approval/);
  assert.deepEqual(before.writeAttempts, []);
  assert.deepEqual(during.writeAttempts, []);
});

test('validatePreparation accepts explicit commit/pr and safe absolute directories', () => {
  for (const input of [{operation: 'commit'}, {operation: 'pr', repo: REPO}]) {
    const result = validatePreparation(Object.freeze(input));
    assert.deepEqual(result, input);
    assert.notEqual(result, input, 'validation returns a canonical request without mutating the caller');
  }
  for (const input of [undefined, null, [], {operation: 'push'}, {operation: 'commit', base: 'main'},
    {operation: 'pr', repo: 'relative/path'}, {operation: 'commit', repo: 3},
    {operation: 'commit', repo: '/nul\0path'}, {operation: 'commit', repo: '/' + 'a'.repeat(4096)}]) {
    assert.throws(() => validatePreparation(input));
  }
});

test('omitting operation defaults to commit without changing the input object', () => {
  for (const input of [{}, {repo: REPO}, {operation: undefined}]) {
    const original = structuredClone(input);
    Object.freeze(input);
    assert.deepEqual(validatePreparation(input), {...original, operation: 'commit'});
    assert.deepEqual(input, original);
  }
});

test('an explicitly invalid operation or unknown field never silently defaults or reads Git', async () => {
  for (const input of [{operation: null}, {operation: ''}, {operation: false}, {operation: 0},
    {operation: 'push'}, {operation: 'PR'}, {operation: []}, {action: 'commit'}, {repo: 'relative'}]) {
    const fixture = harness();
    await assert.rejects(prepareOperation(fixture.ctx, fixture.projection, input, fixture.exec));
    assert.deepEqual(fixture.gitCalls, []);
    assert.deepEqual(fixture.deferred, []);
    assert.deepEqual(fixture.writeAttempts, []);
    assert.deepEqual(fixture.approvals, []);
  }
});

test('empty preparation call loads only commit rules and still requires the next model step', async () => {
  const fixture = harness({settings: {commitInstructions: RULES, prInstructions: 'DO_NOT_LOAD_PR_RULES'}});
  fixture.call(['preparation-root']);
  const result = await prepareOperation(fixture.ctx, fixture.projection, {}, fixture.exec);
  assert.equal(result.operation, 'commit');
  assert.equal(result.repo, REPO);
  assert.deepEqual(fixture.gitCalls, [{action: 'summary', repo: REPO}, {action: 'diff', repo: REPO, staged: true}]);
  assert.equal(fixture.deferred[0].source.operation, 'commit');
  assert.ok(textOf(fixture.deferred[0]).includes(RULES));
  assert.ok(!textOf(fixture.deferred[0]).includes('DO_NOT_LOAD_PR_RULES'));
  fixture.deliver();
  assertDenied(preparationDenial(fixture.ctx, fixture.projection, fixture.commit()));
  fixture.nextStep(['commit-root']);
  assert.equal(preparationDenial(fixture.ctx, fixture.projection, fixture.commit()), undefined);
  assert.deepEqual(fixture.approvals, []);
  assert.deepEqual(fixture.writeAttempts, []);
});

test('a preparation with only repo uses the same default commit operation', async () => {
  const fixture = harness();
  const result = await prepareOperation(fixture.ctx, fixture.projection, {repo: '/synthetic/explicit'}, fixture.exec);
  assert.equal(result.operation, 'commit');
  assert.equal(result.repo, '/synthetic/explicit');
  assert.deepEqual(fixture.gitCalls, [{action: 'summary', repo: '/synthetic/explicit'}, {action: 'diff', repo: '/synthetic/explicit', staged: true}]);
  assert.deepEqual(fixture.approvals, []);
  assert.deepEqual(fixture.writeAttempts, []);
});

test('requestedDirectory uses the Session directory, normalizes it, and rejects relative paths', () => {
  const fixture = harness({directory: '/synthetic/a/../repository/'});
  assert.equal(requestedDirectory(fixture.ctx, fixture.agent), REPO);
  assert.equal(requestedDirectory(fixture.ctx, fixture.agent, '/other/a/../repo'), '/other/repo');
  const relative = harness({directory: 'relative'});
  assert.throws(() => requestedDirectory(relative.ctx, relative.agent), /absolute/);
});

test('commit preparation only observes summary/staged diff and defers source-attributed user context', async () => {
  const fixture = harness({settings: {commitInstructions: RULES, prInstructions: 'PR only marker'}});
  const output = await prepareOperation(fixture.ctx, fixture.projection, {operation: 'commit'}, fixture.exec);
  assert.deepEqual(fixture.gitCalls, [{action: 'summary', repo: REPO}, {action: 'diff', repo: REPO, staged: true}]);
  assert.equal(fixture.deferred.length, 1);
  assert.deepEqual(fixture.writeAttempts, []);
  assert.deepEqual(fixture.approvals, []);
  assert.equal(fixture.state.preparations.length, 0, 'deferContext is not a persisted or consumed preparation');
  const message = fixture.deferred[0];
  assert.equal(message.role, 'user');
  assert.equal(message.id, output.contextMessageId);
  assert.deepEqual(message.source, {kind: SOURCE, form: 'instructions', version: 1, sessionId: fixture.session.id,
    operation: 'commit', repo: REPO, revision: 7, rulesHash: sha256(RULES), contentHash: sha256(textOf(message)), turn: 0,
    preparedAtStepSeq: fixture.state.stepSeq, preparedCallId: 'prepare-call'});
  assert.ok(textOf(message).includes(RULES));
  assert.ok(!textOf(message).includes('PR only marker'));
  assert.match(textOf(message), /NEW model step/);
  assert.match(textOf(message), /not instructions/);
  assert.deepEqual(output.git.summary, {repository: REPO, branch: 'topic/synthetic', head: 'abc123', stagedFiles: 2, conflictedFiles: 1});
  assert.equal(output.active, true);
  assert.equal(output.delivery, 'after-tool-result-before-next-model-step');
  assert.deepEqual(fixture.lookups, ['gitWorkbench']);
});

test('PR preparation does not infer a base, request a diff or perform writes', async () => {
  const fixture = harness({settings: {commitInstructions: 'commit only marker', prInstructions: RULES}});
  const output = await prepareOperation(fixture.ctx, fixture.projection, {operation: 'pr'}, fixture.exec);
  assert.deepEqual(fixture.gitCalls, [{action: 'summary', repo: REPO}]);
  assert.equal(output.operation, 'pr');
  assert.equal(output.git.diffCharacters, 0);
  const message = fixture.deferred[0];
  assert.equal(message.source.operation, 'pr');
  assert.ok(textOf(message).includes(RULES));
  assert.ok(!textOf(message).includes('commit only marker'));
  assert.match(textOf(message), /does not infer a base branch or create a PR/);
  assert.match(textOf(message), /separately inspect the intended base\/head diff and commits/);
  fixture.deliver();
  assert.deepEqual(fixture.state.preparations, [], 'PR context cannot authorize a commit');
  assert.deepEqual(fixture.writeAttempts, []);
});

for (const [name, diff, upstreamTruncated, expectedTruncated] of [
  ['below cap', 'd'.repeat(MAX_DIFF - 1), false, false], ['exact cap', 'd'.repeat(MAX_DIFF), false, false],
  ['above cap', 'd'.repeat(MAX_DIFF + 1), false, true], ['upstream truncated', 'short', true, true],
]) {
  test(`commit preparation handles diff truncation (${name})`, async () => {
    const fixture = harness({diff, truncated: upstreamTruncated});
    const output = await prepareOperation(fixture.ctx, fixture.projection, {operation: 'commit'}, fixture.exec);
    assert.equal(output.git.diffCharacters, Math.min(MAX_DIFF, diff.length));
    assert.equal(output.git.truncated, expectedTruncated);
    assert.equal(textOf(fixture.deferred[0]).includes('[Diff truncated.'), expectedTruncated);
    if (diff.length > MAX_DIFF) assert.ok(!textOf(fixture.deferred[0]).includes('d'.repeat(MAX_DIFF + 1)));
  });
}

test('preparation works without Git Workbench but explicitly warns that observation is missing', async () => {
  const fixture = harness({missingGit: true, settings: {commitInstructions: RULES}});
  const output = await prepareOperation(fixture.ctx, fixture.projection, {operation: 'commit', repo: '/synthetic/explicit'}, fixture.exec);
  assert.equal(output.repo, '/synthetic/explicit');
  assert.equal(output.git, null);
  assert.match(output.gitWarning, /not loaded/);
  assert.ok(textOf(fixture.deferred[0]).includes(RULES));
  assert.match(textOf(fixture.deferred[0]), /Git observation unavailable/);
});

test('default-empty and disabled instructions are not delivered as active rules', async () => {
  for (const settings of [{}, {commitInstructions: '  \n\t'}, {enabled: false, commitInstructions: 'hidden saved marker'}]) {
    const fixture = harness({settings});
    const output = await prepareOperation(fixture.ctx, fixture.projection, {operation: 'commit'}, fixture.exec);
    assert.equal(output.active, false);
    assert.match(textOf(fixture.deferred[0]), /No active custom instructions/);
    assert.ok(!textOf(fixture.deferred[0]).includes('hidden saved marker'));
  }
});

test('preparation rejects absent Session/context executor or unopened model step', async () => {
  for (const change of [{agent: undefined}, {agent: {id: 'no-session'}}, {deferContext: undefined}]) {
    const fixture = harness();
    await assert.rejects(prepareOperation(fixture.ctx, fixture.projection, {operation: 'commit'}, {...fixture.exec, ...change}), /Session.*context-capable/);
    assert.deepEqual(fixture.gitCalls, []);
    assert.deepEqual(fixture.deferred, []);
  }
  const unopened = harness();
  unopened.state = preparationState({id: unopened.session.id});
  await assert.rejects(prepareOperation(unopened.ctx, unopened.projection, {operation: 'commit'}, unopened.exec), /open model step/);
  assert.deepEqual(unopened.deferred, []);
});

test('preparation honors cancellation before reads and after asynchronous reads', async () => {
  const before = harness();
  before.controller.abort(new Error('cancel before reads'));
  await assert.rejects(prepareOperation(before.ctx, before.projection, {operation: 'commit'}, before.exec), /cancel before reads/);
  assert.deepEqual(before.gitCalls, []);
  const during = harness({onGit(current, args) {if (args.action === 'diff') current.controller.abort(new Error('cancel during reads'));}});
  await assert.rejects(prepareOperation(during.ctx, during.projection, {operation: 'commit'}, during.exec), /cancel during reads/);
  assert.deepEqual(before.deferred, []);
  assert.deepEqual(during.deferred, []);
});

test('a concurrent settings save during preparation rejects instead of delivering stale instructions', async () => {
  const fixture = harness({settings: {commitInstructions: RULES}, onGit(current, args) {
    if (args.action === 'summary') current.revise({commitInstructions: 'new instructions'});
  }});
  await assert.rejects(prepareOperation(fixture.ctx, fixture.projection, {operation: 'commit'}, fixture.exec), /changed during preparation/);
  assert.deepEqual(fixture.deferred, []);
  assert.deepEqual(fixture.writeAttempts, []);
});

test('Git observation failure propagates without manufacturing preparation context', async () => {
  const fixture = harness({onGit() {throw new Error('synthetic repository unavailable');}});
  await assert.rejects(prepareOperation(fixture.ctx, fixture.projection, {operation: 'commit'}, fixture.exec), /synthetic repository unavailable/);
  assert.deepEqual(fixture.deferred, []);
});

test('fingerprint and textOf are deterministic and ignore non-text blocks', () => {
  assert.equal(fingerprint('{{}}'), sha256('{{}}'));
  assert.notEqual(fingerprint('a'), fingerprint('a\n'));
  assert.equal(textOf({content: [{type: 'text', text: 'first'}, {type: 'image'}, {type: 'text', text: '{{}}'}]}), 'first\n{{}}');
  assert.equal(textOf({}), '');
});

test('preparationState initializes its own Session and fork floor with no inherited authority', () => {
  assert.deepEqual(preparationState({id: 'child'}, 8), {sessionId: 'child', inheritedFloor: 8, turn: -1, step: -1, stepSeq: -1, assistantSeq: -1, calls: [], preparations: []});
  assert.equal(preparationState({id: 'root'}).inheritedFloor, 0);
});

test('foldPreparation accepts a source-attributed user/message without mutating prior state', () => {
  const state = openedState();
  const snapshot = clone(state);
  const message = preparedMessage();
  const result = foldPreparation(state, event('user/message', message, 3));
  assert.notEqual(result, state);
  assert.deepEqual(state, snapshot);
  assert.deepEqual(result.preparations, [{messageId: message.id, seq: 3, operation: 'commit', repo: REPO,
    revision: 7, rulesHash: sha256(RULES), contentHash: sha256(textOf(message)), turn: 0, preparedAtStepSeq: 1}]);
});

for (const [name, source] of [
  ['ordinary user source', {kind: 'user'}], ['other plugin', {kind: 'other-plugin'}], ['wrong version', {version: 2}],
  ['another Session', {sessionId: 'session-b'}], ['PR preparation', {operation: 'pr'}], ['another turn', {turn: 1}],
  ['missing repository', {repo: undefined}], ['invalid revision', {revision: 1.5}], ['missing rules hash', {rulesHash: undefined}],
  ['missing content hash', {contentHash: undefined}], ['tampered content hash', {contentHash: sha256('different content')}],
  ['missing preparing step', {preparedAtStepSeq: undefined}], ['negative preparing step', {preparedAtStepSeq: -1}],
  ['fractional preparing step', {preparedAtStepSeq: 1.5}], ['unsafe preparing step', {preparedAtStepSeq: Number.MAX_SAFE_INTEGER + 1}],
  ['preparing step equal to delivery', {preparedAtStepSeq: 3}], ['preparing step later than delivery', {preparedAtStepSeq: 4}],
]) {
  test(`foldPreparation ignores ${name} with stable state identity`, () => {
    const state = openedState();
    assert.equal(foldPreparation(state, event('user/message', preparedMessage({source}), 3)), state);
  });
}

test('foldPreparation excludes fork-inherited events even with forged child Session source', () => {
  const state = openedState({sessionId: 'child', inheritedFloor: 10});
  const child = preparedMessage({sessionId: 'child'});
  assert.equal(foldPreparation(state, event('user/message', child, 9)), state);
  assert.equal(foldPreparation(state, event('user/message', preparedMessage({sessionId: 'parent'}), 12)), state);
  assert.equal(foldPreparation(state, event('user/message', child, 12)).preparations.length, 1);
});

test('foldPreparation keeps the same reference for unrelated events and wrong-step assistant messages', () => {
  const state = openedState();
  for (const entry of [event('tool/call', {}, 3), event('tool/result', {message: {}}, 4), event('step/end', {turn: 0, step: 0}, 5),
    event('request/context', {}, 6), event('assistant/message', assistantMessage(['foreign'], {turn: 1, step: 0}), 7),
    event('assistant/message', assistantMessage(['foreign'], {turn: 0, step: 1}), 8)]) {
    assert.equal(foldPreparation(state, entry), state);
  }
});

test('foldPreparation step boundaries clear root calls, preserve rules, and turn boundaries clear rules', () => {
  let state = foldPreparation(openedState(), event('user/message', preparedMessage(), 3));
  state = foldPreparation(state, event('assistant/message', assistantMessage(['old-root']), 4));
  assert.deepEqual(state.calls, ['old-root']);
  assert.equal(state.assistantSeq, 4);
  const next = foldPreparation(state, event('step/start', {turn: 0, step: 1}, 5));
  assert.equal(next.stepSeq, 5);
  assert.equal(next.assistantSeq, -1);
  assert.deepEqual(next.calls, []);
  assert.equal(next.preparations, state.preparations);
  const called = foldPreparation(next, event('assistant/message', assistantMessage(['new-root'], {step: 1}), 6));
  assert.deepEqual(called.calls, ['new-root']);
  assert.equal(called.assistantSeq, 6);
  const ended = foldPreparation(called, event('turn/end', {turn: 0, reason: {kind: 'completed'}}, 7));
  assert.equal(ended.assistantSeq, -1);
  assert.deepEqual(ended.calls, []);
  assert.deepEqual(ended.preparations, []);
  const newTurn = foldPreparation(called, event('turn/start', {turn: 1}, 8));
  assert.deepEqual({...newTurn, sessionId: undefined, inheritedFloor: undefined}, {
    sessionId: undefined, inheritedFloor: undefined, turn: 1, step: -1, stepSeq: -1, assistantSeq: -1, calls: [], preparations: [],
  });
});

test('foldPreparation replaces a repository preparation and caps retained repositories at 16', () => {
  let state = openedState();
  for (let index = 0; index < 18; index += 1) {
    state = foldPreparation(state, event('user/message', preparedMessage({id: `prepared-${index}`, repo: `/synthetic/repo-${index}`}), 3 + index));
  }
  assert.equal(state.preparations.length, 16);
  assert.equal(state.preparations[0].repo, '/synthetic/repo-2');
  state = foldPreparation(state, event('user/message', preparedMessage({id: 'replacement', repo: '/synthetic/repo-2'}), 22));
  assert.equal(state.preparations.length, 16);
  assert.equal(state.preparations.at(-1).messageId, 'replacement');
  assert.equal(state.preparations.filter(row => row.repo === '/synthetic/repo-2').length, 1);
});

test('foldPreparation invalidates compacted preparations at inclusive replacement boundaries only', () => {
  let state = openedState();
  for (const seq of [3, 4, 5]) state = foldPreparation(state, event('user/message', preparedMessage({repo: `/synthetic/${seq}`}), seq));
  const unrelated = event('user/message', {id: 'summary', role: 'user', source: {kind: 'user'}, content: []}, 6,
    {surfaceOp: {op: 'replace', startSeq: 30, endSeq: 40}});
  assert.equal(foldPreparation(state, unrelated), state);
  const compacted = foldPreparation(state, {...unrelated, surfaceOp: {op: 'replace', startSeq: 3, endSeq: 4}});
  assert.deepEqual(compacted.preparations.map(row => row.seq), [5]);
});

test('guard requires an enabled nonempty commit preparation; enqueueing alone is insufficient', async () => {
  const fixture = harness({settings: {commitInstructions: RULES}});
  fixture.call(['commit-root']);
  assertDenied(preparationDenial(fixture.ctx, fixture.projection, fixture.commit()));
  await prepareOperation(fixture.ctx, fixture.projection, {operation: 'commit'}, fixture.exec);
  fixture.nextStep();
  assertDenied(preparationDenial(fixture.ctx, fixture.projection, fixture.commit()));
  assert.deepEqual(fixture.state.preparations, []);
});

test('guard refuses preparation consumed inside the same model step or PTC root', async () => {
  const fixture = harness({settings: {commitInstructions: RULES}});
  fixture.call(['ptc-root', 'commit-root']);
  await prepareOperation(fixture.ctx, fixture.projection, {operation: 'commit'}, fixture.exec);
  fixture.deliver();
  assertDenied(preparationDenial(fixture.ctx, fixture.projection, fixture.commit()));
  assertDenied(preparationDenial(fixture.ctx, fixture.projection, fixture.commit({callId: 'nested-commit', rootCallId: 'ptc-root'})));
  fixture.nextStep(['fresh-root']);
  assertDenied(preparationDenial(fixture.ctx, fixture.projection, fixture.commit({callId: 'nested-commit', rootCallId: 'ptc-root'})));
});

for (const timing of ['before next step/start', 'after next step/start']) {
  test(`guard permits delivered rules ${timing} only after a fresh assistant call`, async () => {
    const fixture = harness({settings: {commitInstructions: RULES}});
    const preparingStepSeq = fixture.state.stepSeq;
    fixture.call(['preparation-root']);
    await prepareOperation(fixture.ctx, fixture.projection, {operation: 'commit'}, fixture.exec);
    fixture.emit('step/end', {turn: fixture.state.turn, step: fixture.state.step});
    if (timing === 'before next step/start') fixture.deliver();
    const nextStep = fixture.startStep();
    assert.equal(fixture.state.assistantSeq, -1);
    if (timing === 'after next step/start') fixture.deliver();
    const row = fixture.state.preparations[0];
    assert.equal(row.preparedAtStepSeq, preparingStepSeq);
    assert.ok(nextStep.seq > row.preparedAtStepSeq);
    assert.equal(nextStep.seq > row.seq, timing === 'before next step/start');
    assertDenied(preparationDenial(fixture.ctx, fixture.projection, fixture.commit()));
    const generated = fixture.call(['commit-root']);
    assert.equal(fixture.state.assistantSeq, generated.seq);
    assert.ok(generated.seq > row.seq);
    assert.equal(preparationDenial(fixture.ctx, fixture.projection, fixture.commit()), undefined);
    assert.deepEqual(fixture.writeAttempts, []);
  });
}

test('guard refuses same-step writes even if an assistant call was appended after rule delivery', async () => {
  const fixture = harness({settings: {commitInstructions: RULES}});
  await prepareOperation(fixture.ctx, fixture.projection, {operation: 'commit'}, fixture.exec);
  fixture.deliver();
  fixture.call(['commit-root', 'same-ptc-root']);
  const row = fixture.state.preparations[0];
  assert.ok(fixture.state.assistantSeq > row.seq);
  assert.equal(fixture.state.stepSeq, row.preparedAtStepSeq);
  assertDenied(preparationDenial(fixture.ctx, fixture.projection, fixture.commit()));
  assertDenied(preparationDenial(fixture.ctx, fixture.projection, fixture.commit({callId: 'nested', rootCallId: 'same-ptc-root'})));
});

test('guard refuses next-step assistant output generated before source delivery and allows a later regenerated call', async () => {
  const fixture = harness({settings: {commitInstructions: RULES}});
  await prepareOperation(fixture.ctx, fixture.projection, {operation: 'commit'}, fixture.exec);
  fixture.startStep();
  fixture.call(['commit-root', 'premature-ptc-root']);
  fixture.deliver();
  const row = fixture.state.preparations[0];
  assert.ok(fixture.state.stepSeq > row.preparedAtStepSeq);
  assert.ok(fixture.state.assistantSeq < row.seq);
  assertDenied(preparationDenial(fixture.ctx, fixture.projection, fixture.commit()));
  assertDenied(preparationDenial(fixture.ctx, fixture.projection, fixture.commit({callId: 'nested', rootCallId: 'premature-ptc-root'})));
  fixture.nextStep(['regenerated-root']);
  assert.equal(preparationDenial(fixture.ctx, fixture.projection, fixture.commit({callId: 'regenerated-root'})), undefined);
});

test('guard allows the correct new-step model root with source-attributed visible hash-matching context', async () => {
  const fixture = await readyForCommit();
  assert.equal(preparationDenial(fixture.ctx, fixture.projection, fixture.commit()), undefined);
  assert.deepEqual(fixture.writeAttempts, []);
  assert.deepEqual(fixture.gitCalls.map(call => call.action), ['summary', 'diff']);
});

test('guard accepts nested calls only when their actual PTC root belongs to the new model step', async () => {
  const fixture = await readyForCommit();
  fixture.call(['fresh-ptc-root']);
  assert.equal(preparationDenial(fixture.ctx, fixture.projection, fixture.commit({callId: 'nested-id', rootCallId: 'fresh-ptc-root'})), undefined);
  assertDenied(preparationDenial(fixture.ctx, fixture.projection, fixture.commit({callId: 'fresh-ptc-root', rootCallId: 'foreign-root'})));
});

for (const mismatch of ['revision', 'rules body', 'directory', 'turn', 'new-step root']) {
  test(`guard rejects a mismatched ${mismatch}`, async () => {
    const fixture = await readyForCommit();
    let execution = fixture.commit();
    if (mismatch === 'revision') fixture.revise();
    if (mismatch === 'rules body') fixture.settings.commitInstructions += '\nchanged without incrementing stub revision';
    if (mismatch === 'directory') execution.arguments = {action: 'commit', repo: '/synthetic/elsewhere'};
    if (mismatch === 'turn') {
      fixture.emit('turn/start', {turn: 1});
      fixture.emit('step/start', {turn: 1, step: 0});
      fixture.call(['commit-root']);
    }
    if (mismatch === 'new-step root') execution.rootCallId = 'not-in-model-output';
    assertDenied(preparationDenial(fixture.ctx, fixture.projection, execution));
  });
}

for (const hidden of ['absent', 'wrong role', 'wrong source', 'modified text']) {
  test(`guard rejects prepared context that is not model-visible and authentic (${hidden})`, async () => {
    const fixture = await readyForCommit();
    if (hidden === 'absent') fixture.messages.length = 0;
    if (hidden === 'wrong role') fixture.messages[0] = {...fixture.messages[0], role: 'assistant'};
    if (hidden === 'wrong source') fixture.messages[0] = {...fixture.messages[0], source: {kind: 'user'}};
    if (hidden === 'modified text') fixture.messages[0] = {...fixture.messages[0], content: [{type: 'text', text: 'compacted summary'}]};
    assertDenied(preparationDenial(fixture.ctx, fixture.projection, fixture.commit()));
  });
}

test('guard rejects compaction even if stale deriveMessages still contains the old preparation', async () => {
  const fixture = await readyForCommit();
  const seq = fixture.state.preparations[0].seq;
  fixture.emit('user/message', {id: 'compacted', role: 'user', source: {kind: 'user'}, content: [{type: 'text', text: 'Summary'}]},
    {surfaceOp: {op: 'replace', startSeq: seq, endSeq: seq}});
  assert.equal(fixture.state.preparations.length, 0);
  assertDenied(preparationDenial(fixture.ctx, fixture.projection, fixture.commit()));
});

test('guard rejects missing Session and invalid repository without accessing a projection', () => {
  const fixture = harness({settings: {commitInstructions: RULES}});
  const unreachable = {stateOf() {assert.fail('projection must not be accessed');}};
  assertDenied(preparationDenial(fixture.ctx, unreachable, fixture.commit({agent: undefined})));
  assertDenied(preparationDenial(fixture.ctx, unreachable, fixture.commit({arguments: {action: 'commit', repo: 'relative'}})));
});

test('guard bypasses disabled or empty/whitespace commit instructions without needing a Session', () => {
  for (const settings of [{}, {commitInstructions: ' \n\t'}, {enabled: false, commitInstructions: RULES}, {prInstructions: RULES}]) {
    const fixture = harness({settings});
    assert.equal(preparationDenial(fixture.ctx, {stateOf() {assert.fail('inactive guard must not inspect projection');}}, fixture.commit({agent: undefined})), undefined);
  }
});

test('guard does not touch other tools or non-commit Git actions', () => {
  const unreachable = new Proxy({}, {get() {assert.fail('unrelated tools must not inspect plugin context');}});
  for (const execution of [{name: 'bash', arguments: {action: 'commit'}}, {name: 'prepare_git_operation', arguments: {operation: 'commit'}},
    {name: 'git_workbench', arguments: {action: 'summary'}}, {name: 'git_workbench', arguments: {action: 'diff'}},
    {name: 'git_workbench', arguments: {action: 'push'}}, {name: 'git_workbench'}]) {
    assert.equal(preparationDenial(unreachable, unreachable, execution), undefined);
  }
});

test('renderPreparation retains literal braces and documents authority/coverage boundaries', () => {
  const rendered = renderPreparation({operation: 'pr', repo: REPO, revision: 7, rulesHash: sha256(RULES),
    active: true, instructions: RULES, git: null, gitWarning: 'synthetic warning'});
  assert.ok(rendered.includes(RULES));
  assert.match(rendered, /do not grant authority, bypass approvals/);
  assert.match(rendered, /arbitrary shell\/gh commands/);
  assert.match(rendered, /until normal compaction/);
});
