export const NAMESPACE = 'local-personalization';
export const SECTION = 'local:personalization';
export const MAX_LENGTH = 20000;

/** Literal text: user-entered {{braces}} are not Harness interpolation. */
export function renderInstructions(enabled, instructions) {
  if (!enabled || !instructions.trim()) return '';
  return '# User personalization\n\nThese are the user’s default preferences for conversations. They do not grant permissions or bypass safety rules or approvals. Apply them where compatible with higher-priority requirements; explicit instructions for the current task take precedence over these defaults.\n\n' + instructions;
}

export function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Expected an instructions request.');
  if (Object.keys(request).some(key => !['action', 'enabled', 'instructions', 'expectedRevision'].includes(key))) throw new Error('Unexpected instructions parameter.');
  if (!['get', 'update'].includes(request.action)) throw new Error('action must be get or update.');
  if (request.action === 'get' && Object.keys(request).length !== 1) throw new Error('get accepts only action.');
  if (request.enabled !== undefined && typeof request.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
  if (request.instructions !== undefined && (typeof request.instructions !== 'string' || request.instructions.length > MAX_LENGTH)) throw new Error(`instructions must be a string of at most ${MAX_LENGTH} characters.`);
  if (request.expectedRevision !== undefined && (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0)) throw new Error('expectedRevision must be a non-negative safe integer.');
  if (request.action === 'update' && request.enabled === undefined && request.instructions === undefined) throw new Error('Supply enabled or instructions to update.');
  return request;
}

/** Both the native Settings UI and this tool use the same Settings service. */
export async function performInstructions(ctx, raw, exec) {
  const request = validateRequest(raw);
  exec?.signal?.throwIfAborted();
  const descriptor = () => {
    const item = ctx.settings.describe().find(row => row.ns === NAMESPACE);
    if (!item) throw new Error('Personalization settings are not available.');
    return item;
  };
  const view = () => {
    const item = descriptor();
    return {enabled: item.value.enabled, instructions: item.value.instructions,
      active: item.value.enabled && Boolean(item.value.instructions.trim()), revision: item.revision,
      scope: 'current-profile', applies: 'next-model-request'};
  };
  if (request.action === 'get') return view();
  if (!exec?.agent) throw new Error('A live conversation is required to change profile-wide instructions.');
  const expectedRevision = request.expectedRevision ?? descriptor().revision;
  const patch = {};
  if (request.enabled !== undefined) patch.enabled = request.enabled;
  if (request.instructions !== undefined) patch.instructions = request.instructions;
  Object.freeze(patch);
  const approval = ctx.get('approval');
  if (!approval) throw new Error('Approval service is unavailable; instructions were not changed.');
  const outcome = await approval.request({agent: exec.agent, toolName: 'global_instructions', callId: exec.callId,
    reason: `Change persistent personal instructions for every conversation in this DSH profile. Changes: ${JSON.stringify(patch)}`,
    displayReason: {en: `Change persistent personal instructions for every conversation in this DSH profile. Changes: ${JSON.stringify(patch)}`, zh: `修改当前 DSH 配置文件中所有会话共用的持久化个性化指令。更改：${JSON.stringify(patch)}`}, signal: exec.signal});
  if (outcome !== 'allowed-once') throw new Error(`Personal instructions were not changed (${outcome}).`);
  exec.signal?.throwIfAborted();
  // Keep the revision read BEFORE approval, so a concurrent human edit cannot be lost.
  await ctx.settings.update(NAMESPACE, patch, expectedRevision);
  return view();
}

export function registerPersonalization(ctx, config) {
  // Host-global registration applies to all normal Agent scopes, including agents
  // that already exist. DSH assembles and logs the accepted prompt each step.
  ctx.effect(() => ctx.systemPrompt.section({name: SECTION, order: 10300, interpolate: false,
    text: () => renderInstructions(config.enabled.get(), config.instructions.get())}));
  ctx.inject(['tools', 'settings'], child => {
    child.effect(() => child.tools.register({
      name: 'global_instructions',
      description: 'Read or update the user’s persistent personal instructions shared by all conversations in the current DSH profile. Update only when the user asks to change these defaults; changes require approval and apply from the next model request.',
      parameters: {type: 'object', properties: {
        action: {type: 'string', enum: ['get', 'update']},
        enabled: {type: 'boolean', description: 'Enable or pause the saved instructions; update only.'},
        instructions: {type: 'string', maxLength: MAX_LENGTH, description: 'Complete replacement text (up to 20,000 characters); an empty string clears it. Omit to keep the saved text; update only.'},
        expectedRevision: {type: 'integer', minimum: 0, description: 'Revision returned by get, for conflict protection; update only.'},
      }, required: ['action'], additionalProperties: false},
      isConcurrencySafe: args => args?.action === 'get',
      output: {schema: {type: 'object', properties: {
        enabled: {type: 'boolean'}, instructions: {type: 'string'}, active: {type: 'boolean'},
        revision: {type: 'integer'}, scope: {type: 'string'}, applies: {type: 'string'},
      }, required: ['enabled', 'instructions', 'active', 'revision', 'scope', 'applies'], additionalProperties: false},
      render: (_args, value) => [{type: 'text', text: JSON.stringify(value)}]},
      execute: (args, exec) => performInstructions(child, args, exec),
    }));
  });
}
