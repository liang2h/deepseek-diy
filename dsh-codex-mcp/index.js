import {ProjectSession, commandErrorText} from './runtime.js';
import {registerActivationProjection, activationReceiptSchema, instructionsLedgerSchema} from './activation.js';
import {normalizeLimits} from './limits.js';
export {Config} from './limits.js';

export const name = 'codex-mcp';
export const inject = ['tools', 'commands', 'credentials', 'agents', 'fs', 'workingDirectory', 'subprocess', 'sessionProjections'];

/** Installed once per profile; all imported tools belong to individual Agent scopes. */
export async function apply(ctx, config = {}) {
  const limits = normalizeLimits(config);
  const activation = await registerActivationProjection(ctx);
  const sessions = new Map(); let stopped = false;
  const get = async agent => {
    if (!agent || stopped) throw new Error('当前会话不可用。');
    let session = sessions.get(agent);
    if (!session) {
      session = new ProjectSession(ctx, agent, {activation, limits}); sessions.set(agent, session);
      agent.ctx.effect(() => () => { sessions.delete(agent); return session.dispose(); }, 'codex-mcp.agent');
      await session.reconcile();
    }
    return session;
  };
  ctx.effect(() => async () => {
    stopped = true; const active = [...sessions.values()]; sessions.clear();
    await Promise.allSettled(active.map(session => session.dispose()));
  }, 'codex-mcp.sessions');
  ctx.commands.register({name: 'codex-mcp',
    description: '管理项目 MCP 连接与 OAuth 登录',
    input: {hint: 'status | tools [server] | reload | trust <fingerprint> | untrust | login/logout/cancel <server>'},
    handler: async ({agent, rawInput, signal}) => {
      try { return {kind: 'success', text: JSON.stringify(await (await get(agent)).human(rawInput, signal), null, 2)}; }
      catch (error) { return {kind: 'error', text: commandErrorText(error)}; }
    }});
  ctx.tools.register({name: 'codex_mcp',
    description: '发现项目 MCP 工具并按需加载。先 tools/search 查询目录，再 load 替换工具工作集，下一模型步骤可调用；加载不执行工具，也不授予信任或 OAuth 登录。',
    parameters: {type: 'object', properties: {
      action: {type: 'string', enum: ['status', 'reload', 'tools', 'search', 'load'], description: 'status 状态/限额；reload 重连；tools/search 查询元数据目录；load 替换激活集。'},
      server: {type: 'string', maxLength: 32, description: '目录的服务器筛选。'},
      query: {type: 'string', maxLength: 256, description: '目录关键词，匹配名称和说明。'},
      names: {type: 'array', maxItems: 8, items: {type: 'string', minLength: 1, maxLength: 64}, description: 'load 的完整工具工作集，使用目录返回的 name；空数组清空，最多 8 个且受 Schema 字节限额约束。'},
      offset: {type: 'integer', minimum: 0, description: '目录分页起点，默认 0。'},
      limit: {type: 'integer', minimum: 1, maximum: 100, description: '每页条数，默认 10；响应另有字节上限。'},
    }, required: ['action'], additionalProperties: false},
    isConcurrencySafe: () => false,
    output: {schema: {type: 'object', additionalProperties: true},
      render: (_args, value) => {
        const {instructions, ...summary} = value;
        return [{type: 'text', text: JSON.stringify(summary)}, ...(instructions ? [{type: 'text', text: instructions}] : [])];
      },
      presentationMeta: (args, value) => args.action === 'load' && value.activation ?
        {codexMcpActivation: activationReceiptSchema.parse(value.activation),
          codexMcpInstructions: instructionsLedgerSchema.parse({version: 1, sessionId: value.activation.sessionId, spentBytes: value.instructionBytesSpent})} : {}},
    execute: async (args, exec) => {
      if (!['status', 'reload', 'tools', 'search', 'load'].includes(args.action) || !Number.isInteger(args.offset ?? 0) || (args.offset ?? 0) < 0 ||
        !Number.isInteger(args.limit ?? 10) || (args.limit ?? 10) < 1 || (args.limit ?? 10) > 100 ||
        (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 256)) ||
        (args.server !== undefined && (typeof args.server !== 'string' || args.server.length > 32))) throw new Error('Invalid codex_mcp action or pagination.');
      return JSON.parse(JSON.stringify(await (await get(exec.agent)).perform(args.action, args, exec.signal)));
    }});
  ctx.on('agent/created', async ({agent}) => { await get(agent); });
  ctx.on('agent/disposed', ({agent}) => {
    const session = sessions.get(agent); sessions.delete(agent); void session?.dispose();
  });
  ctx.on('agent/pre-step', async ({agent, signal}, next) => {
    await (await get(agent)).reconcile({signal}); return next();
  });
  for (const agent of ctx.agents.list()) await get(agent);
}
