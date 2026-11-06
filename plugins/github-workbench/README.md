# GitHub 工作台

在右侧「文件列表」旁的「工作台」Tab 集中处理 PR 和 Issue，与对话并排使用。复用服务所在机器的 GitHub CLI 登录，无需另填 Token。

## 使用

1. 在运行 pi-web-ui 服务的机器安装 [GitHub CLI](https://cli.github.com/)，执行 `gh auth login --hostname github.com`。
2. 在插件市场安装「GitHub 工作台」。本地开发安装：`node bin/pi-web-ui.mjs install ./plugins/github-workbench --data-dir <实际数据目录>`。安装后刷新插件列表。
3. 点击右侧「文件列表」旁的 **工作台** Tab。自动识别打开工作台时的项目仓库；不在 Git 仓库里也能使用个人待办。
4. 选择仓库待办、待我评审、分配给我、我创建的、提到我或自定义搜索。通过「全部 / PR / Issue」切换类型，点击搜索图标展开搜索条件。个人分类同样受仓库输入框限制；清空仓库可跨仓库查询。
5. 窄侧栏中点击条目进入详情，点击「返回列表」继续浏览；侧栏拉宽至 480px 后自动并排显示列表和详情。切换文件列表与工作台时保留筛选、页码、选中条目、滚动位置和评论草稿。

搜索支持 GitHub 搜索语法，例如 `is:pr draft:false`、`is:issue label:bug`、`is:closed`。默认分类已限定未关闭条目，查询历史状态请选「自定义搜索」。搜索按更新时间倒序，每页 50 条，最多浏览 GitHub 搜索允许的前 1000 条。未完整返回的搜索会提示缩小范围。

## 操作

- **查看详情**：点击条目，查看正文、标签、最近一页评论。PR 同时展示源／目标分支、草稿及合并状态、文件改动统计和待评审人。正文按纯文本显示，保留 Markdown 源文；完整 diff、CI 与代码行评审通过 GitHub 链接查看。
- **引用到对话／交给 AI 处理**：在当前对话添加简短引用附件，例如 `PR #749 · owner/repo`，附上 GitHub 链接，然后切回对话。处理要求由用户填写并发送；保留已有正文和附件，重复点击同一条目会去重。
- **发表评论**：输入支持 Markdown 的评论并点击发布，以当前 `gh` 账号发到所选条目。失败保留草稿；切换条目、切回文件列表后仍分别保留草稿。草稿仅在当前页面内存中保存，刷新页面或重载插件后清空。发布中切换 Tab 会等待原操作完成，避免重复提交。网络中断时先在 GitHub 确认是否已经发布，再重试。
- **关闭／重新打开**：修改所选 PR／Issue 的状态。已合并 PR 不提供重新打开按钮。列表会更新状态，重新搜索后按条件筛选。

## 实现约定

- 后端只有 `GET /status`、`GET /items`、`GET /detail`、`POST /comment`、`POST /state`，均挂在宿主已鉴权的 `/plugins-api/github-workbench` 下。客户端从 bundle URL 保留应用根路径。
- `gh api --hostname github.com` 通过异步子进程运行，无 shell、无交互提示；写入内容用 JSON stdin，不拼接评论到命令行。GitHub Enterprise 暂不支持。
- 仓库、编号、状态、评论、搜索长度、分页均在服务端校验。请求限时 25 秒、输出上限 4 MiB，卸载时结束子进程；详情正文和评论有长度上限并显式标注截断。
- 使用现有 `compose` 宿主桥添加 `mode: "quote"` 附件，引用仅包含类型、编号、仓库和链接；AI 可按用户要求读取最新详情。当前会话不可用时显示错误，不自行创建会话。
- 插件版本 `0.1.4`，不添加 npm 依赖。权限仅为 `ui` 和 `http`。通过 `rightpanel.tabs` 注册带 GitHub SVG 图标的工作台 Tab；客户端的 `styles.mjs` 使用宿主主题变量及容器查询，不依赖浏览器窗口宽度。

定向验证：`npx vitest run tests/unit/github-workbench.test.ts tests/unit/github-workbench-client.test.ts`。
