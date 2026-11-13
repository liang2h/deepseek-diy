# DeepSeek DIY 插件

独立的 DeepSeek Harness（DSH）插件集合。GitHub 公开仓库发布后，支持 **分享插件索引** 和 **分享单个安装包 URL**，不需要接收者克隆源码、自己编译，也不需要发布到 npm。

> 当前工作区尚未配置 GitHub 远端；以下 OWNER/REPO 是占位符，不是已经上线的下载地址。这里新增的是发布配置，未创建仓库、上传代码或修改本机 DSH 插件配置。

## 插件

| 插件 | 当前版本 | 使用说明 |
| --- | --- | --- |
| Codex 项目 MCP | 1.2.1 | [项目级 MCP 配置、按需工具与 OAuth](<dsh-codex-mcp/README.md>) |
| Git 工作台 | 1.0.3 | [右侧栏 Git 管理](<dsh-git-manager/README.md>) |
| 个性化 | 1.0.0 | [当前 profile 的统一个性化指令](<dsh-personalization/README.md>) |
| 侧边聊天 | 2.2.0 | [继承主会话上下文的私有问答](<dsh-side-chat/README.md>) |

Codex MCP 明确适配 **DSH 0.2.2-rc.2**；其他插件请查阅各自说明，不能据此保证任意新旧 DSH 版本兼容。

## 如何分享给其他人

### 方式一：分享索引（推荐）

发布工作流成功部署 GitHub Pages 后，分享：

```text
https://OWNER.github.io/REPO/index.json
```

接收者：

1. 在 DSH 中启用内置的 **自定义插件索引**（如果尚未启用）。
2. 打开 **插件 → 发现 → 添加索引源**；已有源时在菜单中选择 **管理索引源…**。
3. 填入上述 URL，选中索引、查看插件来源，并确认安装所需插件。以后刷新索引并检查新版本；不会自动替用户升级。

索引入口稳定，每次新发布更新其内容；每个插件的实际 Git 来源固定到完整提交 SHA，并用子目录路径定位。安装仍需联网获取 Git 仓库和声明的依赖，不是离线安装。

**注意：**DSH 0.2.2-rc.2 的索引只支持 npm / Git 来源，不支持压缩包来源；索引请求拒绝重定向，不能把通常会重定向的 GitHub Release 下载 URL 当索引 URL。

### 方式二：分享单个安装包

不启用“发现”也可以使用 Release 安装包，例如：

```text
https://github.com/OWNER/REPO/releases/download/plugins-v1.0.0/dsh-codex-mcp-1.2.1.tgz
```

接收者在 DSH 的插件安装入口粘贴该 URL，或向智能体发送：

> 请从这个 URL 安装 DSH 插件：上面的完整 .tgz 地址。安装前向我确认来源和影响。

不在 URL 后追加查询参数。安装由 DSH 原生插件管理器处理；不要直接把源码复制进 DSH 安装目录。遇到同名包或升级提示时，按管理器要求操作，不自动移除已有配置。安装后可能需要重启 DSH 或刷新页面。

每次 Release 会附带 4 个安装包、索引快照、SHA256SUMS，以及可直接转发的 SHARE.md；完整安装链接也写入 Release 正文。压缩包不包含 node_modules，运行依赖仍由 DSH 的包管理器下载。

## 作者首次配置

1. 在 GitHub 创建你选择的 **公开仓库**，将经过检查的项目提交并推送到该仓库；本地首次提交、远端地址和公开范围由你确认。可保留插件现有的 @local 包名，不必申请 npm scope；但与接收者已有同名插件可能冲突。
2. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。本流程使用默认的 github.io 项目站点地址，不自动适配自定义域名。
3. 确认仓库允许工作流写入 Releases、部署 Pages；若 github-pages 环境有限制，允许发布标签 plugins-v* 部署。组织策略可能需要管理员调整。
4. 公开前检查整个 Git 仓库和历史中没有密钥、个人配置、OAuth 令牌或日志，并确定代码许可。根目录未擅自给全部插件选择开源许可证；Git 工作台和侧边聊天已有 MIT 声明，其他插件请作者明确许可。[忽略规则](<.gitignore>) 只能防止新的误提交，不能清除历史秘密；已暴露凭据需要轮换。

工作流只使用 GitHub 自动提供的 GITHUB_TOKEN，不要求额外配置个人访问令牌。

## 开发检查与发布

准备 Node.js 24+、pnpm 11.28.5 和 Git。在仓库根目录执行：

```sh
pnpm --dir dsh-codex-mcp install --frozen-lockfile --ignore-scripts
pnpm --dir dsh-personalization install --frozen-lockfile --ignore-scripts
pnpm --dir dsh-side-chat install --frozen-lockfile --ignore-scripts
pnpm build
pnpm check
pnpm test
```

Git 工作台没有额外依赖。开发依赖安装不执行生命周期脚本；侧边聊天的构建是显式执行的。请将构建后的 [客户端产物](<dsh-side-chat/client.bundle.js>) 与源码一起提交：索引从 Git 子目录安装，不保证自动执行构建脚本。CI 会拒绝产物与源码不一致的提交。

确认代码已提交、已推送，且检查通过后发布：

```sh
git tag plugins-v1.0.0
git push origin plugins-v1.0.0
```

该标签是本插件集合的一次发布编号，独立于每个插件自身版本。后续发版需提升已变更插件自己的版本，并使用新的集合标签；不要移动旧标签或重用已发布插件版本。

[发布工作流](<.github/workflows/release.yml>) 会重新构建并测试，打包、检查运行资源、计算校验值、上传 GitHub Release，然后部署 Pages 索引并检查索引返回 200 且没有重定向。[检查工作流](<.github/workflows/check.yml>) 在分支推送和 PR 上执行验证。发布脚本要求标签指向当前提交、工作区干净，输出目录已存在时拒绝覆盖。

如果 Release 已创建但 Pages 部署或验证失败，**不代表索引已更新**：检查 Actions 日志，修复 Pages/环境权限后，重新运行失败的作业；工作流仅复用校验一致且完整的已发布资产，不覆盖旧文件。如果资产不完整，会拒绝继续，应查明原因后使用新的集合标签发布。不要移动旧标签；旧版发布作业也不能覆盖已标记为 latest 的新版索引。公开地址须等实际部署检查通过后再分享。

本机也可只生成产物（不会上传）：

```sh
pnpm release:prepare --repo OWNER/REPO --tag plugins-v1.0.0 --commit 完整40位提交SHA
```

产物位于 dist/release，索引站点位于 dist/site，均被 Git 忽略。具体参数校验、索引生成及包资源检查见 [发布逻辑](<scripts/release-lib.mjs>) 和 [发布入口](<scripts/prepare-release.mjs>)。

## 安装边界

- 插件安装会影响接收者当前 DSH profile 的其他会话；接收者应检查来源及能力，再自行确认。
- 不分发作者的项目 MCP 配置、个性化正文、凭据或会话记录；安装 Codex MCP 不会自动信任项目或发起 OAuth 登录。
- 安装只负责获取插件及声明依赖。系统 Git、MCP 服务器、账号权限和 OAuth 登录由接收者自己配置。
- 接收者如被提示批准依赖构建脚本，应先检查脚本及影响，不能为了安装而批量放开审批。
- 私有仓库、GitHub 无法访问、Pages 尚未启用以及组织访问策略，不在这套公开分享流程的保证范围内。
