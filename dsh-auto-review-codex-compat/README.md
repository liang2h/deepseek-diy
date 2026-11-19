# 自动审查参数兼容

独立 Host 插件，当前 **1.1.1**，验证环境 DSH **0.2.2-rc.5**。为直接升级已有安装，保留包名 `@local/dsh-auto-review-codex-compat` 与原 Loader row ID；**当前功能不限于 Codex**，不会并装第二个兼容层。

## 根因与本次纠正

rc.3 以及当前 rc.5 内置自动审查器在所有审查请求中固定设置 `temperature: 0`。这错误地假定所有 provider、协议和模型都支持显式温度参数；实际上 Codex 和部分 OpenAI API 推理模型都会拒绝它，自定义 provider 名称也不能代表参数能力。

**1.0.0 的 provider 白名单修复不完整**：默认只匹配 `openai-codex`，其他路由仍发送固定温度。本版删除运行时的 provider/model 匹配，将兼容规则统一放在 `purpose === 'auto-review'` 的辅助请求边界，在发送前省略合法温度字段。它不靠模型名字、协议猜测、遇到 HTTP 400 后重试或逐个补别名。

这是通过公开插件扩展点实现的请求级纠正，**没有修改上游 ASAR 或宣称上游源码已修复**。上游理想修复是在审查请求生产处不强行指定通用可选采样控件，或先建立准确的逐模型参数能力契约；当前公开 `LlmResolvedModelInfo` 并没有 temperature 支持能力字段。

## 范围与采样语义

同时满足以下条件才改写：不是带 AgentLoop 进程内身份标记的请求、`purpose` 严格等于 `auto-review`、temperature 是 0～2 的有限数值。不再检查 provider、model 或白名单。未设置和非法温度保留原处理，不把非法输入悄悄变为合法请求。

- **所有 provider/自定义别名自动适用**，无需填写路由列表。
- **审查采样改用提供方/模型默认值**。即使模型支持温度，本版也不再强制审查温度为 0；不保证与旧温度下每次模型判决逐字相同。审查策略、模型、完整上下文与严格判决解析保持不变。
- 普通对话和其他辅助任务完全不改：包括其 request identity、温度、预算、provider/model、session、signal 和消息引用。不是全局剥离所有模型请求的温度。
- 原 Config 的 `providers` 仅作为有界弃用字段继续接受，**值被忽略**，旧配置无需手改也不会限制新规则。禁用/卸载该兼容插件只撤销参数修正，不卸载 Auto 或改变访问模式。

## 实现与安全边界

通过公开 `llm/stream` waterfall 创建冻结副本，仅省略顶层 temperature，其余字段和引用保持一致。使用事件绑定的同一个 `LlmRuntime.stream()` 重入完整中间件链；新请求已无温度，第二次直接 `next()`，外层不调用 `next()`，最终仅一次 adapter dispatch。不更换模型、端点或鉴权。

不合成 allow，不捕获失败，不改判决 JSON，不关闭审查，不改审批策略，不改 MCP 配置，不重放业务工具。deny、模型错误、取消、非法/重复键 JSON 及下游工具策略 veto 继续生效。

该修复针对当前内置审查器 direct-stream 路径，不是通用 prepared-call/AgentLoop 改写方案。前置观察型中间件可能看到外层和清理后的内层两次观察；模型发送仍一次，不应据观察次数重复计算费用。不包含远程参数探测或错误回退重试。

## 测试与证据

```sh
pnpm install --ignore-scripts
pnpm test
```

运行及测试依赖固定到 DSH rc.5；PI SDK 1.3.0 / 其 OpenAI SDK 7.19.0。仅合成数据，未读取真实账号凭据、真实业务仓库或调用云接口：

