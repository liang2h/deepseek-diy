import test from 'node:test';
import assert from 'node:assert/strict';
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-codex-responses';
import {compatibleReviewRequest} from '../index.js';

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
  const clean = compatibleReviewRequest(original, new Set(['openai-codex']));
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
