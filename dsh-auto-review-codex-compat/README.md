# Codex 自动审查兼容

独立 Host 兼容插件 `@local/dsh-auto-review-codex-compat`，当前版本 **1.0.0**，仅验证 DSH **0.2.2-rc.3**。

## 解决的问题

rc.3 自动审查器在代码中固定设置 `temperature: 0`，PI Codex transport 又将它原样写入请求。Codex 拒绝此参数后，自动审查返回 `AUTO_REVIEW_FAILED`，业务工具主体不会执行。这不是 MCP 加载、OAuth 或业务接口故障；将温度改成 0 也不能解决“不支持此参数”。

本插件仅省略目标审查请求的温度字段，不更换 Codex、模型、鉴权或端点，不修改内置审查策略、不关闭 Auto、不改审批策略、不重放业务工具。

## 精确范围

必须同时满足：

- 不是原生 AgentLoop 带进程内身份标记的日志可重建请求；
- `purpose === 'auto-review'`；
- provider 与配置白名单**完全相同**，默认仅标准目录 route `openai-codex`；
- temperature 是 0～2 的有限数值。未设置或非法值保持原有处理，不把非法请求悄悄变为合法审查。

只用模型名包含 `codex`、相近的 route 名、其他辅助请求或普通对话均不会触发。其他请求不改对象、不改控件、不改 signal。

### 自定义 provider

插件 Config 的 `providers` 接受 1～16 个精确 route ID。仅在确认别名也使用 Codex protocol 后添加；不要填模型名、显示标题或通配符。标准 route 的来源可由安装的 PI 目录源码证明，但不能据此断言用户没有重指定 API。公开 LLM 模型元数据不暴露 transport API，本插件不会猜测协议或读取凭据/整个用户设置。

## 实现与安全边界

- 仅使用公开 `llm/stream` waterfall 与事件绑定的同一个 `LlmRuntime.stream()`。原审查请求已深冻结且归调用者所有，因此不原地删字段，而创建冻结副本，保留 messages、system、provider、model、sessionId、signal 和其他字段。
- 只有新请求重入完整中间件链；它已无 temperature，第二次直接 `next()`。外层不调用 `next()`，最终仅一次 adapter dispatch，不是失败后重试。
- 不捕获失败、不合成 allow、不改审查 JSON；deny、模型错误、取消、非法/重复键 JSON 以及其他工具策略的 veto 继续生效。
- 该精确修复针对当前内置审查器的 direct-stream 路径，不作为通用 prepared-call 或 AgentLoop 请求改写方案。前置观察型中间件可能同时看见外层与清理后的内层请求；实际模型发送仍一次。若需要逐请求统计，应避免把两个中间件观察当两次模型计费。
- 不改 ASAR、核心、活动 profile 文件或 MCP 插件；安装只由 Plugin Manager 管理。卸载只撤销本兼容层，**不会卸载 Auto 或改变权限模式**，旧版审查器可能再次遇到原错误。

## 验证

运行：

```sh
pnpm install --ignore-scripts
pnpm test
```

测试使用确切 rc.3 npm 依赖及 PI SDK **1.3.0**。无真实账号、凭据、业务仓库或云请求：

- [真实审查门禁测试](<test/auto-review.test.js>) 挂载未修改的 Auto review、AgentLoop、LlmRuntime、NativeExecutor、Approval 和 PermissionPresets，仅模型 adapter/工作目录事实为替身。验证旧错误阻止业务；兼容后真实 allow 只执行一次；卸载恢复旧错误；deny+ask 保留人工拒绝审计；deny+never 不提示；独立下游 veto 保留；错误、取消、异常和严格 JSON 无效都不执行业务、不重试。
- [兼容层测试](<test/compatibility.test.js>) 验证冻结输入不变、字段引用保留、精确路由/purpose、无效参数不被合法化、事件 this 上下文、单次 dispatch、失败原样传播和发布资源。
- [真实 SDK wire 测试](<test/wire.test.js>) 使用公开的 Codex provider/API。只有合成 JWT，并在公开 `onPayload` hook 捕获真实 body 后立即抛出本地停止标记，早于 headers/WebSocket/SSE；断言修复前有 temperature、修复后无该字段且其余 body 一致，fetch 调用为 0。它不是远程 Codex 或完整 PI 适配器云端验收。

当前完整结果 **18/18 通过，0 跳过**。Native 主循环请求 identity、冻结、模型控件不变；PTC 共享同一个自动审查分类器，但本包没有另起真实 PTC 子进程的端到端 gate 测试。真实 Codex 自动审查、云效业务和实际 GUI 图标渲染仍须在适当授权的用户操作中验收，安装或本地测试不能代替这些结论。

## 依据与升级

参数来源：[内置审查器](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/src/index.ts#L682-L692>)；公开 waterfall：[LLM runtime](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/src/index.ts#L1185-L1198>)。

仅通过 Plugin Manager 安装当前目录或版本化 tarball，查看 `application` / `nextStep` 判断是否已应用。未来 DSH 升级后须重新核验；若上游已解决此问题，优先移除本兼容层。没有使用版本豁免或放宽未来版本范围。

图标为本插件原创的透明盾牌/参数符号，非第三方品牌标识；提供中英文标题和说明。
