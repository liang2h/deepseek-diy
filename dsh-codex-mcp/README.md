# Codex 项目 MCP

独立 DSH 插件（Host 业务逻辑 + 轻量 Client 菜单显示层）：读取当前项目的 `.codex/config.toml`，为每个 Agent 建立独立 MCP 连接，支持 stdio、Streamable HTTP、OAuth、原始工具名白名单及逐工具审批。当前 1.2.1 针对 DSH **0.2.2-rc.2** 和 MCP Client SDK **2.2.0** 开发验证；不修改 DSH 核心文件或 agent preset；菜单显示采用下述限定版本兼容适配。

## 首次使用

1. **先轮换任何已在聊天、截图或版本库中暴露的凭据。** 在自己的项目本机配置文件中保存配置，不要把密钥发给智能体。
2. 将已有 Codex MCP 配置放到项目根目录的 `.codex/config.toml`，在 DSH 中进入该项目。
3. 在聊天输入框直接发送以下人类命令（不是让智能体代为执行）：

```text
/codex-mcp status
/codex-mcp trust <status 返回的完整 fingerprint>
/codex-mcp login agentlens
/codex-mcp login engineering_context
/codex-mcp status
```

信任之前请检查完整配置：`trust` 会启动已启用且未显式配置空工具白名单的服务器，向它们传递显式环境变量/请求头，并采纳工具的审批配置。`uvx`、`npx` 可能下载并执行第三方包。生产/测试注释不控制启停；需要停用服务器请显式 `enabled = false`。从 1.2.0 起，`enabled_tools = []` 也明确跳过连接、OAuth 管理器和目录发现，而不仅隐藏工具。**插件安装本身不会信任配置或开始 OAuth 登录。**

从 1.0.3 开始，人类执行 `login` 后会自动请求**系统默认浏览器**打开授权页，并返回 `state: "waiting-for-user"`、打开请求结果、备用链接及到期时间。你手动登录并确认授权后，插件通过本机回调自动保存令牌并重连。自动打开失败时仍保留链接和等待状态，可手动继续；`browser.state: "requested"` 只表示已发出系统打开请求，不保证浏览器页面已显示。插件不会代填账号或点击授权。

登录回调等候最长 5 分钟，不占用 MCP 的启动超时预算。命令不会一直阻塞，等待期间仍可用 `status` 查询、`cancel <server>` 取消；取消登录不负责关闭已打开的浏览器标签页。回调监听在本机 `127.0.0.1` 随机端口；浏览器与 DSH 应在同一台电脑。远程浏览器/容器回调转发暂不支持。后台 401、重连、reload 和模型工具都不会自动打开浏览器。

## 管理入口

| 人类命令 | 作用 |
| --- | --- |
| `/codex-mcp status` | 当前项目、配置指纹、信任状态、各服务器连接状态和安全诊断 |
| `/codex-mcp tools [server]` | 已发现、静态过滤后的目录元数据（默认前 10 项）；查询不会激活工具 |
| `/codex-mcp reload` | 重新读取配置并重连；不自动批准新指纹 |
| `/codex-mcp trust <fingerprint>` | 明确批准当前配置；指纹变化时必须重新确认 |
| `/codex-mcp untrust` | 撤销项目信任并关闭连接，不删除已保存 OAuth 授权 |
| `/codex-mcp login <server>` | 显式发起已信任 HTTP 服务器的 OAuth 登录 |
| `/codex-mcp cancel <server>` | 取消尚未完成的登录 |
| `/codex-mcp logout <server>` | 停止该服务器连接并删除本地授权记录；不等同于服务端撤销授权 |

模型工具 `codex_mcp` 提供 `status`、`reload`、`tools`、`search`、`load`。目录支持 `server`、`query`、`offset`、`limit`（默认 10，最大 100），每页另有约 16 KiB JSON 响应上限，说明和原始长名称会截短；激活使用完整公共 `name`。模型不能通过此工具信任项目、登录、退出或取消人类授权。人类和模型的查询/重载仍使用同一业务实现。

## 渐进发现与加载（1.2.0）

