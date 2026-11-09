# 单测性能审计：现状、已改、待解（供外部评审）

> 目的：把这个套件「为什么慢、慢在哪、试过什么、还卡在哪」一次性摆清楚，便于外部给出思路。
> 所有数字都是本机实测（非估算），复现命令见文末。写于 v0.119.0 阶段。

## 0. TL;DR

- 套件规模：`tests/unit/` **1029 个文件 / 12,480 条用例**，纯 `node` 环境 + `pool: "forks"`。
- 改之前全量：**墙钟 704s**，用例累计 1955s，11 条假红（真因是超时预算零余量）。
- 现在（全部实测、全绿）：
  - **默认 `npm test`（快池 1023 文件 / 12.4k 条）：182s**（原 704s，**3.9×**）。
  - **`npm run test:integration`（重型 6 文件 / 111 条）：墙钟 135.2s、用例累计 443s**（原 1064s，**−58%**）。
  - 两个池合计 ≈318s（原 704s）。
- 两个真正生效的杠杆（都不是“少跑用例”）：
  1. **分层**：快池 8 worker / 重型池 4 worker，各自预算。worker 数对两个池的效应完全相反（见 §2.2、§2.3）。
  2. **产品侧 `git()` 的两层缓存**：filter 探测（每次调用多跑一个子进程）+ 仓库身份查询（`--show-toplevel` 等 82 次/管线），
     合计把管线内 git 子进程从 462 → 约 106，重型池两轮共砍 58%（见 §3.1、§3.1.1）。
- 剩下的硬成本（已量化、未改）：每条验证命令 ~2.7s 的 PowerShell 主管进程冷启动；快池 44% 时间在 ESM 模块图求值（`isolate:false` 能吃掉 36%，但会引入顺序依赖，见 §3.2）。
- 历史疑点已闭环：那“3 次调用 16.7s”已定位并降到 **11.1s**，机制见 §3.1。

## 1. 环境与测量方法

| 项              | 值                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| OS / CPU / RAM  | Windows，12 物理核 / 24 逻辑核，32GB                                                                                                   |
| Node            | v25.9.0（`engines.node >= 22.19`）                                                                                                     |
| 测试框架        | vitest 5.0.1 + vite 8 + tsx，`pool: "forks"`，`isolate` 默认（true）                                                                   |
| 计时来源        | `npx vitest run --reporter=json --outputFile=<tmp>/x.json`，用 `testResults[].startTime/endTime` 与 `assertionResults[].duration` 汇总 |
| 墙钟 / 用例累计 | 墙钟 = 最早 startTime 到最晚 endTime；用例累计 = 各文件 duration 之和                                                                  |
| 「并行系数」    | 用例累计 ÷ 墙钟。4 worker 下上限 4.0；明显小于 worker 数就说明时间花在 fork / 空转上                                                   |

逐条用例耗时观察器：`tests/lib/test-timing-reporter.mjs`（本次新增，见 §3），每条用例打「结束时刻 + 耗时」。

## 2. 现状数字

### 2.1 全量（改动前后）

|                                   | 文件 | 用例   | 墙钟                       | 用例累计 | 并行系数  | 失败            |
| --------------------------------- | ---- | ------ | -------------------------- | -------- | --------- | --------------- |
| 改动前、4 worker                  | 1028 | 12,479 | **704s**                   | 1955s    | 2.78      | 11 条（5 文件） |
| 修超时预算/清理竞态后、4 worker   | 1028 | 12,487 | **559s**                   | 1512s    | 2.70      | 0               |
| 分层后：快池 8 worker             | 1023 | 12,383 | **172–186s**               | 502–530s | 2.70–3.08 | 0               |
| 分层后：重型池 4 worker（优化前） | 6    | 111    | ≈320s（按 1064s/3.3 估算） | 1064s    | 3.32      | 0               |
| **加 git 探测缓存后：重型池**     | 6    | 111    | **167.6s**                 | 557s     | 3.32      | 0               |
| **加 git 探测缓存后：快池**       | 1023 | 12,384 | **182.4s**                 | 484s     | 2.65      | 0               |

