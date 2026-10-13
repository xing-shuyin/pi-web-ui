# 预设分享（导入 / 导出 / 社区共享仓库）

> 代码：`server/preset-share.ts`（纯逻辑 + 编排）、`server/settings-service.ts`（port 适配）、
> `server/dsh/dsh-agent-service.ts`（DSH 的 port 适配）、`web/src/components/PresetShareModal.tsx`（三页签面板）、
> 共享仓库 [xing-shuyin/pi-web-ui-presets](https://github.com/xing-shuyin/pi-web-ui-presets)。

设置预设（**设置 → 预设**）原本只能在本机保存/应用。现在它是**可交换的文件**：能导出成 JSON、
按网址导入、一键发到社区仓库，并在面板里浏览别人分享的预设。

## 1. 三条路径

| 路径        | 入口                                                         | 走哪条通道                                                | 落点                                                  |
| ----------- | ------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------- |
| 导出 / 分享 | 预设区顶部「分享预设」主按钮，或预设行的分享图标，或面板页签 | `preset_export` / `preset_share`                          | 剪贴板 / 下载 `.json` / 社区仓库 Issue                |
| 导入        | 预设区顶部「导入预设」按钮，或面板「导入」页签               | `preset_import`（粘贴/文件）、`preset_import_url`（网址） | 本地 `presets` 存储（同名覆盖），可选立即应用         |
| 浏览分享    | 预设区顶部「浏览共享」按钮，或面板「浏览分享」页签           | `preset_catalog`                                          | 拉仓库 `index.json` → 列表 → 一键导入（复用网址导入） |

三个顶部按钮打开的是同一个面板（`PresetShareTab` 决定先落在哪个页签），不再需要在面板里先切页签。

设置区把三块内容合并成一张卡片（**引擎预设 / 权限两个下拉 + 设置预设列表**）：原来 Agent 预设与
权限各有一份只读列表（逐条列名称 + 说明），精简成下拉框 + 一行当前值说明；权限只剩一个下拉。

**为什么导入/抓取必须在服务端**：下发给浏览器的 `UiSettingsPreset` 是**裁剪视图**（只有
name/promptMode/customSystemPrompt/promptTemplate/promptOverrides/disabledSkills/disabledExtensions/
reviewPrompt/reviewDisabledSkills），完整字段只存在服务端的 `SettingsPreset` 里；而且浏览器直接抓
raw.githubusercontent.com 会撞 CORS。所以「解析 → 净化 → 落盘」全在服务端做，前端只负责展示与确认。

## 2. 交换格式（`pi-web-ui-preset` v1）

```jsonc
{
	"format": "pi-web-ui-preset",
	"version": 1,
	"name": "预设名", // 必填，≤60 字；导入后的预设名（同名覆盖）
	"description": "适合什么场景", // ≤500 字
	"author": "github 用户名", // ≤80 字
	"tags": ["编程", "极简"], // ≤8 个，单条 ≤24 字
	"createdAt": "2026-01-01T00:00:00.000Z",
	"appVersion": "0.99.0", // 生成端的包版本
	"settings": {/* 见下 */},
}
```

`settings` 与 `server/client-state.ts` 的 `SettingsPreset` 同构，**字段白名单 = `ClientSettings` 全集**
（47 个，清单与分组在 `server/preset-fields.ts`，前后端共用）：

| 分组                      | 字段                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt` 提示词           | `promptMode` · `customSystemPrompt` · `promptTemplate` · `promptOverrides` · `reviewPrompt` · `reviewDisabledSkills`                                                                                                                                                                                                         |
| `tools` 工具与开关        | `disabledAgentTools` · `disabledPluginTools` · `toolPromptOverrides`（逐工具文案）· `toolLazyLoading` · `readDirEnabled` · `toolApprovalEnabled` · `toolWatchdogTimeoutMs` · `questionnaireEnabled` · `editSoftEnabled` · `terminalToolsEnabled`                                                                             |
| `terminal` 终端接管       | `terminalBash` · `terminalBashIdleMs` · `terminalBashMaxForegroundMs`                                                                                                                                                                                                                                                        |
| `skills` 技能与扩展       | `disabledSkills` · `disabledExtensions` · `skillsFullText`                                                                                                                                                                                                                                                                   |
| `ai` 模型行为与专用提示词 | `retryMaxAttempts` · `softCapTokens` · `softCapByModel` · `subagentDefaultModel` · `visionBridgeEnabled` · `visionBridgeModel` · `visionBridgePromptMode` · `visionBridgePrompt` · `scmCommitMsgPromptMode` · `scmCommitMsgPrompt` · `planModePromptMode` · `planModePrompt` · `goalModeEnabled` · `parallelReminderEnabled` |
| `ui` 界面与交互偏好       | `uiLayout` · `disabledPlugins` · `thinkingWrap` · `toolsWrap` · `toolImagesEnabled` · `keepRecentMessages` · `showForkedParentSessions` · `quickPhrases` · `quickPhrasesEnabled` · `devNoCache` · `autoReload`                                                                                                               |
| `engine` 引擎默认         | `defaultAgentPreset` · `defaultPermissionPreset`                                                                                                                                                                                                                                                                             |

**仍在预设之外**（不在 `ClientSettings` 里，各有自己的存储）：标记开关（`markersEnabled`/`disabledMarkers`）、
审批规则库（`approval-rules.json`）、子代理模板库（`subagent-templates.json`）、以及纯前端 localStorage 的
偏好（墙纸、宽屏聊天列、present 自动预览、标题设置、声音/TTS、通知、输入历史）。

**字段可选**：旧版文档（只有 19 个字段）与「只导入一部分」都靠 `SettingsPreset` 的 `Partial` 语义落地 ——
应用预设时缺哪个字段就**保持当前值**。单测用编译期断言守「`ClientSettings` 的每个字段都在清单里」。

JSON Schema 也在共享仓库里：`schema/preset.schema.json`、`schema/index.schema.json`。

## 3. 导入纪律（白名单 + 上限 + 收口）

导入的外部 JSON **绝不直接摊进设置**，四道闸门：

1. **形状**：`format` 必须等于 `pi-web-ui-preset`、`version` 必须是 `1`、`name` 非空、`settings` 是对象；
   失败给**稳定的 errorKey**（`presets.import.format` / `.version` / `.name` / `.settings` / `.parse` /
   `.tooLarge` / `.empty` / `.shape` / `.noFields`）与本地化文案。单元素数组也接受（有人会包一层数组）。
2. **白名单 + 类型**：只认上面那 47 个字段；类型不符的**丢弃**（不抛错）并在预览里列出（`rejected`）；
   未知字段列进 `ignored`（旧版客户端/拼错字段的提示）。列表字段去空白、去重、单条 ≤200 字、≤500 条；
   映射字段 ≤200 条；长文本字段 ≤100KB。`disabledAgentTools`/`softCapTokens`/`softCapByModel`/
   `retryMaxAttempts`/`skillsFullText` 走应用侧**同一批归一化函数**（`tool-manager` / `soft-cap` /
   `client-state`），所以「导入的预设」和「本地保存的预设」语义一致。
3. **上限**：单个文档 ≤512KB（`PRESET_JSON_MAX_BYTES`，与仓库收录脚本一致）。
4. **抓取收口**：网址导入只允许 `http(s)`，且**拒绝内网/回环/链路本地/`.local`/`.internal`/IPv6 本地**
   （`isBlockedHost`，SSRF 收口）；带 10s 超时与大小上限，只走注入的 `Fetcher`（默认
   `update-check.ts` 的 `defaultFetcher`，因此跟随全局代理配置）。

**两段式**：前端先发 `dryRun: true` 拿预览（名称、说明、作者、标签、将写入的字段、被忽略/被丢弃的字段、
摘要徽标、自定义提示词/模板/审查提示词片段、是否覆盖同名），用户确认后才发 `dryRun: false` 真正落盘
（可选 `apply: true` 立即应用）。导入成功会推 `settings_state` + 一条 notice。

**可选导入**：确认时带 `fields: string[]`（最后一个 `dryRun` 预览里的字段名，按分组/按字段勾选，默认全选）→
服务端只把勾选的字段写进预设；未勾选的字段不落盘，应用时保持当前值。名单里出现白名单之外的名称会被过滤掉；
名单为空数组 = 一个都不勾，服务端回 `ok:false` 并拒写。不给 `fields` = 全量（旧客户端行为不变）。

## 4. 社区共享仓库

默认仓库 `xing-shuyin/pi-web-ui-presets`（`PI_WEB_PRESET_REPO` 可换成自己的 fork / 自建仓库）。结构：

```
index.json                     # 目录（浏览列表的唯一来源）
presets/<slug>-<sha1前7>.json  # 收录的预设文件
schema/…                       # 两个 JSON Schema
scripts/ingest-preset.mjs      # Issue → 收录（校验 → 写文件 → 更新 index.json）
scripts/validate-repo.mjs      # 仓库自检（PR/push 跑）
.github/workflows/ingest-preset.yml    # 标题以 [preset] 开头的 Issue：打开/编辑 → 自动收录 → 评论 → 关闭
.github/workflows/validate-presets.yml # index ↔ 文件自洽
```

**一键分享**（`preset_share`）——服务端按「用户要动手的程度」依次尝试三条落地路径：

1. **gh CLI**（装了且已登录）——全自动：
   `gh issue create --repo <repo> --title "[preset] <name>" --body-file <临时文件>`
   （`PI_WEB_PRESET_GH` 可指定 gh 路径；正文走临时文件，不受命令行长度限制）；
2. **GitHub API + 令牌**（无 gh 也能全自动）：令牌取 `PI_WEB_PRESET_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`，
   有令牌就 `POST https://api.github.com/repos/<repo>/issues`（走同一个注入的 Fetcher，因此跟随代理设置）；
   令牌无效/无权时错误体里的 message 会一并回报；
3. **预填网页**（不需要任何凭据）——前端复制 JSON 后打开建 Issue 页。**大多数情况点一下 Submit 就行**：
   正文能塞进 URL（编码后 ≤7K）时链接里就**预填了正文且不带 `template=`**（GitHub 在带 template 时会忽略
   body，两个一起给反而要手动粘）；正文太大才退回模板页，并把 JSON 放进剪贴板让用户粘。

回执 `method` 为 `"gh"` / `"api"`（两者都已建好 Issue，前端直接打开 URL）或 `"browser"`（前端复制 JSON + 打开链接）。
仓库 Action 校验通过后写入 `presets/`、更新 `index.json`、评论并关闭 Issue（失败则评论原因 + 打 `needs-fix`，改完正文自动重试）。

**浏览列表**（`preset_catalog`）：拉 `PI_WEB_PRESET_CATALOG_URL`（默认
`https://raw.githubusercontent.com/<repo>/main/index.json`），解析 `index.json` →
逐条过滤（`id`/`name`/`file` 必填、`file` 必须是仓库内相对路径、挡 `..` 与绝对地址、`id` 去重、
≤500 条）→ 按 `updatedAt` 倒序 → 回执。**5 分钟进程内缓存**（`refresh: true` 绕过）；
抓取失败时**保留上一次成功的列表**（`cached: true`），离线只是列表变旧。列表里的每条都能直接
「导入」（复用网址导入，URL 由 raw 基址拼出）或跳来源 Issue。

## 5. 环境变量

| 变量                        | 默认                                                       | 作用                                                                                                                               |
| --------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PI_WEB_PRESET_REPO`        | `xing-shuyin/pi-web-ui-presets`                            | 共享仓库 `owner/name`（也接受 `https://github.com/owner/name(.git)`）；`off`/`0`/`false`/`no` = 关闭分享（导入/导出仍可用）        |
| `PI_WEB_PRESET_CATALOG_URL` | `https://raw.githubusercontent.com/<repo>/main/index.json` | 目录文档地址；空串或 `off` = 关闭「浏览分享」                                                                                      |
| `PI_WEB_PRESET_GH`          | `gh`                                                       | 一键分享调用的 GitHub CLI 路径                                                                                                     |
| `PI_WEB_PRESET_TOKEN`       | 空                                                         | 无 gh 时的直连 API 令牌（回落顺序：`PI_WEB_PRESET_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`）；未设就走「预填网页」路径，不需要任何凭据 |

完整表见 `docs/env-vars.md`。

## 6. 隐私

预设**只含设置**：API key、provider 登录、项目路径都不在预设里（`SettingsPreset` 的类型定义就排除了它们）。
但预设**可以**携带自定义系统提示词、组合模板与审查提示词——**导入前请先看预览**；预览会把这几段文本截断展示，
不点「导入」不会落盘，不点「应用」不会生效。分享到公开仓库 = 这些文本会公开，别把私有提示词发出去。

## 7. 协议消息

```
client → server
  preset_export      { source?: "preset"|"current", name?, description?, author?, tags?, requestId? }
  preset_import      { json, dryRun?, name?, apply?, fields?, requestId? }
  preset_import_url  { url, dryRun?, name?, apply?, fields?, requestId? }
  preset_catalog     { refresh?, requestId? }
  preset_share       { source?, name?, description?, author?, tags?, requestId? }

server → client
  preset_export_result { requestId?, ok, name?, fileName?, json?, error? }
  preset_import_result { requestId?, ok, dryRun, preview?: UiPresetImportPreview, applied?, error? }
  preset_catalog_result{ requestId?, ok, entries: UiPresetCatalogEntry[], source, cached, fetchedAt, error? }
  preset_share_result  { requestId?, ok, method?: "gh"|"browser", url?, name?, json?, error? }
```

`requestId` 原样回显；前端把导入来源编在前缀里（`paste:` / `file:` / `url:`），预览头部据此提示
（服务端不关心来源）。`fields` = 可选导入的字段名（见 §2 末）；不给 = 全量。两个引擎共用同一份编排
（`PresetSharePort`）：`SettingsService`（pi）与 `DshClientSession`（DSH）各自实现「取预设 / 存预设 /
应用预设 / 推设置」四件事。

## 8. 测试

- `tests/unit/preset-share.test.ts` — 60 个纯函数/编排单测：slug/短哈希、白名单净化（47 字段 + 可选导入
  选择过滤）、解析与 errorKey、SSRF 收口、目录解析与缓存、env 读取、Issue 文本、port 编排
  （导出/导入/分享回落/目录）。
- `tests/settings-test.mjs` — 真机协议往返（隔离 data-dir）：导出 → dryRun 预览 → 改名导入 + 应用
  （改掉当前设置，导入后应被恢复）→ 可选导入（只写勾选字段 / 空选拒写）→ 净化（未知字段/类型不符）
  → 坏 JSON → 网址导入拦回环与非 http(s) → 分享被 env 关闭时明确拒绝但仍回传 JSON → 目录形状。
  该测试**显式把分享关掉**，绝不真在共享仓库开 Issue。
- `tests/scratch/preset-share-live.mjs` — 手动联调（真网络）：默认 env 下拉官方仓库目录 → 网址导入
  真实预设 → 导出闭环。需要联网，不入 smoke。
- `tests/scratch/preset-share-nogh-live.mjs` — 无 gh 的回落验证（真网络）：无效令牌打真实 api.github.com
  应拿到干净的 `HTTP 401: Bad credentials`（不抛），以及网页回落 URL 的预填/长度/`template` 二选一规则。
- `tests/scratch/preset-share-api-live.mjs` — 令牌直连 API 的**成功**路径（真网络 + 真仓库）：建一条
  Issue → 读回校验标题/正文 → GraphQL `deleteIssue` 删掉。跑之前先 `gh workflow disable "Ingest shared preset"`。
