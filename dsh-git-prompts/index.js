import schema from '@deepseek-ai/schemastery';
import {z} from 'zod';
import {MAX_LENGTH, NAMESPACE, PREPARE_TOOL, SETTINGS_TOOL, PROJECTION_KEY,
  preparationState, foldPreparation, preparationDenial, prepareOperation, performSettings} from './core.js';

export const Config = schema.object({
  enabled: schema.boolean().default(true).volatile(),
  commitInstructions: schema.string().max(MAX_LENGTH).default('').volatile(),
  prInstructions: schema.string().max(MAX_LENGTH).default('').volatile(),
});
export const inject = ['tools', 'settings', 'sessionProjections', 'workingDirectory'];

const preparationSchema = z.object({messageId: z.string(), seq: z.number().int(), operation: z.literal('commit'),
  repo: z.string(), revision: z.number().int().nonnegative(), rulesHash: z.string(), contentHash: z.string(), turn: z.number().int(), preparedAtStepSeq: z.number().int().nonnegative()});
export const stateSchema = z.object({sessionId: z.string(), inheritedFloor: z.number().int().nonnegative(),
  turn: z.number().int(), step: z.number().int(), stepSeq: z.number().int(), assistantSeq: z.number().int(), calls: z.array(z.string()), preparations: z.array(preparationSchema).max(16)});
const objectOutput = {schema: {type: 'object', additionalProperties: true}, render: (_args, value) => [{type: 'text', text: JSON.stringify(value)}]};

export async function apply(ctx) {
  ctx.effect(() => ctx.settings.configure({auto: false}, ctx.fiber));
  // Await before publishing tools/guards. The owning fiber releases the projection on unload.
  const projection = await ctx.sessionProjections.register({key: PROJECTION_KEY, stateSchema, stateVersion: 2,
    init: preparationState, apply: foldPreparation});
  ctx.effect(() => ctx.tools.guard(exec => preparationDenial(ctx, projection, exec)));
  ctx.effect(() => ctx.tools.register({
    name: PREPARE_TOOL,
    description: 'Load configured commit or pull-request instructions on demand before drafting Git text. Returns source-attributed context and an optional read-only Git observation. Call before generating a commit message or PR title/body, then continue in a NEW model step; this tool never commits, pushes, or creates a PR.',
    parameters: {type: 'object', additionalProperties: false, properties: {
      operation: {type: 'string', enum: ['commit', 'pr'], description: 'The operation whose instructions to load.'},
      repo: {type: 'string', maxLength: 4096, description: 'Absolute repository directory; defaults to the current Session directory. Use the same directory in the subsequent git_workbench commit.'},
    }, required: ['operation']},
    isConcurrencySafe: () => false,
    output: objectOutput,
    execute: (args, exec) => prepareOperation(ctx, projection, args, exec),
  }));
  ctx.effect(() => ctx.tools.register({
    name: SETTINGS_TOOL,
    description: 'Read or update this profile’s persistent commit and PR instructions. Read only when inspecting Git preferences; update only at the user’s request and with approval. Instruction bodies are loaded for Git work via prepare_git_operation, never added to the system prompt.',
    parameters: {type: 'object', additionalProperties: false, properties: {
      action: {type: 'string', enum: ['get', 'update']},
      enabled: {type: 'boolean', description: 'Pause or enable on-demand rules and commit preparation checks; update only.'},
      commitInstructions: {type: 'string', maxLength: MAX_LENGTH, description: 'Complete commit instructions; empty clears. Update only; omit to preserve.'},
      prInstructions: {type: 'string', maxLength: MAX_LENGTH, description: 'Complete PR title/body instructions; empty clears. Update only; omit to preserve.'},
      expectedRevision: {type: 'integer', minimum: 0, description: 'Revision read before editing; update only.'},
    }, required: ['action']},
    isConcurrencySafe: args => args?.action === 'get',
    output: objectOutput,
    execute: (args, exec) => performSettings(ctx, args, exec),
  }));
}
