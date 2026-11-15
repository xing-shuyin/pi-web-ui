[English](./README.en.md) · **简体中文** · [繁體中文](./README.zh-TW.md)

# 🐦 feishu —— pi-web-ui 飞书工作台插件

在 pi-web-ui 界面里提供一个完整的飞书 / Lark 工作台（顶栏 🐦 飞书 标签页）：
支持飞书企业自建应用双向会话收发与自定义群机器人 Webhook 卡片推送，新消息轮询提醒，并将飞书交互能力开放给 AI 直接调度。HTTP API 使用内置 fetch 与 crypto；双工长连接使用官方 `@larksuiteoapi/node-sdk`，缺失时通过宿主 `ensureDeps` 安装。

## 功能

- **会话与通道**：
  - 浏览机器人加入的群聊与单聊会话
  - 支持手动添加自定义快捷接收人（`chat_id` `oc_...`、`open_id` `ou_...`、用户邮箱）
  - 内置虚拟 Webhook 推送通道（`__webhook__`），即使没有企业自建应用，仅凭群机器人 Webhook 也可完整使用
- **消息浏览与阅读**：
  - 支持查看与解析多种飞书消息类型：纯文本（`text`）、富文本（`post`）、交互卡片（`interactive`）、图片、文件、视频、名片等
  - 关键词搜索当前会话或近期聊天记录
  - **一键引用到对话**：一键将飞书消息格式化引用注入主聊天输入框
  - **智能翻译**：支持中英互译、可选特定 AI 模型翻译，自动保护 URL 与代码块，内置 Google GTX 快速回退
  - **原始数据查看**：可展开查看飞书 Open API 下发的原始 JSON 结构
- **消息发送与富交互**：
  - 发送纯文本、富文本（带标题）或飞书交互卡片（支持 Markdown 与 10 种卡片标题配色主题：蓝色、绿色、橙色、红色、紫色等）
  - 支持直接回复或**话题内回复**（reply in thread）
  - 支持一键**撤回**（recall）机器人发送的消息
  - 支持**表情回应**（reactions）：👍 点赞、👌 好的、❤️ 爱心、👏 鼓掌、✅ 完成、🔥 火焰
- **自定义机器人 Webhook**：
  - 支持飞书群自定义机器人 Webhook 地址推送
  - 支持基于 HMAC-SHA256 的签名校验密钥（Secret），自动计算 `timestamp` 与 `sign`
  - 本地自动留存 Webhook 推送历史，方便追溯和排查
- **状态栏与新消息提醒**：
  - 后台周期性轮询监控会话新消息（默认 60s，可自定义）
  - 发现新消息时通过 `host.notify` 弹出桌面/网页通知并触发广播
  - 状态栏实时显示徽标（`🐦 3 未读` / `🐦 ✓` / `🐦 Webhook` / `🐦 未配置`）
- **AI 飞书管理工具 (`feishu`)**：
  - 激活后向宿主注册 action 式 `feishu` 工具：
    - `chats`：列出群聊与会话列表
    - `list`：获取会话近期消息列表
    - `read`：阅读单条消息详情与正文
    - `search`：搜索消息内容
    - `send`：向群或个人发送文本/富文本/卡片消息
    - `reply`：回复指定消息（支持话题内回复）
    - `recall`：撤回机器人发送的消息
    - `react`：为消息添加表情回应
    - `webhook`：直接通过群机器人 Webhook 推送卡片或文本
  - 遵循严格的提示词与安全规范，发送前提示模型先向用户确认目标与内容

## 0.3.0 双工命令与媒体

命令均在通道本地处理：`/help`、`/new [prompt]`、`/clear [prompt]`、`/reset [prompt]`、`/status`、`/stop`（别名 `/abort`）、`/model [provider/id|default]`、`/thinking [off|minimal|low|medium|high|xhigh|default]`、`/cwd [绝对路径|default]`（别名 `/workspace`）。命令名兼容大小写、全角字母和全角斜杠；思考强度与 default 不区分大小写。重置后的 prompt 直接作为新会话输入，保留内部空白及字面 `/stop`、`@文本` 等内容，不再解析为命令。未知命令直接反馈，不送模型。

会话按发送人、聊天和 thread 隔离。新建、清空及切换目录均递增账号 epoch，确保宿主建立全新上下文；旧历史保留。`/new`、`/clear`、`/reset` 及模型、思考强度、目录 setter 均立即重置当前作用域并请求停止旧运行，下载、表情反馈和回执等待中的旧消息不再投递或恢复旧绑定；其他聊天和 thread 不受影响。模型列表验证完成前发生的重置会使该 setter 失效，避免迟到验证覆盖新上下文。default 清除该项覆盖并恢复插件配置默认值。目录只做绝对路径检查，存在性与访问限制由宿主在下一次投递时验证。模型从宿主列表校验，模型与思考强度在下一次请求真实传递，最终支持情况由宿主验证。偏好只保存在运行内存；epoch 与稳定 session 路由持久化，重载后仍保留。

