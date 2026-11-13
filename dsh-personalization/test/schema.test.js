import test from 'node:test';
import assert from 'node:assert/strict';
import {Config} from '../index.js';

test('real Schemastery Config yields live refs with empty defaults', () => {
  const c = Config({}); assert.equal(c.enabled.get(), true); assert.equal(c.instructions.get(), '');
});
test('real Config permits maximum length and rejects invalid values', () => {
  assert.equal(Config({instructions: '中'.repeat(20000)}).instructions.get().length, 20000);
  for (const value of [{instructions: 'a'.repeat(20001)}, {instructions: 12}, {enabled: 'yes'}]) assert.throws(() => Config(value));
});
