[English](./README.en.md) · **简体中文** · [繁體中文](./README.zh-TW.md)

# Slack 机器人与工作台 (Slack Plugin)

> Slack 机器人插件，基于 Slack 官方 Socket Mode 出站 WebSocket 长连接，支持双向会话对话（零公网 IP / 免反代）、结构感知 Markdown (mrkdwn) 智能分块、白名单安全准入与频道/线程消息推送。零外部第三方包依赖（Node 内建 fetch + node:crypto + 全局 WebSocket）。

## 功能特性

- 🤖 **Socket Mode 出站 WebSocket 双工对话**：基于 Slack 官方 Socket Mode，客户端主动发起长连接，**零公网 IP、免域名、免反向代理、免开放入站端口**，在局域网或个人电脑即可即开即用！
- 📦 **结构感知 Markdown 分块**：针对 Slack 消息长度限制，采用类似 `dsh-im` 的智能分块算法，保证代码块（\`\`\`）自动闭合与语法高亮不破损。
- ⚡ **文本指令**：支持 `/help`、`/new`、`/clear`（别名 `/reset`，这三个重置命令均支持附带提示词，重置后按原文派发）、`/status`、`/stop`（别名 `/abort`）、`/model [provider/id|default]`、`/thinking [off|minimal|low|medium|high|xhigh|default]`、`/cwd [绝对路径]`（别名 `/workspace`）。命令支持全角斜杠与大小写混写，未知指令返回帮助，不送模型。
- 🛡️ **安全白名单控制**：支持设置允许对话的 Slack User ID 白名单，未授权人员友好拦截，防止 Bot 被陌生人滥用。
- 💬 **线程会话回复**：支持在频道线程（Thread）中跟进回复，保持频道界面整洁。
- 🛠️ **AI 工具**：向 AI 助手注册 `slack` 工具，AI 可自主向 Slack 频道推送消息与通知。

## 配置指南

1. 打开 [Slack API 开发者后台](https://api.slack.com/apps) 并创建应用（Create New App → From scratch）；
2. 进入「Socket Mode」页面，开启 **Enable Socket Mode**，生成包含 `connections:write` 权限的 **App-Level Token**（以 `xapp-` 开头）；
3. 进入「OAuth & Permissions」页面，在 **Bot Token Scopes** 中添加权限：
   - `chat:write`
   - `app_mentions:read`
   - `channels:history`
   - `im:history`
4. 点击「Install to Workspace」完成安装，复制生成的 **Bot User OAuth Token**（以 `xoxb-` 开头）；
5. 进入「Event Subscriptions」开启事件订阅，在 **Subscribe to bot events** 中添加 `app_mention` 与 `message.im`；
6. 在 pi-web-ui 的 Slack 面板点击「⚙️ 配置凭证」，填入 Bot Token 与 App-Level Token，勾选「启用 Slack Socket Mode 机器人双向对话服务」即可！

## 媒体与运行边界

- 接收消息中的附件会真实下载至当前工作区的 `.channel-attachments/slack/`，需要插件 `fs` 权限和宿主文件访问授权；切换目录必须是已授权、存在的绝对路径。
- PNG/JPEG/GIF/WebP 通过 `host.chat({text, attachments:[{path,imageData,mimeType,name}]})` 投递真实图片数据，最多 8 张、单张 10 MiB、图片合计 20 MiB；是否能理解图片取决于所选模型。其他文件以 `{path,mode:"reference",name}` 投递本地路径。未知格式和不支持的图片类型明确提示。
- 音频/语音及视频以文件收发，不接入实时语音频道、录音或视频通话，不自动转写或解码；模型需要可用的读取、转写或解码工具。下载或投递失败会回复错误。
- AI `slack` 工具的 `send` 支持 `file` 本地路径（图片、语音文件、普通文件、视频），通过平台上传真实字节；统一上限 20 MiB，平台或工作区可能施加更低限额。上传失败工具抛错；回复投递失败记入 lastError 并通知浏览器。
- 指令作为普通消息发送；频道内需 @ 机器人，私聊可直接发送。未注册平台原生 slash command。模型/思考设置下一次消息生效，宿主校验无效配置并反馈失败。`default` 恢复插件默认配置。
- 模型、思考强度、目录和会话映射按用户 + 频道 + thread 隔离（Slack 普通私聊共用该私聊会话），会话映射、设置与 epoch 随 `sessionRoutes` 持久保存，插件重载后可继续同一 scope 的会话。运行中拒绝第二条任务；`/stop` 可立即取消正在下载的附件并阻止后续派发。`/new`、`/clear`（`/reset`）、`/cwd`（`/workspace`）、`/model`、`/thinking` 修改设置前需先停止并等待；它们会更换账号 epoch，确保 daemon 不复用旧会话。模型或思考强度切换会开启新上下文，无参数查询保留上下文，新建不删除历史。
- 网页续聊须先收到无 `runId` 的 `run_start`，再按已绑定的稳定 SDK `sessionId` 回传到原用户、频道及 thread；旧宿主仅兼容完整 `clientId + conversationId`，不会按匿名 `c1` 认领。带 `runId` 的事件必须与通道回执精确匹配，未知 ID 不借用 session 路由。每轮仅回传最后一个助手正文候选，不拼接工具前言，重复结束事件不重复发送。
- `/new`、`/reset` 和上下文设置变更撤销旧 epoch 的路由，切换机器人凭据清除旧账号绑定，重载不会复活已撤销路由。网页运行没有精确 `runId` 时，`/stop` 提示到网页停止，不猜测 canonical conversationId。发送仍走原 Slack API，错误保留在 lastError 并通知网页。
- 收发使用模拟 API 行为测试，未以真实机器人凭据验证平台端到端。

Slack 附件还需 Bot Token scopes `files:read`、`files:write`（修改 scopes 后重新安装应用）。上传使用 `files.getUploadURLExternal` + 字节上传 + `files.completeUploadExternal`；频道中的文件消息仍需 @ 机器人，回复保持原 thread。私有文件下载只接受 `files.slack.com` 且不跟随重定向。
