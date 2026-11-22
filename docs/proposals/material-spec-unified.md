# 材料规格统一（Material Spec）：规格只收字符串，要材料就给指针

> 关联：issue #961 / #962（目标模式附件"能加不能发"）。本文把该 bug 的根因从"目标模式缺功能"上升到分层缺失，给出一次收敛的方案。
> 状态：**已实施**（目标 / 定时任务 / 画布三条线）。实施细节与红线以 `docs/proposals/material-spec-contract.md` 为准；本文保留取舍推导与备选方案。
>
> 实施时相对本文的一处瘦身：协议只收 `string[]`（不是 `MaterialRef[]`），`MaterialRef` 降为服务端内部结构，AI 面零新概念。

## 0. 一句话

把"材料"从**会话内的消息片段**提升为**规格内的可寻址指针**，由唯一一层 `server/material.ts` 负责校验 / 清单渲染 / 降级决策；执行者（满血对话）用自己的工具去取。

规则只有一条：**规格只收字符串；要材料就给指针。**

## 1. 问题定位

现状不是"目标模式少个附件位"，而是：每个**会被第二次执行**的载体各自决定"输入能带什么"：

| 载体        | 规格字段                                                   | 今天能不能带材料         |
| ----------- | ---------------------------------------------------------- | ------------------------ |
| 目标        | `set_goal.goal: string` / `start_goal_wizard.text: string` | ❌ 显式拦截              |
| 定时任务    | `SchedulerTaskInput.prompt?: string`                       | ❌                       |
| 子代理 task | `tasks[{ key, prompt }]`（重启后按原 task 重放）           | ❌                       |
| 画布节点    | `canvas_run_node.prompt?` / 节点配置                       | ❌                       |
| 普通聊天    | `prompt.attachments?: PromptAttachment[]`                  | ✅（唯一有材料层的载体） |

于是每加一个载体都要再吵一次"这里支持不支持附件"。**这是分层缺失，不是功能缺失。**

## 2. 分层（单向依赖，越往下越不知道上面）

```
规格层 spec      goal / schedule / subagent / canvas      只存 MaterialRef[]（纯字符串）
   ↓
材料层 material  server/material.ts（新，单源）            校验 / 清单 / 降级决策；不解析内容
   ↓
投递层 delivery  server/attachments.ts#buildAttachmentMessages   唯一解析管道（不动）
   ↓
执行层 agent     满血对话 + read/bash/vision                （不动）
```

耦合方向固定：`spec → material → delivery → agent`。
**material 层不认识 React、不认识会话、不碰文件内容**，只处理"地址"。

## 3. 数据形状

```ts
// server/protocol.ts（类型单源，前端经 type-only re-export 自动同步）
export interface MaterialRef {
	kind: "file" | "image" | "dir" | "conversation" | "terminal" | "canvas" | "url";
	/** 内容寻址路径（dataDir/attachments/<sha256>.<ext>）或工作区相对路径；空 = 无效 */
	ref: string;
	name: string;
	mime?: string;
	size?: number;
	/** 给模型的一句话说明，用户可编辑，≤120 字 */
	note?: string;
}
```

- **不放 base64、不放 bucket id、不引入资源系统**：`ref` 就是地址，内容寻址天然去重共享。
- 远程工作区沿用现有 `remote-workspace-uri` 归一，不新增坐标体系。

## 4. 单一入口（3 个函数 + 1 组上限）

```ts
// server/material.ts
export const MATERIAL_LIMITS = {
	maxItems: 12,
	maxNoteChars: 120,
	maxListChars: 1200,
	maxBytes: 32 * 1024 * 1024,
};

/** 脏数据不抛错：丢项、去重、cap，全部记账 */
export function normalizeMaterials(
	raw: unknown,
	ctx: MaterialCtx,
): {
	materials: MaterialRef[];
	dropped: Array<{ index: number; reason: "bad-shape" | "duplicate" | "over-cap" }>;
};

/** 稳定格式的「材料清单」块（可快照测试、可缓存） */
export function describeMaterials(ms: MaterialRef[]): string;

/** 投递策略：谁 inline、谁只给指针、谁降级 */
export function planMaterialDelivery(
	ms: MaterialRef[],
	ctx: { engine: string; vision: boolean; cwd: string; remote: boolean },
): {
	inline: MaterialRef[]; // 必须随上下文：图片（执行/审查模型有视觉）、无 fs 引擎
	pointers: MaterialRef[]; // 只给路径，交给 read/bash
	degraded: Array<{ ref: string; reason: "no-vision" | "no-fs" | "unreachable" }>;
};
```