**已连接不等于已激活，分页也不等于激活。** 已信任项目仍可在 Host 连接服务器并缓存完整允许目录，但新会话首轮只贡献管理工具，不向模型发送整个 MCP 目录的完整 Schema，也不自动发送服务器 instructions。本版本没有宣称所有非空服务器都改成延迟连接。

模型按以下顺序工作：

```json
{"action":"search","server":"remote_example","query":"read","limit":10}
{"action":"load","names":["mcp__remote_example__upstream__example_read"]}
```

第二行必须使用第一行实际返回的 `name`，这里仅是格式示例。`load` **替换整个工作集**，不是追加；需要同时保留的工具须一起传入。`{"action":"load","names":[]}` 清空工作集。加载不调用业务工具，也不绕过审批。

- 默认每个 Agent 同时最多 8 个 MCP 工具，完整 `{name, description, parameters}` JSON 的 UTF-8 总预算 64 KiB。超过预算、重复或不可用名称会整体拒绝，不部分加载、不破坏原工作集；线上的协议包装和其他插件上下文不计入这个预算。
- `when` 使用精确 Agent 身份、当前项目/指纹/信任代际、成功日志回执以及当前工具内容签名共同判定。只设置 `deferLoading` 不会激活工具，因此插件不靠该标记隐藏目录，而由原生工具更新机制处理实际 addition/removal。未激活工具在 Schema、原生执行与 PTC admission 中都不可调用。
- 激活只发生在原生成功 `tool/result` 提交后的**下一个模型步骤**。同批次或同一个 PTC 程序中刚 load 后立即调用此前未 admission 的工具仍不可用。没有最终成功日志的取消、失败或未完成加载不恢复选择。
- 使用原生 `sessionProjections` 折叠配对调用/结果，whole-value 回执放在公开 `output.presentationMeta` 中，不从可能截断的正文猜状态，不新增 Session 事件，也不遍历 deprecated 日志 API。同 ID 日志重建恢复选择；新 ID fork 不继承工具激活。
- 断线/重连或 `reload` 只恢复当前有效绑定下、签名完全相同的已选工具，不重放业务调用。新名称和同名但签名已变的工具需要重新发现并加载。观察到新的配置指纹后旧 grant 失效；未运行期间发生又恢复的字节变化无法仅凭当前文件检测。
- 显式 untrust/retrust 即使指纹相同也创建新的非秘密授权代际，旧加载回执不复活。logout 保留项目指纹信任，但旋转**项目级**激活代际：该项目各 Agent 的全部旧工作集需重新 load，不仅限于退出的服务器。

### Instructions 的累计预算

instructions 仅随显式 `load` 的成功工具结果作为独立文本块交付，**不注册动态系统提示 section**。每次单服务器内容（含来源、非授权声明和截断标记）默认不超过 2 KiB；每会话由本版本交付的累计 UTF-8 文本默认不超过 8 KiB。只交付此次选择涉及的服务器，不复制完整目录或完整 Schema 到结果正文。

累计消费使用原生结果 metadata 持久化，清空工作集、重新信任和同 ID 重建不会退款；fork 会计入继承历史中合法 instructions ledger 的已用预算，但仍不会继承激活。未提交或取消的加载可能保守占用当前进程的预留配额，防止同批并发超发；重建后以已提交日志为准。额度耗尽后仍能加载工具 Schema，但不再补发 instructions。该预算不是整个对话的 token 上限：既有旧版本上下文、其他插件、摘要和业务返回不受它控制。

插件原生 Config 可调整（通过设置/配置编辑器修改，不手写活动 profile）：

| 字段 | 默认值 | 可用范围 |
| --- | ---: | ---: |
| `maxActiveTools` | 8 | 1–8 |
| `maxSchemaBytes` | 65536 | 1024–262144 |
| `instructionsPerServerBytes` | 2048 | 0–8192 |
| `instructionsTotalBytes` | 8192 | 0–32768 |

instructions 两个值均可设为 0 关闭交付。较高预算是显式扩大上下文，不是免费缓存。

## 命令菜单显示（1.1.0）

