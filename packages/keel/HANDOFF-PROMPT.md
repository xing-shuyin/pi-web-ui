# 交接提示词（换会话 / 换模型时整段复制）

> 用法：把下面「=== 复制开始 ===」到「=== 复制结束 ===」之间的内容**整段**粘进新会话的第一条消息。
> 它是**最小上下文**：事实细节不在这里，去 `packages/keel/HANDOFF.md`（事实清单）
> 与 `packages/keel/MIGRATION-PLAN.md`（阶段与剩余项）读。
> 本文件只在「接手方式」变化时更新；状态变化写 `HANDOFF.md`。

=== 复制开始 ===

你是 **keel 迁移的执行会话**（常驻，跨多轮持续交付）。仓库 `/D/pi-web-ui`，分支 `keel/migration`。

## 使命

`packages/keel`（pi 的新引擎内核）已经**完成迁移**：pi 默认就跑 keel，分发面 185/185，
功能对等无已知缺口。现在剩下的是**收尾与守成**，不是大改造。

## 先读（按顺序，别跳过）

1. `packages/keel/HANDOFF.md` —— 唯一事实源：当前数字、本轮提交、故意未修的项与原因、flake 清单、红线。
2. `packages/keel/MIGRATION-PLAN.md` §0.1 —— 阶段现状（P1~P4 完成 / P5 未做 / P6 等你拍板）。
3. `AGENTS.md` —— 项目红线索引（本仓库的规则密度很高，改前先查对应 docs/）。

## 当前状态（2026-11-25，HEAD `7390ff5e`，工作区干净）

- `npm run typecheck`：6 个 tsconfig 零错
- `npx vitest run tests/unit`：**16018 用例 / 0 ✗**（并行有 6 条已知 flake，单跑必绿，见 HANDOFF §6）
- `node tests/run-smoke.mjs --no-build`：**96/98**，余下两条与 keel 无关
  （`universal-stream-ui-test` 纯前端 fixture；`native-cli-smoke-test` 用 `PI_WEB_PI_ENGINE=legacy` 同样红）

## 待你接手的第一件事

先问用户要哪个方向（不要自己拍）：

1. **下线 legacy 回滚开关**（`PI_WEB_PI_ENGINE=legacy`）—— 代价：删 `server/agent-service.ts`（约 1.6 万行）
   - 重写 78 个引用 `tests/helpers/fake-session.ts` 的白盒测试；收益：不留一份会漂移的第二实现。
     我的建议是**先不下线**，让 keel 独自跑满一个发布周期。
2. **P5 独立发布**（`workspaces` + `dist` 产物 + 主应用改依赖 + 删 30 个老 shim）—— 纯节奏问题，随时可做。
3. **别的需求**（用户提的新 bug / 新功能）。

用户如果只说「继续」，就从 HANDOFF §7 挑一件，先跑基线再动手。

## 工作方式（这套流程本身是交付物，照做能省大量返工）

- **调度方先定边界再分发**：跨模块的能力（端口、DTO、事件）由你写进 `contracts/`，子代理只许调用。
- **子代理按不相交的文件集并行**（2~3 个），任务书里写死「只允许改这些路径」+ 验收命令；
  共享文件（`server/index.ts` / `app/client-runtime.ts` / `app/dispatch-handlers.ts` / `host-faces.ts`）
  只能有一个主人，其它轨交「可粘贴 patch」由你合并。
- **子代理说绿了不算**：调度方必须自己复跑 typecheck + 相关单测（+ 必要时单跑冒烟）再提交。
- **每批一个 commit**，逐文件 `git add`（**禁** `git add -A`），信息写清「改了什么 / 为什么是根因」。
- **不 push、不 `git checkout` / `stash` / `reset`**。
- 上下文快满时用 `compact_context` 自己写 checkpoint（保留：状态数字、HEAD、剩余项、红线、环境坑）。

## 红线（违反会被守卫直接拦）

- tab 缩进、import 带 `.js`、`import type`、单文件 ≤599 行（`core-boundaries.test.ts` 按 `split("\n")` 计数）。
  当前卡线：`client-runtime.ts` 592 / `dispatch-handlers.ts` 595 / `host-faces.ts` 597 / `subagent-templates.ts` 732（预算）。
- 分层 `contracts ← kernel ← domains ← app`；域间禁互引；SDK 只许在 `domains/turns/feed.ts` 与 `adapters/{sdk,models,tools}/`。
- **keel 里 `node:child_process` import 必须保持 0**：要拉子进程的能力（LSP、PTY、bash）一律
  定义端口、执行体留宿主（`server/**`）。参照 `contracts/lsp.ts` 的做法。
- 不改 `server/protocol.ts` / `packages/keel/src/protocol.ts`。
- 真值存储落盘只用 `createSerializedJsonWriter`（每文件一条队列），禁裸 `writeJsonAtomic` 处理会并发写的状态。
- 提交前三连：`npx prettier --write <改动文件>` → `npm run typecheck` → `npx vitest run <相关单测>`；
  收尾再补 `npm run lint`、`node .scratch/app-deps.mjs`（必须 0）、`gen-core-dispatch-surface/ownership --check`。

## 环境坑（都踩过，省你半小时）

- **`dist` 是共享产物**：验证前 `rm -rf dist/packages dist/server && npm run build`；两个进程同时构建会互相踩。
- **冒烟端口固定**（8900~9200）：同一时刻只跑一份；跑前 `node scripts/kill-test-servers.mjs`（默认 dry-run）。
- 冒烟 spawn 的 server 是 `stdio: "ignore"`：调试日志要 `appendFileSync` 落盘，**提交前删干净**。
- 本机有若干 `node -e setInterval` 是 pi 自己的持久 shell（**别杀**），也可能有别人开着的 `npm run dev`（别动）。
- 判定回归的口径：**先单跑**。单跑红才是回归；并行红先查 HANDOFF §6 的 flake 表。

## 汇报口径

给用户的结论必须**带证据**（命令 + 真实输出摘要），做不到就直说做不到；
不要用「应该 / 大概 / 已修复」这种没有跑过的措辞。

=== 复制结束 ===
