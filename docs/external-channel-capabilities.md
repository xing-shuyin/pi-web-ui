# 外部消息渠道能力与使用说明

覆盖微信 iLink、QQ、企业微信、飞书、钉钉、Telegram、Discord、Slack、Matrix、WhatsApp、iMessage 共 11 个渠道。各平台的 API 权限、账号资格与格式限制仍然适用。

## 统一行为

11 个渠道均处理 `/help`、`/new`、`/clear`、`/status`、`/stop`（别名 `/abort`）、`/model`、`/thinking`、`/cwd`（别名 `/workspace`）。未知命令回复帮助，不投递模型。Discord/Slack 指令是普通消息中的文本指令，没有注册平台原生 slash-command endpoint。

会话按发送者和会话空间隔离：Telegram chat/topic、Discord channel（包括独立 thread channel）、Slack channel/thread、Matrix room/thread。会话映射是否持久化依渠道而异；Telegram、Discord、Slack、Matrix 的偏好与映射保存在插件内存，重启会重置。新建/清空及目录切换会更换 peer account epoch，下一次 host.chat 使用不同 accountId，避免 daemon 复用旧上下文。历史记录保留。模型切换开启新上下文；运行中切换限制见各插件 README。

所有桥接消费 host.chat 回执中的真实 conversationId、稳定 runId，并缓冲回执前到达的助手消息与结束事件。按 runId 认领事件，避免会话过户或重命名后错回。停止优先传稳定 runId；下载期间的停止取消后续模型投递。派发、下载、模型执行失败有渠道反馈；发送本身失败记录状态/日志，Discord/Slack/Matrix 还使用宿主通知能力（若可用）。

## 媒体能力与限制

| 渠道             | 入站                                                                       | 出站及主要限制                                                                                                            |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 微信 iLink 0.5.3 | 私聊图片作为视觉附件，文件/视频提供本地引用；语音有识别文本时消费识别结果  | 保留 ilink 文本/图片/文件/视频发送；仅私聊，拒绝群/thread；无内置 ASR                                                     |
| QQ 0.1.16        | 图片视觉附件、文件/音视频本地引用，保留平台已有语音识别文本                | 保留富媒体发送；群/频道/thread/用户隔离；发送格式、配额与授权依 QQ API                                                    |
| 企业微信 0.1.7   | 可信回调适配器可投递文本/平台语音识别文本；无法下载的媒体明确反馈          | 当前没有入站回调网络服务，Webhook 仅发送文本/Markdown；不宣称开箱即用双向媒体聊天                                         |
| 飞书 0.3.0       | 图片视觉输入，其他媒体作为持久化文件；群/thread 原位回复                   | 图片、文件、Opus 音频、MP4 视频（需时长），受机器人权限与编码限制                                                         |
| 钉钉 0.2.0       | Stream 真实入口，图片视觉输入，其他媒体持久化文件；企业/群/thread/用户隔离 | 企业机器人支持图片、AMR 音频、文件、带封面 MP4；Webhook 仅文本/Markdown                                                   |
| WhatsApp 0.2.3   | Meta 媒体 ID 下载图片/音频/文件/视频；仅私聊                               | multipart 上传媒体；需可信中继验证签名后携宿主 token 转发。尚无直接 Meta challenge/签名验证，受 24 小时窗口和模板要求限制 |
| iMessage 0.2.0   | macOS 只读 chat.db 轮询，图片视觉输入，其余本地引用；群 GUID 定向          | Messages AppleScript 发送本地媒体；仅 macOS，需系统权限；thread 隔离但不支持苹果原生原位 thread 回复                      |

| 渠道     | 入站                                                                               | 出站                                                                                              | 真实限制                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Telegram | photo、图片文档、voice、audio、document、video、video_note、animation 下载真实字节 | 工具上传本地文件或 HTTP(S) URL，支持 photo/document/audio/voice/video/animation，保留 forum topic | 单文件本地限制 20 MiB；Bot API 仍有格式/方法限制。相册按独立消息处理，不聚合。下载保留于服务器临时目录，需要定期清理     |
| Discord  | 消息 attachments 下载，图片视觉附件，其他类型文件引用                              | 工具以 multipart 上传本地文件；图片/音频/视频/普通文件均可作为附件                                | 本地限制 20 MiB，服务器/账号可能更低；不连接语音频道，不提供语音消息录制元数据；需启用 Message Content Intent 和频道权限 |
| Slack    | 带鉴权下载私有 files，图片视觉附件，其他类型文件引用                               | 工具使用外部上传 URL 和 completeUploadExternal 上传本地文件                                       | 本地限制 20 MiB；需 files:read/files:write 与相应消息事件权限；无 huddle/实时语音；频道附件消息须提及机器人              |
| Matrix   | m.image/m.audio/m.file/m.video，通过鉴权媒体下载                                   | 工作区内本地文件上传 mxc 后发送对应消息，支持 thread                                              | 文件本地限制 25 MiB，homeserver 可更低；不支持 E2EE 房间/附件解密，明确报错；不解码实时通话                              |

PNG/JPEG/GIF/WebP 按既有 PromptAttachment 合同传 `{path, imageData:base64, mimeType, name}`，每请求最多 8 张、单图 10 MiB、图片合计 20 MiB，最终还受宿主校验与模型视觉能力限制。Telegram 和 Matrix 一条事件通常只有一个媒体。非图片按 `{path:absoluteDownloadedPath, mode:"reference", name}` 输入；模型接收真实文件引用，而不是远程下载链接。

飞书/钉钉通过 base64 输入的媒体单份最大 10 MiB、混合合计 20 MiB；WhatsApp 入站单媒体最大 10 MiB。出站飞书最大 10 MiB，钉钉/WhatsApp 最大 20 MiB，仍受各平台限制。本地路径引用不占 base64 字节预算。

音视频收发不等于自动理解：插件不内置语音转写或视频解码。收到音视频或不支持的图片/未知文件类型会明确说明，模型需要可用的转写、解码或文档读取工具。无法理解时必须反馈，不能静默丢弃附件。附件下载位置及授权要求见各插件 README；工作区文件需宿主 fs 权限。

## 验证与部署

本轮行为测试使用 mock 平台 HTTP/API 和 host.chat，覆盖真实附件内容、命令拦截、账号 epoch、群/thread 隔离、稳定 runId 与早到结束事件，以及停止下载等竞态。没有使用生产机器人凭据做真实平台端到端测试。

实际检查的本机插件目录为 `C:\Users\c\.pi-web\plugins`，已同步其中已安装的 QQ、微信源码，并核验 secrets/storage 未变；其他九个渠道未安装，未自动安装。Telegram/Matrix 版本为 0.2.0，Discord/Slack 为 0.1.7。

公共宿主现在通过 `host.chat({text, attachments})` 真正透传附件；最多 8 份，base64 附件单份 10 MiB、合计 20 MiB，超过限制明确拒绝而不截断；本地路径引用按原有附件权限链处理。`host.abortRun(runId)` 支持按 `pr-` 稳定标识查找过户后的真正运行，失效标识返回失败，不误停同名会话。

本轮联合验证：29 个相关测试文件、404 项测试通过，覆盖宿主媒体输入、停止归属和各渠道行为；插件版本、工具提示词与 manifest 权限另有守卫检查。Prettier、全项目五组 TypeScript 检查、lint 与差异空白检查通过。生产账号真实平台端到端联调仍需分别验证。