Client 为原有菜单行补充单色连接图标、中文标题“项目 MCP”、英文别名 `codex-mcp` 和简短说明“管理项目 MCP 连接与 OAuth 登录”；英文界面使用对应英文文案。继续由原生菜单组件处理对齐、字号、主题和悬停样式，无自建菜单或 DOM/CSS 覆盖。

**保留全部带参数命令。** Host 注册、input hint、参数解析、执行 handler 和人类授权边界均不改变，`/codex-mcp login agentlens` 等原有用法照常。不会注册第二个同名 Client 命令、添加重复候选或替换输入 source。

侧边聊天确实通过原生 Client contribution 实现了同类展示，不需要改 DSH 核心；此前将第三方完整样式归结为必须修改框架，是过于绝对的判断。但该方式不能与同名 Host 参数命令直接并存。本版本按用户要求保留 Host 参数入口，采用**已重新核验 DSH 0.2.2-rc.2 的 Client 兼容适配**：封装当前实现的候选生成函数，只为 name、hint、description 均匹配的本插件行补充展示字段。它不是官方稳定的 Host 行装饰 API，升级 DSH 后须重新核验；没有修改核心文件、私有目录/注册表、参数 claim 或执行路径。

适配失败、接口不匹配或属性不可配置时，保留原生行和原有命令功能；其他行的对象与顺序不变，不新增 RPC、不重新查询。中文标题仅用于展示，搜索仍沿用原命令名和原生筛选/排序，未新增中文命令别名。正常卸载恢复原方法和词典，进行中的请求卸载后不再装饰；若之后有第三方另行包装相同方法，本插件仅将自身层失活，不强行拆除对方包装。

真实 Cordis 隔离测试已验证候选数据、作用域和卸载行为；当前没有浏览器控制，**尚未视觉确认实际菜单渲染**。

## 支持的配置

```toml
[mcp_servers.local_example]
command = "uvx"
args = ["example-mcp-package"]
startup_timeout_sec = 30.0

[mcp_servers.local_example.env]
EXAMPLE_TOKEN = "REPLACE_LOCALLY_DO_NOT_COMMIT"

[mcp_servers.local_example.tools.example_read]
approval_mode = "approve"

[mcp_servers.remote_example]
url = "https://mcp.example.com/mcp"
startup_timeout_sec = 10.0
tool_timeout_sec = 60.0
enabled_tools = ["upstream__example_read"]
```

| 字段 | 行为 |
| --- | --- |
| `command`、`args`、`env` | stdio 独立进程；绝不复用另一服务器的进程或显式凭据 |
| `cwd`、`env_vars` | 子进程工作目录（默认项目根目录）；显式继承的凭据引用名 |
| `url` | Streamable HTTP；优先 POST 初始化，GET 405 不表示握手失败，不按 `/stream` 路径猜旧版 SSE |
| `http_headers`、`env_http_headers`、`bearer_token_env_var` | 固定请求头、凭据引用请求头与 Bearer 凭据引用；有固定 Authorization 时不自动注入 OAuth token |
| `enabled` | 默认 true；false 不连接不注册工具 |
| `startup_timeout_sec` | 有限正数秒，可用浮点数；默认 10 秒，覆盖启动/初始化/首次工具目录 |
| `tool_timeout_sec` | 有限正数秒，可用浮点数；默认 60 秒；取消信号传递给 SDK |
| `enabled_tools` | 匹配原始工具名；省略为全部，空数组明确跳过连接和发现；非空仍需 load 才进入模型上下文 |
| `disabled_tools` | 在白名单之后排除，拒绝优先 |
| `tools.<raw>.approval_mode` | `approve`、`prompt`、`auto`、`writes`；见下文 |
| `scopes` | 显式 OAuth scope，与认证挑战所要求的 scope 合并 |
| `oauth.client_id`、`oauth.client_secret_env_var` | 可选预注册客户端与 secret 凭据引用；否则采用服务支持的公共客户端 DCR |

`env_vars`、请求头引用和 OAuth secret 引用通过 DSH credentials.resolve 解析，继承当前凭据存储/环境回退规则。裸 `command` 通过 DSH subprocess.resolveExecutable 的 PATH 查找；绝对命令路径必须可执行。桌面 DSH 不一定与终端 PATH 相同。显式静态环境变量只在连接内存中使用，不额外复制到插件持久化配置。