机器人下载图片（包括富文本内图片）、文件、语音及视频，向 `host.chat({text, attachments})` 投递真实字节。图片使用 `imageData`，其他文件使用 `fileData`，由宿主持久化；需要支持该附件契约的新版宿主。图片最多 8 张，每个图片或 fileData 附件最多 10MiB；同一消息的 imageData 与 fileData 共用累计 20MiB 预算，按 Base64 编码前的原始字节数计算。图片支持 PNG/JPEG/GIF/WebP，以文件头检查格式；完整像素解码由宿主/模型完成。资源权限不足、下载失败、不支持的格式均明确反馈。通道不自带 ASR、音频转码或视频解码；音视频作为文件交给模型工具处理，不能保证内容理解，收到时明确告知限制。

AI 工具 `feishu` 的 `send/reply` 支持 `msg_type=image|audio|file|media` 与 `file_path`，读取真实本地文件、上传飞书后发送；音频仅 Opus、视频仅 MP4，须提供真实毫秒 `duration`。其他格式可用 `file` 发送。文件读受宿主 fs 授权限制（插件新增 fs 权限），单文件最多 10MiB。媒体发送通过 AI 工具执行；工作台输入框仍为文本/卡片，Webhook 不支持媒体。助手输出的任意路径不会自动上传，须调用工具发送。

回执必须含真实 `conversationId/runId`，事件只按稳定 runId 关联，支持早到消息/结束事件和过户改名。分块全部回复原消息并保持 thread。停止命令旁路处理，下载中的任务取消派发，等待回执的任务在收到回执后调用宿主 abortRun；不会伪称已中止尚无回执的宿主运行。运行错误、空结果和回信失败均尝试文字反馈；飞书完全不可用时只能记录错误，无持久重试队列。

## 0.3.2 持续会话与网页续聊

同一发送人、聊天及 thread 持续使用原会话；宿主返回稳定 `sessionId` 后，插件持久化应用账号指纹、scope、epoch 与原消息/thread 目的地。网页在该 session 主动续聊时，最终助手候选会回复原消息并保持 thread；工具前言不会与最终答复拼接。原请求严格按 runId 关联，未知 runId、仅有 `c1` 的事件不会认领路由；旧宿主仅在同时提供完整 clientId/conversationId 时支持本次加载内的网页续聊。

`/new` 等重置撤销当前 scope 路由并持久化新 epoch，应用凭据/平台变更撤销全部旧路由。普通停止与插件重载不重置 session；只恢复稳定 sessionId 路由，不恢复未完成运行或重发旧答复。网页无 runId 的任务无法精准调用 abortRun 时，命令明确提示从网页停止，不猜测 canonical conversationId。发送继续使用现有飞书消息回复 API；失败保留状态错误并尝试文字提示，无持久发送重试队列。路由持久化失败也会显示最近错误。

## 配置

在工作台点击右上角「⚙ 配置」即可打开设置面板：

| 字段                | 说明                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| 接入模式 / 平台预设 | 飞书国内版 (`open.feishu.cn`) / Lark 国际版 (`open.larksuite.com`) / 仅自定义机器人 Webhook / 自定义私有化网关 |
| App ID (`cli_xxx`)  | 飞书开放平台 → 企业自建应用 → 凭证与基础信息                                                                   |
| App Secret          | 企业自建应用密钥（加密落盘保存，前端回传自动脱敏）                                                             |
| 默认会话 ID         | 可选，如 `oc_xxx`，留空时默认取首个群聊                                                                        |
| 轮询间隔 pollSec    | 新消息检查周期（秒），默认 60s（最低 15s）                                                                     |
| Webhook 地址        | 飞书群机器人 Webhook 地址（如不需要自建应用，仅填此处即可使用卡片推送）                                        |
| Webhook 签名密钥    | 可选，自定义机器人的安全签名密钥（HMAC-SHA256 加密保存）                                                       |

密钥优先存储于宿主的安全机密库（`host.secrets`，AES-256-GCM 加密落盘）。

## 安装 / 卸载 / 更新

```bash
# ── 安装 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/feishu
pi-web-ui install plugins/feishu        # 本地目录开发态

# ── 查看 ──
pi-web-ui plugins                        # 列出已装插件与 id

# ── 更新 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/feishu --force
cp -r plugins/feishu ~/.pi-web/plugins/  # 本地开发直接覆盖

# ── 卸载 ──
pi-web-ui uninstall feishu
```

## 回归测试

- `tests/unit/feishu-session-routes.test.ts`：两 scope 同 c1 并发、网页回传、重复/未知事件、重置、重载与账号变更
- `tests/unit/feishu-runtime.test.ts`：命令、epoch、旁路停止、真实媒体附件、上传、稳定 runId 与跨群/thread 隔离行为测试
- `tests/unit/feishu-features.test.ts`：纯函数单元测试（消息解析、卡片生成、Webhook HMAC 签名、URL 保护与格式转换）
- `tests/unit/feishu-secrets.test.ts`：敏感凭证加密持久化与脱敏测试
