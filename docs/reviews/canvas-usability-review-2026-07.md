[English](./canvas-usability-review-2026-07.en.md) · **简体中文** · [繁體中文](./canvas-usability-review-2026-07.zh-TW.md)

# 画布协同可用性审视

## 结论与范围

画布已经具有工程编辑、节点配置、真实引擎执行、人工审批、日志、模板、自定义卡片和 AI 工具入口。但当前实现更适合有人观察的简单串行试跑；条件分支、审查返工、多 worktree 代码集成和多窗口共同编辑，尚不足以作为稳定自动协作流水线依赖。

本次以源码审查、临时隔离存储复现及相关单测为依据。未调用付费模型、未操作用户已有画布、未进行浏览器或真机端到端测试。另一并行任务正在修改删除生命周期；该项不重复修复或计入下列新增缺陷。行号以审查时工作区为准，并行改动可能使其移动。

## 已有能力与实际边界

| 能力           | 已实现                                                         | 实际边界                                                  |
| -------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| 工程管理与搭图 | 列表、新建、重命名、保存、模板、卡片、连线、导入导出、撤销重做 | 保存确认、切图保护与多窗口版本冲突未闭环                  |
| 引擎执行       | Pi/DSH/Claude/Durable 的节点接入、模型选择与强度配置           | 引擎或模型可能自动回落；实际执行配置应明显展示            |
| 运行控制       | 单节点/全图运行、停止、插话、人工批准/驳回协议                 | 图状态与节点状态同步不足；返工和汇聚语义有缺陷            |
| 代码隔离       | Git worktree 创建与节点独立 cwd                                | 缺少集成工作区和产物合入；路径命名未包含 graph/run        |
| 输出与证据     | 工具日志、节点对话、交接摘要、时间线                           | LLM 交接仅保留正文末尾 300 字符；运行轮次与产物版本未建模 |
| AI 建图        | DAG 提示、解析、确认与 canvas 工具编辑                         | 工具路径可编辑图；界面的“智能”入口请求与结果通道断开      |
| 逻辑与数据节点 | 条件、人工、转换、汇聚等角色                                   | cron/webhook/memory/loop 等部分角色只是配置说明透传       |

## 优先修复的问题

### P1：保存与协同编辑会丢失工作

1. **保存未使用服务端的版本保护，发送即显示成功。** `web/src/components/canvas/CanvasStudio.tsx:757` 不传 `baseRev/requestId`，忽略发送结果并立即清除脏标记。服务端 `server/canvas/canvas-dispatch.ts:57`、`canvas-store.ts:215` 已有 revision 冲突能力。两个标签页、AI 与用户同时编辑时，旧拓扑可能覆盖新拓扑；断线也可能显示已保存。
2. **切换工程丢弃未保存编辑。** `CanvasStudio.tsx:1021` 清脏标记后加载另一图，自动保存前的修改没有暂存或保存确认。
3. **其他工程的广播会切走当前工程。** `CanvasStudio.tsx:196` 接收任意 `canvas_graph_state`；未保存保护仅针对同 ID。`server/index.ts:2175` 全连接广播 AI 改图，因此编辑 A 时 B 的更新可替换 A。
4. **编辑态与运行态混在一个 graph 对象。** `CanvasStudio.tsx:218/288` 的节点事件会触发整图脏检测与自动保存；节点事件不同时更新图级 status，运行/停止按钮可能显示错误。运行状态变化不应产生用户编辑版本。

### P1：流程执行与交付存在语义断点

