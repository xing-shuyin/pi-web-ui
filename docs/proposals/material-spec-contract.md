# 材料规格实施契约（Material Spec Contract）

> 状态：**已冻结**。三条实施线（目标 / 定时任务 / 画布）必须按本文执行；本文与代码冲突时以本文为准，改契约先提 PR 改本文。
> 背景与取舍见 `docs/proposals/material-spec-unified.md`。

## 1. 冻结接口（已落地，不许改形状）

```ts
// server/protocol.ts —— 只加这一个字段，不带对象/note/base64
set_goal            { materials?: string[] }
start_goal_wizard   { materials?: string[] }
SchedulerTaskInput  { materials?: string[] }
SchedulerTaskView   { materials?: string[] }
CanvasNode          { materials?: string[] }
canvas_run_node     { materials?: string[] }
canvas_run_all      { materials?: string[] }
```

```ts
// server/material.ts —— 载体唯一允许使用的 API（服务端内部实现，AI 不可见）
normalizeMaterials(raw, ctx)  → { materials: MaterialRef[]; dropped: DroppedMaterial[] }
describeMaterials(materials)  → string            // 给模型的「清单」文本，≤3 项时只出一行
planMaterialDelivery(materials, ctx) → { inline, pointers, degraded }
stageMaterials(materials, targetCwd) → { staged, failed }
MATERIAL_LIMITS.maxItems = 12
MATERIAL_STAGE_DIR = ".pi-materials"
```

## 2. 十条规则

| #       | 规则                                                                                                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1**  | 规格里只能存 `string[]`。禁 `MaterialRef[]`、禁 JSON 字符串、禁 base64 进规格。**唯一例外**：粘贴图随消息瞬态上传（`materialBlobs`），服务端 `persistMaterialBlobs()` 落盘成内容寻址路径后再进规格。 |
| **R2**  | 路径语义：相对路径按**该载体自己的 cwd** 解释；绝对路径原样；`http(s):` / `data:` / `browser:` / `remote-workspace:` 等 URI 原样保留、不做 stat。                                                    |
| **R3**  | **AI 面只有路径**。渲染给模型的材料信息只能由 `describeMaterials()` 产出；禁止在任何 tool schema / 提示词里解释"材料格式/字段"。                                                                     |
| **R4**  | 唯一 API。禁自写路径解析、禁自写"材料"文案、禁自用 `fs.stat` 判断存在性、禁绕过 `attachments.ts#buildAttachmentMessages` 解析内容。                                                                  |
| **R5**  | 投递形式（图 inline / 文件给路径 / 降级）**只由 `planMaterialDelivery()` 决定**，载体不得自己判断。                                                                                                  |
| **R6**  | 不静默。`dropped`（missing / duplicate / over-cap / invalid）与 `degraded`（no-vision / no-fs）必须至少进日志；用户可见载体必须给 notice 或状态行。                                                  |
| **R7**  | 跨环境（worktree / 沙盒 / 远程 / 不同 cwd）必须先 `stageMaterials(targetCwd)`；`failed` 项必须在清单或 notice 里明示"材料不可达"。                                                                   |
| **R8**  | 预算：≤12 项、清单 ≤1200 字。阈值只允许改 `MATERIAL_LIMITS`，不许在载体里写魔法数。                                                                                                                  |
| **R9**  | 兼容：老规格无 `materials` ≡ `[]`，读路径一律 `?? []`；不做迁移脚本、不做版本号。                                                                                                                    |
| **R10** | **不传 `materials` 时行为与今天逐字节一致**：不改文案、不改顺序、不改触发条件。                                                                                                                      |

## 3. 每条线的实施步骤（四步，缺一不可）

1. **存**：把 `materials` 落到自己的规格/存储里（`?? []`），并保证视图/回放能带出来。
2. **归**：执行前 `normalizeMaterials(raw, { cwd })`，把 `dropped` 记账。
3. **投**：`planMaterialDelivery(...)` → `describeMaterials()` 拼进该载体的 prompt；`inline` 部分走 `buildAttachmentMessages`。
4. **证**：一条最小回放单测（无 materials 时行为不变 + 有 materials 时清单出现 + 不可达时明示）。

## 4. 文件所有权（越界即回退）

