# Canvas 协同：编辑版本、运行与产物

画布入口是 `web/src/components/canvas/CanvasStudio.tsx`，独立 WebSocket 在 `canvas-client.ts`。服务端协议单源为 `server/protocol.ts`；`canvas-dispatch.ts` 处理用户请求，`canvas-agent-tool.ts` 提供 AI 编辑和调试入口。两者共用存储及调度器。

## 对话调用与引用

输入框 `@` 候选包含保存的画布工程，可用 `@画布`、`@canvas`、`@工作流` 或名称检索。列表通过当前聊天连接请求，不缓存跨项目列表；选中后发送 `mode: "canvas"` 附件，`path` 保存稳定 graphId。引用不会启动工作流，也不作为工作区文件读取。

服务端验证工程存在后注入精简 `<canvas-ref>`，模型先通过 `canvas` 的 `get` 读取最新配置，再根据用户要求调用 `run_all`、`stop` 或 `get_log`。pi 会话在延迟加载开启时对捕获的目标 session/Conversation 加载现有工具，保留开关、预设和权限门控；工具不可用时显示提示，不自动放宽权限。

## 编辑与保存

`CanvasGraph.rev` 只随拓扑保存增加，运行进度不推进编辑版本。保存带 `baseRev` 与 `requestId`；服务端成功回执才确认保存。冲突返回 `canvas_error/rev_conflict` 和权威图，不能用旧图覆盖或把冲突当成功。

拓扑保存保留磁盘上的节点、边运行字段和 `graph.run`，避免旧浏览器快照抹掉进度。运行态保存仅合并相同 ID 的运行字段，不能回滚节点配置、重建已删除图。画布载入响应绑定请求；其他图的广播不得切换当前工程。草稿与日志都按 graphId 隔离。

`canvas-validation.ts` 校验节点、边、枚举、唯一性、端点、大小及正向无环；受限返工边不参与前向环判断。导入和 AI 修改也必须经过校验。工具 details 保持在 64KB 以下，大图可通过文字结果取回。

画布工具动态返回文案的 `pick()` 必须显式传入插值变量，键名与语言包 `serverStrings` 的 `{表达式}` 槽位逐字一致（如 `"card.title"`、`"nodes.length"`），避免向用户返回未替换的占位符。

## 定时触发

内置定时任务支持 `target: "canvas"` 与稳定 `graphId`，面板和 `schedule` 工具共用存储及 cron/间隔/单次规则。未指定目标的旧任务继续执行对话。保存画布任务前校验工程存在和图结构；触发时重新读取最新配置，传入任务 prompt 与 cwd 作为本轮输入和运行根，不改变节点各自的引擎或模型。

`canvas-scheduled-task.ts` 复用同一个 `CanvasOrchestrator.runAll`，等待该轮执行结果并在任务历史中保存 graphId/runId。人工审批暂停、阻塞、错误、取消、删除或运行被替换均不得报告完成；同一工程的运行与等待审批状态由调度器统一拒绝重入。画布删除后定时任务会失败，不会复活 default 工程。单次任务消费由 `SchedulerStore` 统一持久化，记录失败仍推进内存状态，防止每个 tick 重复执行。

## 每轮执行

`CanvasGraph.run` 记录运行 ID、起始图版本、开始/结束时间与范围。节点的 runId、attempt、artifact 和实际引擎/模型属于运行态；边的激活、交接及返工计数也须持久化。

调度按本轮激活边判断前驱就绪。未选分支标 skipped，避免分支汇聚等待永不执行的节点。审批批准与驳回有独立边；返工有次数边界，不能将 reject/review/loop_back 当普通完成边无条件触发。停止和删除撤销运行代次，跨 await 后必须检查取消与身份，旧执行不得清除新执行或继续派发。

服务启动调用 `markInterruptedCanvasRuns`，把磁盘遗留的 running/queued 标成 paused，并记录中断原因；磁盘运行标签不能代表真实引擎仍存在。恢复通过明确重跑完成。

cron、webhook、memory、loop 等尚无确定性执行器的角色不得伪装成功。引擎或模型不可用应明确失败；不能在界面仍显示原配置时静默替换。

## Git 隔离与产物

`canvas-workspace.ts` 提供 prepare/capture/cleanup 三个 Canvas 边界，共享的异步 Git、路径和工作树身份校验、scratch index 快照与补丁原语位于 `server/workspace-handle.ts`。设备代码任务通过独立的 `device-center/task-workspace.ts` 适配相同原语，不借用 graph/run/node 身份；协议与证据约束见 [`device-collaboration.md`](device-collaboration.md#21-版本化契约与代码任务)。Canvas 的类型、产物层语义和公开 API 继续由本适配层维护。隔离目录位于 dataDir/canvas/workspaces/graph/run/node-attempt；使用 detached worktree，保留原 cwd 子目录。不会 reset 用户分支、自动 commit 或合并主树。

隔离要求本地 Git 和干净源基线；不支持的 SSH/非 Git 隔离、脏基线、路径逃逸、创建失败均明确报错，不回落为共享目录。dataDir 必须在源仓库外。

节点产物用临时 Git index 生成树和 binary patch，覆盖 tracked、删除和非 ignored 新文件；不修改用户 index。产物层包括 SHA-256、统一 baseline 和来源，按顺序去重共同祖先。下游有上游隔离产物时，即使 useWorktree=false，也在集成 worktree 应用上游层；冲突停止并保留工作区。QA 验证的因此是组合产物。

`CanvasArtifact` 保留完整交付正文与 workspace 证据，短摘要仅用于阅读。待采纳 patch 与工作区保留供用户检查，不自动写回主分支。清理是显式且非强制的，只清理干净、未产生额外提交的隔离目录，不删除产物。

## 验证

相关单测以 `canvas-*` 命名，覆盖保存确认/冲突、断线丢 ACK 后核对恢复、运行态不覆盖拓扑、删除迟到完成、分支汇聚、审批返工与产物继承、模板与导入、交互纯算法、临时 Git 仓库产物集成。测试不得使用用户画布、真实模型或修改用户仓库。

`node tests/canvas-browser-test.mjs` 使用 `tests/lib/ensure-build.mjs` 与 Chrome 探测器，自起隔离服务验证首屏工程加载、保存 ACK 与草稿清理、Portal 菜单、零 token 条件汇聚、后台运行不切图，以及 390px 窄屏布局。截图写入 `.artifacts/canvas/`。真实引擎与真机触屏体验仍需另外验证。
