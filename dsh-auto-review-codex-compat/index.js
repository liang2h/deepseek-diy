import Schema from '@deepseek-ai/schemastery';
import {isAgentLoopRequest} from '@deepseek-ai/dsh-llm';

export const inject = ['llm'];
export const Config = Schema.object({
  providers: Schema.array(Schema.string().min(1).max(128)).min(1).max(16)
    .default(['openai-codex'])
    .description('Exact provider routes using the Codex protocol. Never matches provider or model names by substring.'),
});

/** Only this installed release's auxiliary reviewer call is eligible, never a logged loop request. */
export function compatibleReviewRequest(request, providers) {
  if (isAgentLoopRequest(request) || request.purpose !== 'auto-review' ||
      !providers.has(request.provider) || request.temperature === undefined) return request;
  // Preserve invalid input failures rather than turning a malformed request into a valid one.
  if (typeof request.temperature !== 'number' || !Number.isFinite(request.temperature) ||
      request.temperature < 0 || request.temperature > 2) return request;
  const {temperature: _unsupported, ...clean} = request;
  return Object.freeze(clean);
}

export function apply(ctx, config) {
  const providers = new Set(config.providers);
  ctx.on('llm/stream', function (request, next) {
    const clean = compatibleReviewRequest(request, providers);
    if (clean === request) return next();
    // The Event's receiver is the invoking scoped LlmRuntime. Do not capture ctx.llm,
    // mutate caller-owned frozen inputs, replace an adapter or bypass other middleware.
    // The nested request lacks temperature, so it follows next() on its one pass.
    // No outer next(): exactly one adapter dispatch; no retry or failure conversion.
    return this.stream(clean);
  });
}