5. **条件分支无法可靠汇聚、结束。** `server/canvas/canvas-orchestrator.ts` 的 `handleDownstreamEdges` 按所有入边源节点是否 done 决定启动；未选分支没有 skipped 状态。全图完成也要求所有节点 done。已复现：true 分支完成、false 分支 idle 时，join 未启动，图仍 running。
6. **返工边未绑定审查决策。** 正常完成会遍历 reject/review/loop_back 并递增重试、派发；`reviewNode(reject)` 只改成 waiting_approval，不派发返工。已分别复现“普通完成触发 reject”和“人工驳回不启动返工”。反向边还参与正向入度和汇聚计算，环图启动策略缺少明确入口。
7. **代码隔离缺少集成闭环。** `resolveNodeCwd` 使用 `.worktrees/canvas-${node.id}` 和 `canvas/${node.id}`，没有 graph/run 命名空间；启用 worktree 后返回仓库根而非原来的 web/server 子目录。默认模板 FE/BE 使用 worktree，QA 在主树，调度器没有汇总两者改动再验证的步骤。worktree 创建失败还会静默回落原目录。应明确产物提交、基线、冲突处理、集成测试目录和最终采纳流程。
8. **节点交接丢失大部分正文。** `executeRealEngineNode` 返回 `replyText.slice(-300)` 加 diff stat。架构契约、接口、文件清单和验证证据可能被截掉，仅传末段套话。交接还依赖边上的 lastHandoffSummary，但 `saveCanvasRuntimeState` 只持久化节点字段与图 status，不保存边摘要和循环次数；刷新/重启后的证据与重试预算不完整。

### P1/P2：界面承诺与真实能力不一致

9. **“智能”建图未接通结果。** `App.tsx:2826` 未给 CanvasStudio 传 lastMessage；`CanvasStudio.tsx:493` 通过独立 WS 发 prompt，DAG 解析却仅依赖 propLastMessage，独立通道没有对应 snapshot 解析。pending 缺少超时/取消。应绑定明确会话和 requestId，返回结构化建图提案。
10. **部分角色只有外形没有执行器。** `canvas-orchestrator.ts` 的 CANVAS_PASSTHROUGH_ROLES 含 cron/webhook/memory/loop。它们运行时生成配置摘要然后完成；不能据此认定具备定时注册、Webhook 接入、持久记忆或可控循环。应逐项补执行器与验收，或显式标注为说明节点。
11. **AI DAG schema 无法表达已有分支能力。** `web/src/components/canvas/canvas-dag.ts:12/88/126` 的边只有 from/to，转换后全为 handoff，缺少 condition_true/false、approve/reject 与节点 config；生成的条件图可能两边都执行。

## 交互与恢复问题

| 优先级 | 问题与影响                                                                      | 证据                                                                       |
| ------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| P1     | 窄屏工具栏缺少折叠/滚动，内部 absolute 菜单可能被裁切；模板菜单缺少高度上限     | styles.css:27669/27680/27779；CanvasToolbar.tsx:389；需浏览器验证尺寸      |
| P2     | 50%/200% 缩放拖动不跟手，屏幕增量未除 zoom                                      | CanvasNodeCard.tsx:313                                                     |
| P2     | 触屏拖线依赖目标端 pointerup，可能被起点隐式捕获；缺少命中测试与取消清理        | CanvasNodeCard.tsx:288；CanvasStudio.tsx:394；需真机验证                   |
| P2     | 画布隐藏仍响应全局 Ctrl+Z/Ctrl+D/Ctrl+S/Delete                                  | CanvasStudio.tsx:938；App.tsx:2824                                         |
| P2     | 日志缓存仅按 nodeId，模板复用节点 ID 时跨图串日志；时间线不主动加载历史         | CanvasStudio.tsx:81/244/922；CanvasTimeline.tsx:19                         |
| P2     | JSON 导入只校验数组与悬空边，缺少节点必填字段、类型、唯一性验证，可导致渲染错误 | CanvasStudio.tsx:657；CanvasNodeCard.tsx:94                                |
| P2     | 小地图按 %800 近似映射且点击只选中；定位不移动视口，布局不按真实卡片高度        | CanvasStudio.tsx:823/1221/1240；canvas-p0.ts:6                             |
| P2     | 多处文案未接应用 i18n；保存/断线/导入失败缺少统一可见反馈                       | CanvasToolbar.tsx、CanvasAiBar.tsx、CanvasNodeDrawer.tsx、canvas-client.ts |