- [真实审查门禁测试](<test/auto-review.test.js>)：未修改的 Auto review、AgentLoop、LlmRuntime、NativeExecutor、Approval 和 PermissionPresets，模型 adapter 与工作目录事实用替身。7 路由含标准 Codex、OpenAI、Responses、自定义/未知别名及支持温度的模型；旧 `providers: ['openai-codex']` 无法阻止其他路由修复。Codex/OpenAI/不透明别名分别复测全部 11 条门禁路径，保持严格解析、原上下文引用、单次审查/执行、deny+ask 人工拒绝审计、deny+never、下游 veto、模型异常/取消/非法 JSON 仍阻断。卸载恢复原参数行为。
- [请求级单元测试](<test/compatibility.test.js>)：所有路由同一规则、0/0.5/1/2、loop 身份保护、其他 purpose 精确不变、无效温度不合法化、this 上下文、字段引用、异常原样传播和发布资源。
- [SDK wire 测试](<test/wire.test.js>)：真实 Codex SDK 的公开 `onPayload` hook 捕获 body 后、网络发送前停止，fetch 为 0；真实 OpenAI Chat Completions 与 Responses SDK 使用纯内存 fetch 替身，对标准路由和自定义别名分别复现 HTTP 400，再验证省略温度后成功且其余 body 一致。不存在真实网络调用，也不把替身当云端验收。

完整回归 **53/53 通过，0 跳过**。针对本次新增的真实门禁测试，旧 1.0.0 取得 RED：40 项中 12 通过、28 因温度仍存在失败；新实现 GREEN：40/40。历史 1.0.0 的 18 项测试没有覆盖跨 provider 缺陷，不能证明通用兼容。

PTC 复用同一个审查分类器，但本包没有另启 PTC 子进程的完整门禁端到端测试。真实 OpenAI/Codex 云端、原云效业务及 GUI 图标渲染未代替用户执行，均不据本地结果声称成功。

## 1.1.1 / DSH rc.5 兼容性核查

- 将 `engines.dsh`、DSH peer 和测试依赖精确迁移到 `0.2.2-rc.5`，同步锁文件；不扩大到未经测试的未来版本，不使用运行时版本豁免。
- 通过当前 Host Inspect 核对 `llm/stream` waterfall 的 `this: LlmRuntime`、`next()` 和 `stream()` 契约；rc.5 内置审查器仍构造冻结的 `purpose: 'auto-review', temperature: 0` 请求，因此保留现有最小参数修正，不改权限判决代码。
- 测试所用 rc.5 npm 包的 LLM、Auto review、AgentLoop、NativeExecutor 入口与当前 Desktop ASAR 入口逐一 SHA-256 一致；PI SDK 仍为 `1.3.0`。
- 对照本机[升级索引](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/docs/upgrade-guide/README.md#L7-L17>)检查 rc.3→rc.4 的 DeepSeek 拒答错误码变更、rc.4→rc.5 的网页搜索默认提供方变更。本包既不匹配该错误码，也不注册搜索提供方，因此无需对应代码迁移；两项均按不影响本包跳过，未借用旧版 API 推断兼容。
- 保留既有原创图标、中英文标题、Loader row ID 和旧 Config 迁移支持。未修改 ASAR、活动 profile 或用户访问模式；安装一律交给 Plugin Manager。

## 安装与升级

通过 Plugin Manager 安装版本化 tarball，替换原包；以 `application` / `nextStep` 为准。若要求重启，完整退出重开 DSH，仅刷新网页不保证 Host 模块更换；不要为此关闭审查。确认新 schema 中 providers 标注 deprecated/ignored，而不是旧的路由白名单。

没有手改活动 profile、ASAR 或 MCP 插件，没有使用版本豁免。未来 DSH 升级需重新核验，若上游修复应优先移除兼容层。

依据：[内置审查器的固定温度](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/src/index.ts#L682-L692>)；[公开 waterfall](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/src/index.ts#L1185-L1198>)。沿用本插件原创透明盾牌/参数图标，提供中英文标题和说明。