### 2.2 快池 worker 扫描（同一份代码、同一批 1023 文件）

| maxWorkers | 墙钟     | 用例累计 | 并行系数 | 结果                                                                                  |
| ---------- | -------- | -------- | -------- | ------------------------------------------------------------------------------------- |
| 4          | 280s     | 409s     | 1.46     | 绿                                                                                    |
| 8          | **186s** | 502s     | 2.70     | 绿（当前默认）                                                                        |
| 12         | 172s     | 777s     | 4.51     | 1 条假红：`canvas-scheduler` 内部 `vi.waitFor({timeout:15_000})` 被 12 路争抢拖过预算 |

注意用例累计随 worker 数上升（409 → 502 → 777s）：这是真实的争抢膨胀，说明机器在 8 之后已接近饱和。

同一批文件上试过的其他「复用」变体（详细分析见 §3.2）：

| 变体                                              | 墙钟                                          | 结果                        |
| ------------------------------------------------- | --------------------------------------------- | --------------------------- |
| `--isolate=false`（复用模块图）                   | 117.3s（40 条失败）/ 隔离 7 文件后 >340s 自旋 | 否决（见 §3.2）             |
| `experimental.fsModuleCache`（复用编译产物）冷/热 | 187.5s / 189.9s                               | 无收益（transform 只占 3%） |

### 2.3 重型池（6 个文件，4 worker 稳态）

| 文件                                          | 用例 | 耗时 | 单条最慢 |
| --------------------------------------------- | ---- | ---- | -------- |
| `device-hub-artifact-integration.test.ts`     | 30   | 304s | 34.2s    |
| `device-local-integration.test.ts`            | 22   | 280s | 32.6s    |
| `device-hub-integration.test.ts`              | 18   | 218s | 35.3s    |
| `task-workspace.test.ts`                      | 13   | 122s | ≈40s     |
| `canvas-workspace.test.ts`                    | 11   | 77s  | 21.2s    |
| `device-center-runtime-code-artifact.test.ts` | 17   | 63s  | 15.2s    |

重型池 worker 扫描：**4 是上限**。抬到 8 worker 时同一条用例从 30s 膨胀到 **83s**，另有 4 条撞 60s/90s 预算报超时（不是功能坏）。

## 3. 已经改了什么（本次提交范围）

