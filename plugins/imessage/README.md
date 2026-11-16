[English](./README.en.md) · **简体中文** · [繁體中文](./README.zh-TW.md)

# iMessage

通过 macOS Messages 发送文字及本地图片、语音、文件、视频，并只读轮询 `~/Library/Messages/chat.db` 接收消息。无需公网入口。

## 运行条件

仅支持 macOS，Messages 必须登录 Apple ID。运行 pi-web-ui 的终端或应用须获「完整磁盘访问权限」（读取 chat.db）和「自动化 → Messages」权限（发送消息）。系统须提供 `/usr/bin/sqlite3`、`/usr/bin/osascript`。不满足条件会显示错误或 unsupported，不能在 Windows/Linux 假装在线。

启动时以数据库最新记录为游标，仅接收之后到达的消息，每两秒只读查询一次。停机期间消息不补发。Apple 未提供公开的 Messages 接收 API，数据库 schema 和 AppleScript 行为可能随系统更新变化；此实现并非苹果官方机器人 API。数据库仅含 attributedBody 而无 text 的富文本消息会收到明确的纯文本重发提示。

## 命令

支持 `/help`、`/new [prompt]`、`/clear [prompt]`、`/reset [prompt]`、`/status`、`/stop`（`/abort`）、`/model [provider/id|default]`、`/thinking [off|minimal|low|medium|high|xhigh|default]`、`/cwd [目录|default]`。`/workspace` 为目录命令兼容别名。命令 token 支持大小写、全角字母和全角斜杠；`default` 与思考强度忽略大小写。未知命令及无效参数直接反馈，不送模型。

`/new`、`/clear`、`/reset` 创建新上下文，不删除历史；携带 prompt 时立即在新会话执行其字面正文，保留换行与空格，正文 `/stop` 等不会再次解析为命令。设置模型、思考强度或目录也会轮换账号、解绑旧会话，`default` 恢复配置默认值。无参数的设置命令只查询当前值。控制命令立即处理，使重置前尚未启动的准备请求、排队消息及迟到启动回执失效；异步目录验证迟到不能覆盖后来的重置。重置与 model/thinking setter 在任务运行中也会立即解绑旧任务并请求停止；停止失败会明确反馈，旧任务回复不再关联新会话。`/cwd`、`/workspace` 在已启动任务运行中须先停止并等待结束再切换。模型、思考强度和工作目录按发送者与群聊/thread 隔离；宿主拒绝模型/目录会反馈启动失败。会话关联使用宿主真实 conversationId 和稳定 runId，支持早于 chat 回执到达的结束事件及会话过户。

## 媒体

接收 PNG/JPEG/GIF/WebP 时，以真实 `attachments.imageData` 传给宿主：最多 8 张，单张 10 MiB，总计 20 MiB。HEIC 等未知或不支持图像明确反馈，不伪装为已理解。

音频、视频、文本及常见 application 文件以绝对本地路径 reference 附件送入宿主。音视频会提示「是否可转录/理解取决于模型与工具」；插件没有内置 ASR 或视频解码器。附件读取失败会回复错误。

AI `imessage` 工具和插件 `send_message` 接口支持 `file` 本地路径，可与 `text` 一起发送。Messages 决定具体格式、压缩和大小限制，AppleScript 成功仅表示系统接受发送请求，不表示收件人已送达/已读。助手输出的文件不会自动发送，应明确调用工具。群聊回复使用原始 chat GUID 定向发送，避免错发为私聊；Apple Messages 不提供此桥接可用的 thread 定向发送接口，同群不同 thread 会话隔离，但回复落在原群。

## 持续会话回传

入站消息的宿主回执会绑定稳定 `sessionId` 与原 iMessage 群组/thread/发送者路由，并持久保存。网页继续该会话时，只有无 `runId` 的 `run_start` 能创建独立待回复项；最终助手消息替换此前文本，`run_end` 仅回复一次。携带 `runId` 的事件只匹配精确运行，未知运行不会借用会话路由。

旧宿主仅在同时提供 `clientId` 与 `conversationId` 时支持内存路由，裸 `c1` 等编号不构成身份。旧宿主路由不会跨插件重载恢复。`/reset`、`/new`、`/clear` 及模型/目录切换撤销旧路由并持久保存会话代次，重载后不会恢复已撤销的旧会话。账号或默认收件人变更会使旧路由失效。`/stop` 保留后续网页继续能力；网页运行缺少精确 `runId` 时，机器人会提示在网页停止，不猜测中止目标。

## 验证范围

命令、早到事件、runId 归属、跨群/thread、图片附件、文件引用、发送 AppleScript、轮询和错误反馈均有模拟行为测试。真实 macOS 端到端验证仍需有 Apple ID 与上述权限的机器。
