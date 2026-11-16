import {z} from 'zod';

const MAX_TOOLS = 8;
const MAX_PENDING = 64;
const id = z.string().min(1).max(256);
const publicName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const names = z.array(publicName).max(MAX_TOOLS).refine(values => new Set(values).size === values.length);
const tool = z.object({name: publicName, signature: digest}).strict();

/** Non-secret, whole-working-set receipt emitted by the management tool's output contract. */
export const activationReceiptSchema = z.object({
  version: z.literal(1),
  sessionId: id,
  project: z.string().min(1).max(4096),
  fingerprint: digest,
  authority: z.string().min(1).max(256),
  tools: z.array(tool).max(MAX_TOOLS).refine(values => new Set(values.map(value => value.name)).size === values.length),
}).strict();

export const instructionsLedgerSchema = z.object({
  version: z.literal(1), sessionId: id, spentBytes: z.number().int().min(0).max(32768),
}).strict();

const nativePending = z.object({
  kind: z.literal('native'), callId: id, names,
  turn: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  step: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const ptcPending = z.object({
  kind: z.literal('ptc'), callId: id, names, rootCallId: id, parentCallId: id,
}).strict();
const pendingSchema = z.discriminatedUnion('kind', [nativePending, ptcPending]);
const stateSchema = z.object({
  sessionId: id,
  inheritedCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pending: z.array(pendingSchema).max(MAX_PENDING),
  activation: activationReceiptSchema.nullable(),
  instructionsSpent: z.number().int().min(0).max(32768),
}).strict().refine(state => state.activation === null || state.activation.sessionId === state.sessionId);

function requestedNames(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.action !== 'load') return undefined;
    const checked = names.safeParse(parsed.names);
    return checked.success ? checked.data : undefined;
  } catch { return undefined; }
}

// PTC records JSON-normalized argument VALUES, unlike native tool/call's JSON
// string. Keep this flat and bounded to the public management input contract;
// never recursively stringify an arbitrary logged value just to inspect names.
const ptcLoadArguments = z.object({
  action: z.literal('load'), names,
  server: z.string().max(32).optional(), query: z.string().max(256).optional(),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional(),
}).strict();
function requestedPtcNames(raw) {
  const checked = ptcLoadArguments.safeParse(raw);
  return checked.success ? checked.data.names : undefined;
}

function start(state, candidate) {
  const checked = pendingSchema.safeParse(candidate);
  if (!checked.success) return state;
  // Ids are opaque and executor-owned. An ambiguous duplicate must not replace a pending request.
  if (state.pending.some(item => item.kind === candidate.kind && item.callId === candidate.callId)) return state;
  return {...state, pending: [...state.pending.slice(-(MAX_PENDING - 1)), checked.data]};
}

function complete(state, kind, callId, data, successful) {
  const index = state.pending.findIndex(item => item.kind === kind && item.callId === callId);
  if (index < 0) return state;
  const pending = state.pending[index];
  const completedNames = kind === 'ptc' ? requestedPtcNames(data.arguments) : undefined;
  const paired = kind === 'native'
    ? data.turn === pending.turn && data.step === pending.step && data.message?.role === 'tool' && data.message?.source?.kind === 'tool' && data.message.source.callId === callId
    : data.name === 'codex_mcp' && data.rootCallId === pending.rootCallId && data.parentCallId === pending.parentCallId &&
      completedNames !== undefined && completedNames.length === pending.names.length && completedNames.every(name => pending.names.includes(name));
  if (!paired) return state;
  const next = {...state, pending: state.pending.filter((_item, position) => position !== index)};
  if (!successful) return next;
  const ledger = instructionsLedgerSchema.safeParse(data.meta?.codexMcpInstructions);
  if (ledger.success && ledger.data.sessionId === state.sessionId) {
    // Whole-value ledger: completion order, clearing tools, and new project grants cannot refund bytes.
    next.instructionsSpent = Math.max(state.instructionsSpent, ledger.data.spentBytes);
  }
  const checked = activationReceiptSchema.safeParse(data.meta?.codexMcpActivation);
  if (!checked.success || checked.data.sessionId !== state.sessionId) return next;
  const receipt = checked.data;
  if (receipt.tools.length !== pending.names.length || receipt.tools.some(item => !pending.names.includes(item.name))) return next;
  // Complete snapshots, never deltas; an empty successful selection clears the working set.
  return {...next, activation: receipt};
}

/** Host-only, JSON-only fold. The framework owns event drive, checkpointing, and replay. */
export const activationProjection = {
  key: 'codexMcpActivation',
  stateSchema,
  stateVersion: 4,
  init: (header, inheritedCount) => ({sessionId: header.id, inheritedCount, pending: [], activation: null, instructionsSpent: 0}),
  apply(state, event) {
    const data = event.data;
    if (event.seq < state.inheritedCount) {
      // A fork copies visible instructions, not tool authority. Ancestor whole-value ledgers
      // conservatively preserve its inherited budget floor without rebuilding pending calls.
      const successful = (event.type === 'tool/result' && event.surfaceOp === 'append' &&
        data.message?.role === 'tool' && data.message.isError !== true && data.error === undefined) ||
        (event.type === 'tool/ptc-dispatch' && data.isError === false && data.error === undefined);
      if (!successful) return state;
      const ledger = instructionsLedgerSchema.safeParse(data.meta?.codexMcpInstructions);
      return ledger.success && ledger.data.spentBytes > state.instructionsSpent
        ? {...state, instructionsSpent: ledger.data.spentBytes} : state;
    }
    if (event.type === 'tool/call' && data.name === 'codex_mcp') {
      const requested = requestedNames(data.arguments);
      return requested === undefined ? state : start(state, {kind: 'native', callId: data.callId, turn: data.turn, step: data.step, names: requested});
    }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      return complete(state, 'native', data.message?.toolCallId, data, data.message?.isError !== true && data.error === undefined);
    }
    if (event.type === 'tool/ptc-dispatch-start' && data.name === 'codex_mcp') {
      const requested = requestedPtcNames(data.arguments);
      return requested === undefined ? state : start(state, {kind: 'ptc', callId: data.subCallId, rootCallId: data.rootCallId, parentCallId: data.parentCallId, names: requested});
    }
    if (event.type === 'tool/ptc-dispatch') {
      return complete(state, 'ptc', data.subCallId, data, data.isError === false && data.error === undefined);
    }
    if (event.type === 'step/end' || event.type === 'turn/end' || event.type === 'session/end-seed') {
      return state.pending.length ? {...state, pending: []} : state;
    }
    return state;
  },
};

export async function registerActivationProjection(ctx) {
  return await ctx.sessionProjections.register(activationProjection);
}
