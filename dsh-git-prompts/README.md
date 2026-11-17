# Git 操作指令 / Git operation instructions

在 **设置 → Git** 分别保存提交说明（commit）与 Pull Request 标题/正文的规则。正文**不常驻系统提示词**，只在明确准备对应操作时交付给当前会话。

## 使用

1. 打开设置 → Git，填写提交提示词、PR 提示词，点击「保存更改」。默认为空；输入框示例不是已经保存的规则。每项最多 20,000 个 UTF-16 字符，Markdown、换行和 `{{模板括号}}` 均保持字面内容。
2. 告诉助手准备提交或 PR。助手应先调用 `prepare_git_operation({operation:"commit"|"pr",repo?:"绝对路径"})`，在**下一次模型步骤**读取规则并生成文案，再通过原有工具/审批流程执行。
3. 暂停开关保留已保存文字；空白提交规则或暂停状态不会阻拦 `git_workbench` 提交。关闭设置或切换分类保留本窗口草稿，但刷新页面不会保留未保存内容。

配置保存到当前 DSH profile；不是账号级或自动按仓库覆盖。保存是原子三字段更新，带 revision 并发保护。其它窗口修改时不会静默覆盖草稿。指令会发送给模型，切勿存放密钥、密码或其他秘密。

## 按需时序

- 插件不注册 `systemPrompt.section`，不替换系统提示词，不修改 Agent preset 或项目指令。
- 准备工具只读取对应规则；安装了 Git Workbench 时调用其已有只读业务服务，获取仓库摘要；commit 另读取暂存区差异。差异最多交付 32,000 字符，截断时明确提示继续检查；PR 不猜测目标分支，需另外检查实际 base/head 差异。
- 正文通过 `exec.deferContext()` 作为有来源的 user-role 指令上下文，随工具结果之后交付。只调用准备工具、只把内容放入 inbox、在同批调用或同一段 PTC 程序中继续提交，都不算模型已经读取。
- 规则启用且提交正文非空时，注册单调拒绝的 `tools.guard()`：`git_workbench(action=commit)` 必须具备**同会话、同一轮、相同请求目录、同配置 revision**的可见准备上下文，且已跨一个模型步骤、当前执行对应新生成的 assistant 调用。未准备时拒绝而不是偷偷改写命令；原有审批和沙箱继续生效。
- 准备状态由原生会话日志的 host-only `sessionProjections` 推导，不追加自定义事件。分支不继承父会话准备凭据；新一轮要求重新准备；上下文被压缩移除、配置变更或改用不同目录时需重新准备。目录按绝对路径词法标准化，路径别名/子目录可能要求再次准备，这是保守限制。
- 该检查证明「规则已出现在生成调用之前的模型可见历史」，**不证明模型主观理解规则或文案语义完全符合规则**。不进行 commitlint 等格式校验，不冻结暂存区，不承诺准备后仓库内容没有被外部修改。
- 已交付的正文会作为历史保留到正常压缩等机制处理；暂停/清空只影响以后准备与检查，不会删除旧历史。

## Agent 工具

### `prepare_git_operation`

- 参数：`operation: "commit" | "pr"`；可选 `repo` 为绝对目录，默认当前 Session 目录。
- 返回配置 revision、规则 SHA-256、上下文 message ID、交付时点、只读 Git 摘要及截断信息；正文通过附加上下文交付，避免在结果中重复。
- 不提交、不暂存、不推送、不创建 PR、不启动模型请求。不需要 Forge 或 GitHub 登录；Git Workbench 未加载时仍提供规则并提示缺少仓库观察。
- 读取 Git 失败、取消或准备期间配置变化时不发放上下文。提交时使用和准备时相同的请求目录。

### `git_prompt_settings`

- `{"action":"get"}`：明确检查偏好时读取当前开关、两项正文和 revision；普通 Git 工作使用准备工具，不先读取全部偏好。
- `{"action":"update","commitInstructions":"…","expectedRevision":0}`：替换指定字段。省略字段保留，空字符串清空；可用字段为 `enabled`、`commitInstructions`、`prInstructions`。
- 仅在用户要求更改偏好时使用 update。通过 DSH approval 获得 `allowed-once` 后调用与设置界面相同的 Settings 服务；审批前固定 revision，避免审批期间丢失并发修改。拒绝、取消、无审批服务都不会写入。

## 覆盖边界

- 自动提交检查仅覆盖走 DSH 工具管线的 `git_workbench(action=commit)`，包括通过标准 PTC 内层管线的调用；不覆盖任意自定义 executor。
- **手工 Git 工作台按钮、任意 bash/gh 命令、外部终端、Forge、PR 实际创建入口没有自动接入或强制检查。** PR 规则可由准备工具获取，但不声称自动拦截所有 PR 创建方式。
- 本插件不增加「一键生成并填入工作台」按钮，不自动执行任何 Git 写操作，不以规则加载代替用户授权。
- 同一轮、同目录、同配置版本的规则可用于后续生成的调用，不是一次性授权票据；每次写操作仍由原工具负责审批。

## 开发与安装

```sh
pnpm install --ignore-scripts
node --test test/*.test.js
node --check index.js
node --check core.js
node --check client.js
```

使用 DSH `plugin_manager install_bundle` 安装本目录；本地链接安装应先在本目录安装依赖。不要手工改写 profile 的配置文件。无安装脚本；只依赖 Schemastery 与 Zod。包包含原创透明 SVG 图标、中英文元信息和本说明；无额外详情图片，避免把静态示意当作实际界面验证。

## 验证（2026-11-17）

- 102 项自动化测试全部通过，无跳过；覆盖配置校验、审批拒绝零写入、revision 冲突、取消、字面括号、工具只读、会话/目录/轮次隔离、PTC 同批拒绝、真实接纳顺序与压缩失效。
- `test/installed-runtime.mjs` 使用已安装 DSH 0.2.2-rc.3 的真实 Tools Pipeline、Session 和 Projection Registry，在隔离 Context 中验证延迟上下文持久化、同批/同步骤拒绝、下一模型步骤允许、配置变更与压缩拒绝、系统段落不变。执行工具使用替身，真实 Git 写入和模型请求均为零。
- 实际 profile 已安装并激活；Host Config 可读、两个工具可调用，当前浏览器的 `settings.section` 与图标槽位已注册。实际准备工具读取真实 Git 只读摘要，commit/PR 正文分别通过独立上下文交付。
- 通过原生 Settings 临时保存两项验证规则，确认配置层持久值一致、正文未进入系统段落和常驻工具定义、`{{literal}}` 保持原样；测试后已恢复两项为空。已交付测试文字仍可在本会话历史中存在，不是残留有效配置。
- 真实轨迹表明延迟上下文可在下一步骤 `step/start` 后接纳；最终判定比较准备时步骤与后续 assistant 生成顺序，而不是错误地要求上下文先于 `step/start`。该顺序已有独立回归测试。
- `test/live-readonly.mjs` 仅连接已运行的本机 Host Inspector，读取配置层与会话重建历史；不执行工具或修改数据。此证据不是供应商网络请求抓包。
- 已完成独立源码级 UI/UX 审查。无浏览器视觉控制，尚未实测设置页/图标的真实渲染、明暗主题、键盘及双窗口点击保存流程；不能把槽位注册等同于视觉验收。没有执行真实提交、推送或创建 PR。

本地复核：

```sh
node --test test/*.test.js
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" test/installed-runtime.mjs
node test/live-readonly.mjs
```

后两项需使用当前安装提供的运行时/已经运行的本机 Host Inspector；缺少环境时应报告未取证，不开启替代服务或修改配置。
