# PR #838 / #839 技术审查与架构演进建议

审查对象：[PR #838](https://github.com/xing-shuyin/pi-web-ui/pull/838)，合并提交 `9df07225e4a30b7979d9ffb2a8a9e071b25e4b55`；[PR #839](https://github.com/xing-shuyin/pi-web-ui/pull/839)，合并提交 `d5ee3b203659758652d063d2070423cb4638c15a`。结论以这些提交为准，未将当前工作区的其他改动计入 PR。

**结论：#838 是有效的止血修复，但路径兼容层不适合作为 SDK 的长期边界；#839 打通了一个有限入口，尚未建立统一的自动压缩扩展契约。优先修复可观测的功能缺口，再分别收敛到按运行态发布的插件 SDK、由 Pi SDK 统一拥有的压缩生命周期。**

两个 PR 暴露了相似问题：运行态、触发来源等本应由接口表达的信息，分别通过“让所有入口都兼容浏览器”和“让字符串携带控制信号”间接表达。长期演进应使这些信息显式化，同时保留小而清楚的兼容层。

## 1. 已确认的问题与严重程度

| 优先级 | 问题                                            | 影响与归属                                                                                                   |
| ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| P1     | #839 的 `set_settings` 分发白名单没有转发新字段 | 客户端发送合法的 `autoCompactionInstructions` 会被静默丢弃；协议声明与实际行为不一致。属于该 PR 的集成缺口。 |
| P2     | #839 只给宿主空闲软上限路径传指令               | 工具调用间隙的 SDK 阈值压缩、溢出恢复仍没有该指令；依赖暗号的扩展不能统一接管自动压缩。属于能力覆盖限制。    |
| P2     | #838 的 mock 路径语义偏离原生 Node              | 部分合法路径被拒绝或被改写；影响测试 Harness 的可信度。不能据此推断生产宿主存在路径越界漏洞。                |
| P2     | `upgrade-sdk` 只检查第一份副本的版本            | 服务端 SDK 最新、客户端 SDK 旧且文件齐全时，可能误报已最新，阻碍 #838 修复落地。属于存量问题。               |
| P2     | 客户端只对入口 URL 加 epoch/retry 参数          | 相对依赖的 URL 不变，热重载可能继续使用旧 SDK，失败依赖也可能继续命中模块缓存。属于存量模块图发布问题。      |

此外，多扩展摘要竞争、错误回退、运行时结果校验和提交一致性，是引入正式 Provider 前必须补齐的 SDK 契约；它们并非 #839 新增的问题。

### 1.1 #839 的设置消息确实丢字段

[合并后的 `handleSettingsMessage`](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/server/dispatch-domain-handlers.ts#L701) 手工构造传给 `setSettings` 的对象。`softCapTokens`、`softCapByModel` 位于第 758–759 行，新字段没有被加入。另一方面，[协议](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/server/protocol.ts#L1839) 已接受它，[设置服务](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/server/settings-service.ts#L1053) 也实现了写入。

在合并提交的临时快照中执行实际 `handleSettingsMessage`，传入 `{ type: "set_settings", autoCompactionInstructions: "[[auto]]" }`：函数返回 `true`，`setSettings` 被调用，但参数没有 `autoCompactionInstructions`。这解释了为什么字段类型、持久化和预设单测都正确，正常 Web 消息入口仍不能设置该值。

修复需补分发映射，并同步宿主 `setSettings` 的参数声明。回归测试应穿过真实消息分发、设置服务和刷新后的设置快照，验证写入、清空以及归一化行为。新增的复现只证明了分发层的丢字段，尚未执行完整持久化往返。

### 1.2 #838 的路径回归

[新的 `resolvePath`](https://github.com/xing-shuyin/pi-web-ui/blob/9df07225e4a30b7979d9ffb2a8a9e071b25e4b55/plugin-sdk/index.mjs#L71) 对所有输入执行反斜杠替换，并使用自定义的绝对路径与路径风格识别。直接加载该提交的 SDK，得到以下结果：

| cwd / 输入                                  | 原生 Node 的预期语义                 | 新 mock 的实际结果     |
| ------------------------------------------- | ------------------------------------ | ---------------------- |
| POSIX `/work/proj` / `a\b`                  | `/work/proj/a\b`，反斜杠是文件名字符 | `/work/proj/a/b`       |
| Windows `C:\work\proj` / `\work\proj\a.txt` | `C:\work\proj\a.txt`                 | HTTP 403               |
| Windows `C:\work\proj` / `C:a.txt`          | `C:\work\proj\a.txt`                 | `C:\work\proj\C:a.txt` |
| Windows 当前进程、cwd 为 `.` / `a.txt`      | 相对当前进程目录的绝对路径           | HTTP 403               |

前两列分别用 `path.posix.resolve`、`path.win32.resolve` 对照。生产宿主仍使用 Node 路径处理，因此这是新增的 **mock 合同回归**。根路径、UNC、`.` / `..` 的现有测试不能证明完整兼容 Node，继续补齐这些规则也会逐步变成维护一个路径库。

如果确实需要跨平台虚拟文件系统，应明确它自己的路径语法，并让消费者主动选择；不要让一个测试替身悄悄改变生产 API 的语义。

## 2. #838：按运行态切分发布边界

### 2.1 当前修复的价值与局限

移除顶层 `node:path` 确实解决了浏览器链接模块图时的硬失败。原生 ESM 必须先解析静态依赖，调用方只使用 `defineView` 并不能避免解析同一入口里的 Node 依赖；无构建流程的浏览器运行时也不存在可依赖的 tree-shaking。

但为让服务端测试工具留在统一入口而重写路径算法，是以语义成本换取入口兼容。`createMockHost` 默认属于测试运行态，不应成为客户端 SDK 的传递依赖。

这不意味着测试 Harness 永远只能在 Node 中运行。浏览器组件测试可以需要 mock，但应使用明确的客户端测试入口及能力集合。当前模拟整个服务端 Host、包含工作区路径和二进制读取语义的 Harness，更适合 Node 测试入口。

### 2.2 建议的发布结构

```text
plugin-sdk/
  core/
    definitions.mjs          # 纯定义及校验，不依赖 Node 或 DOM 全局
    shared-types.d.ts        # 真正跨运行态的数据契约
  client.mjs                 # defineView / defineRenderer / onUiAction / 客户端工具
  client.d.mts               # 浏览器类型，不引入 Buffer、fs 或 Express
  server.mjs                 # definePlugin / 服务端辅助函数
  server.d.mts               # PluginHost、路由及 Node 类型
  testing.mjs                # createMockHost，使用原生 node:path
  testing.d.mts
  client-utils.mjs           # 现有兼容入口，逐步转为内部模块或子路径转发
  index.mjs                  # 有期限的旧 API 兼容入口
  index.d.mts
  package.json
  sdk-manifest.json          # 各运行态文件闭包、版本及内容摘要
```

`core` 只共享稳定且实际复用的东西，不应重新变成一个聚合全部能力的大入口。`server.mjs` 可以保持轻量；按运行态分层并不要求每个服务端文件都引入 Node。

打包消费者使用显式子路径：

```json
{
	"exports": {
		"./client": { "types": "./client.d.mts", "default": "./client.mjs" },
		"./server": { "types": "./server.d.mts", "default": "./server.mjs" },
		"./testing": { "types": "./testing.d.mts", "default": "./testing.mjs" }
	}
}
```

这里的 `./client` 是建议的新版完整客户端入口。**当前 `./client` 只指向 `client-utils.mjs`，不能直接把脚手架 import 改成它，否则会缺少 `defineView` 等现有能力。** 应先完善导出和兼容测试，再改生成模板。

条件导出可作为打包工具的便利能力，但不应承担主要边界。脚手架产生的 `./sdk/index.mjs` 是相对 URL，浏览器不会为它解析 SDK 的 `package.json#exports`。相对路径直接导入 `.mjs` 时，声明文件也应有相应的 `.d.mts`，不能只依赖包级 `types`。

### 2.3 定向复制与向后兼容

新脚手架应生成明确的运行态入口：

```js
// client/entry.mjs
import { defineView } from "./sdk/client.mjs";

// 服务端入口
import { definePlugin } from "./sdk/server.mjs";

// Node 测试
import { createMockHost } from "../sdk/testing.mjs";
```

复制逻辑以发布清单为单源，客户端只获得 `client.mjs` 的运行时依赖闭包及客户端声明，服务端及开发测试目录获得各自清单。不要继续以“两个固定文件复制到两处”代表 SDK 发布。

兼容迁移可分两步：

1. 在次版本中新增三个入口，完整保留旧导入方式和同步 `createMockHost` 签名；新模板、文档和测试立即改用新入口。旧浏览器可达的 `index.mjs` 必须保持其整个静态依赖图浏览器可加载，不能静态转发到 Node `testing.mjs`。因此旧纯实现可以暂留为隔离的 legacy shim，标注弃用并修复已知回归。
2. 在明确的主版本中移除旧入口的测试导出，使 Node mock 回归原生路径库。若生成按角色的 `sdk/index.mjs` 兼容转发文件，应明确它们支持的旧 API 集合，不要让同一导入在两端默默暴露不同的完整契约。

不能为了删除 50 行兼容代码，把同步 API 改成 `async`，或者让旧浏览器入口重新链接 Node 模块；这会重建原故障。

升级器应逐副本检查版本和文件摘要，并先写临时目录、检查后替换。[当前仅核对 `dirs[0]` 版本](https://github.com/xing-shuyin/pi-web-ui/blob/9df07225e4a30b7979d9ffb2a8a9e071b25e4b55/bin/pi-web-ui.mjs#L3619) 的逻辑应优先修复。兼容层完成前，普通旧插件升级仍必须能拿到 #838 的修复。

### 2.4 检验真实产物及类型边界

新增 browser-safe 测试有价值，但其正则扫描不能等同浏览器验证：它主要检查静态 `node:` 导入，可能漏掉同一行前面有语句的 import、裸 `path` / `fs` 模块，以及运行时依赖问题；仓库中的依赖存在也不能证明脚手架确实复制了它。

长期只需保留三类有实际价值的检查：

- 用 CLI 真正生成插件，再从生成目录启动隔离 HTTP 服务，在 Chrome 中导入客户端入口并执行最小 mount；检查错误和依赖网络请求。测试端口与数据目录遵循仓库约束。
- 客户端、服务端、测试入口分别做声明类型检查。客户端使用 DOM + 标准 ES 库且不自动注入 Node types；服务端使用 Node 类型；增加导出存在性检查，避免 JS 有函数而声明没有。
- 检查发布清单及客户端依赖闭包，明确禁止 Node builtin 和未提供解析策略的裸包依赖。

存量声明中存在 `Promise<Buffer>` 与 mock 返回 `Uint8Array` 的差别，客户端工具也有声明覆盖债务。应在分入口时一起明确二进制返回契约，而不是仅移动 `.mjs` 文件。

## 3. #839：把摘要焦点与扩展选择分开

### 3.1 设置字段本身并非原罪

如果产品确实允许用户设置“自动摘要优先保留决策和待办”，将附加指令持久化、传给 UI，并允许预设分享，都是合理的功能。遵循现有约定把协议从 43 升至 44，也不是架构问题。

问题在于同一个字符串同时表示两种不同东西：

- 面向模型的人类指令，例如“保留所有未完成事项”；
- 面向程序的控制信号，例如“选用某个扩展生成摘要”。

后一种用途会让扩展安装状态、字符串精确值、全局设置和预设导入共同决定运行行为。用户编辑、空白归一化或截断可能改变选择；相同文本可能在手动压缩中出现；多个扩展可能约定冲突。扩展未安装或抛错时，标记还可能被当作普通摘要指令传给默认模型。它不具有权限或身份凭据的意义。

因此应保留有产品价值的 `instructions`，让 Provider ID 和触发来源拥有自己的字段及类型。若 Provider 由扩展本地配置决定，并不需要进入 Web 协议；若用户要在 UI 中选择 Provider，协议与预设中有显式 ID 则完全合理，但导入预设不能隐式安装扩展或授予额外能力。

### 3.2 实际有多种压缩来源

| 来源                   | 现有路径                        | 扩展看到的 reason | #839 新字段是否传入 |
| ---------------------- | ------------------------------- | ----------------- | ------------------- |
| 用户手动 `/compact`    | `session.compact(用户指令)`     | `manual`          | 否                  |
| AI `compact_context`   | `session.compact(工具指令)`     | `manual`          | 否                  |
| 宿主空闲软上限         | `session.compact(设置中的指令)` | `manual`          | 是                  |
| SDK 在回合间隙检查阈值 | `_autoCompact("threshold", …)`  | `threshold`       | 否                  |
| SDK 上下文溢出恢复     | `_autoCompact("overflow", …)`   | `overflow`        | 否                  |

宿主通过 `reserveTokens = W - C` 将软上限注入 SDK，因此“宿主空闲软上限”和“轮内 SDK 阈值”可能由同一产品策略触发，却给扩展两套不同信息。

[#839 的新增调用点](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/server/agent-service.ts#L9321) 可以解决一条路径，不能代表统一的自动压缩接管。已有 `reason: threshold/overflow` 已经有类型价值，最小的根本改进是让宿主触发也带正确、显式的来源，并让所有路径经过同一个生命周期。

### 3.3 先修公开请求契约，再按需求增加 Provider

不必立即在宿主再建立一个与 Pi SDK 平行的插件总线。如果当前只有一个摘要扩展，首先补齐 SDK 的请求和事件元数据，继续用已有 hook 就足以解除暗号依赖。多提供者选择、配置和隔离有明确需求时，再升级为注册机制。

建议由 **Pi coding-agent SDK** 拥有以下管线：

```text
规范化请求并预占 operation
  → prepare（选切点、计算 token、固定历史版本）
  → 选择唯一 provider
  → 生成摘要或明确选择默认生成器
  → 结果校验
  → 宿主保留信息装饰
  → 最终校验及原子提交
  → 更新上下文投影并发送事件
```

宿主负责何时请求压缩、产品设置、模型策略、证据保留及 UI 快照。SDK 负责它实际拥有的会话状态、历史切点、取消和提交。这样用户手动、工具调用、空闲检查、轮内阈值和溢出恢复都可以复用同一实现。

以下是建议中的类型形态，**并非当前已经存在的 SDK API**：

```ts
type CompactionCause =
	| { kind: "manual"; initiator: "user" | "agent" | "api" }
	| { kind: "threshold"; policy: "host-soft-cap" | "sdk" }
	| { kind: "overflow" };

interface CompactionRequest {
	requestId: string;
	sessionId: string;
	cause: CompactionCause;
	willRetry: boolean;
	instructions?: string; // 只表达摘要内容偏好
	providerId?: string; // 来自当前会话的生效配置
}

type ProviderResult =
	| { decision: "summary"; summary: string; details?: JsonValue; usage?: Usage }
	| { decision: "use-default" }
	| { decision: "cancel"; message?: string };

interface CompactionProvider {
	id: string; // 扩展命名空间内的稳定 ID
	label: string;
	generate(
		request: Readonly<CompactionRequest>,
		input: Readonly<PreparedCompactionInput>,
		context: CompactionProviderContext, // 含 signal、受约束模型调用及日志能力
	): Promise<ProviderResult>;
}

// 拟议的 Pi ExtensionAPI
pi.registerCompactionProvider(provider);

// 新调用重载；compact(string | undefined) 保持原有含义
await session.compact({
	cause: { kind: "threshold", policy: "host-soft-cap" },
	instructions: policy.instructions,
	providerId: policy.providerId,
});
```

请求、Provider 选择及必要的配置在开始时绑定稳定会话身份，不在跨 `await` 后读取活动会话。`PreparedCompactionInput` 暴露规范化的待摘要内容、先前摘要及保留信息；不要默认暴露可随意变更 SessionManager 的宿主对象。

### 3.4 Provider 必须解决的契约

**唯一选择。** 每个请求先确定一个生成 Provider。重复 ID 在注册时拒绝；选择顺序可设为会话显式配置、宿主默认、SDK 默认。配置的 Provider 不存在时返回明确的 unavailable 状态，不能把它的 ID 当成摘要文本，也不能依赖加载顺序。显式 `use-default` 代表主动让渡。

**错误和取消。** `cancel`、超时、执行异常、Provider 不存在以及结果无效应是可区分结果。运行错误默认应显式失败；确实需要自动回退时，由宿主策略指定可回退的错误类别，并记录实际使用的 Provider。溢出恢复还应保留原本的 `willRetry` 语义。取消后要避免立即再次触发相同压缩的忙循环。

**截断所有权。** 普通 Provider 只生成摘要及附属信息。`firstKeptEntryId`、`tokensBefore` 和分支有效性由 SDK 计算。当前旧 hook 允许扩展返回这些字段，应作为 legacy 能力保留并验证；高级保留策略可以通过显式接口提出候选策略，由 SDK 重新 prepare 和校验。这样既允许专用记忆策略，也避免普通摘要器意外决定丢弃哪些历史。

**运行时校验。** TypeScript 不会校验外部 `.mjs` 扩展。SDK 应验证摘要类型、完整性和合理大小，details 的 JSON 形状及仓库 64KB 边界、usage 数值、切点与当前分支的关系。默认生成器对模型错误或截断的检查，也应成为 Provider 的统一完成性要求。

**会话一致性。** operation 必须在第一个 `await` 前预占，取消控制器局部持有，finally 只释放自己的 operation；提交前核对 session/branch/history revision。Provider 内递归压缩同一会话应明确拒绝，或通过显式延迟机制处理。不能允许 Provider 一边等待当前压缩完成、一边成为阻止它完成的回调。

**能力和预算。** 提供取消信号、受约束模型调用、超时与输出预算；需要额外工具或外部数据的 Provider 应显式声明能力。扩展上下文可以灵活，但不应默认把可重入的 `session.compact()` 当成生成接口交给它。

### 3.5 当前 SDK hook 不能直接视为 Provider 注册表

精确检查了 `@earendil-works/pi-coding-agent@1.1.0` 的发布包，相关实现与本地依赖一致。其 [`ExtensionRunner.emit`](https://unpkg.com/@earendil-works/pi-coding-agent@1.1.0/dist/core/extensions/runner.js) 会顺序执行各 handler：

- 后一个 truthy 结果整体替换前一个结果，`{}` 也可能抹掉前一个扩展的摘要。
- `cancel` 提前结束分发。
- handler 抛错会报告扩展错误并继续，最终可能落到默认摘要。

这适合作为需要兼容的旧事件语义，不能支撑“只有一个提供者、失败是否回退可预测”的新契约。新增 Provider 管线不能同时执行旧摘要器和新摘要器、最后再比谁返回了内容。建议新 Provider 选中时跳过 legacy 摘要生成；未配置时维持旧语义；诊断明确报告实际路径。观察与保留策略 hook 可以单独执行。

也不要混淆两套插件体系：`plugin-sdk` 的 `PluginHost` 面向 Web UI 插件；`session_before_compact` 属于 Pi SDK 扩展的 `ExtensionAPI`。在前者增加一个同名方法不会让后者自动具备 Provider 能力。如未来允许 Web 插件注册服务端 Provider，需要通过带稳定会话身份的宿主适配器接入同一 SDK 注册表，并说明生命周期和权限。

## 4. 其他值得一并修正的架构盲区

### 4.1 证据保留不能只装饰默认生成器

当前 [`installCompactionInstructions`](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/server/compaction-instructions.ts#L41) 包装 SDK 私有的 `_runDefaultCompaction`，并校验它的参数个数。它改写默认生成的指令、附加证据索引。

它不会在 `session_before_compact` 之前改写暗号。另一方面，扩展返回 `{ compaction }` 后，SDK 跳过默认生成器，因此依赖这个 wrapper 的证据索引保留也会被跳过。

如果证据索引是 pi-web-ui 的恢复能力，应把它放到所有生成器之后、提交之前的宿主保留信息阶段；否则 Provider 接管摘要就可能连带接管了它不该负责的系统不变量。装饰阶段应幂等，并计入最终摘要预算。

### 4.2 一个 `reserveTokens` 承担了两种预算

宿主用 `reserveTokens = W - C` 控制触发阈值；SDK 默认摘要生成又用 reserveTokens 推导摘要输出上限，并受模型 maxTokens 限制。因此调低输入软上限，可能间接抬高允许生成的摘要长度。这不是 #839 引入的问题，但新 Provider 不应继续继承这个耦合。

公开策略应分别表达 `triggerTokens`、`keepRecentTokens`、`maxSummaryTokens`。Provider 用摘要预算，不应从阈值差额推导它。先加独立摘要预算，再用公开阈值策略替代对 `getCompactionSettings` 的运行时覆盖。

### 4.3 单次同步提交不等于持久化事务

SDK 当前手动压缩在首次 `await abort()` 前没有预占专用 operation；扩展结果也直接提供切点和 token 信息。并发或重入需要 SDK 层保障，单靠宿主调用前检查是否 streaming 不够。

另一个存量边界是 SessionManager 先修改内存条目、索引和 leaf，再持久化；写盘失败可能使内存、磁盘和 agent 投影不同步。正式压缩提交应定义持久化失败时的回滚或恢复，并让 append 返回确切条目 ID。当前按摘要文本 `find` 已保存条目的方式还可能命中旧的同文摘要，Provider 更容易重复生成固定格式文本。

overflow 恢复还有一个需要明确的边界：SDK 在进入自动压缩前，可能已通过 context edits 省略失败的 assistant/tool 消息。因此取消压缩或 Provider 失败，并不天然表示上下文完全未变。新契约应明确这些编辑是独立提交的恢复动作，或将它们纳入同一次候选投影并在成功时提交。

这些问题应通过 SDK 的故障注入、并发和取消测试收敛，无需在 pi-web-ui 再复制一套 SessionManager。

### 4.4 热重载需要版本化整个模块图

[`pluginEntryUrl`](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/web/src/plugin-loader.ts#L243) 只修改 `entry.mjs?e=...&r=...`。入口中的 `./sdk/index.mjs` 解析后没有这些参数，因此旧依赖仍在浏览器模块表里；禁用 HTTP 缓存不能清掉当前页面的 ESM 模块表。

隔离 Node 原生 ESM 复现中，先加载入口 `?e=1`、修改依赖内容、再加载入口 `?e=2`，两次仍读到旧依赖的值 `1`。这是 ESM URL 身份的机制验证，未声称跑过真实浏览器热升级端到端测试。

建议按构建修订发布完整、不可变的模块图，例如 `/plugins/<id>/client-assets/<revision>/entry.mjs`，相对依赖自然继承 revision 路径。服务器必须真正保存并提供对应 revision 的产物，不能让所有 revision 都映射到可变的当前文件。较小实现也可以在构建时打包为内容哈希资源。升级完成后让 UI 加载新 revision，并清理旧实例的注册与资源。

### 4.5 配置链路重复，类型检查没有验证“字段真的到达”

本次漏转发不是字段类型错误，而是多个手写投影之间缺少覆盖约束。`preset-fields` 已有部分元数据，可以在其上逐步建立按用途声明的字段注册表：normalize、默认值、持久化、Web 可写、UI 可读、预设可分享分别显式声明。

可以生成投影和做编译期覆盖检查，但**不能把所有持久化字段自动加入分享或 Web 写入白名单**。安全上的允许列表仍要显式，只是由一份可检查的元数据驱动。配合少量贯穿 dispatch→settings→snapshot 的契约测试，比继续堆源码字符串测试更有价值。

## 5. 建议的分阶段路线

| 阶段              | 具体交付                                                                                                   | 兼容性和完成判据                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A：立即修复       | 补 `set_settings` 字段链路；修正已确认 mock 路径回归；升级器检查每个副本；文档明确当前仅 idle 路径带新指令 | 现有插件继续工作；消息写入、清空、重启恢复均可验证；客户端旧副本能被升级。         |
| B：SDK 运行态边界 | 新增 client/server/testing 入口和独立声明；发布清单；更新脚手架及示例；保留 legacy 入口                    | CLI 生成产物在 Chrome 真正加载；客户端类型无需 Node；旧导入兼容测试通过。          |
| C：最小压缩契约   | 上游 SDK 提供带来源的 compact 请求；统一所有自动路径；独立摘要预算；开放提交前宿主保留信息接口             | 无暗号也能区分 user/agent/host/SDK；手动焦点指令保留；证据索引在扩展摘要下仍保留。 |
| D：按需 Provider  | 会话范围注册与显式选择；结果验证；错误/取消/回退契约；串行化及提交一致性                                   | 重复 ID、缺失 Provider、并发、取消、重入、模型截断及持久化失败均有明确结果。       |
| E：收敛兼容层     | 迁移旧 hook 与暗号配置；移除私有 method/settings wrapper；版本化插件模块图；逐步引入配置元数据投影         | 声明最低 SDK 能力并可诊断降级；无双重摘要；主版本再删除旧入口和过渡代码。          |

C 可以先于 D 独立交付，不必等待完整 Provider 系统。B 与 C 也可以并行，二者分属不同 SDK 契约。

迁移时不能猜测任意 `autoCompactionInstructions` 是否暗号：保留其原有文字含义；只有已知扩展声明的旧标记才可精确迁移，并在配置版本中记录。过渡期只允许一个摘要生成路径，避免新旧机制同时调用模型。

宿主应按能力检测新 SDK API，并声明最低支持版本，不能只依赖宽范围依赖或私有函数的参数个数。旧 SDK 可以保留有限、明确的 legacy 适配模式；诊断应能看到它的覆盖范围。

建议以五个规模可控的后续 PR 推进：先修消息分发与副本升级；再拆运行态发布；上游补请求来源和统一生命周期；按实际需求引入 Provider 及一致性保障；最后移除适配层并修正模块图版本管理。

## 6. 验证与审查边界

在 `d5ee3b2` 的独立临时完整快照中，用现有依赖执行：

- `plugin-sdk-browser-safe.test.ts`
- `plugin-host-primitives.test.ts`
- `auto-compaction-instructions.test.ts`
- `preset-share.test.ts`

结果：**4 个测试文件、90 个测试全部通过。** 临时快照执行完已删除，未修改当前工作区源码。

另在独立快照中增加并执行了一个行为复现测试，证实真实 `handleSettingsMessage` 接受消息但不转发新字段；直接加载 #838 合并提交的 SDK，实测了表中四个路径差异；用临时文件实测了 ESM 入口 epoch 不刷新依赖的问题。

已核验锁定的 SDK `1.1.0` 发布包相关源码与本地依赖一致。未运行全仓测试、真实浏览器脚手架加载或生产压缩端到端测试；未以“现有单测全绿”替代这些验证，也未把建议中的新 API 当成现有功能。

本次只新增本审查文档。架构方案均为建议，未修改业务实现、发布 SDK 或调整运行中配置。