## 根本优化方向

### 第一阶段：建立可信的编辑与运行边界

- GraphDefinition 单独保存拓扑、配置和位置，revision 乐观并发；RunState 保存 runId、图版本、节点 attempt、状态和执行配置。
- 保存以服务端成功回执为准；失败保留草稿。切图先保存成功或存本地草稿。加载响应带 requestId；后台广播不得隐式切图。
- 运行时固定一份图版本；编辑生成下一版本，不能让旧执行对象覆盖新配置。
- 打通智能建图的会话和请求归属、超时、取消、错误与确认。

验收：两标签页竞争保存有明确冲突；离线保存不显示成功；A/B 工程更新互不切换；运行状态更新不触发编辑保存；一次智能生成可完成确认落图。

### 第二阶段：重建可收敛的调度语义

- 状态至少区分 pending/running/succeeded/failed/skipped/cancelled/waiting_review，并让每个状态有明确可执行动作。
- 边按本轮令牌/决策激活；汇聚区分“所有激活前驱”与“任一前驱”。未选路径显式 skipped。
- 回路以 attempt/iteration 建模；批准走主线，驳回带意见返回指定节点；定义次数、超时、成本上限与人工接管。
- graph 状态由调度器根据所有本轮任务推导，不由 UI 推测；出现 error 或无可运行节点时明确失败/阻塞原因。
- 服务重启将遗留 running 标为 interrupted，明确支持续跑、重跑或人工确认，不能仅恢复一个运行标签。

验收：条件菱形图可结束；驳回后返工再审批可结束；非选分支不阻塞；停止后不派发后继；重跑不复用旧输出与重试次数。

### 第三阶段：把协作从文字交接升级为产物交接

- 产物 envelope 含摘要、完整正文引用、文件/commit/patch、测试结果、基线与来源 attempt；摘要供阅读，执行按引用取证据。
- worktree 用 graphId/runId/nodeId 命名并保留子目录；失败明确报错或由用户选择共享目录模式。
- 专设集成工作区：收集并合入节点产物，解决冲突，QA 对同一集成产物执行检查；最终呈现待采纳 diff。
- 运行前预检引擎、模型、目录、Git 基线、必填配置和节点执行能力；展示真实使用的回落配置。
- 调度并发有队列和预算；同目录写任务需文件认领或互斥；重试必须保留历史 attempt。

验收：两个隔离节点的修改进入同一测试产物；可追溯每个文件来源；模型回落可见；重试和恢复不会混用别轮产物。

### 第四阶段：降低使用门槛

先提供少而可靠的串行实现、开发—测试—人工验收、隔离开发—集成三个模板；每个模板有零 token 契约测试与可选真引擎端到端检查。再补响应式工具栏、Portal 菜单、拖拽缩放、触控连线、真实小地图和键盘焦点边界。能力未完成的节点应明确标识，避免依靠名称形成自动化预期。

## 本次验证

临时脚本使用 mkdtemp 独立目录和调度入口替身，不启动模型、不创建 worktree。输出：

```json
{"probe":"branch_join","scheduled":[],"joinStatus":"idle","graphStatus":"running"}
{"probe":"unconditional_reject_edge","scheduled":["coder"],"loopCount":1}
{"probe":"human_reject","scheduled":[],"nodeStatus":"waiting_approval"}
```

运行 canvas-orchestrator、canvas-history、canvas-cards、canvas-picker-isolation、canvas-pstack-skills 五组 Vitest：50 项中 49 通过，1 项失败。失败为审查回路测试 expected 2 / actual 1，与并行生命周期修复新增运行图身份检查有关；已交接修复方核对夹具，不能将当前工作区称作全绿。测试通过也不代表浏览器操作、触屏和真实多模型流水线已经验证。

本报告仅新增审查文档，未修改业务实现。
