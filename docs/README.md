# docs/ 文档总索引

> 本仓库文档的**唯一入口**。`AGENTS.md` 只放「关键功能 → 事实源文件 → 文档」的映射，本文件放「每份文档讲什么、多重、什么时候该读」。
> 新增 / 删除 / 改名文档必须同步本索引（守卫：`tests/unit/docs-index.test.ts`）。

## 权重含义

| 标记 | 含义                                                 | 阅读方式               |
| ---- | ---------------------------------------------------- | ---------------------- |
| ★★★  | 动核心代码前必读：全局架构决策、跨模块红线、代码地图 | 通读                   |
| ★★   | 碰对应模块前必读：该模块的实现边界、状态机、常见坑   | 通读该篇               |
| ★    | 运维 / 部署 / 配置接入：改环境、上线、连供应商时查   | 按需查表               |
| ○    | 参考材料：设计稿、历史审查、审查证据、示例预设       | 不必通读，按追溯需要读 |

红线细则（颜色令牌、`details` 上限、提示词三处分离、压缩软上限、过户事务性等）**统一在 [`agent-rules.md`](agent-rules.md)**，其它文档不再复述禁令。

## 一、全局必读（★★★）

| 文档                                                 | 主题                                                                                                                              | 何时读                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| [`architecture-core.md`](architecture-core.md)       | 核心架构：快照驱动、协议单源、安全边界、主题与 CSS 分层、中央列几何、多对话并发、审批、问卷、异步归属与持久化、命令/搜索/恢复状态 | 任何跨端、运行态、审批、并发改动   |
| [`architecture-plugins.md`](architecture-plugins.md) | 插件体系：manifest、34 个 UI 插槽与四层合并、宿主 API、MCP 项目运行态、多根工作区、定时任务、市场与更新                           | 插件、UI 扩展点、MCP、工作区改动   |
| [`agent-rules.md`](agent-rules.md)                   | 编码红线细则：协议与数据安全、工具提示词三处分离、UI 样式与对比度、运行态铁律、边界指针表                                         | 提交前自查；改样式/提示词/运行态前 |
| [`development.md`](development.md)                   | 开发工作流：常用命令、CI 矩阵、编码约定、AGENTS.md 索引约定、斜杠命令目录、测试规范                                               | 每天；动测试或无把握的写法时       |
| [`directory-reference.md`](directory-reference.md)   | 目录树参考：每个文件干什么（★ 标单源/入口）                                                                                       | 找文件、判断该改哪一层             |

## 二、模块专题（★★）

| 文档                                                             | 主题                                                                                                | 何时读                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------ |
| [`architecture-terminal.md`](architecture-terminal.md)           | 终端 PTY、SCM 只读走 execFile、`ownerKind` 归属、bash 接管分流、SDK process patch hook              | 动终端、bash 路由、Git 面板          |
| [`architecture-attachments.md`](architecture-attachments.md)     | 附件 / 图片 / 视觉桥、预览嗅探与 GBK 回退、512KB 上限、媒体 Range、上传下载安全                     | 动附件、预览、文件保存               |
| [`architecture-system-prompt.md`](architecture-system-prompt.md) | 系统提示词组装链路：`compose` 模板、`{{tools}}` 目录、override 钩子、项目上下文文件                 | 动提示词、工具描述、上下文注入       |
| [`tool-context-budget.md`](tool-context-budget.md)               | 工具上下文预算：文案精简、逐工具覆盖、延迟加载、前缀缓存硬约束、只读去重、证据外置、压缩指令        | 工具多到吃预算、延迟加载、上下文优化 |
| [`architecture-canvas.md`](architecture-canvas.md)               | 画布协同：`@画布` 引用、revision 保存、定时触发、每轮执行与返工、Git 隔离产物                       | 动画布、图形工作流、产物回写         |
| [`architecture-sandbox.md`](architecture-sandbox.md)             | 沙盒工作区：身份与准入、基线写回三方比较、生命周期冻结、验证重点                                    | 动沙盒、写回、执行边界               |
| [`root-cause-boundaries.md`](root-cause-boundaries.md)           | 根因整改边界：稳定归属、取消代次、持久提交与安全清理、工作树清理、HTTP 传输                         | 动异步/归属/清理/网络请求            |
| [`goal-conversation-design.md`](goal-conversation-design.md)     | 目标模式 2.0 设计：执行对话 + 审查者主对话、服务端轮次与熔断、证据注入                              | 动目标模式、审查循环                 |
| [`dsh-engine.md`](dsh-engine.md)                                 | DSH 双引擎：四预设 file: 克隆隔离、问卷与技能钩子挂 agent scope、底栏统计吃直播帧                   | 动 DSH 预设 / 问卷 / 统计            |
| [`preset-sharing.md`](preset-sharing.md)                         | 预设导入导出：白名单净化、dryRun、一键分享、社区目录与 gh 回落                                      | 动设置预设、分享流程                 |
| [`device-center.md`](device-center.md)                           | 设备中心：Hub 与连接器、绑定配对、群聊、单端口 `/device/<id>/` 与 CSP sandbox                       | 动设备中心服务端                     |
| [`device-collaboration.md`](device-collaboration.md)             | 群组 / Bot / 跨设备协作硬约束：任务派发、Bot registry lease、并发调度、任务恢复、交付审查、远程桌面 | 动群任务、Bot、跨设备协作、交付流    |
| [`device-desktop.md`](device-desktop.md)                         | 远程桌面：原生 JPEG over WS、平台权限、只读强制、禁用中继的本地接口                                 | 动远程桌面                           |
| [`streaming-stability.md`](streaming-stability.md)               | 流式消息稳定性：身份贯穿三层、不卸载不重置、不移动阅读位置                                          | 动消息渲染 / 流式状态                |
| [`loading-performance.md`](loading-performance.md)               | 加载优化：首屏动态导入、`DeferredMount` 语义、历史对话加载                                          | 动首屏、懒加载、大列表               |

