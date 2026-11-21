# pi-tunnel CHANGELOG

## 1.5.0（2026-10-24）安全修复：wsPort 鉴权 + 设备安装链路修正

### wsPort 鉴权（上游 60daa53d 移植）

- **security(/cli /status /pi-pkg)**：WS 汇聚口（:8765 全网卡）此前无鉴权——任意同网可达主机可下载内嵌完整 token 的 CLI 源码（冒充设备/踢掉真设备/劫持 SOCKS 出口）、读设备拓扑、拉 agent 离线包。三端点统一 `?token=` 校验（`tnlAuthed`，失配 401）。宿主 route 通道（/plugins-api/tunnel/*）由面板自身鉴权体系保护，不变更。
- **feat(snapshot)**：statusSnapshot 增发完整 `token`（仅授信面板可得），面板用它拼设备安装命令。

### 设备安装链路修正（配合鉴权）

- **fix(persistCmd)**：三平台 curl 下载 /cli、/pi-pkg 补 `?token=`（否则升级后设备装不上）。
- **fix(/pi-pkg wsPort 缺失)**：persistCmd 从 wsPort 下载 pi-agent.tgz，但 wsPort handler 只有 /cli /status——设备会下到纯文本、tar 解包必失败。wsPort 补 /pi-pkg 分支（同款鉴权，流式回 404）。

### 部署注意（破坏性变更）

- 升级到 1.5.0 后，旧版 persistCmd（无 token）复跑会 401；新命令从面板「网络隧道」页复制即可。

## 1.4.0（2026-10-24）P3b 打磨

### persistCmd 模板修复（launchd %h 实锤）

- **fix(persistCmd)**：macOS plist `StandardOutPath` 的 `%h/pi-tunnel-cli.log` launchd 不展开占位符 → 日志文件建立失败 → spawn 即 `78 EX_CONFIG`（设备反复"手动能跑、launchd 拉不起"的最终根因）。改 `$HOME/pi-tunnel-cli.log`（heredoc 展开为绝对路径）；Linux systemd 的 %h 合法保留

### 设备端 CLI p15（connect 废弃卡死修复）

- **fix(connectGuard)**：undici WebSocket 在 CONNECTING 态调 close() 不触发 onclose，废弃后重连链死亡（设备 18min 无动作实锤）。废弃后 3s 复检 readyState 仍 0 → exit(0) 由 launchd KeepAlive 重拉（进程级重启是唯一可靠复位）

### 多设备路由修复

- **fix(mesh 投递路由)**：p3a 版本把所有消息投给 `activeAgent()`（单设备侥幸正确，多设备必投错）。现按消息所在 inbox 目录（目标设备 agent 名）→ registry `device` 字段反查设备 aid 定向投递；目标离线则滞留等上线补发（`meshEnqueueFile` 签名加 `nm`）

### 设备端会话管理

- **feat(CLI p14)**：`GET /session`（快照：sessionId/updatedAt/size，只读）+ `POST /session/reset`（删 `~/.pi-tunnel-agent/session.json`，下条消息开新会话）
- **feat(server)**：`GET /mesh/session`、`POST /mesh/reset`（均支持 `?agent=`/`agentName` 指定设备，默认活跃设备；审计 `mesh.sessionReset`）
- **feat(面板)**：Mesh 卡新增「会话」（快照弹窗）+「重置会话」（confirm 后调 reset）按钮

### 文档

- README 重写至当前能力面（架构图/能力矩阵/三级解析/排障表/mesh 用法），更新日志补 1.2.0/1.3.0/1.4.0

## 1.3.0（2026-10-24）Phase 3a：pi_messenger mesh 桥

### 新增

- **mesh 桥**：设备 agent 以 `Remote<驼峰主机名>` 接入 pi_messenger——纯文件桥（registry/inbox watch/离线补发限 5 条/滞留队列），pi-messenger 零改动；`GET/POST /mesh` 开关 + 面板 Mesh 卡
- **设备端持久会话**：`--session <uuid>` 跨消息记忆（CLI p12→p14）；上行 `{t:'msg-res'}` 回发起方 inbox + wake

### 修复（附根因）

- **mesh resume**：`--resume` 无论组合什么 flag 必弹 TUI 会话选择器（pi dist/cli/args.js + main.js 源码实锤），p11 误诊为 `-n` 污染；改 `--session <uuid>`（exact-id 本地匹配直接 open 零交互），跨消息记忆实测通过
- **TDZ 竞态**：`meshEnabled` 由 const 箭头改 function 声明——hello/离线钩子可在 startTunnel await 让出期触发，先后两次致 activate failed（"时好时坏"真凶）
- **ver 下发同步**：握手 `t:"ver"` 硬编码与 assets/cli.mjs CLI_VER 两轮漏改（p11/p12 卡推送）；改 `CLI_VER_PUBLISH` 常量

### 定论

- **launchd KeepAlive 自愈实锤**（1.3.0 期内验证）：主人盖屏→开盖→自动回连；设备端 plist `KeepAlive=true` 远程读取验真。"老要重跑"主因=Mac 睡眠（物理规律非故障），唤醒后 5-10s 自愈无需重跑

## 1.2.0（2026-10-24）

### 模型通道重写（修复 Phase 1 暴露的两缺陷）

- **fix(resolveModelEnv)**：废除「正则扫 client-state.json 全文取第一个 `provider/model`」的伪实现——它命中的是 `projectModels` 里任意项目条目（如 WorkSpace 的 ark 模型），并非当前会话模型；且 client-state 无可靠的"当前模型"字段，该路径不可修，直接移除。
- **fix(标准 provider 不注 key)**：旧版标准 provider 返回 `{env:{}}` 只传模型 ID，设备端 pi 无凭据直接报 `No API key found`；新版统一注入 `OPENAI_BASE_URL` + `OPENAI_API_KEY`。
- **feat(三级解析)**：新 `resolveModelEnv(wantModel)` 语义改为「为设备任务挑一条可用模型通道」：
  1. 请求级 override：`POST /device/task` 带 `model="provider/model[/…]"` 精确解析该 provider；
  2. 面板手动 modelEnv（storage 三元组）；
  3. 自动枚举 `models.json` providers ∩ `provider-keys.json`，仅 openai-completions 型；内网网关 baseUrl（127.0.0.1/localhost）自动换算 `lanIp` 并优先排序（设备同网段直连，流量不出公网）。
- **feat(REST)**：`GET /modelenv`（manual/resolved/candidates，key 只回尾部 4 位）、`POST /modelenv`（保存手动三元组 / `{clear:true}` 恢复自动）。
- **feat(面板)**：「网络隧道」页新增**模型通道**卡：生效状态（来源/模型/key 尾部）、手动三元组编辑（key 不回填）、恢复自动、自动候选展示。
- **边界**：anthropic-messages 型 provider（minimax-cn/ark-anthropic）设备端暂不支持注入（设备 CLI 的 `/task` 仅对 `OPENAI_*` 回写设备侧 models.json），选中时返回明确错误；后续版本评估。
- 日志：`[tunnel] task → …` 增加 `src=` 字段（override/manual/auto）便于排障。

## 1.1.1 及更早

见 `git log -- plugins/tunnel/`。
