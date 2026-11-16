import test from 'node:test';
import assert from 'node:assert/strict';
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-codex-responses';
import {compatibleReviewRequest} from '../index.js';
import {createRequire} from 'node:module';
const {OpenAI} = createRequire(import.meta.resolve('@earendil-works/pi-ai'))('openai');

// Exercise the same installed pi-ai 1.3.0 Codex wire builder, but stop at its
// public onPayload hook, BEFORE headers/transport/fetch. No account or cloud I/O.
test('real Codex SDK payload contains temperature before compatibility and omits it afterwards with zero fetches', async () => {
  const catalog = openaiCodexProvider().getModels();
  assert.ok(catalog.length > 0);
  const model = {...catalog[0], baseUrl: 'http://127.0.0.1:1/never-dispatched'};
  assert.equal(model.api, 'openai-codex-responses');
  const token = ['e30=', Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': {chatgpt_account_id: 'synthetic-local-only-account'},
  })).toString('base64'), 'synthetic-no-valid-signature'].join('.');
  const original = Object.freeze({provider: 'openai-codex', model: model.id, purpose: 'auto-review',
    temperature: 0, system: 'SYNTHETIC_POLICY', messages: []});
  const clean = compatibleReviewRequest(original);
  const bodies = []; let fetchCalls = 0;
  const stop = 'LOCAL_ONLY_STOP_BEFORE_TRANSPORT';
  const previousFetch = globalThis.fetch;
  const noFetch = async () => {++fetchCalls; throw new Error('NO_NETWORK_ALLOWED');};
  globalThis.fetch = noFetch;
  try {
    for (const request of [original, clean]) {
      const errors = [];
      // Mirror only the documented DSH PiAiAdapter sampling pass-through. All
      // context is synthetic; explicit fake auth prevents native auth lookup.
      const options = {apiKey: token, transport: 'sse', maxRetries: 0, fetch: noFetch,
        ...(request.temperature === undefined ? {} : {temperature: request.temperature}),
        onPayload(body) {bodies.push(structuredClone(body)); throw new Error(stop);}};
      const context = {systemPrompt: request.system,
        messages: [{role: 'user', content: [{type: 'text', text: 'SYNTHETIC_LOCAL_REVIEW_ONLY'}], timestamp: 0}]};
      for await (const event of streamSimple(model, context, options)) {
        if (event.type === 'error') errors.push(event.error.errorMessage);
      }
      assert.ok(errors.some(message => message?.includes(stop)), 'SDK must stop at the payload hook');
    }
  } finally {globalThis.fetch = previousFetch;}
  assert.equal(bodies.length, 2); assert.equal(bodies[0].temperature, 0);
  assert.equal(Object.hasOwn(bodies[1], 'temperature'), false);
  const {temperature: _unsupported, ...before} = bodies[0];
  assert.deepEqual(bodies[1], before);
  assert.equal(fetchCalls, 0);
});

for (const api of ['chat', 'responses']) {
  for (const provider of ['openai', 'company-reasoner-alias']) {
    test(`real OpenAI SDK ${api} / ${provider}: reject temperature then accept omission; synthetic fetch only`, async () => {
      const original = Object.freeze({provider, model: 'synthetic-reasoner', purpose: 'auto-review',
        temperature: 0, system: 'SYNTHETIC_POLICY', messages: []});
      const bodies = [];
      const text = '{"risk":"low","decision":"allow"}';
      const client = new OpenAI({apiKey: 'synthetic-no-real-credential', baseURL: 'http://127.0.0.1:1/never-dispatched',
        maxRetries: 0, fetch: async (url, init) => {
          assert.equal(new URL(String(url)).hostname, '127.0.0.1');
          const body = JSON.parse(init.body); bodies.push(body);
          if (Object.hasOwn(body, 'temperature')) return new Response(JSON.stringify({error: {
            message: "Unsupported parameter: 'temperature' is not supported with this model.",
            type: 'invalid_request_error', param: 'temperature', code: null,
          }}), {status: 400, headers: {'content-type': 'application/json'}});
          const result = api === 'chat'
            ? {id: 'synthetic-completion', object: 'chat.completion', created: 0, model: original.model,
              choices: [{index: 0, finish_reason: 'stop', message: {role: 'assistant', content: text}}]}
            : {id: 'synthetic-response', object: 'response', created_at: 0, status: 'completed', model: original.model,
              output: [{id: 'synthetic-message', type: 'message', status: 'completed', role: 'assistant',
                content: [{type: 'output_text', text, annotations: []}]}]};
          return new Response(JSON.stringify(result), {status: 200, headers: {'content-type': 'application/json'}});
        }});
      const send = request => {
        const sampling = request.temperature === undefined ? {} : {temperature: request.temperature};
        return api === 'chat'
          ? client.chat.completions.create({model: request.model, messages: [{role: 'user', content: 'SYNTHETIC_LOCAL_ONLY'}], ...sampling})
          : client.responses.create({model: request.model, input: 'SYNTHETIC_LOCAL_ONLY', ...sampling});
      };
      await assert.rejects(send(original), error => error.status === 400 && error.param === 'temperature');
      const result = await send(compatibleReviewRequest(original));
      assert.equal(api === 'chat' ? result.choices[0].message.content : result.output_text, text);
      assert.equal(bodies.length, 2, 'one baseline and one corrected request, not a runtime fallback retry');
      const {temperature: _unsupported, ...before} = bodies[0];
      assert.equal(bodies[0].temperature, 0);
      assert.equal(Object.hasOwn(bodies[1], 'temperature'), false);
      assert.deepEqual(bodies[1], before);
    });
  }
}