| 文件                                              | 改动                                                                                        | 理由                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/lib/test-timing-reporter.mjs`（新增）      | 逐条用例打印「结束时刻 + 耗时」，收尾打最慢文件/最慢用例 Top；`PI_TEST_TIMING=all/slow/off` | `vitest.config.ts` 里 `silent: true` + `onConsoleLog: () => false` 把默认 reporter 的 per-file 行全吞了，全量跑 12 分钟零输出，无法定位慢点 |
| `vitest.config.ts`                                | 接上 reporter；按 `suite-partition.mjs` 排除重型文件；`PI_TEST_ALL=1` 可一次跑全            | 快慢分层                                                                                                                                    |
| `vitest.integration.config.ts`（新增）            | 重型池专用配置：`include: HEAVY_SUITE`、4 worker、90s 预算                                  | 重型文件在同一池里会互相拖慢                                                                                                                |
| `tests/lib/suite-partition.mjs`（新增）           | 重型清单 + 两个池的 worker/预算常量（单源）                                                 | 避免配置与守卫各写一份                                                                                                                      |
| `tests/unit/test-suite-partition.test.ts`（新增） | 守卫：重型清单存在且不重复、**两池并集 == `tests/unit/**` 全集**、CI 两个池都跑             | 防止「被 exclude 后再也没人跑」                                                                                                             |
| `package.json`                                    | `test:integration`、`test:all`                                                              | 入口                                                                                                                                        |
| `.github/workflows/ci.yml`                        | `Unit tests` 后再跑 `npm run test:integration`                                              | CI 不丢覆盖                                                                                                                                 |
| 6 个重型测试文件                                  | 超时预算 20–30s → 90s（依据写在文件注释里）；`EBUSY` 清理加 `maxRetries/retryDelay`         | 原预算零余量 → 满载必假红，且每条假红白烧 30s（11 条共烧 367s = 当时总时间的 18.8%）                                                        |
| `tests/unit/canvas-scheduler.test.ts`             | 内部 `vi.waitFor` 15s → 30s                                                                 | 与 90s 用例预算不匹配                                                                                                                       |
| `docs/development.md`                             | 新增「测试耗时观测」「两个池」两节                                                          | 规则落文档                                                                                                                                  |

假红根因（已验证）：这 6 个文件单跑最慢 19.2s / 满载 31s+，撞 30s 墙；`device-hub-integration` 单跑 127s 全绿、并行 290s 且 3 条超时 —— **纯负载敏感，不是功能回归**。

### 3.1 产品侧架构优化：`git()` 的 filter 探测缓存（本轮最大收益）

用 `performance.now()` + child_process 拦截做了分层计时（管道拆准备/验证/确认三段）：

```
[probe] prepare 953ms   verify 6199ms   confirm 7051ms
[probe] spawns=463  spawnMs=14486  (git ×462 = 11.8s，powershell.exe ×1 = 2.7s)
[probe] git exec(测试自己跑的 16 次)=505ms   store.transact ×7=25ms
```

结论：一条 3 调用管线里 **462 次 git 子进程**，根因是 `server/workspace-handle.ts` 的 `git()`
**每次逻辑调用都先跑一遍 `git config --get-regexp ^filter\..*` 探测**（为了中和恶意 clean/smudge filter），
即「一次逻辑调用 = 两个子进程」。

改法：按**仓库配置文件指纹**（`config` / `config.worktree` 的 path+mtime+size，含 linked worktree 的
`commondir` 解析）缓存要透传的 `-c` 参数。任何不确定都**不缓存、退回每次探测**：找不到 `.git`、
配置里有 `include`/`includeIf`（外部文件指纹不可靠）、stat/read 失败、缓存超 64 条。
捕获「中途新增 filter」的回归测试：`tests/unit/workspace-handle.test.ts` 的
「refreshes the filter-override cache when repo config changes mid-session」。

效果（同机、同配置、4 worker，全部绿）：

| 文件                                  | 优化前    | 优化后            | 变化 |
| ------------------------------------- | --------- | ----------------- | ---- |
| `device-hub-artifact-integration`     | 304s      | **167s**          | −45% |
| `device-local-integration`            | 280s      | **154s**          | −45% |
| `device-hub-integration`              | 218s      | **108s**          | −50% |
| `task-workspace`                      | 122s      | **60s**           | −51% |
| `canvas-workspace`                    | 77s       | **37s**           | −52% |
| `device-center-runtime-code-artifact` | 63s       | **31s**           | −51% |
| 合计 / 重型池墙钟                     | 1064s / — | **557s / 167.6s** | −48% |

单条最贵用例（`completes full pipeline`）单跑从 **16.7s → 11.1s**。

#### 3.1.1 第二轮：仓库身份查询缓存（管线里 82/188 次是同三个查询）

缓存掉 filter 探测后再测，`workspace-handle.git()` 仍被调用 188 次/管线，其中：

```
41x  rev-parse --path-format=absolute --git-common-dir
25x  rev-parse --show-toplevel
16x  rev-parse --absolute-git-dir        ← 这三项合计 82 次，全是对「目录」恒定的查询
16x  branch --show-current     16x  rev-parse HEAD     16x  status --porcelain --untracked-files=all
```

于是按同一指纹机制缓存这几个查询（命中 **77/82**）。三条踩坑都写进了代码注释：

1. 模式表要算上 argv 里的 `rev-parse` 前缀 —— 第一版漏了，缓存一次都没命中，还被误判成「无收益」；
2. key 要带 **cwd** —— 主仓与其工作树共享 config（指纹相同），但 `--show-toplevel` 各自不同，漏 cwd 会串值；
3. 指纹要含 **`.git` 指针文本 + commondir 文本** —— `task-workspace` 的「工作树指针替换」用例会把 `.git` 换成指向主仓，
   漏了指针内容就会命中旧缓存、绕过身份校验（这条是被重型用例抓到的真回归）。

效果（同机、4 worker，全绿）：重型池 **167.6s → 135.2s**（用例累计 557s → 443s）。

| 文件                                  | filter 缓存后 | + 身份查询缓存 |
| ------------------------------------- | ------------- | -------------- |
| `device-hub-artifact-integration`     | 167s          | **135s**       |
| `device-local-integration`            | 154s          | **122s**       |
| `device-hub-integration`              | 108s          | **96s**        |
| `task-workspace`                      | 60s           | **42s**        |
| `canvas-workspace`                    | 37s           | **26s**        |
| `device-center-runtime-code-artifact` | 31s           | **22s**        |

### 3.2 「复用」类优化：四个方向已逐个实测

快池的 182s 到底花在哪，vitest 自己就给了分账：`tests 44% / import 44% / environment 8% / transform 3%`。
据此把四种「复用资源」的想法都跑了一遍：

| 复用对象                  | 做法                                           | 实测                                                                                                                  | 结论                                                                                                                                                                                                                                                               |
| ------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 编译产物（transform）     | `experimental.fsModuleCache: true`，跑两次对比 | 冷 187.5s / 热 **189.9s**                                                                                             | **无效**。transform 只占 3%，缓存它等于没省                                                                                                                                                                                                                        |
| 模块图（ESM 求值）        | `--isolate=false`（worker 内复用模块图）       | 首测 **117.3s**（−36%）但 **40 条失败**；把这 7 个文件排除后再测：**>340s 未结束、单 worker 烧 315s CPU（疑似自旋）** | **否决**。`mcp-manager`/`engine-cli`/`shared-state-persistence`/`file-integrity`/`file-transfer-routes`/`native-cli-lifecycle`/`plugin-removal` 的 mock/env/单例串到了别的文件；即便隔离它们仍会自旋。isolate:false 让整轮变成「依赖文件顺序」，确定性倒退，不采用 |
| 子进程（git）             | 缓存 `git config` filter 探测（**已合入**）    | 重型池 1064s → **557s**                                                                                               | ✅ 性价比最高（见 §3.1）                                                                                                                                                                                                                                           |
| 子进程（PowerShell 主管） | 未改：每个验证命令一个 PowerShell 主管进程     | 单次冷启动 **2.7s**，占集成管线端到端 ≈18%                                                                            | 最大剩余固定成本。要复用就得改warm 主管（常驻 named pipe），属独立改造                                                                                                                                                                                             |

还有两个“复用”经估算**不值得做**：

- **共享模板仓**（beforeAll 建一次，逐用例 `fs.cp`）：实测 `fs.cp` 5 次 143ms、`git init+commit` 6 次 186ms，
  → 每条只能省 ≈0.15s，111 条共 ≈17s（占重型池 3%），不值重构风险。
- **合并小测试文件**（减少 fork）：`≤40 行` 的 53 个文件全并了也只省 ≈43 次 fork ≈ 4s 墙钟。

因此快池要想再赚那 36%，只能回到 `isolate:false`；而它的前提是把上面 7 个“有状态”文件
拆成独立隔离池——等价于维护一张“状态黑名单”，需要你拍板是否接受这份脆弱性。

### 3.3 快池的下一个真杠杆：78 个文件各花 ~2s 载入 agent-service

用两个探针文件量化（同一环境、vitest 内计时）：

| 探针                                                    | Duration                                | 说明                                          |
| ------------------------------------------------------- | --------------------------------------- | --------------------------------------------- |
| 只 `import { ClientSession } from server/agent-service` | **3.00s**（import 52% + transform 47%） | 载入 `agent-service.ts` → pi SDK 的整张模块图 |
| 空用例                                                  | **123ms**                               | 基线                                          |

- `tests/unit/` 有 **78 个文件**在运行期 import `server/agent-service.js`（只有 1 个是 `import type`）；
- 其中 63 个通过 `tests/helpers/fake-session.ts` 进来，而该 helper 只用 `ClientSession.prototype` 做 `Object.create` 与 accessor 判定——**为了一个原型对象付整张 SDK 图的代价**；
- 量级：78 × ≈2s ≈ **150s CPU**（快池用例累计才 ~484s）。

**建议做法（未执行，需协调）**：把 `ClientSession` 抽到轻模块 `server/client-session.ts`，`agent-service.ts` re-export；
`fake-session.ts` 改从轻模块取原型。语义零变化，预计 **快池 −25~30%**。
未动手的原因：`server/agent-service.ts` 正被并行会话修改，同文件改动会互相踩。

### 3.4 又试并否决的三条（省得后人重走）

| 想法                                                                                      | 实测                                                                                               | 结论                                          |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 抽出 `server/client-session.ts`，让 `fake-session.ts` 不再 import agent-service           | 63 个 fake-session 消费者里 **52 个自己也 import agent-service**，只有 **11 个**能受益（≈22s CPU） | 弃：收益配不上跨模块重构                      |
| 预编译 supervisor 的 C# 成 DLL（`Add-Type -Path`）躲开现场编译                            | `powershell -NoProfile -Command 1` = **1.18s**（进程启动）；`Add-Type -TypeDefinition` 只 **73ms** | 弃：那 2.7s 是 PS 冷启动 + 命令本身，不是编译 |
| 按指纹缓存仓库身份查询（`--show-toplevel` / `--git-common-dir` / `--show-object-format`） | 单测三次中位数 11.1s → **11.7s**（落在噪声内）                                                     | 弃：未证明收益，不合并复杂度                  |

顺带把管线剩余的 git 调用归属量清了（一条 `prepare→verify→confirm`，经 `workspace-handle.git()` 共 **188 次**）：

```
82x rev-parse(纯 flag)   16x rev-parse HEAD   16x branch   16x status   12x ls-files
 8x config                6x cat-file          6x read-tree 6x hash-object
 6x update-index          6x write-tree        2x rev-list  …（另有 PowerShell 1x = 2.7s）
```

也就是说：缓存掉 filter 探测后，剩下的是**管线自己反复查仓库状态**（rev-parse/branch/status/ls-files 共 126 次）。
要再砍只能把这些查询在调用方合并（如一次 `rev-parse` 同时取 toplevel/format），属产品侧重构，收益估计 10–15%。

### 3.5 已定位但未改的其余成本

- 验证阶段每个命令都通过 **PowerShell 主管进程**跑（`server/device-center/local-verification.ts`
  的 named-pipe + `-EncodedCommand`）——Windows 上冷启动实测 **2.7s/命令**。这是取消/停止语义
  的实现基础，要改得快先得换主管机制，属独立改造。
- `server/process-utils.ts` 的 `snapshotProcessTree` / `lookupProcessCommandLine` 用 `Get-CimInstance`
  （WMI）拿进程表，单次也是秒级；目前只在 `bg-servers` 与排查路径上，不在集成管线主路径。

## 4. 已排除的假设（别再往这些方向试）

| 假设                                         | 实测                                                                | 结论                      |
| -------------------------------------------- | ------------------------------------------------------------------- | ------------------------- |
| 脚手架建仓太慢（git init/config/commit/add） | 6 次 git 子进程共 **186ms**；单次 git ≈30ms                         | 否                        |
| fixture 复用能大幅提速                       | 一条只需要 0.3s 的用例（含完整 beforeEach + Hub 启动）= **504ms**   | 收益 ~0.3s/条，不解决问题 |
| 测试里有大量 `sleep`/固定等待                | 6 个重型文件里 `setTimeout` 级等待只有 2–3 处（10s 级的取消类用例） | 否                        |
| 伪计时器被误用                               | 全仓 78 个文件用 `vi.useFakeTimers`，但重型 6 文件基本不用          | 否                        |
| 提高 worker 数就行                           | 快池 4→8 有效（280→186s）；重型池 4→8 **变慢且假红**                | 分池才行                  |
| `silent` 只是输出问题                        | 是输出问题的同时，也掩盖了「每条用例 15–35s」这个事实               | 已修                      |

## 5. 结论与仍开放的点

### 已闭环（本轮已答）

| 原疑点                     | 答案                                                                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1：3 次调用为何 16.7s     | 不是 `store.transact`（7 次共 **25ms**）、也不是测试自己的 git（16 次 505ms）。是**产品 `git()` 每次调用多跑一次 `git config` 滤波探测**：一条管线 462 次 git 子进程（11.8s）+ 1 次 PowerShell 主管（2.7s）。已在产品侧按配置指纹缓存修复 → 同一条用例 **16.7s → 11.1s**，重型池 −48% |
| Q2：快池 fork 开销怎么根治 | 分账实测为 `tests 44% / import 44% / environment 8% / transform 3%`。所以 `fsModuleCache`（缓存 transform）**无效**；`isolate:false`（复用模块图）**有效 −36% 但引入顺序依赖**；把 worker 从 4 抬到 8 是当前最优折中                                                                  |
| 砍用例能不能提速           | 能，但只值 ≈60s（§5）。重型池的 557s 是真实工作，删用例是最后手段                                                                                                                                                                                                                     |

### 仍开放（需要拍板/需要独立改造）

1. ~~抽出 `client-session.ts`~~ —— 已量过否掉：只有 11 个文件能受益（见 §3.4）。
2. **PowerShell 主管进程常驻化**：每条验证命令 2.7s 冷启动 ≈ 集成管线端到端 18%。改成 warm 主管
   （进程复用 + 常驻 named pipe）能拿回大头，但属取消/停止语义的独立改造，风险在产品侧不在测试侧。
3. **重型文件的真并行**：并发上限实测 4–5 路（8 路即破预算）。要再快只能把 218–304s 的串行链拆成多文件，
   但拆文件不减少总工作量，收益取决于负载均衡，**预计 ≤10%**；优先级低于上面两条。

## 6. 复现命令

```bash
# 逐条耗时（默认 all；slow=只打 ≥1s；off=只留小结）
npm test
PI_TEST_TIMING=slow npm test

# 快池 / 重型池 / 全量
npx vitest run                       # 快池（8 worker，按 suite-partition 排除重型）
npm run test:integration             # 重型池（4 worker，90s 预算）
npm run test:all                     # 两个都跑
PI_TEST_ALL=1 npx vitest run         # 一次跑全（不分池）

# worker 扫描
npx vitest run --maxWorkers=4|8|12

# 机器可读的逐用例计时
npx vitest run --reporter=json --outputFile=<tmp>/timing.json

# 单条用例探针（重型文件里最贵的那条）
npx vitest run tests/unit/device-hub-integration.test.ts -t "completes full pipeline"
```

## 7. 关键源码位置

| 位置                                                    | 作用                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `vitest.config.ts` / `vitest.integration.config.ts`     | 两个池的配置（worker 数、超时、reporter、exclude/include）                       |
| `tests/lib/suite-partition.mjs`                         | 重型清单与两个池的常量（单源）                                                   |
| `tests/lib/test-timing-reporter.mjs`                    | 逐条用例计时 reporter                                                            |
| `tests/unit/test-suite-partition.test.ts`               | 分层守卫（两池并集 == 全集）                                                     |
| `server/device-center/store.ts`                         | `transact()` / `persist()`：全量 `structuredClone` + WAL + index 重写（Q1 嫌疑） |
| `server/device-center/hub-transaction-log.ts`           | WAL append（每次 `open`）                                                        |
| `server/device-center/device-integration.ts`（1159 行） | 真 git 物化 / 真命令验证的执行体                                                 |
| `docs/development.md` §「测试耗时观测」「两个池」       | 现行的耗时观测与分层规则                                                         |
