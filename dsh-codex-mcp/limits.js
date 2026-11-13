import Schema from '@deepseek-ai/schemastery';
import {Buffer} from 'node:buffer';

export const DEFAULT_LIMITS = Object.freeze({
  maxActiveTools: 8,
  maxSchemaBytes: 65536,
  instructionsPerServerBytes: 2048,
  instructionsTotalBytes: 8192,
});

const RANGES = Object.freeze({
  maxActiveTools: [1, 8],
  maxSchemaBytes: [1024, 262144],
  instructionsPerServerBytes: [0, 8192],
  instructionsTotalBytes: [0, 32768],
});

/** Native Cordis/Loader configuration schema, not a Zod execution-value schema. */
export const Config = Schema.object({
  maxActiveTools: Schema.number().step(1).min(1).max(8).default(DEFAULT_LIMITS.maxActiveTools)
    .description('每个 Agent 同时激活的 MCP 工具数量上限。'),
  maxSchemaBytes: Schema.number().step(1).min(1024).max(262144).default(DEFAULT_LIMITS.maxSchemaBytes)
    .description('已激活 MCP 工具定义的 UTF-8 字节预算。'),
  instructionsPerServerBytes: Schema.number().step(1).min(0).max(8192).default(DEFAULT_LIMITS.instructionsPerServerBytes)
    .description('单个服务器 instructions 的 UTF-8 字节预算；0 表示不注入。'),
  instructionsTotalBytes: Schema.number().step(1).min(0).max(32768).default(DEFAULT_LIMITS.instructionsTotalBytes)
    .description('每条会话历史累计的服务器 instructions UTF-8 字节预算，包含 fork 继承历史；清空工作集或重新授信不重置，0 表示不交付。'),
});

/** Validate direct/programmatic callers too; never clamp or silently widen a budget. */
export function normalizeLimits(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(config))) {
    throw new TypeError('codex-mcp limits must be a plain configuration object.');
  }
  for (const key of Reflect.ownKeys(config)) {
    if (typeof key !== 'string' || !Object.hasOwn(RANGES, key)) throw new TypeError('Unknown codex-mcp limit.');
  }
  const limits = {};
  for (const [key, [minimum, maximum]] of Object.entries(RANGES)) {
    const value = config[key] === undefined ? DEFAULT_LIMITS[key] : config[key];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new TypeError(`codex-mcp ${key} must be an integer in ${minimum}..${maximum}.`);
    }
    limits[key] = value;
  }
  return Object.freeze(limits);
}

/** Return the longest UTF-8 prefix within bytes, without splitting a code point. No suffix is added. */
export function clipText(text, bytes) {
  if (typeof text !== 'string') throw new TypeError('clipText text must be a string.');
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('clipText bytes must be a non-negative safe integer.');
  if (bytes === 0 || text.length === 0) return '';
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= bytes) return encoded.toString('utf8');
  let end = bytes;
  // encoded[end] is the first omitted octet: a continuation means the cut is inside one code point.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) --end;
  return encoded.subarray(0, end).toString('utf8');
}