`describeMaterials` 的输出形如（措辞固定，便于守卫断言）：

```
【目标材料（动手前先读，不要凭印象改）】
1. image: dataDir/attachments/<sha256>.png — 崩溃截图
2. file:  docs/requirements.md
```

## 5. 接线：每个载体只改两处

1. **入口（写规格）**：客户端 `PromptAttachment[]` → `MaterialRef[]`（一个 `toMaterial()`，复用现有 `attachmentKey` 身份规则），随协议发出。
2. **出口（物化）**：载体自己的 prompt 构造处加两行：

```ts
const text = [basePrompt, describeMaterials(materials)].filter(Boolean).join("\n\n");
const plan = planMaterialDelivery(materials, ctx);
const turns = plan.inline.length ? await buildAttachmentMessages(plan.inline, ctx) : [];
```

载体从此**不认识附件**，只认识 `MaterialRef[]` 和这两个函数。新载体 = 存字段 + 调两函数。

## 6. 迁移顺序（每步可独立上线）

| 步     | 内容                                                                                                                                     | 风险 | 影响面                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------- |
| **P0** | `server/material.ts` + 纯函数单测（无 IO）                                                                                               | 无   | 新文件                                              |
| **P1** | goal 首个消费者：协议加 `materials?`；`executorRoundPrompt` 与 reviewer prompt 各加清单；前端目标态**不再禁附件**，改为"已附加 N 项材料" | 中   | protocol / goal-service / ChatInput / composer-gate |
| P2     | 定时任务 `SchedulerTaskInput.materials?`，执行时注入                                                                                     | 低   | scheduler + 面板                                    |
| P3     | 子代理 task 重放（"relaunch carrying the original task"）带上 materials                                                                  | 低   | subagents                                           |
| P4     | 画布节点 materials                                                                                                                       | 低   | canvas                                              |
| P5     | 存量兼容：老规格无 `materials` ≡ `[]`，读路径一律 `?? []`                                                                                | 低   | 各载体                                              |

P1 落地即闭合 #962：目标可以带截图与文档，`goalAttachBlocked` 这条拦截随之删除（文案保留为"材料不可达"的降级提示）。

## 7. 三个必须同时定死的策略

1. **落盘时点**：进规格前必须落盘（`saveAttachment`），规格只存 `ref`。客户端提交前 `ensurePersisted()`，不许把 base64 写进规格。
2. **跨环境可达**：`planMaterialDelivery` 判 `ref` 在执行者 cwd 是否可达；不可达则复制到 `<cwd>/.pi-materials/`（并加入 ignore 上报），仍失败 → `degraded:unreachable`，清单里明写"材料不可达，请让用户重传"。
3. **审查侧一致**：审查者拿**同一份清单**；`kind:image` 仅在审查模型有视觉时 inline，否则走 `vision-bridge` 转写（缓存按 `sha256` 复用）。验收标准才完整。

## 8. 守卫（都是便宜的那种）

- `tests/unit/material.test.ts`：normalize（脏形状 / 重复 / 超 cap）、describe 稳定格式、plan 三条降级路径。
- `tests/unit/material-single-source.test.ts`（结构性守卫）：
  - 除 `server/material.ts` 外，禁止新拼「材料清单」文案；
  - 除 `buildAttachmentMessages` 外，禁止新写附件解析；
  - 载体侧的 `materials` 字段必须是 `MaterialRef[]`，不许 `string[]` 打补丁。
- 浏览器 smoke：目标态 + 截图 → 执行者首轮 prompt / 会话转录里出现清单项。

## 9. 代价与边界

- 规模：P0+P1 ≈ 350–450 行（含测试）；P2–P4 各 40–80 行。
- 唯一有技术难度的是 **P1 的跨环境可达 + 审查侧降级**，其余是搬运。
- **不解决**：指针方案下"模型是否真去读"从确定变概率 → 用"必读指令 + 执行模型有视觉时首轮 inline 图片"两条兜底。
- **不做**：二进制进规格（每轮物化，撞 soft-cap 与 blob 生命周期）、把 materials 做成带 GC/引用计数的资源系统、为这事重写 goal-service。
- 判据：**"会被第二次执行的东西"才需要 materials；一次投递的普通聊天保持现状。**
