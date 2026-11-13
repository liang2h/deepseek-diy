# DSH 侧边聊天

版本 **2.2.0**。侧聊是私有问答记录，不再创建普通 DSH Session，也不使用 `sessionController.fork`。不会出现在左侧会话列表，右侧只显示侧聊自己的问答。

## 使用

- 从右侧栏开始页、斜杠菜单中的 `/side-chat`，或主会话正文选区中的“在侧边聊天中提问”打开。会话顶部不再显示侧聊按钮；选区“添加到对话”的草稿插入功能保留。
- 打开后继承主会话当前已提交的模型上下文和模型设置，但消息区保持空白；选区只加入侧聊草稿，不自动发送。
- 在独立输入框提问：Enter 发送，Shift+Enter 换行，支持中文输入法、流式回复、停止、失败重试。
- `+` 新建另一条侧聊。来源链接返回关联主会话。左侧栏底部不增加入口。

## 2.2.0 Markdown 渲染修复

- 用 Marked 的 GFM 解析替换精简正则渲染，支持表格（表头、列对齐、单元格内格式）、标题、有序/无序/嵌套列表、任务列表、引用、粗体/斜体/删除线、代码块及 HTTP(S)/邮件链接。
- 宽表格在侧聊正文内横向滚动，不挤压面板；支持键盘聚焦滚动区域，沿用浅深色主题 token。
- 保持流式显示：不完整的表格和代码围栏在后续文字到达时重新解析。已经保存的回复重新显示时也使用新渲染器，不改写消息记录或模型上下文。
- 只将解析得到的安全元素树交给 React，不注入 HTML；原始 HTML 按文字显示，危险协议链接不生成可点击元素，图片只显示替代文字、不自动联网加载。
- `client.js` 与 `markdown.js` 是源码；`node build-client.mjs` 生成自包含的 `client.bundle.js`，`./client` 导出指向该产物。Marked 和 esbuild 是锁定版本的开发依赖，运行时不需要额外安装解析器，也不使用 CDN。第三方许可保留在 `THIRD_PARTY_NOTICES.md`。

## 模型上下文与显示记录分离

Host 从 `session.deriveMessages()` 捕获原生有效模型消息，包括主会话当前压缩后的上下文、原生角色、内容块、附件引用和已有 replay 元数据；不扫描会话 DOM，不把聊天正文重新拼成一个字符串提示词。

模型使用来源当前 pending model selection，或最新 request header 的 provider/model、推理档位和请求控制。随后仅把侧聊的新问答追加到这份上下文快照。来源尚未返回的工具调用仅在独立请求中补齐“结果尚不可用”的 tool result，不重试该工具，也不改写主会话。

展示层只读取 Host 返回的 `messages`（侧聊用户/助手消息），**不会返回或渲染背景模型上下文**。不复制源 Session 的 goal、待执行队列、todo、命令日志或历史时间线。

上下文是打开时的快照，不在之后双向同步。本版是 **问答模式**：请求 `tools: []`，不运行 Agent 循环、不执行文件/命令工具、不修改主会话，也不自动续跑 goal。来源工作目录和 preset 可作为背景信息继承，但这不是一个有独立权限控件的普通工作会话。

## 存储与旧版迁移

- 私有记录保存在 profile 配置的原生 JSON KV backend：unit `local_side_chat`，per-record table `chats`。模型背景和侧聊回复由 Host 保存，不放进浏览器 localStorage。
- 浏览器继续使用原键 `dsh.local-side-chat.v1.<source>.<tab>`。新 v3 记录只包含 `sideChatId`、来源 ID、草稿和待插入引用；兼容旧 v1/v2 标签关联。
- 旧版由本插件创建的普通会话会先提取并保存其真正的侧聊消息，再通过原生 Workspace API **归档**，不删除原日志。过滤掉继承的主线历史和 fork 合成关闭事件。
- 迁移必须在来源日志里找到 `/side-chat` 或 `create_side_chat` 的真实成功回执证明；不会仅凭同名、同父关系或传入的 ID 归档其他会话。旧侧聊仍在运行时拒绝迁移，不强行停止。
- 创建新侧聊时会清理当前来源中已证明的旧版侧聊；旧标签在恢复时按 ID 幂等迁移。迁移写入成功后才更新浏览器关联。
- 刷新恢复侧聊自己的消息；异常重启中的请求标记为中断，可重试。发送 requestId 防止重复回答；同 ID 不允许换文字。停止只取消该条私有推理请求。