未知 MCP 字段、错误嵌套、command/url 冲突、无效超时或 URL 均明确报错，不静默忽略。仅忽略与 MCP 无关的顶级 Codex 设置。错误隐藏输入值和第三方响应内容，以免诊断泄露秘密。

## 审批与隔离

- **`approve` 表示预先批准，不是“每次询问”。** 仅在用户显式信任该配置后生效，不覆盖 DSH 其他插件的拒绝、询问或权限限制。
- `prompt` 始终要求批准；`auto`/`writes` 仅对明确声明 `readOnlyHint = true` 且非 destructive 的工具不额外询问，其余保守地要求批准。服务端注解不是强制只读沙箱。
- 项目白名单、`mcp:read` scope 或工具名不能证明数据库、Kubernetes、脚本工具无写入能力。
- 注册按精确 Agent 限定，包括对子 Agent 的可见性与执行检查。子 Agent 在自己的项目重新加载配置，不能继承父 Agent 的项目连接或审批豁免。
- 白名单、逐工具审批始终匹配完整原始名；DSH 公共名采用 `mcp__server__raw`，超过 64 字符或包含不支持字符时，按当前官方桥接算法缩短并附 12 位哈希。网络调用仍发送完整原始名。
- 配置监听加每步/执行前校验；变化、删除、解析失败或撤权后撤下旧工具。已信任配置的任意文本变化都会改变指纹，包含注释与空格。
- 断线仅重连，不重放业务调用。写操作超时/取消不代表远端未执行，应先核实结果再决定是否重试。

## OAuth 与存储

发现、动态客户端注册（DCR）、PKCE S256、授权码交换与刷新均使用官方 SDK。后台 401 只进入待登录状态，不自动注册客户端或弹出浏览器。受保护资源的 `WWW-Authenticate` 元数据地址被保留用于显式登录。

凭据键绑定 canonical 项目根目录、服务器名、URL、配置的 OAuth 客户端与 scopes。授权码、PKCE verifier 与 state 仅存在于本次登录内存。OAuth grant 存入 DSH credentials 记录，不写项目配置或模型消息；刷新在同一记录锁内读、判断和写，避免多个 Agent 并发轮换 refresh token。沿用当前 DSH 存储机制，**不额外宣称系统钥匙串或加密存储保证**。

动态客户端使用本次随机回调端口注册；重新显式登录可能重新注册客户端。logout 仅删除本地授权，不保证令牌在远端被撤销；需要远端彻底撤销时在服务账户管理页处理。

## OAuth 登录失败诊断（1.0.1）

如果 `login` 没有返回授权链接，命令错误和 `status.servers[].oauth.failure` 会给出安全字段：

```json
{"code":"oauth_failed","stage":"client_registration","reason":"http_error","httpStatus":400,"oauthError":"invalid_redirect_uri"}
```

这是示例，不是对实际服务的错误判断。`stage` 区分本机监听、凭据读取/保存、资源元数据、认证服务器元数据、客户端注册、授权链接生成及令牌交换；`httpStatus` 只在收到响应时出现；`oauthError` 只保留标准白名单错误码，`networkCode` 只保留常见 DNS/连接/TLS 错误码。不会显示服务响应正文、URL、client secret、token、state 或授权码。`sdk_validation` 表示 SDK 在当前阶段拒绝了响应，不一定能仅凭阶段确定具体根因。请提供这些安全字段用于排查，不要提供完整授权链接或凭据。

## 凭据保存兼容修复（1.0.2）

修复 `stage=credential_write, reason=credential_store` 的一项已复现原因：官方 SDK 的 discovery state 等 JS 对象允许可选字段显式为 `undefined`，但 DSH 文件凭据存储要求 payload 无损 JSON 往返。插件现在在每个 OAuth 记录写入边界递归省略对象中的 `undefined` 可选字段，同时保留 issuer、客户端信息和 token 数据；不将不合法数字、类实例、循环或数组中的 `undefined` 静默改成其他值。