| 归属                       | 文件                                                                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **总调度（已完成，禁改）** | `server/protocol.ts`、`server/material.ts`、`server/engine-service.ts`、`server/agent-service.ts`、`server/dispatch-domain-handlers.ts`、`server/files-service.ts`、`tests/unit/material.test.ts`、`docs/proposals/*`         |
| **A 目标线**               | `server/goal-service.ts`、`web/src/components/ChatInput.tsx`、`web/src/composer-gate.ts`、`tests/unit/composer-gate.test.ts`、`tests/unit/chatinput-send-notice.test.ts`、`tests/unit/goal-materials.test.ts`（新）           |
| **B 定时线**               | `server/scheduler-tasks.ts`、`server/scheduler-delivery.ts`、`server/schedule-agent-tool.ts`、`web/src/components/SchedulerPanel.tsx`、`tests/unit/scheduler-materials.test.ts`（新）                                         |
| **C 画布线**               | `server/canvas/canvas-dispatch.ts`、`server/canvas/canvas-orchestrator.ts`、`server/canvas/canvas-store.ts`、`server/canvas/canvas-agent-tool.ts`、`web/src/components/canvas/*`、`tests/unit/canvas-materials.test.ts`（新） |
| **谁都不许动**             | `web/src/App.tsx`、`web/src/styles.css`、`web/src/i18n/messages/core/*.json`、`tests/run-smoke.mjs`、`package.json`、`locales/*`                                                                                              |

需要新增用户可见文案时：**复用现有 i18n key**（`attachHint` / `removeAttachment` / `attachContent` 等），不许新增 key、不许改语言包。

## 5. 验收（每条线自证，缺一即不算完成）

```bash
npx prettier --write <改过的文件>
npm run typecheck
npx vitest run <本线单测>
```

外加一条**反例断言**：构造 `materials: ["不存在.txt"]` → 必须走 `dropped: missing`，且**不抛错**、不静默（日志/notice 二者之一）。

## 6. 明确不许做（反例清单）

- ❌ 把材料内容（base64 / 图片 / 文件正文）写进规格或每轮 prompt。
- ❌ 为材料新增 tool schema 字段给 AI 解释格式（AI 只给路径字符串）。
- ❌ 在载体里另写一套"清单"文案（`describeMaterials` 是唯一产出点）。
- ❌ 用 `fs.stat` 自己判断可达性（用 `normalizeMaterials` / `stageMaterials`）。
- ❌ 顺手重构无关代码、顺手改文案、顺手改阈值。
- ❌ 用"静默跳过"处理不可达材料。

## 7. 已冻结的行为契约（目标线特别注意）

- 目标模式**不再拦截**附件：`sendBlockedReason()` 不得再返回 `goalAttachBlocked`（该 key 保留但不再由客户端使用）。
- 目标的材料在**提炼（wizard）阶段就参与**：wizard 是普通会话，可 inline 图片。
- 执行者与审查者必须拿到**同一份**材料清单（跨轮重放，因为执行会话可被重建）。

## 8. 落地记录与已知缺口（2026-11 实施完成）

**已完成**：`server/material.ts` + 协议字段 + 三条线（目标 / 定时任务 / 画布）全部接入；
含 P1.5（粘贴图落盘进规格）与 R7 `runCwd` 接线；
`tests/unit/{goal,scheduler,canvas}-materials.test.ts` 各自覆盖 R10 逐字节、清单、不可达、邻归。

**已知缺口（都不是"以后再补就行"，而是有明确代价的取舍）**

| #   | 缺口                                                 | 现状                                                                                                                                                                                              | 代价 / 出路                                                        |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | ~~内联图片（base64 无路径）不能作为材料~~ **已闭环** | `set_goal` / `start_goal_wizard` 增加**瞬态** `materialBlobs`：服务端 `persistMaterialBlobs()` 落盘成 `attachments/<sha>.<ext>` 后只把路径并入 `materials`（R1 的唯一合法出口，规格仍只存字符串） | 单张 8MB 上限；超大/坏数据只记账 + notice，不阻断设目标            |
| 2   | ~~定时任务 R7 的 `runCwd` 未接线~~ **已闭环**        | `server/index.ts` 的 `deliverScheduledRun` host 已注入 `runCwd`（`SchedulerWakeEngine.getConversation(id)?.cwd`）；执行会话被切到别的工作区时材料先暂存                                           | —                                                                  |
| 3   | **画布非 LLM 节点不投材料**                          | `ai_judge` / `transform` / 人工节点无执行者，材料不注入也不提示                                                                                                                                   | 口径：材料只在"有执行者"时存在。若要提示，需在节点日志补一行       |
| 4   | **`.pi-materials/` 暂存目录会进画布产物**            | 已加入 `.gitignore` 与文件树忽略集（`server/files-service.ts`）                                                                                                                                   | 若某工作区自带 `.gitignore` 覆盖规则，仍可能出现在 worktree 产物里 |
| 5   | **材料暂存分支缺真 git 用例**                        | `stageMaterials` 逻辑有单测，worktree 隔离路径只有接线                                                                                                                                            | 需要 `tests/integration` 级真 worktree 用例                        |

**口径补充**：`setGoalPrefs` 不接受 `materials`（偏好与材料无关）；`SchedulerTaskView.materials` 只读展示，材料编辑入口在 v1 由 AI 工具承担。
