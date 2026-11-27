# 前端结构与可维护性优化方案

> 状态：**提案（未落地）**。
> 目标：参照 `packages/keel/src/` 已经落地的分层、端口和边界守卫，把前端从“少量巨型编排文件”逐步改造成“状态有所有者、功能有边界、对外接口稳定”的结构。
> 本文只定义方案与验收，不代表立即修改业务代码。

## 目录

- [1. 结论与范围](#1-结论与范围)
- [2. 事实基线](#2-事实基线)
- [3. 根因分析](#3-根因分析)
- [4. 优化原则](#4-优化原则)
- [5. 目标架构](#5-目标架构)
- [6. 前端公共契约](#6-前端公共契约)
- [7. 分阶段实施计划](#7-分阶段实施计划)
- [8. 结构守卫与预算](#8-结构守卫与预算)
- [9. 性能与可维护性验收指标](#9-性能与可维护性验收指标)
- [10. 测试与回归策略](#10-测试与回归策略)
- [11. 风险、回滚与变更边界](#11-风险回滚与变更边界)
- [12. 推荐启动顺序](#12-推荐启动顺序)

## 1. 结论与范围

### 1.1 结论

前端需要优化，但不采用“推倒重写”或“按行数机械切文件”的方式。

推荐路线是：

1. 先补**基线、预算和边界守卫**，防止结构继续恶化。
2. 优先拆 `SettingsModal`，以最低风险验证前端拆分方式。
3. 拆 `use-chat` 的状态、消息归约、选择器和连接层，保持 `useChat()` 对外形状不变。
4. 拆 `App` 的编排 Hook 与布局壳，让 `App` 只负责组合。
5. 拆 `LeftPanel`、消息渲染和输入框，最后收敛共享边界与 CSS。

这套路线与后端已经落地的做法一致：**先明确状态所有者，再搬移实现；先保持窄接口稳定，再改变内部结构。**

### 1.2 本期范围

纳入：

- `web/src/` 的状态管理、功能编排、组件边界、CSS 组织和构建分包。
- 前端直接导入 `server/` 或 `packages/keel/src/` 的共享边界。
- 前端结构守卫、文件预算、性能基线和相关文档。
- 保持现有 UI、交互、协议和插件能力不变。

不纳入：

- 不修改 WebSocket 协议、持久化格式和引擎契约。
- 不重写已经落地的 `packages/keel/src/` 后端内核。
- 不更换 React 或引入新的全局状态管理库。
- 不做视觉改版，不改变主题层叠规则。
- 不为了减少行数删除注释、测试或把逻辑塞进更难读的文件。

## 2. 事实基线

以下数据为制定本方案时的仓库基线，后续每阶段结束必须重新统计。

### 2.1 后端已经具备的结构基础

`packages/keel/src/` 已形成以下层次：

| 层           | 职责                                     | 现有守卫                  |
| ------------ | ---------------------------------------- | ------------------------- |
| `contracts/` | 纯类型、窄接口、端口                     | 禁止依赖实现层            |
| `kernel/`    | 对话聚合、注册表、核心不变量             | 只依赖 contracts / kernel |
| `domains/`   | 会话、回合、快照、工具、子代理等领域行为 | 域之间禁止直接 import     |
| `adapters/`  | SDK、存储、协议等外部适配                | 只通过端口接边            |
| `app/`       | 客户端运行时、组合装配、对外门面         | 禁止业务分支继续堆积      |

`tests/unit/core-boundaries.test.ts` 已经固化：

- 分层依赖方向；
- 域间禁止直接引用；
- SDK 与喂轮出口边界；
- 禁止重新引用旧上帝对象；
- 新文件默认不超过 600 行；
- 存量例外预算只允许减少。

前端应当复用这套**思路和守卫形态**，但不能照搬后端的全部层数。

### 2.2 前端当前体量

前端 TS/TSX 源码约 11.5 万行，另有 `web/src/styles.css` 约 4.1 万行。

| 指标                      |                        当前值 |
| ------------------------- | ----------------------------: |
| 超过 800 行的 TS/TSX 文件 |                            31 |
| 超过 1,500 行             |                            13 |
| 超过 2,500 行             |                             5 |
| 超过 4,000 行             |                             2 |
| `SettingsModal.tsx`       |                      7,446 行 |
| `App.tsx`                 | 3,979 行，约 187 次 Hook 调用 |
| `LeftPanel.tsx`           |                      3,808 行 |
| `use-chat.ts`             |                      3,441 行 |
| `ChatInput.tsx`           |                      2,321 行 |
| `Message.tsx`             |                      2,290 行 |
| `ui-slots.ts`             |                      2,187 行 |

### 2.3 前端当前职责混合

| 文件                | 混合的职责                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `App.tsx`           | 全局状态订阅、布局、弹窗、附件、预览、插件动作、深链、移动端抽屉、视图切换                 |
| `use-chat.ts`       | 客户端身份、会话缓存、项目删除状态、连接、协议消息归约、会话操作、终端操作、设置与插件状态 |
| `SettingsModal.tsx` | 设置壳、二十多个 tab、共享表单状态、市场、模型、插件、提示词、布局、桌面与设备设置         |
| `LeftPanel.tsx`     | 项目树、历史列表、子代理树、排序、过滤、折叠、菜单、行操作、会话列表请求                   |
| `Message.tsx`       | 多种消息与内容块渲染、流式 Markdown、工具卡、附件、引用、插件装饰                          |
| `ChatInput.tsx`     | 草稿、附件、提及、快捷短语、插件动作、斜杠命令、发送与队列交互                             |

### 2.4 已有优化不能回退

以下能力已经存在，本次优化必须保留：

- `React.lazy` + `DeferredMount` 的首屏按需加载；
- 消息列表窗口化与高度测量；
- 流式消息的稳定 React key 和 DOM identity；
- 安静模式、搜索与导出对完整历史视图的处理；
- 左栏 memo 与稳定 props；
- 会话预览到快照的列表原地交接；
- 主题 CSS 分层与视觉回归基线；
- `api-client.ts` 的 HTTP 请求与失败回执单源。

## 3. 根因分析

### 3.1 根因不是“文件大”，而是“状态没有所有者”

一个组件或 Hook 同时持有多个领域的状态，并允许这些领域通过共享闭包互相修改时，文件变大只是结果。

前端当前有三类典型问题：

1. **聚合根过大**：`App` 和 `useChat` 知道所有领域的细节。
2. **渲染与编排耦合**：组件既负责派生数据，又负责网络动作、全局桥和弹窗状态。
3. **共享边界隐式化**：通过相对路径直接导入服务端模块，或通过全局动作桥绕过显式依赖。

### 3.2 不能继续采用的做法

- 按固定行数把文件切成 `part1.ts`、`part2.ts`；
- 把同一个状态分别复制到多个组件；
- 用新的全局单例Store替代现有全局桥，但没有明确所有者；
- 给所有组件统一添加 `memo` / `useMemo`；
- 在拆分时顺手改变协议、交互或样式；
- 只删除测试中的源码路径断言来“适配”新结构，而不是迁移真实行为。

### 3.3 判断拆分是否正确的标准

每完成一次拆解，必须能回答：

- 这份可变状态唯一属于谁？
- 谁允许写它？
- 哪个模块负责派生数据？
- 哪个模块负责执行动作？
- 组件只依赖哪个窄接口？
- 旧公共接口是否保持不变？
- 对应行为测试是否仍然命中生产代码？

## 4. 优化原则

1. **状态所有权优先于文件大小**：先确定所有者，再决定文件边界。
2. **先稳接口，再改内部**：`useChat()`、`AppGlobals`、`LeftPanel`、`SettingsModal` 的对外形状先保持不变。
3. **一次只拆一个领域**：每个 PR 只包含搬移、委托和必要的守卫，不混入新功能。
4. **纯逻辑先于 React**：reducer、选择器、树模型、排序和分组优先做成可单测纯函数。
5. **组件只消费选择器**：避免组件直接读取整个大状态对象。
6. **显式端口替代隐式全局**：跨功能能力通过窄接口提供，不让组件直接碰连接、缓存或全局动作实现。
7. **不为单次使用创造抽象**：抽象必须有两个以上真实消费方，或代表明确领域边界。
8. **结构和性能一起度量**：既看行数与依赖，也看首屏体积、交互时延和流式渲染。

## 5. 目标架构

### 5.1 前端采用“轻量分层”，不照搬后端全部层次

建议最终形成以下逻辑结构：

```text
web/src/
  app/                         # 组合根：Provider、Shell、全局编排
    WorkspaceShell.tsx
    hooks/
      use-draft-attachments.ts
      use-preview-open-state.ts
      use-panel-layout.ts
      use-modal-stack.ts

  contracts/                   # 前端窄接口与端口，不依赖 React 实现
    chat.ts
    settings.ts
    sidebar.ts
    transport.ts

  state/                       # 状态、归约器、选择器
    chat/
      types.ts
      reducer/
      selectors.ts
      connection.ts
      actions/
    settings/
    sidebar/

  features/                    # 按产品领域组织用例与功能 Hook
    chat/
    settings/
    sidebar/
    workspace/
    messages/
    composer/

  components/                  # 可复用展示组件与功能组件壳
    Message.tsx                # 稳定门面
    MessageList.tsx
    LeftPanel.tsx              # 稳定门面
    SettingsModal.tsx          # 稳定门面
    ChatInput.tsx              # 稳定门面

  adapters/                    # 浏览器、桌面、插件、传输适配
    transport/
    desktop/
    plugins/

  shared/                      # 前端专用纯工具；禁止反向依赖 feature/app
```

说明：

- `contracts/` 只放类型和窄接口，不放业务实现。
- `state/` 尽量保持纯函数，不直接依赖 DOM 和组件。
- `features/` 持有功能生命周期和用例编排。
- `components/` 负责渲染与交互，不直接拥有跨页面状态。
- `app/` 是唯一组合根，负责把 ports、features、components 装配起来。
- 现有文件路径可以通过 re-export 门面长期保留，不必一次性全量搬迁。

### 5.2 允许的依赖方向

```text
contracts ← state ← features ← app
                 ↑
            components
                 ↑
                app

adapters → contracts
shared → contracts
```

硬性约束：

- `state` 不 import `features`、`components`、`app`；
- `features` 不 import `app`；
- `components` 不直接 import `server/` 运行时实现；
- `app` 不继续承载可独立测试的业务分支；
- 同层功能之间通过 `contracts/` 或组合根提供的端口通信，不互相 import 实现。

### 5.3 共享层边界

当前约有 44 个前端文件直接相对导入 `server/` 模块。其中包含纯共享函数，不能简单认定为错误，但需要分级：

| 类型                                | 处理方式                                                             |
| ----------------------------------- | -------------------------------------------------------------------- |
| 协议纯类型                          | 保留 `web/src/types.ts` shim，长期作为兼容入口                       |
| 前后端共用纯函数、常量、schema      | 迁到明确共享层，例如 `packages/keel/src/contracts/` 或独立 `shared/` |
| 服务端运行时、带 I/O 或重依赖的实现 | 禁止前端直接 import                                                  |
| 存量兼容项                          | 进入显式 allowlist，只允许减少，不允许新增                           |

目标不是一次性清完 44 个文件，而是先阻止新增，再按功能迁移。

## 6. 前端公共契约

### 6.1 `useChat()` 兼容契约

拆分期间必须保持以下导出可用：

- `useChat()` 返回的 `chat` 形状；
- `ChatState`、`Notice`、`TerminalMeta`、`UpdateAllItem` 等类型；
- `getClientId()` 及测试重置函数；
- 会话缓存、路径归一、项目删除标记等现有工具函数；
- `reducer` / `_chatReducerForTest` 的测试入口。

推荐演进：

```text
web/src/use-chat.ts                 # 稳定门面，只 re-export / 装配
web/src/state/chat/types.ts         # 状态与动作类型
web/src/state/chat/reducer/*.ts     # 按消息族拆分的纯归约
web/src/state/chat/selectors.ts     # 派生数据
web/src/state/chat/connection.ts    # WS 生命周期
web/src/state/chat/actions/*.ts     # 会话、终端、设置等动作
web/src/features/chat/use-chat.ts   # React Hook 组合
```

### 6.2 `AppGlobals` 兼容契约

保留 `useAppGlobals()`、`useAppField()`、`appSend` 和现有字段，不新建第二套全局状态。

后续只做两件事：

- 让页面通过 `useAppField` 或更窄的选择器订阅，避免订阅整个对象；
- 把 `appSend` 背后的实现移入 `adapters/transport/`，全局文件只保留稳定 API。

### 6.3 组件 Props 兼容契约

以下组件优先保持 Props 不变：

- `SettingsModal`
- `LeftPanel`
- `ChatInput`
- `Message`
- `MessageList`

内部可以改由 Context、选择器和窄端口提供依赖，但外部调用点不应在结构重构中大面积修改。

## 7. 分阶段实施计划

### F0：基线、预算与守卫

**目标**：先让恶化可被及时发现，不改变任何业务行为。

工作内容：

1. 建立前端结构基线脚本或测试：
   - 文件行数；
   - 超过预算文件清单；
   - 前端模块依赖图；
   - `web → server` 导入清单；
   - 循环依赖。
2. 增加 `tests/unit/frontend-file-budget.test.ts`：
   - 新文件默认不超过 600 行；
   - 存量巨型文件按当前值登记，只允许下降；
   - 不允许通过提高预算规避重构。
3. 增加 `tests/unit/frontend-boundaries.test.ts`：
   - 禁止 `state → features/components/app`；
   - 禁止 `features → app`；
   - 禁止新增未授权的 `web → server` 运行时导入；
   - 禁止前端模块循环依赖。
4. 记录构建与浏览器性能基线：
   - 首屏引用资源原始体积与 gzip；
   - 首次打开设置体积；
   - 冷启动、切会话、长会话流式、移动端滚动。
5. 更新 `docs/loading-performance.md`，区分“构建资源预算”和“真实浏览器时延”。

验收：

- 现有 typecheck、lint、相关单测通过；
- 守卫能真实发现故意新增的超限文件和反向依赖；
- 基线数据可重复生成。

预估：2～3 人日。

---

### F1：拆分 `SettingsModal`

**目标**：把设置壳与各设置页分离，保持现有设置保存、同步和交互不变。

建议目录：

```text
web/src/features/settings/
  context.tsx
  types.ts
  hooks/
    use-settings-form.ts
    use-tab-state.ts
  tabs/
    ModelsTab.tsx
    PromptTab.tsx
    ToolsTab.tsx
    PluginsTab.tsx
    DisplayTab.tsx
    LayoutTab.tsx
    DesktopTab.tsx
    ...
  helpers/
```

实施要点：

1. 先把共享设置状态与动作抽成 `SettingsFormContext`。
2. 每个 tab 只消费自己需要的 context 字段和动作。
3. tab 内容通过 `lazy` 按激活加载，避免首次打开设置下载全部 tab。
4. `components/SettingsModal.tsx` 只保留：
   - 弹窗外壳；
   - tab 导航；
   - 当前 tab 渲染；
   - 少量跨 tab 协调。
5. 纯 helper 从组件搬到 `features/settings/helpers/`。
6. 不改变设置的乐观更新、失败回执、失焦保存和 DSH/引擎差异逻辑。

验收：

- 所有设置相关单测和真实浏览器设置流程通过；
- tab 切换、保存失败重试、预设、插件、模型、布局和桌面设置行为一致；
- 设置壳 chunk 明显缩小，首屏包不增加；
- `SettingsModal.tsx` 降到 400 行以内。

预估：4～6 人日。

---

### F2：拆分 `use-chat`

**目标**：把“连接 + 协议归约 + 会话操作 + 缓存 + 终端”拆成有所有权的模块，同时保持 `useChat()` 兼容。

建议目录：

```text
web/src/state/chat/
  types.ts
  client-id.ts
  session-cache.ts
  project-removal.ts
  selectors.ts
  connection.ts
  reducer/
    index.ts
    snapshots.ts
    messages.ts
    conversations.ts
    sessions.ts
    settings-models.ts
    interactions.ts
    plugins-markets.ts
    terminals-workspace.ts
    updates.ts
  actions/
    conversation.ts
    terminal.ts
    settings.ts
    workspace.ts
```

实施要点：

1. 先搬纯类型和纯 helper，再搬 reducer。
2. reducer 按消息族拆分，总入口只负责稳定分派和未知消息兜底。
3. 连接生命周期独立到 `connection.ts`，不继续混在 reducer 文件中。
4. 会话、终端、设置、工作区动作按域拆文件。
5. React Hook 只负责组合状态、连接和动作，不继续膨胀。
6. 保留 `use-chat.ts` 作为 re-export 和兼容门面。
7. 对现有源码路径断言测试，迁移到新的真实生产入口，不复制算法到测试里。

验收：

- 现有 reducer、全局交互、队列、流式、终端、设置、会话缓存测试通过；
- 相同输入下新旧 reducer 输出等价；
- 断线、重连、切会话、排队、停止、子代理通知无回归；
- `useChat()` 消费点无需修改；
- `use-chat.ts` 门面降到 300 行以内。

预估：6～9 人日。

---

### F3：拆分 `App` 编排与布局壳

**目标**：让 `App` 只负责组合，不让它继续承担所有功能状态。

建议目录：

```text
web/src/app/
  WorkspaceShell.tsx
  use-draft-attachments.ts
  use-preview-open-state.ts
  use-panel-layout.ts
  use-modal-stack.ts
  use-plugin-actions.ts
  use-deep-link.ts
```

实施要点：

1. 按“一块状态 + 一组副作用”抽 Hook，不按行号抽。
2. 顶栏、三栏、消息列、输入区、底坞收进 `WorkspaceShell`。
3. 弹窗栈、预览栈、附件草稿分别有明确所有者。
4. 插件动作与 UI slot 只通过现有桥和窄接口调用。
5. 保持移动端抽屉、桌面分栏、视图切换和深链行为。
6. `App.tsx` 最终只做 Provider、Hook 组合和视图装配。

验收：

- 桌面与移动端核心冒烟通过；
- 插件 slot、弹窗层级、附件、预览、视图切换无回归；
- `App.tsx` 降到 800 行以内，Hook 数量显著下降；
- 流式更新不导致整个 Shell 无意义重渲染。

预估：5～8 人日。

---

### F4：拆分 `LeftPanel`

**目标**：把项目树、会话行、历史加载和行操作分离。

建议目录：

```text
web/src/features/sidebar/
  model.ts
  project-tree.ts
  conversation-groups.ts
  hooks/
    use-session-list.ts
    use-project-order.ts
    use-collapsed-state.ts
    use-row-actions.ts
  components/
    ProjectHeader.tsx
    ConversationRow.tsx
    SubagentTree.tsx
    HistoryRows.tsx
    DeviceGroupSlot.tsx
```

实施要点：

1. 纯派生逻辑进入 `model.ts`，保留现有 `projectTreeModel` 语义。
2. 会话行成为独立组件，Props 只包含该行需要的数据与动作。
3. 项目展开、折叠、排序、列表请求分别进入专属 Hook。
4. 菜单动作按会话、项目、设备群组拆分，避免一个超长回调函数处理所有情况。
5. 保留 `components/LeftPanel.tsx` 作为稳定门面。
6. 不改变会话归属、置顶、未读、历史分页、键盘导航和子代理树语义。

验收：

- 左栏排序、过滤、删除、置顶、展开、分页、键盘和子代理测试通过；
- 左栏不随流式 token 重渲染；
- 行身份和顺序保持稳定；
- `LeftPanel.tsx` 门面降到 500 行以内。

预估：4～6 人日。

---

### F5：拆分消息渲染与输入框

**目标**：降低 `Message` 和 `ChatInput` 的职责密度，同时绝对保证流式 DOM identity。

建议目录：

```text
web/src/features/messages/
  Message.tsx
  blocks/
    TextBlock.tsx
    ThinkingBlock.tsx
    ToolCallBlock.tsx
    AttachmentBlock.tsx
    QuoteBlock.tsx
  cluster.tsx

web/src/features/composer/
  ChatInput.tsx
  attachments/
  actions/
  mentions/
  quick-phrases/
  plugin-actions/
```

实施要点：

1. `Message` 只负责消息级分派与稳定 key。
2. 内容块按类型拆渲染器，不改变块索引身份规则。
3. 流式定稿仍使用同一 `StreamMarkdown` / `MarkdownBody` 路径。
4. `MessageList` 的窗口化、quiet mode、搜索和导出逻辑不动。
5. `ChatInput` 的草稿仍由唯一所有者持有，附件、动作和插件区只消费窄接口。
6. 不为拆组件改变 DOM 层级、主题 class 或 CSS 选择器。

验收：

- `message-finalization-dom`、`stream-segment-identity`、`message-list-identity` 通过；
- `tests/stream-stability-ui-test.mjs` 通过；
- `tests/lazy-window-test.mjs` 通过；
- 安静模式、搜索、导出、附件、插件动作和移动端输入无回归。

预估：5～7 人日。

---

### F6：共享边界与 CSS 收敛

**目标**：让前后端共享和样式组织有明确边界。

#### 共享边界

1. 登记现有 `web → server` 导入 allowlist。
2. 新增运行时导入直接报错。
3. 将纯共享函数和常量迁入明确共享层。
4. 前端业务只依赖协议类型、窄 ports 和共享纯函数。
5. 每迁移一项，从 allowlist 删除一项。

#### CSS

1. 保持 `@layer guard, base, theme, drawer` 层序不变。
2. `styles.css` 保留基线、令牌、全局布局和少量跨域复位。
3. 设置、侧栏、消息、输入框、画布等功能 CSS 按领域拆文件。
4. 所有新 CSS 通过 `@import ... layer(base)` 或既有层引入。
5. 不新增 `!important`，不改变主题覆盖优先级。
6. 不删除未知可能被插件或主题使用的 class；先通过使用扫描和视觉回归确认。

验收：

- `css-layers`、`css-tokens`、主题按钮和主题视觉回归通过；
- 35 个主题的既有视觉差异不扩大；
- 前端不再新增未授权服务端运行时导入；
- CSS 文件职责可检索、可定位，不再依赖单个 4 万行文件。

预估：4～6 人日。

---

### F7：收尾、文档与预算下调

工作内容：

1. 将实际行数写入预算，持续下调存量例外。
2. 更新 `docs/architecture-ui.md`，增加前端状态层与功能边界说明。
3. 更新 `docs/directory-reference.md` 和 `AGENTS.md` 的事实源映射。
4. 将已过时的前端重写提案标记为“已由本方案取代”或“已部分落地”。
5. 记录最终性能、结构和测试指标。
6. 删除仅为拆分临时存在的转发层；长期兼容门面保留。

验收：

- `npm run ci:local` 全绿；
- 所有结构、性能、主题和流式守卫通过；
- 文档索引无死链；
- 新模块有明确所有者，旧巨型文件预算只降不升。

预估：2～3 人日。

## 8. 结构守卫与预算

### 8.1 文件预算

| 对象                       | 规则                         |
| -------------------------- | ---------------------------- |
| 新增 TS/TSX                | 默认不超过 600 行            |
| 存量 >600 行文件           | 登记当前预算，只允许下降     |
| `SettingsModal.tsx` 门面   | 目标 ≤400 行                 |
| `use-chat.ts` 门面         | 目标 ≤300 行                 |
| `App.tsx`                  | 目标 ≤800 行                 |
| `LeftPanel.tsx` 门面       | 目标 ≤500 行                 |
| 纯数据、协议类型、生成文件 | 单独登记，不机械套用组件预算 |

预算测试必须同时检查：

- 实际行数；
- 预算是否长期高于实际；
- 新文件是否绕过目录扫描；
- 是否通过重命名或移动文件重置预算。

### 8.2 依赖守卫

新增 `frontend-boundaries.test.ts`，至少覆盖：

1. `contracts` 不依赖 `state/features/components/app`；
2. `state` 不依赖 `features/components/app`；
3. `features` 不依赖 `app`；
4. `components` 不直接 import 未授权的服务端运行时；
5. 前端不新增循环依赖；
6. `shared` 不反向依赖业务层；
7. `use-chat.ts`、`SettingsModal.tsx`、`LeftPanel.tsx` 门面不重新堆积业务实现。

### 8.3 状态所有者守卫

对核心状态增加静态或行为断言：

- `ChatState` 只能由 reducer 修改；
- 会话缓存只能通过 `session-cache.ts` 读写；
- 项目删除标记只有一个实现来源；
- 设置草稿只能通过设置 context / store 修改；
- 面板布局和弹窗栈只能由对应 Hook 修改；
- 组件不得复制一份会话顺序、项目排序或流式身份算法。

## 9. 性能与可维护性验收指标

### 9.1 结构指标

| 指标                                 |       基线 | 目标 |
| ------------------------------------ | ---------: | ---: |
| >800 行 TS/TSX                       |         31 |  ≤10 |
| >1,500 行                            |         13 |   ≤3 |
| >2,500 行                            |          5 |    0 |
| >4,000 行                            |          2 |    0 |
| 前端模块循环依赖                     | 未系统统计 |    0 |
| 未授权新增 `web → server` 运行时导入 |   未设守卫 |    0 |
| 新文件 >600 行                       | 无统一守卫 |    0 |

### 9.2 性能指标

| 指标                 |        当前参考 |                                           目标 |
| -------------------- | --------------: | ---------------------------------------------: |
| 首屏引用资源 gzip    |      约 876 KiB |               第一阶段 ≤800 KiB，最终 ≤700 KiB |
| 首屏引用资源原始体积 |     约 3.23 MiB |                           不增加，最终明显下降 |
| 设置首次打开 chunk   | 约 331 KiB 原始 |                          按 tab 加载后显著下降 |
| 流式更新             |    已有左栏隔离 | App Shell、左栏、输入框不因 token 无意义重渲染 |
| 长会话滚动           |      已有窗口化 |                  不回归，真实浏览器 p75 不恶化 |
| 主题视觉             |    已有回归基线 |                                 非有意差异为 0 |

以上是目标预算，不是承诺值；F0 必须先用同一构建配置和同一测量口径复测。

### 9.3 可维护性指标

每次 PR 必须能证明：

- 改动文件变少或职责变清晰；
- 跨功能 import 不增加；
- 新状态有唯一所有者；
- 对外接口无需调用方修改；
- 相关行为测试仍直接调用生产代码；
- 文档事实源已同步。

## 10. 测试与回归策略

### 10.1 每个阶段的固定门禁

```bash
npx prettier --write <改动文件>
npm run typecheck
npm run lint
npx vitest run <相关单测>
npm run build:web
```

涉及样式时额外执行：

```bash
npm run audit:themes
npm run audit:diff
```

涉及消息、输入框或长列表时额外执行：

```bash
node tests/stream-stability-ui-test.mjs
node tests/lazy-window-test.mjs
```

涉及设置、侧栏、移动端或插件 UI 时执行对应真实浏览器测试与 `npm run test:smoke:core`。

### 10.2 reducer 等价性测试

拆分 `use-chat` 时，优先使用现有 fixture 和真实 action：

- snapshot / snapshot_delta；
- message_delta / tool_delta；
- 会话切换与历史加载；
- 排队、停止、重试；
- 设置、模型、插件；
- 终端与工作区；
- 未知消息兜底。

不允许在测试里复制一份新 reducer 算法来“证明等价”。

### 10.3 组件行为测试

每个拆分后的功能组件至少覆盖：

- 正常渲染；
- 空状态；
- 加载与失败；
- 用户动作；
- 卸载与迟到响应；
- 稳定身份与状态保留。

### 10.4 源码守卫迁移

现有部分测试直接读取 `use-chat.ts`、`App.tsx` 等源码路径。迁移时应：

1. 找到该测试真正要保护的生产行为；
2. 将断言指向新的真实入口；
3. 尽量改为行为测试或生产导出测试；
4. 不保留对新旧两份实现的重复检查。

## 11. 风险、回滚与变更边界

### 11.1 主要风险

| 风险                          | 影响                             | 对策                                         |
| ----------------------------- | -------------------------------- | -------------------------------------------- |
| 机械搬移导致行为漂移          | 设置、会话、侧栏出现隐性回归     | 一域一 PR，保持接口，跑真实浏览器流程        |
| tab 懒加载丢失局部状态        | 设置草稿或未保存内容丢失         | 先明确状态所有者，再按 tab 拆包              |
| 消息组件拆分改变 DOM identity | 流式闪烁、滚动跳动、输入状态重置 | 保持 key、父级和块索引规则，跑流式稳定性测试 |
| CSS 拆分改变层叠              | 主题样式被压住或视觉差异         | 全部进入既有 layer，跑主题截图回归           |
| 共享层迁移拉入重依赖          | 首屏包膨胀或浏览器运行服务端代码 | 共享层只放纯函数/类型/窄契约，构建预算兜底   |
| 预算守卫形式化                | 文件变多但耦合更重               | 同时检查依赖方向和状态所有者，不只看行数     |
| 提案文档落后于代码            | 后续开发按错误状态重复规划       | F7 同步文档，标记旧提案状态                  |

### 11.2 回滚方式

- 每个阶段独立 PR，不做跨阶段混合提交。
- 不修改协议、存储和引擎契约，结构重构可整 PR 回滚。
- `use-chat.ts`、`SettingsModal.tsx`、`LeftPanel.tsx` 保留兼容门面。
- 设置按 tab 懒加载如出现状态问题，可单独撤回懒加载，不影响已经拆出的纯逻辑和组件。
- 不为纯结构重构增加运行时 feature flag；通过 PR 粒度和兼容门面控制风险。

### 11.3 每个 PR 的变更边界

允许：

- 搬移文件；
- re-export；
- 引入窄接口；
- 抽取纯函数；
- 更新对应测试和文档；
- 下调预算。

不允许：

- 顺带新增产品功能；
- 改协议字段；
- 改主题视觉；
- 改存储格式；
- 改全局状态语义；
- 用大范围 `any` 绕过类型问题；
- 删除失败路径和边界测试。

## 12. 推荐启动顺序

推荐按以下顺序执行：

1. **F0**：结构基线、文件预算、依赖守卫、性能基线。
2. **F1**：`SettingsModal` 拆分，作为前端拆分范本。
3. **F2**：`use-chat` 状态层拆分，解决最大的状态耦合。
4. **F3**：`App` 编排与 `WorkspaceShell`。
5. **F4**：`LeftPanel`。
6. **F5**：消息渲染与 `ChatInput`。
7. **F6**：共享边界与 CSS。
8. **F7**：文档、预算和最终验收。

估算：

- 单人顺序实施约 **6～8 周**；
- 在接口冻结且测试边界清晰的前提下，F1、F4、F6 可部分并行；
- 不建议 F2 与 F3 同时改同一批 `App` / `useChat` 消费点。

### 12.1 第一个可交付 PR

建议第一个 PR 只包含：

- `frontend-file-budget.test.ts`；
- `frontend-boundaries.test.ts`；
- 前端结构基线统计；
- 首屏与设置 chunk 的构建资源统计；
- 本方案文档。

该 PR 不改变业务代码，但能让后续每一步都有可执行的边界和预算，避免再次回到“边拆边长、只改表象”的路线。
