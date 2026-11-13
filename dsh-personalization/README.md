# DSH 个性化 / Personalization

在 **设置 → 个性化** 配置统一的 personal instructions，适用于当前 DSH profile 中所有工作区的新会话、已有会话和常规子代理。

## 使用

1. 在设置中打开「个性化」。
2. 输入偏好的语言、回答风格、编码规范等，点击「保存更改」。
3. 保存后从下一次新模型步骤的提示词组装起生效；不会修改已经发出的请求或唤醒空闲会话。
4. 开关可暂停使用而不删除内容；清空正文后保存可移除注入。

默认启用但正文为空，不会自动替用户设置任何偏好。正文最多 20,000 个 UTF-16 字符，换行、Markdown 和 `{{模板括号}}` 均按字面保留。关闭设置或切换分类时，尚未保存的草稿会保留到当前页面刷新或插件卸载。

## 原理与边界

- Host 插件注册独立的全局 `systemPrompt.section`，每次组装读取最新的 volatile Config 引用；不重写原系统提示词、不修改 AGENTS.md、不追加自定义会话事件。
- `enabled` 和 `instructions` 通过 DSH 原生 Settings / config-editor 持久保存到当前 profile 的配置补丁。这里的 `.volatile()` 表示热更新，并非临时存储。插件本身不直接读写 profile 文件。
- 旧会话无需重建。系统提示词的变化由 DSH 自己记录，支持正常恢复、分支与回放。
- **只影响当前 profile**，不是账号级的跨 profile 配置。已发出的请求和同一步骤已冻结的重试不会变化。
- 声明了 `complete: true`、完整替换系统提示词的特殊预设会排除普通 section，因此不适用；普通预设可正常叠加项目指令。
- 指令属于用户默认偏好，不会授予工具权限、绕过审批，或覆盖更高优先级规则及当前任务的明确要求。
- 指令会发送给模型，请勿存放密码、密钥或其他秘密。

## Agent 工具

`global_instructions`：

- `{"action":"get"}`：读取当前启用状态、完整正文与 revision。
- `{"action":"update","instructions":"默认使用简体中文","expectedRevision":0}`：替换正文；省略字段保持原值。`enabled:false` 暂停，`instructions:""` 清空。

只在用户要求修改默认偏好时更新。更新经过 DSH approval 服务，只有 `allowed-once` 才会调用与设置界面相同的 `settings.update`；无审批服务、拒绝或取消均不写入。审批展示修改内容及跨会话的持久影响。

页面将开关和正文一次性保存，并使用草稿读取时的 revision；工具也固定审批前的 revision。并发修改会拒绝旧写入，不会静默覆盖；页面保留草稿并提示载入最新值。

## 开发与安装

```sh
node --test test/*.test.js
node --check index.js
node --check core.js
node --check client.js
```

本地目录链接安装时，先在本目录执行 `pnpm install --ignore-scripts` 安装依赖，再通过 DSH 的 `plugin_manager install_bundle` 安装本目录；链接安装不会替源目录安装依赖。无安装脚本；唯一依赖为与 DSH 同系列的 `@deepseek-ai/schemastery`。无需修改 DSH 安装目录或启动新 Web 服务。配置编辑本身不依赖 Client 源码 watcher。

图标为本插件原创 SVG，英文和中文元信息位于 `locale/`。卸载插件只移除本插件的 section 和工具，不更改其他插件或项目文件。

## 本次验证（2026-11-04）

- 已在当前 profile 安装并激活，最终 `application: applied`，无警告；实时 `settings.section` 中存在 `local-personalization`。
- 22 项自动化测试通过：真实 Config、字面模板括号、长度边界、禁用/清空、审批拒绝零写入、审批期间并发修改保护、资源和 UI 接口契约等。
- 经实际 `global_instructions` 工具批准写入 160 字符临时标记；4 个现有 Agent scope 均可读取同一 section，当前会话的实际模型提示词包含标记。
- 插件停用再启用后标记仍保留，验证了通过 Settings 保存的配置能跨插件实例重新载入。没有为测试重启整个 DSH 进程。
- 已经通过工具清空测试标记，最终 `enabled:true / instructions:"" / revision:4`；最新的模型提示词确认不再含个性化 section。支持 in-history 更新的模型会保留旧 epoch 的历史提示词，检查的是最新生效节点。
- DSH tokenMeter 对当前 scope 的首步提示词及工具 JSON 估算：插件为空时从 11,541 增至 11,753，增加 212 tokens（主要为工具描述）；160 字符测试正文启用时增加 326 tokens。这是估算，不是供应商计费数据。
- 已检查安装链接中的中英文元信息和原创 SVG 的 XML、尺寸、资源导出。没有可用的浏览器视觉控制，因此尚未验证设置页及图标的实际渲染、浅色/深色视觉效果与 UI 点击流程；未生成替代预览页。

`node test/live-readonly.mjs` 可通过已经运行的本地 DSH Host Inspector 重新执行只读检查；该脚本不启动浏览器、不修改配置、不发送模型请求。
