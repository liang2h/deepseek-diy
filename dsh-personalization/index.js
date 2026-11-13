import z from '@deepseek-ai/schemastery';
import {MAX_LENGTH, registerPersonalization} from './core.js';

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  instructions: z.string().max(MAX_LENGTH).default('').volatile(),
});
export const inject = ['systemPrompt'];

export function apply(ctx, config) {
  registerPersonalization(ctx, config);
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({auto: false}, ctx.fiber));
  });
}