## 同一业务操作，两类调用

UI 通过 agent-scope `localSideChat.perform` 与 `localSideChat.send`（原生 Typert Remote 流）调用 `SideChatService`，不在主线追加每条聊天的 command/run 或模型消息。

Agent 工具 `side_chat` 提供 `create/get/send/stop/migrate`，与 UI 调用同一服务。工具读取默认最近 12 条侧聊消息，可以按 offset/limit 继续读取；不能读取其他主会话的侧聊背景。

斜杠命令 `/side-chat` 由客户端贡献注册，而不是 Host 命令目录，因为原生菜单只按第一方 `definitionId` 提供本地化标题；同名 Host 命令还会触发贡献冲突。贡献提供与原生指令一致的「本地化标题 + 命令名 + 本地化说明」行，打开当前会话的侧聊标签页。

## 2.0.5 客户端修复

修复页面报错 `cannot get property "remote.localSideChat" without inject`。`sessions.scope(id)` 借用的是原生 Session Context，不继承插件的 namespace 依赖声明；不能直接读取 `scope.remote.localSideChat`。现改用公开的可选服务查找 `scope.get('remote.localSideChat')`，并显式处理未就绪状态。该 API 保留调用方 Context，原来的 scoped 参数签名和来源身份都不变。

没有把 namespace 加到 `$mount` 前的静态 inject 列表，避免依赖等待自己创建的服务。本次不改变 Host 侧聊、模型背景、存储或旧版迁移逻辑。

## 验证

- `node build-client.mjs`；`node --check index.js`、`node --check client.js`、`node --check client.bundle.js`。
- `node --test test/*.test.js`：**33 项通过**，含截图表格回归、对齐/转义管道符、嵌套格式、围栏代码、链接/HTML 安全、逐字符流式前缀、CRLF、滚动容器及产物完整性；另覆盖覆盖上下文/消息可见性隔离、无 Native Session、请求幂等、错误/重试/停止、模型配置、持久化、迁移授权、归档保护、Remote/工具/命令一致性、显式 Remote mount、裸 stream frame，以及真实客户端 transport closure 在禁止 property 访问时仍能查找 namespace、处理缺失服务和更新 generation。
- `node test/client-context-integration.mjs`：在已运行 Host 中创建并销毁隔离的**真实 Cordis Context**，精确复现截图的旧错误；验证完整 key 的 `scope.get` 成功、普通方法和 native 同型 getter 闭包保留同一 caller Context/fiber，namespace 卸载后返回 undefined。没有 DOM、React、模拟页面或用户 Session 写入。
- 真实原生 Gateway 验证通过：scoped create/get、私有流取消、有效模型消息前缀一致、原生 Session 目录不变、来源历史与配置不变。当前来源的 **9 个**已证明旧侧聊均已迁移归档，主会话未归档。
- 真实 `openai / gpt-6.1-sol / xhigh` 推理与 Remote 流已返回正确答案：“侧聊不应显示在左侧会话列表中，只继承主会话的模型上下文，不展示或回放主会话的完整对话历史。”没有执行工具或向主线追加模型问答。
- 模型工具 schema 实测 913 字符、原生 tokenMeter 估算 229 tokens（不是计费值；1.1.0 的单一创建工具为 352/88）。增加的是可发现的 create/get/send/stop/migrate 与分页参数；默认只回传最近 12 条侧聊消息。
- `test/cdp.mjs` 只连接已存在的 DSH Inspector。`node test/native-integration.mjs <live-source-session-id>` 测试真实 Gateway，附加 `--send` 会发生一次真实模型推理；测试只清理自己生成的私有 KV 记录，不创建或取消主 Session。测试目录不在分发 files 中。
- 2.1.1 已移除标题栏入口，选区草稿绑定改为不可见的输入框 slot 贡献。未连接浏览器调试器，因此没有宣称已完成页面点击、选区操作、截图、图标及浅深色视觉验收。

## 安装与资源

通过 `plugin_manager` 安装此目录，已安装的链接包按管理器要求先移除再安装。安装前必须运行 `node build-client.mjs`；仅修改源码不会更新已分发的产物。没有外部运行时依赖、安装脚本或替代 Web 服务；开发依赖锁定在 `pnpm-lock.yaml`，依赖安装使用 `--ignore-scripts`。保留原创 SVG、中英文 metadata 和原生主题 token。插件源码与图标采用 MIT 许可，Marked 许可见 `THIRD_PARTY_NOTICES.md`。
