import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createMcpToolDefinition} from '@deepseek-ai/dsh-mcp-client';
import {scrubbedParentEnv} from '@deepseek-ai/dsh-subprocess';
import {credentialRef} from '@deepseek-ai/dsh-credentials';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {clipText} from './limits.js';
import {publicToolName, isToolEnabled} from './config.js';

/** One server connection per Agent. No business call is ever replayed after failure. */
export class ServerConnection {
  constructor({ctx, agent, server, projectRoot, oauth, validate, selected = () => false, onState = () => {}}) {
    Object.assign(this, {ctx, agent, server, projectRoot, oauth, validate, selected, onState});
    this.instructions = ''; this.instructionsBytes = 0;
    this.disposers = []; this.contextDisposers = []; this.tools = new Map(); this.state = 'stopped'; this.attempts = 0;
    this.stopped = false; this.syncQueue = Promise.resolve();
  }
  publish(state, diagnostic) { this.state = state; this.diagnostic = diagnostic; this.onState(); }
  async credentials() {
    const env = {...this.server.env};
    for (const name of this.server.envVars) {
      const value = await this.ctx.credentials.resolve(credentialRef(name));
      if (!value) throw new Error('MISSING_CREDENTIAL');
      env[name] ??= value.value;
    }
    const headers = {...this.server.headers};
    for (const [key, name] of Object.entries(this.server.envHeaders)) {
      const value = await this.ctx.credentials.resolve(credentialRef(name));
      if (!value) throw new Error('MISSING_CREDENTIAL');
      headers[key] = value.value;
    }
    if (this.server.bearerTokenEnvVar) {
      const value = await this.ctx.credentials.resolve(credentialRef(this.server.bearerTokenEnvVar));
      if (!value) throw new Error('MISSING_CREDENTIAL');
      headers.Authorization = `Bearer ${value.value}`;
    }
    return {env, headers};
  }
  connect() {
    if (this.stopped) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  async open() {
    this.publish('connecting'); this.controller = new AbortController();
    const timeout = setTimeout(() => this.controller.abort(new Error('STARTUP_TIMEOUT')), this.server.startupTimeoutMs);
    timeout.unref?.();
    try {
      await this.validate();
      const {env, headers} = await this.credentials();
      this.controller.signal.throwIfAborted();
      if (this.server.transport === 'stdio') {
        const command = await this.ctx.subprocess.resolveExecutable(this.server.command, env, this.controller.signal);
        this.controller.signal.throwIfAborted();
        this.transport = new StdioClientTransport({command, args: this.server.args,
          env: {...scrubbedParentEnv(), ...env}, cwd: path.resolve(this.projectRoot, this.server.cwd || '.'), stderr: 'pipe'});
      } else {
        const hasAuth = Object.keys(headers).some(key => key.toLowerCase() === 'authorization');
        this.transport = new StreamableHTTPClientTransport(new URL(this.server.url), {
          requestInit: {headers, signal: this.controller.signal},
          ...(!hasAuth && this.oauth ? {authProvider: await this.oauth.provider()} : {}),
        });
      }
      this.client = new Client({name: 'dsh-codex-mcp', version: '1.0.0'}, {capabilities: {},
        listChanged: {tools: {onChanged: () => this.scheduleSync(), autoRefresh: false}}});
      // Discard stderr instead of inheriting potentially credential-bearing package logs.
      this.transport.stderr?.resume();
      await this.client.connect(this.transport, {signal: this.controller.signal, timeout: this.server.startupTimeoutMs});
      await this.sync();
      this.controller.signal.throwIfAborted();
      if (this.stopped) throw new Error('STOPPED');
      const instructions = this.client.getInstructions?.() || '';
      this.instructionsBytes = Buffer.byteLength(instructions, 'utf8');
      // Host-only cache. ProjectSession admits bounded excerpts only for servers
      // with tools in this exact step's resolved set; connecting injects nothing.
      this.instructions = clipText(instructions, 32768);
      const client = this.client;
      client.onclose = () => { if (!this.stopped && client === this.client) this.lost(); };
      client.onerror = () => {}; // The surfaced operation owns its sanitized diagnostic.
      this.attempts = 0; this.publish('ready');
    } catch (error) {
      await this.closeGeneration();
      if (this.stopped) return;
      const auth = ['NeedAuthError', 'UnauthorizedError', 'InsufficientScopeError'].includes(error?.name);
      this.publish(auth ? 'needs-login' : 'error', auth ? '请使用登录命令完成 OAuth 认证。' :
        this.controller.signal.aborted ? '启动超时或连接已取消。' : '连接或工具发现失败；请检查命令、依赖、凭据和服务状态。');
      if (!auth) this.retry();
    } finally { clearTimeout(timeout); }
  }
  scheduleSync() {
    const client = this.client;
    this.syncQueue = this.syncQueue.then(() => this.state === 'ready' && this.client === client ? this.sync() : undefined)
      .catch(() => { if (!this.stopped && this.client === client) { this.clearTools(); this.publish('error', '工具目录更新失败，已撤下该服务器工具。'); } });
  }
  async sync() {
    const client = this.client, controller = this.controller;
    const check = () => {
      if (this.stopped || this.client !== client || this.controller !== controller) throw new Error('STALE_CONNECTION');
      controller.signal.throwIfAborted();
    };
    await this.validate(); check();
    const result = client.getServerCapabilities()?.tools ?
      await client.listTools(undefined, {signal: controller.signal, timeout: this.server.startupTimeoutMs, cacheMode: 'refresh'}) : {tools: []};
    check();
    const definitions = [], rawNames = new Set();
    for (const tool of result.tools) {
      if (rawNames.has(tool.name)) throw new Error('DUPLICATE_TOOL');
      rawNames.add(tool.name);
      if (!isToolEnabled(this.server, tool.name)) continue;
      const name = publicToolName(this.server.name, tool.name);
      const definition = createMcpToolDefinition(this.ctx, {name, rawName: tool.name,
        description: tool.description || '', inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
        taskRequired: tool.execution?.taskSupport === 'required',
        call: async (args, exec) => {
          await this.validate(); check();
          if (this.state !== 'ready') throw new Error('MCP connection is not ready; check codex_mcp status.');
          try {
            return await client.callTool({name: tool.name, arguments: args},
              {signal: exec.signal, timeout: this.server.toolTimeoutMs, toolDefinition: tool});
          } catch (error) {
            if (['NeedAuthError', 'UnauthorizedError', 'InsufficientScopeError'].includes(error?.name)) {
              this.clearTools(); this.publish('needs-login', '授权失效，请重新登录。');
            }
            throw new Error('MCP 调用失败或已取消；未自动重放，请检查服务器状态。');
          }
        }});
      const execute = definition.execute;
      definition.execute = async (args, exec) => {
        if (this.agent && exec.agent !== this.agent) throw new Error('MCP tool belongs to a different Agent/project.');
        try { return await execute(args, exec); }
        catch { throw new Error('MCP 工具执行失败或已取消（上游错误内容已隐藏）；未自动重放。'); }
      };
      const signature = createHash('sha256').update(JSON.stringify(tool)).digest('hex');
      const schemaBytes = Buffer.byteLength(JSON.stringify({name, description: definition.description, parameters: definition.parameters}), 'utf8');
      definitions.push({name, definition, signature, schemaBytes, rawName: tool.name, annotations: tool.annotations});
    }
    await this.validate(); check();
    this.clearTools();
    try {
      for (const item of definitions) {
        this.disposers.push(this.ctx.tools.register(item.definition, {when: context =>
          !this.stopped && this.state === 'ready' && (!this.agent || context.agent === this.agent) &&
          this.selected(item.name, item.signature, context)}));
        this.tools.set(item.name, item);
      }
      this.missingTools = (this.server.enabledTools || []).filter(name => !rawNames.has(name));
    } catch (error) { this.clearTools(); throw error; }
  }
  clearTools() { for (const dispose of this.disposers.splice(0)) dispose(); this.tools.clear(); }
  retry() {
    if (this.stopped || this.attempts >= 5 || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.connect(); }, Math.min(30000, 500 * 2 ** this.attempts++));
    this.timer.unref?.();
  }
  async lost() {
    this.clearTools(); this.publish('disconnected', '连接已断开；仅重连，不重放工具调用。');
    await this.closeGeneration(); this.retry();
  }
  async closeGeneration() {
    this.clearTools(); this.instructions = ''; this.instructionsBytes = 0;
    for (const dispose of this.contextDisposers.splice(0)) dispose();
    const client = this.client; this.client = undefined;
    if (client) { client.onclose = undefined; try { await client.close(); } catch {} }
    else try { await this.transport?.close(); } catch {}
    this.transport = undefined;
  }
  async dispose() {
    this.stopped = true; clearTimeout(this.timer); this.controller?.abort();
    await this.closeGeneration();
    await this.connecting; await this.syncQueue; this.clearTools();
    this.publish('stopped');
  }
  status() { return {name: this.server.name, transport: this.server.transport, state: this.state,
    tools: this.tools.size, missingTools: (this.missingTools || []).slice(0, 20), missingToolCount: this.missingTools?.length || 0,
    ...(this.diagnostic ? {diagnostic: this.diagnostic} : {})}; }
}