## 三、运维与接入（★）

| 文档                                                                               | 主题                                                             | 何时读                     |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| [`env-vars.md`](env-vars.md)                                                       | 环境变量全表（端口/鉴权/数据目录/引擎/窗口/预设/SSH/远程桌面）   | 改配置、排查行为差异       |
| [`deployment.md`](deployment.md)                                                   | 部署：前台、自启（launchd/systemd/Run 键）、Docker、反代与子路径 | 上线、装机、守护进程       |
| [`device-center-deployment.md`](device-center-deployment.md)                       | 设备中心独立部署：Hub 拓扑、账号、连接器、域名与 TLS             | 部署设备中心               |
| [`release.md`](release.md)                                                         | 发布：版本号、changelog:i18n、tag 与 Action、npm publish         | 发版                       |
| [`official-providers.md`](official-providers.md)                                   | 官方供应商快速配置                                               | 接官方 API Key             |
| [`antigravity-proxy.md`](antigravity-proxy.md)                                     | Antigravity-Manager 反代接入（本机 8045）                        | 用反代接 Google/Anthropic  |
| [`magpie-proxy.md`](magpie-proxy.md)                                               | Magpie 反代接入（多供应商统一网关）                              | 用 Magpie 聚合供应商       |
| [`external-channel-capabilities.md`](external-channel-capabilities.md)             | 外部消息渠道：11 个平台命令与能力矩阵                            | 接微信/QQ/飞书/Telegram 等 |
| [`daily-ai-maintainer-workflow.md`](daily-ai-maintainer-workflow.md)               | 每日 AI 仓库维护：执行锁、分诊顺序、交付形态                     | 维护定时维护任务           |
| [`workflows/daily-ai-maintainer-setup.md`](workflows/daily-ai-maintainer-setup.md) | 上述工作流的落地配置（含 `workflows/*.canvas.json` 画布定义）    | 首次搭维护流水线           |

## 四、参考材料（○，不必通读）

| 位置                                                                                                                                                                                                 | 内容                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [`device-file-sync.md`](device-file-sync.md)                                                                                                                                                         | 分块目录导出（`prepare({recursive})`）的边界与拒绝规则 |
| [`audits/root-cause-review-2026-10-29.md`](audits/root-cause-review-2026-10-29.md)                                                                                                                   | 根因整改审查证据（对应 `root-cause-boundaries.md`）    |
| [`reviews/canvas-usability-review-2026-07.md`](reviews/canvas-usability-review-2026-07.md)                                                                                                           | 画布可用性评审记录                                     |
| [`proposals/`](proposals)                                                                                                                                                                            | 旧提案（issue #769 diff 可视化两个 HTML 方案）         |
| [`composer-height-solutions.html`](composer-height-solutions.html) · [`plugin-market-redesign.html`](plugin-market-redesign.html) · [`settings-modern-redesign.html`](settings-modern-redesign.html) | 交互/视觉设计稿（HTML，浏览器直接看）                  |
| [`presets/README.md`](presets/README.md) · [`examples/`](examples)                                                                                                                                   | 预设交换格式示例与内置预设样例                         |

## 五、按场景的阅读路线

| 我要…                        | 先读                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| 改跨端协议 / 快照 / 会话     | `architecture-core.md` → `agent-rules.md`（协议与数据安全）                                   |
| 加或改工具                   | `agent-rules.md`（工具与提示词）→ `tool-context-budget.md` → `architecture-system-prompt.md`  |
| 改样式 / 主题 / 布局         | `agent-rules.md`（UI 布局与样式）→ `architecture-core.md`（主题、CSS 分层、中央列几何）       |
| 动终端 / bash                | `architecture-terminal.md` → `agent-rules.md`（命令与恢复状态边界）                           |
| 动画布 / 图形工作流          | `architecture-canvas.md` → `root-cause-boundaries.md`                                         |
| 动群组 / 设备中心            | `device-collaboration.md` → `device-center.md` → `device-center-deployment.md`                |
| 动插件 / UI 插槽 / MCP       | `architecture-plugins.md` → `agent-rules.md`（插件版本号、`arrange.label`、peerDependencies） |
| 动目标模式 / 委派 / 计划模式 | `goal-conversation-design.md` → `agent-rules.md`（运行态铁律）                                |
| 动沙盒                       | `architecture-sandbox.md` → `root-cause-boundaries.md`                                        |
| 排查内存 / 上下文爆炸        | `tool-context-budget.md` → `loading-performance.md` → `streaming-stability.md`                |
| 部署 / 排障环境变量          | `deployment.md` → `env-vars.md`（设备中心另见 `device-center-deployment.md`）                 |

## 六、维护约定

1. **一处一件事**：细则写进对应主题文档；`AGENTS.md` 只登记入口，本索引登记主题与权重。
2. **新增文档** = 建文件 + 在本索引对应分组加一行（写明主题、权重、何时读）+ 必要时在 `AGENTS.md` 映射表补一行。
3. **红线不散落**：新增禁令写进 `agent-rules.md`，并在 `AGENTS.md` §3 补一行 + 守卫测试名。
4. 守卫：`tests/unit/docs-index.test.ts`（本索引覆盖全部 `docs/*.md`、链接与锚点存活、每行有权重标记）、`tests/unit/agents-md.test.ts`（`AGENTS.md` 体量与死链）。
