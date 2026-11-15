[English](./README.en.md) · **简体中文** · [繁體中文](./README.zh-TW.md)

# 微信通道（wechat-ilink）

微信扫码登录，直连微信 ilink 后端（`https://ilinkai.weixin.qq.com`），协议与
腾讯官方的 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 同源
（见其 `docs/protocol_zh_CN.md`，MIT 协议）。

## 为什么不需要公网

不出回调、只出站：扫码登录拿 `bot_token` → `getupdates` 长轮询（35s）收消息 →
`sendmessage` 回消息。家里内网、公司内网都能跑，不用开端口、不用公网 IP。

## 上手

1. 装上插件，打开顶栏 💬 视图，点「扫码登录」，微信扫码确认。
2. 有人发来消息：白名单（设置 → 允许的用户，或填 `*` 全放行）直接执行；
   陌生人先挂「待配对」，在视图里点允许/拒绝（并会推一条系统通知）。
3. 微信里直接说话，agent 跑完回结果；跑超 `执行超时提醒` 先回“还在执行”。

## v1 范围（诚实版）

- ⚡ **斜杠快捷指令**：支持单独发送 `/`（或 `/h`、`/help`）查看简化序号菜单、`/clear`、`/reset` 或 `/new [提示]`（清空上下文开启全新对话）、`/status`（查看运行状态与指标）、`/cwd [路径]`（查看或切换项目根目录）、`/model [模型]`（查看或切换模型）、`/thinking [强度]`（设置思考强度）、`/plan [on|off]`（计划模式）、`/compact`（上下文压缩）、`/stop` 或 `/abort`（中止当前任务）、`/reload`（重载扩展与技能）以及插件扩展指令（如 `/todo`、`/note`、`/remind`），支持中文全角 `／` 与数字序号快捷输入。
- 单账号、文本消息全双工。
- **图片/文件双向**（v0.5.0）：
  - **发**：AI 调 `wechat_send` 带 `image`（图片）或 `file`（其他附件，按扩展名分流 image/video/file），
    本地路径（相对当前工作区）或 `http(s)` URL 都行；链路 = `getuploadurl` → AES-128-ECB 加密
    → CDN `POST`（读 `x-encrypted-param`）→ `sendmessage` 的 `image_item`/`video_item`/`file_item`。
  - **收**：微信发来的图片/文件/视频下载后按 `image_item.aeskey`（hex）或 `media.aes_key` 解密，
    落到工作区 `.pi-wechat-media/`。图片通过 `host.chat.attachments` 的 `imageData` / `mimeType` 作为真实图片附件进入模型；文件和视频以 `path` / `mode: reference` 附件进入宿主。需要支持该附件契约的宿主版本。
  - 下载单文件上限 25MB；图片单张 10MiB、最多 8 张、合计 20MiB。格式或限额失败会直接告知用户，不能读取时不宣称已理解内容。
  - 未接入语音识别（ASR）；收到语音直接提示无法听取、请改发文字，并将此边界传给 agent。视频按文件引用交付，不承诺自动理解画面或声音。
- 仅私聊：群聊和 thread 一律忽略，旧 `respondGroups` 设置不再放行，避免同用户跨群合并私聊上下文。
- 每个已配对微信用户按 ID 隔离独立会话；持久化的每用户序号进入 `accountId`，`/new`、`/clear`、`/reset`、工作区（`/cwd`、`/workspace`）、模型和思考强度切换会递增，确保宿主不复用上一轮上下文。已有数字快捷命令、全角斜杠及大小写形式使用相同的重置流程。这些命令同时让当前微信用户脱离网页会话投递，后续消息持续使用新会话，插件重载后仍保留；其他用户不受影响。重置前尚未返回的宿主请求也会中止，不再认领旧运行。在微信插件面板或设置中重新开启「投递到网页当前会话」可恢复网页同步。
- 媒体下载独立执行（最多 4 个），不会阻塞后续 `/stop`；停止或新建会话后，尚未下载完成的媒体不会重新启动任务。中止操作优先传稳定 `runId`（老宿主回执无该字段才回退实际 `conversationId`），过户后仍可定位运行；等待宿主确认，失败会明确提示。
- **微信发起的运行按 `runId` 认领，网页续聊按稳定 `sessionId` 回传**：在同一微信会话的网页视图里主动发消息，助手回复也会发送给对应微信联系人。会话绑定与当前用户会话代次关联，`/new` 等重置会使旧绑定失效；共享查看不改变执行归属。运行中发生过户或局部 `c1` 改名时，稳定身份仍可定位原联系人，不按单独的局部会话 ID 猜测。老宿主没有 `sessionId` 时仅使用完整 `clientId + conversationId`；未建立身份绑定或存在多个联系人绑定歧义时不自动回传。宿主未返回真实 `conversationId` 会明确反馈执行失败。
- 过滤内部控制标记（如 [[plan:...]]、[[todo:...]]、[[conv:...]]、[[notify:...]]），只将用户可见正文发送到微信。
- 设置里可配默认工作空间（显式 pin cwd，防后台启动飘到 system32；
  Windows 下系统目录直接拒绝）、模型 / 思考强度（两个都是**下拉选择**：模型列已配置
  鉴权的模型、思考强度列 SDK 档位，留空 = 跟随全局默认），以及「投递到网页当前会话」
  （开 = 微信指令 steer 到浏览器正在打开的对话，网页实时可见）。
