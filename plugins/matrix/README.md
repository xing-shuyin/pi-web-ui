[English](./README.en.md) · **简体中文** · [繁體中文](./README.zh-TW.md)

# Matrix (去中心化) 机器人与工作台 (Matrix Plugin)

> Matrix 机器人插件（实验功能），基于 Matrix Client-Server API (v3) 出站 Sync 长轮询，支持双向会话对话（零公网 IP / 免反代）、结构感知 Markdown 智能分块、白名单安全准入与房间消息推送。零外部第三方包依赖（Node 内建 fetch + node:crypto）。

## 功能特性

- 🤖 **去中心化 Matrix 出站 Sync 双工长轮询**：基于 Matrix Client-Server 官方规范，客户端主动发起出站长轮询，**零公网 IP、免域名备案、免反向代理、免开放入站端口**，支持连接自建 Synapse 或公共 Matrix 服务器（如 matrix.org）！
- 📦 **结构感知 Markdown 分块**：针对消息长度限制，采用类似 `dsh-im` 的智能分块算法，保证代码块（\`\`\`）自动闭合与语法高亮不破损。
- ⚡ **斜杠快捷指令**：支持 `/help`、`/new`、`/clear`（别名 `/reset`，这三个重置命令均支持附带提示词，重置后按原文派发）、`/status`、`/stop`（别名 `/abort`）、`/model [provider/id|default]`、`/thinking [off|minimal|low|medium|high|xhigh|default]`、`/cwd [绝对目录]`（别名 `/workspace`）。命令支持全角斜杠与大小写混写，未知命令会提示帮助，不投递模型。模型从宿主可用目录校验；目录须存在且通过宿主文件权限检查。运行时须先停止并等待结束才能新建会话或切目录。
- 🛡️ **安全白名单控制**：支持设置允许对话的 Matrix User ID 白名单（形如 `@user:matrix.org`），未授权人员友好拦截，防止 Bot 被陌生人滥用。
- 💬 **多房间与群聊支持**：支持在 Matrix 房间中接收消息并回复，按房间、thread、发送者隔离上下文与命令设置，回复保持原 thread。运行以稳定 runId 认领，支持回执前到达的消息及结束事件。
- 🛠️ **AI 工具**：向 AI 助手注册 `matrix` 工具，AI 可自主向 Matrix 房间推送消息与通知。

## 配置指南

1. 拥有一个 Matrix 账号（可在 [matrix.org](https://matrix.org/) 注册，或使用私有部署的 Synapse / Conduit 服务器）；
2. 使用 Element Web 或其他客户端登录后，在「个人设置」→「帮助与关于」中复制你的 **Access Token** 与 **Homeserver URL**；
3. 将该机器人账号邀请到你的目标 Matrix 房间；
4. 在 pi-web-ui 的 Matrix 面板点击「⚙️ 配置凭证」，填入 Homeserver URL 与 Access Token，勾选「启用 Matrix 机器人双向对话服务」；
5. 点击「🔌 测试连接」验证通过后点击「💾 保存配置」即可开始对话。

## 媒体与限制

- 接收图片、音频（含语音）、文件、视频：从认证 Matrix media API 下载原始字节到所选工作区 `.matrix-media/`，再传给 `host.chat({text, attachments})`。PNG/JPEG/WebP/GIF 图片通过 `{path:"", imageData:base64, mimeType, name}` 传入；其他媒体用 `{path:absolutePath, mode:"reference", name}` 引用，并提示模型使用 read 或可用工具。视觉能力取决于模型；渠道不自动转录语音或解码视频，无法解析时必须说明。
- 每个 Matrix 消息接收一个媒体附件，因此图片每次至多一张且不超过 10 MiB（低于宿主 8 张/合计 20 MiB 上限），其他附件不超过 25 MiB；流式读取同样限制字节数。文件保留在工作区，需自行清理。额外目录须事先在宿主授权，渠道不会绕过文件权限。
- `matrix` 工具 `action=send` 支持 `path`（工作区内本地路径）、`media_type=image|audio|file|video`、`mimetype`、`text`、`thread_id`：真实读取文件、上传原始字节并发送相应 Matrix 媒体事件。路径越界、下载/上传/发送失败均返回错误；入站失败尝试回复原 thread，回复本身失败记录日志及状态错误。
- **不支持 E2EE**：没有设备密钥、Olm/Megolm 解密、密钥备份或加密上传。加密房间消息和加密附件明确拒绝，出站先查房间状态并拒绝向加密房间发送明文。请使用机器人已加入的未加密房间；无法读取房间状态也会拒绝发送。无法解密的事件无法读取 thread 关系。
- 首次无持久游标的同步只建立游标，不重放历史。命令偏好为内存态；稳定 `sessionId` 回传路由及作用域 epoch 持久化，插件重载后仍可将网页续轮的最终回答送回原房间与线程。旧宿主仅支持完整 `clientId + conversationId` 内存路由，不接受裸 `c1`。带 `runId` 的事件只匹配精确运行，未知 ID 不借用会话；无 `runId` 的网页续轮必须由 `run_start` 建立记录，结束后只回传一次，助手消息以最后候选替换前文并排除工具调用前言。网页运行无可取消的运行 ID 时，`/stop` 明确报告无法安全停止，不猜测会话 ID。切换 Homeserver 或凭据清空旧路由；`/new`、`/clear`（`/reset`）、`/cwd`（`/workspace`）和模型、思考强度切换会轮换 peer epoch 与 accountId，确保宿主创建全新上下文，保留原历史；无参数查询保留上下文。运行中修改设置须先停止并等待结束。`/stop` 可立即取消当前附件下载，取消或切换后不会派发旧附件消息；停止任务保留会话路由供后续网页续轮使用。
