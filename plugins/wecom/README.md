[English](./README.en.md) · **简体中文** · [繁體中文](./README.zh-TW.md)

# 企业微信工作台与机器人 (WeCom Plugin)

企业微信群机器人 Webhook 推送、自建应用连接检查，以及可由适配器调用的 `WecomBotBridge`。零外部依赖。

## 当前接入边界

企微群机器人的 Webhook 是发送接口，不能凭 Webhook Key 接收群消息。本插件目前没有部署企业应用回调接收、签名验证及加解密服务，也没有把外部入站消息接入 `WecomBotBridge.onInboundMessage` 的网络入口。工作台“启动机器人”仅启用内部桥接监听，不能视为已建立企微入站连接。实际双向对话需要额外的可信回调适配器，完成签名验证、解密后调用该桥接。

桥接会话按企业/应用账号、回复 Webhook、room（chatId / ChatId / roomId）、channelId、threadId、发送者及持久 epoch 隔离。适配器必须传真实目的地标识和正确的回复 Webhook。宿主回执中的稳定 sessionId 绑定原目的地；网页主动续聊同一 session 的无 runId `run_start` 会创建独立回复任务，结束后只发送最后一条助手候选正文，不拼接工具调用前言。已结束任务的重复结束事件不再次发送；未知 runId 不能借用 session 路由。

路由、scope 账号与 epoch 保存到插件 storage；目的地 Webhook 通过宿主 secrets 保存，路由记录不含明文密钥。插件重载可恢复稳定 session 路由及入站会话；旧宿主仅以完整 clientId + conversationId 兼容（仅内存），裸 c1 不认领。reset、模型/目录 setter 以及账号凭据变更撤销旧路由；重载不恢复已撤销 epoch。网页任务没有精确 runId 时 `/stop` 明确返回无法安全中止，不猜测 canonical ID。回复复用 Webhook 发送与错误校验，缺少原目的地密钥或平台拒收会记录错误，不改投当前默认 Webhook。

## 桥接命令

- `/help`：帮助。
- `/new [prompt]`、`/clear [prompt]`、`/reset [prompt]`：立即隔离旧任务和在途投递，使用新的宿主账号及会话；提供 prompt 时直接执行原文，例如 `/reset /stop` 会把 `/stop` 当作提示词。会尽力中止旧任务，迟到的回执和回复不会恢复旧绑定。
- `/status`：内部运行状态及消息计数。
- `/stop`、`/abort`：通过宿主中止当前范围的任务；投递尚未返回时提示稍后重试。
- `/model [provider/id|default]`：查看或设置该范围的模型。
- `/thinking [off|minimal|low|medium|high|xhigh|default]`：查看或设置思考强度。
- `/cwd [路径|default]`、`/workspace [路径|default]`：查看或设置工作目录，default 恢复面板默认值，下次投递由宿主校验路径并创建新会话。

命令名不区分大小写，支持全角字母和全角斜杠；仅命令名做字符规范化，prompt 与路径保留原文字形和内部空白。default 与思考强度不区分大小写。模型、思考强度和目录偏好仅存于桥接内存，插件重载后回到面板默认配置；scope 身份、epoch 与稳定会话路由持续保存。普通重复任务在忙碌时拒绝；重置及有效的模型、思考强度、目录 setter 均立即隔离旧上下文，不等待旧任务或投递回执，查询和无效参数不重置。模型与思考强度的实际可用性由宿主投递时校验，命令保存不代表模型已验证可用。

## 媒体支持

桥接接受 `voice` 消息已有的 `Recognition`/`recognition` 平台识别文本，并明确标记来源；没有识别文本时不宣称已转写。图片、文件、视频、原始语音和未知类型明确回复无法下载或解码，不把媒体 URL 当作视觉输入。当前未实现企微 media_id 下载、媒体解密或 ASR，不能读取这些媒体的内容。

出站提供 Markdown/文本消息和 UTF-8 字节预算分块。尚未提供图片、语音、文件、视频上传发送。

## 配置

群推送：在企微群中添加群机器人，复制 Webhook 中的 key，填入工作台。仅用于向对应群发送消息。

企业自建应用连接检查：填写 CorpID、应用 AgentId 与 Secret。密钥由宿主 secrets 保存；这些凭据不会自动创建回调服务或媒体接收能力。