- 个人微信扫码走官方 ilink 后端——比野路子 Hook 干净，但个人号自动化仍有
  平台风险，小号先行、重要号三思。`bot_token` 存宿主加密机密（拷机解不开）。

## 文件

- `index.mjs` 服务端：ilink 客户端 + 登录/轮询/配对/回包 + 媒体 CDN 收发 + `wechat_send` 工具
- `client/entry.mjs` 视图：状态/扫码/配对/收件箱/手动发送（文本 + 媒体路径或 URL）
- `client/vendor/qrcode.js` 二维码编码器（kazuhikoarase/qrcode-generator 1.4.4，MIT，
  仅追加一行 ESM 导出）：官方 `qrcode_img_content` 是 JS 跳转页不是图片，
  扫的内容就是该 URL 本身，视图在本地生成（与官方 CLI 的 qrcode-terminal 一致）
- 无头调用走宿主 `host.chat`（`server/plugins.ts` + `AgentService.chatFromPlugin`），
  无浏览器也能跑；结果经 `onRunEvent(run_end)` 按 conversationId 关联回包。

## 斜杠快捷指令

微信里直接发送斜杠指令（支持英文 `/`、中文全角 `／` 及简写序号 `1/cwd` / `/1` 等），通道直接快速回复，无需消耗 AI 模型额度：

- **快捷帮助菜单**（发 `/`、`/h` 或 `/help`）：
  ```text
  可直接发送 /序号（如 /1 或 /2 <提示>）快捷操作：
  1/cwd : 查看或切换当前项目根目录
  2/new : 清空上下文开启全新会话 [提示]
  3/status : 查看通道运行状态与指标
  4/model : 查看或切换当前模型 [名称]
  5/thinking : 设置思考强度 <off|low|high|max>
  6/plan : 开启或关闭计划模式 [on|off]
  7/compact : 压缩当前会话上下文 [说明]
  8/stop : 中止当前正在执行的任务
  9/reload : 重新加载扩展与配置
  10/help : 显示全部命令 (或发 /)
  11/note : 存一条笔记 <正文>（已安装插件命令自动展示）
  12/todo : 加一条待办 <内容>
  ...
  ```
- **核心命令支持**：
  - `1/cwd` 或 `/1` 或 `/cwd [路径]`：查看或切换项目根目录（`/cwd default` 恢复默认）
  - `2/new` 或 `/2` 或 `/new [提示]`：清空上下文开启新会话（可直接带首条提示）
  - `3/status` 或 `/3` 或 `/status`：查看通道状态、账号、模型与消息统计
  - `4/model` 或 `/4` 或 `/model [模型]`：查看或切换模型（`/model default` 恢复默认）
  - `5/thinking` 或 `/5` 或 `/thinking [强度]`：设置思考强度（off/minimal/low/medium/high/xhigh/max）
  - `6/plan` 或 `/6` 或 `/plan [on|off]`：开启或关闭计划模式（只规划不实施修改）
  - `7/compact` 或 `/7` 或 `/compact`：压缩当前会话上下文
  - `8/stop` 或 `/8` 或 `/stop`：中止当前正在执行的任务
  - `9/reload` 或 `/9` 或 `/reload`：重新加载系统扩展与配置
  - `10/help` 或 `/10` 或 `/h` 或 `/`：查看帮助
- **配对成功自动推送**：管理员在 Web 控制台完成配对后，通道会自动向该微信用户发送简洁的连接成功欢迎语及高频命令速查。
- **第三方插件指令透传**：支持已安装插件注册的命令（如 `/todo`、`/note`、`/remind` 等），微信发送后直接执行并回显插件结果。