回归测试使用真实 `@deepseek-ai/dsh-credentials-local@0.2.2-rc.2` 与隔离临时文件，覆盖发现/无 scope 认证挑战的登录记录保存，以及官方 SDK 授权码交换、刷新、重新打开存储和退出。旧内存测试也增加了严格 JSON 往返校验。不会读取或清空用户真实凭据。此修复不保证其他磁盘权限或 I/O 问题也已排除。

## 范围与验证边界

仅单个项目根配置；优先按 DSH 已登记 workspace 根目录定位，没有登记时采用会话进入目录，并在其子目录内保持根。不会读取用户级 Codex 配置或导入 Codex 登录态；不做项目子目录多层覆盖。配置通过符号链接逃出项目时拒绝读取。仅支持本机文件系统和 SDK 管理的本机进程；stdio 与 DSH 内置 MCP 桥一样采用 scrubbedParentEnv，不应把 MCP 进程当成受 bash 文件沙箱完全约束的进程。敏感项目应使用专门受限账户/容器。

暂不支持旧版 HTTP+SSE、CIMD 客户端文档、MCP prompts、企业托管认证或服务端授权撤销。工具与资源结果的处理复用官方 DSH 工具桥，但本期仅注册 MCP tools，不额外注册 resources 访问入口。

[脱敏九服务器样例](<test/fixtures/redacted.toml>)保留目标配置的结构，不包含用户真实凭据；不会安装它为实际项目配置。测试仅执行本机 Node 模拟服务器与回环 HTTP，不运行 uvx/npx 云服务、不访问生产业务。

```sh
pnpm install --ignore-scripts
pnpm test
```

测试覆盖配置校验、原始工具名和稳定长名称、stdio/HTTP 真实 SDK 握手/调用/超时/取消、环境变量隔离、OAuth DCR+PKCE/刷新、真实 Cordis 作用域及撤权生命周期。真实云服务的依赖安装、更新后凭据、OAuth 登录及实际工具清单仍须在用户授权后单独验收。

首轮只贡献一个管理工具，无额外静态系统提示。Host 连接和缓存目录本身不会 admission 业务工具；instructions 也不再因为连接成功就进入系统提示。旧会话已经存在的大目录、Schema 和正文历史不会被插件篡改或自动删除，升级后应开启新会话观察首轮收益。尤其原生 `in-history` 模型可保留已卸载的历史 Schema，这不代表它们仍可执行；当前工作集上限不等于整个历史上下文的上限。

### 1.2.0 本机真实请求测量

1.2.0 当时在 DSH 0.2.2-rc.1 的完整回归 **177/177 通过**，包含既有 OAuth、真实隔离凭据存储、菜单适配和新增渐进加载/原生请求测试。当前 rc.2 的验证见下节。

[真实请求测试](<test/progressive-request.test.js>) 启动 240 工具的回环 HTTP MCP 和模拟模型端，挂载真实 DSH AgentLoop、LlmRuntime、NativeToolExecutor、ToolsService 与 DeepSeekAdapter，读取实际 POST JSON；不是手工 map Schema 的模拟 builder。**测量发生在 MCP 已 initialize/list 完成后**，不是无配置场景。无真实账户、无远程服务，模型 SSE/usage 是固定替身，不能作为真实模型用量。

| 隔离 fixture 首轮指标 | 旧 eager admission 对照 | 1.2.0 默认未激活 |
| --- | ---: | ---: |
| 完整工具 Schema 数（含管理入口） | 241 | 1 |
| 实测 HTTP JSON 字节 | 166675 | 1425 |
| 实测 wire tools JSON 字节 | 166415 | 1165 |
| Schema JSON 字符数 / 4 向上取整的粗估 | 41523 | 211 |

对照使用相同的当前管理入口与真实 SDK 发现定义，仅在独立测试连接设置 `selected: () => true` 重现旧的立即 admission；不是声称运行了旧发布包的所有代码。三种路径（不支持工具更新、`addition-only`、`in-history`）首轮均得到以上结果。字节和 Schema 数是实测，字符密度只是估算，中文偏差尤其明显，**不是 tokenizer 或账户实际 input tokens**，也不是生产完整 preset 的 token 上限。

