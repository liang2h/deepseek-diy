import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Config, DEFAULT_LIMITS, normalizeLimits, clipText} from '../limits.js';

const ranges = {
  maxActiveTools: [1, 8],
  maxSchemaBytes: [1024, 262144],
  instructionsPerServerBytes: [0, 8192],
  instructionsTotalBytes: [0, 32768],
};

test('limits defaults are immutable and normalization accepts omitted or partial configuration', () => {
  assert.deepEqual(DEFAULT_LIMITS, {maxActiveTools: 8, maxSchemaBytes: 65536, instructionsPerServerBytes: 2048, instructionsTotalBytes: 8192});
  assert.equal(Object.isFrozen(DEFAULT_LIMITS), true);
  for (const config of [undefined, {}, {maxActiveTools: undefined}, Object.create(null)]) {
    const limits = normalizeLimits(config);
    assert.deepEqual(limits, DEFAULT_LIMITS); assert.equal(Object.isFrozen(limits), true);
    assert.notEqual(limits, DEFAULT_LIMITS);
  }
  const input = {maxActiveTools: 2, instructionsTotalBytes: 0};
  const limits = normalizeLimits(input); input.maxActiveTools = 8;
  assert.equal(limits.maxActiveTools, 2); assert.equal(limits.instructionsTotalBytes, 0);
  assert.equal(limits.maxSchemaBytes, DEFAULT_LIMITS.maxSchemaBytes);
  assert.throws(() => {limits.maxActiveTools = 9;}, TypeError);
});

test('every documented inclusive boundary is accepted without clamping', () => {
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    for (const value of [minimum, maximum]) {
      assert.equal(normalizeLimits({[key]: value})[key], value);
      assert.equal(Config({[key]: value})[key], value);
    }
  }
});

test('direct normalization rejects nonintegers, wrong types and out-of-range budgets', () => {
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    for (const value of [minimum - 1, maximum + 1, minimum + 0.5, NaN, Infinity, -Infinity, null, String(minimum), true, {}, []]) {
      assert.throws(() => normalizeLimits({[key]: value}), TypeError, `${key}: ${String(value)}`);
    }
  }
  for (const value of [null, [], false, 7, '', new Date(), Object.create({maxActiveTools: 2})]) {
    assert.throws(() => normalizeLimits(value), TypeError);
  }
  for (const value of [{unknownBudget: 1}, {[Symbol('hidden')]: 1}, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => normalizeLimits(value), TypeError);
  }
});

test('Config is the installed native Schemastery schema and validates Loader-facing ranges', async () => {
  const require = createRequire(import.meta.resolve('@deepseek-ai/schemastery'));
  const {version} = require('@deepseek-ai/schemastery/package.json');
  assert.equal(version, '3.19.0');
  assert.equal(Config.type, 'object');
  assert.deepEqual(Config({}), DEFAULT_LIMITS);
  assert.deepEqual(Config(), DEFAULT_LIMITS);
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    assert.equal(Config.dict[key].type, 'number');
    assert.equal(Config.dict[key].meta.step, 1);
    assert.equal(Config.dict[key].meta.min, minimum);
    assert.equal(Config.dict[key].meta.max, maximum);
    assert.equal(Config.dict[key].meta.default, DEFAULT_LIMITS[key]);
    for (const value of [minimum - 1, maximum + 1, minimum + 0.5, '2', true, NaN, Infinity]) {
      assert.throws(() => Config({[key]: value}), `${key}: ${String(value)}`);
    }
  }
});

test('clipText supports empty and zero budgets, exact ASCII prefixes and unlimited safe budgets', () => {
  assert.equal(clipText('', 0), ''); assert.equal(clipText('data', 0), '');
  assert.equal(clipText('abcd', 2), 'ab'); assert.equal(clipText('abcd', 4), 'abcd');
  assert.equal(clipText('abcd', Number.MAX_SAFE_INTEGER), 'abcd');
  for (const budget of [-1, 0.5, NaN, Infinity, '4', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => clipText('text', budget), TypeError);
  }
  for (const value of [undefined, null, {}, 1]) assert.throws(() => clipText(value, 4), TypeError);
});

test('clipText never splits a UTF-8 code point at any possible byte boundary', () => {
  for (const text of ['中文目录', '🙂工具🧑‍💻', 'Aé中🙂Z', 'e\u0301', '\u0000中文\n', 'a'.repeat(50) + '🙂']) {
    const encoded = Buffer.from(text, 'utf8');
    for (let budget = 0; budget <= encoded.length + 2; ++budget) {
      const actual = clipText(text, budget);
      assert.equal(Buffer.byteLength(actual, 'utf8') <= budget, true);
      assert.equal(text.startsWith(actual), true);
      assert.equal(actual.includes('\ufffd'), false);
      const points = Array.from(text);
      let expected = '';
      for (const point of points) {
        if (Buffer.byteLength(expected + point, 'utf8') > budget) break;
        expected += point;
      }
      assert.equal(actual, expected, `budget=${budget} text=${text}`);
    }
  }
});

test('clipText sanitizes ill-formed UTF-16 into valid UTF-8 without exceeding budget', () => {
  assert.equal(clipText('\ud800', 2), '');
  assert.equal(clipText('\ud800', 3), '\ufffd');
  assert.equal(clipText('A\udfffZ', 4), 'A\ufffd');
});
