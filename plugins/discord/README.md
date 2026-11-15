[English](./README.en.md) · **简体中文** · [繁體中文](./README.zh-TW.md)

# Discord 机器人与工作台 (Discord Plugin)

> Discord Bot 官方 Gateway WebSocket 出站长连接双工对话插件，支持双向会话对话（零公网 IP / 免反代）、结构感知 Markdown 智能分块、白名单安全准入与消息推送。零外部依赖（Node 内建 fetch + node:crypto + 全局 WebSocket）。

## 功能特性

- 🤖 **Gateway WebSocket 出站长连接双工对话**：基于 Discord 官方 Gateway (v10) 协议，客户端主动发起出站长连接，**零公网 IP、免域名、免反向代理、免开放入站端口**，在局域网或个人电脑即可即开即用！
- 📦 **结构感知 Markdown 分块**：针对 Discord 单条消息上限（2000 字符），采用类似 `dsh-im` 的智能分块算法，保证代码块（\`\`\`）自动闭合与语法高亮不破损。
- ⚡ **文本指令**：支持 `/help`、`/new`、`/clear`、`/reset [提示词]`、`/status`、`/stop`（别名 `/abort`）、`/model [provider/id|default]`、`/thinking [off|minimal|low|medium|high|xhigh|default]`、`/cwd [绝对路径]`（别名 `/workspace`）。未知指令返回帮助，不送模型。
- 🛡️ **安全白名单控制**：支持设置允许对话的 Discord User ID 白名单，未授权人员友好拦截，防止 Bot 被陌生人滥用。
- 💬 **持续会话与网页续聊**：按用户与频道隔离，Discord thread 使用其独立频道 ID。同一 scope 持续使用同一账号与上下文，稳定 sessionId 路由持久保存；网页继续该会话时，回复仍发送到原频道或 thread。
- 🛠️ **AI 工具**：向 AI 助手注册 `discord` 工具，AI 可自主向 Discord 频道推送消息与通知。

## 配置指南

1. 打开 [Discord Developer Portal](https://discord.com/developers/applications)；
2. 点击「New Application」创建应用，输入应用名称；
3. 进入「Bot」标签页，点击「Add Bot」生成机器人；
4. **重要**：在 Bot 页面向下滚动，开启 **Privileged Gateway Intents** 中的「MESSAGE CONTENT INTENT」与「SERVER MEMBERS INTENT」；
5. 点击「Reset Token」复制生成的 `Bot Token`；
6. 在「OAuth2」→「URL Generator」中勾选 `bot` 范围，并授予 `Send Messages`、`Read Messages/View Channels` 权限，复制生成的链接将机器人邀请到你的服务器中；
7. 在 pi-web-ui 的 Discord 面板点击「⚙️ 配置凭证」，填入 Bot Token 并勾选「启用 Discord 机器人双向对话服务」即可！

## 媒体与运行边界

- 接收消息中的附件会真实下载至当前工作区的 `.channel-attachments/discord/`，需要插件 `fs` 权限和宿主文件访问授权；切换目录必须是已授权、存在的绝对路径。
- PNG/JPEG/GIF/WebP 通过 `host.chat({text, attachments:[{path,imageData,mimeType,name}]})` 投递真实图片数据，最多 8 张、单张 10 MiB、图片合计 20 MiB；是否能理解图片取决于所选模型。其他文件以 `{path,mode:"reference",name}` 投递本地路径。未知格式和不支持的图片类型明确提示。
- 音频/语音及视频以文件收发，不接入实时语音频道、录音或视频通话，不自动转写或解码；模型需要可用的读取、转写或解码工具。下载或投递失败会回复错误。
- AI `discord` 工具的 `send` 支持 `file` 本地路径（图片、语音文件、普通文件、视频），通过平台上传真实字节；统一上限 20 MiB，平台或工作区可能施加更低限额。上传失败工具抛错；回复投递失败记入 lastError 并通知浏览器。
- 指令作为普通消息发送；频道内需 @ 机器人，私聊可直接发送。未注册平台原生 slash command。模型/思考设置下一次消息生效，宿主校验无效配置并反馈失败。`default` 恢复插件默认配置。
- 模型、思考强度、目录、账号 epoch 和稳定 sessionId 路由按用户 + 频道 + thread 隔离并持久化，插件重新加载后恢复；运行中的临时输出不恢复。运行中拒绝第二条任务；`/stop` 可立即取消正在下载的附件并阻止后续派发。`/new`、`/clear`、`/reset` 可立即取消旧任务或附件下载并开启空白会话，也可在命令后附提示词直接执行；命令名支持大小写和全角写法，提示词与路径保持原样。`/cwd`、`/workspace` 验证目录后同样开启新会话；查询目录不重置，验证失败保留原会话。旧任务迟到回执和结束事件不会覆盖新会话或解除其忙碌状态。重置保留模型、思考强度与目录设置。`/model`、`/thinking` 设置参数仍需先停止并等待，成功设置均开启新上下文；`default` 和思考强度值不区分大小写，模型标识保留原样。以上会话切换均更换账号 epoch，确保 daemon 不复用旧会话，历史保留。
- runId 存在时只允许精确匹配已认领的运行，未知 runId 不借用 session 路由。网页无 runId 的事件必须先由相同 sessionId 的 `run_start` 建立运行，结束只发送一次，并只发送最后一条助手正文候选，不拼接工具调用前言。旧宿主的完整 clientId + conversationId 可在当前实例兼容，匿名 `c1` 不认领。
- `/new`、`/clear`、`/reset`、目录或模型设置变更撤销旧 epoch 的路由；更换 Bot Token 撤销全部旧账号路由。网页无稳定 runId 时 `/stop` 明确提示在网页停止，不猜测 `c1` 作为中止目标。持久化或发送失败会反馈错误；回复继续走现有 Bot API 分块发送，不额外建立 webhook 通道。
- 收发使用模拟 API 行为测试，未以真实机器人凭据验证平台端到端。

Discord 文件发送还需 `Attach Files` 权限，附件下载只接受官方 `cdn.discordapp.com` / `media.discordapp.net` HTTPS URL，不跟随重定向；音视频以附件发送，语音文件不伪装为原生语音消息。