已验证发现 → load → 下一步骤真实 SDK 业务调用；未 load、卸载、撤权、同名 Schema 变化后 `UNKNOWN_TOOL`；重连不重放业务；相同 ID 原生日志 JSON 往返重建恢复、fork 激活隔离；原生 addition/removal 及不支持模型的 fallback。日志重建用公开 Agent 创建 seed，不冒充线上持久化 resume API。投影 checkpoint/tail replay、截断缓存拒绝、旧 stateVersion 重折、累计 instructions 与继承预算另见 [投影测试](<test/activation.test.js>) 和 [生命周期测试](<test/progressive-lifecycle.test.js>)。

现有菜单、OAuth、真实隔离本地凭据存储及 stdio/HTTP 回归继续保留。自动打开浏览器测试使用注入的 OS 调用替身；未使用真实账号授权，未宣称实际浏览器页面或菜单视觉验收。原问题中约 218k 输入以及连续 `outputTokens=16, stopReason=length` 仍须对该工作区的最终请求单独取证；此 fixture 的 `max_tokens=256000` 不代表真实模型预算，更不能证明原请求被裁到 16。

### 1.2.1：DSH 0.2.2-rc.2 兼容迁移

- 明确锁定并验证 **DSH 0.2.2-rc.2**；所有 DSH peer/dev 依赖及锁文件同步到 rc.2，不用版本豁免，不放宽到未经测试的未来版本。MCP Client SDK 仍为 2.2.0。
- 完整回归 **179/179 通过**。[兼容性测试](<test/compatibility.test.js>) 直接校验实际解析到的 DSH 包版本，避免拿 rc.1 的测试结果证明 rc.2 兼容；还验证 rc.2 的 `Session.append` 数组重载能保留激活回执和累计 instructions 账本，清空不会退还预算。
- [真实请求测试](<test/progressive-request.test.js>) 按 rc.2 的真实协议更新：`addition-only` 在移除工具或向空集合加入工具时重建声明基线，已激活的重新加入工具不再保留旧 `defer_loading` 和已被基线替代的 addition 块；`in-history` 则继续保留延迟声明与 activation。分别严格断言 Schema、标记和更新块，不手工拼装请求。
- 重新运行 240 工具测量，三种路径的首轮数据仍与上表一致：只提交 1 个管理 Schema，实际 HTTP JSON 1425 字节。原有授权、OAuth、撤权、不重放、恢复、fork、累计预算与参数命令回归均通过。投影保持 stateVersion 3，配置和凭据格式不变，无需重写用户日志或凭据。
- 重新核对当前安装的 Client 命令源码和构建产物，候选方法及原生参数入口仍适用，故不改 Client 业务逻辑；该适配仍不是稳定公开 API。live Client Inspect 查询超时，未完成实际菜单的视觉验收。

迁移核对包括安装版本的 `session-append-overloads`、`runtime-context-reminders`、`plugin-update-method` 和 `window-drag-regions` 指南。本插件不替换 `Session.append`、不按文本解析 runtime-context、不读取 `BundleInfo.updatable`、不创建覆盖页头的浮层，故这些 API 无需业务改动；新增批量日志回归验证相关边界。跳过账户通知/Remote、worktree、附件/CUA、Forge、终端、搜索计费和子 Agent 默认配置指南，因为插件没有消费这些扩展面。开发已使用替代旧开发技能的 `dsh-doc`。

### 安装升级

仅通过 Plugin Manager 安装/升级本地目录或版本化 tarball，不手改活动 profile、核心文件或已安装模块。本次发布为 1.2.1；以管理器返回的保存状态、`application` 和 `nextStep` 区分“安装完成”与“当前进程已加载”。替换已导入的 Host 模块通常需要**完整退出并重开 DSH**，刷新网页或 `/codex-mcp reload` 不能清除 Node 模块缓存。旧会话历史不会因重启自动变小，请在新会话中验收首轮。

图标为本插件原创 SVG；中英文插件标题/说明由 [中文资源](<locale/zh.json>) 和 [英文资源](<locale/en.json>) 提供。
