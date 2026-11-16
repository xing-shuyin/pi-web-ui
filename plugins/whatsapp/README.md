[English](./README.en.md) · **简体中文** · [繁體中文](./README.zh-TW.md)

# WhatsApp 机器人与工作台

基于 Meta WhatsApp Business Cloud API（Graph API v20.0），无第三方运行依赖。插件版本 **0.2.5**。

## 命令与会话

支持 `/help`、`/new [prompt]`、`/clear [prompt]`、`/reset [prompt]`、`/status`、`/stop`（别名 `/abort`）、`/model [provider/id|default]`、`/thinking [off|minimal|low|medium|high|xhigh|default]`、`/cwd [absolute path]`（兼容 `/workspace`）。未知斜杠命令直接提示，不交给模型。

模型与思考参数在下一次投递时由宿主验证；命令回复不会伪称模型已切换。目录必须存在、已获宿主文件授权，切目录会新建会话。命令名兼容大小写及全角字符（含全角斜杠），参数保留原文。`/new`、`/clear`、`/reset` 带提示词时，会在新会话执行该提示词，提示词以 `/` 开头也作为正文发送。模型、思考强度及目录 setter 均重置上下文；`DEFAULT` 恢复默认，思考强度兼容大小写。

`/new`、`/clear`、`/reset` 立即使旧队列、下载和在途投递失效，解除旧会话绑定并轮换独立账号，保留模型、思考强度及目录偏好，同时请求中止旧运行。迟到回执也会请求中止，旧事件不会恢复绑定；中止失败会明确反馈。`/stop` 调用真实 `host.abortRun(runId || conversationId)`，优先稳定运行 ID，过户或对话改名后仍准确中止。取消投递后晚到的回执同样优先使用其 `runId` 中止。

会话使用通道来源隔离账号。使用 `await host.chat()` 回执的真实 `conversationId` 和稳定 `runId`，支持回执前到达的消息及结束事件、会话过户及改名。未返回稳定运行 ID 时明确报错。发送失败记录日志、状态并通知工作台；投递失败、中止、模型错误、超时均有反馈。

## 媒体

- 收入图片：通过 Meta 媒体 ID 查询、下载真实二进制，以 `attachments: [{path:"", imageData:base64, mimeType, name}]` 交给宿主；不会把 URL 或文件名当作图片。支持 PNG/JPEG/WebP/GIF，其他类型明确告知无法解码。
- 收入音频、文件、视频：以 `attachments: [{path:"", fileData:base64, mimeType, name}]` 交给宿主持久化。音视频明确说明插件没有自动转录/视频解码能力，附件作为文件参考，进一步解析取决于模型与工具。
- 所有入站附件（图片、音频、文件、视频）单个最大 10 MiB；元数据、Content-Length 及实际下载流均检查上限。Meta 每个入站消息只有一个媒体对象，插件每次模型请求仅一份附件，因此符合宿主最多 8 张图片、单附件 10 MiB、合计 20 MiB 的约束。
- 工作台支持选择图片/音频/文件/视频类型、输入工作区文件路径及 MIME 类型发送；AI 工具 `whatsapp` 的 `send_media` 同样支持工作区文件上传或已存在的 Meta `media_id`。工具 `send` 继续发送文本。
- 外发媒体使用 multipart 上传后按媒体 ID 发送，最大 20 MiB；具体 MIME/编码/账号能力还受 Meta API 限制，失败会反馈。语音发送为 audio 媒体，不额外承诺语音气泡或语音合成。

## 配置与接入

在 Meta 开发者平台启用 WhatsApp Business，配置 Phone Number ID 与具有 `whatsapp_business_messaging` 权限的 Access Token。在插件面板测试、保存并启动机器人。Token 通过宿主 secrets 保存，文件访问通过宿主 fs 权限控制。

插件接收入口是 `POST /plugins-api/whatsapp/inbox`（反向代理子路径部署需加宿主前缀），接受 Meta webhook 的 `entry[].changes[].value.messages[]` JSON。入口受宿主 `PI_WEB_TOKEN` 鉴权；机器人关闭时返回 503。需要配置可信的 webhook 中继验证 Meta 签名，再携带宿主鉴权转发 JSON。本插件没有公开直连 webhook 的 GET challenge 和 Meta 签名验证，不能直接把未鉴权公网回调当作可信输入。

## 能力边界

- 当前 Cloud API 仅支持业务号码与用户私聊。群/thread 消息不送模型，不将群回复降级发到私聊，限制记录到状态和日志；没有承诺群聊支持。
- 模型切换、无头聊天和真实附件需要新版 pi 宿主支持；缺少 `conversationId/runId` 回执会拒绝不安全的关联。不能在旧版宿主靠 URL 文本降级图片。
- 音视频没有内置转录、视频帧解码或合成服务。无法解码必须说明，不能编造媒体内容。
- Meta 24 小时服务窗口、模板消息要求、收件号码资格、媒体编码支持及网络可达性由 Meta 管理；不承诺零封号或无限制发送。
- 同一来源持续复用会话；目的地、独立账号、稳定 sessionId 与 reset epoch 经宿主 storage 保存，插件重载后恢复。网页主动续聊的最终助手正文仍回原收件人；工具前言不拼入最终回复，重复结束事件只发送一次。旧宿主仅接受完整 clientId + conversationId，不按匿名 c1 认领。
- `/new` 或业务账号/Token 变化撤销旧路由；旧事件不能恢复旧 epoch。网页运行没有 runId 时只能解除回传绑定，明确报告无法精准中止，不猜测 canonical conversationId。运行中文本与 webhook 去重仍只在内存中保留，重载不会重发已结束运行。Meta 服务窗口到期仍由原 Cloud API 发送并明确记录错误，不自动发送收费模板。

验证：`npx vitest run tests/unit/whatsapp-features.test.ts tests/unit/whatsapp-behavior.test.ts tests/unit/whatsapp-session-routes.test.ts`。
