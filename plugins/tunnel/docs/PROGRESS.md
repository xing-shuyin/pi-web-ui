# pi-tunnel 阶段进展文档

> 更新：2026-10-24 11:00 · 状态：Phase 1 ✅ / Phase 2 ✅（v1.2.0）/ Phase 3a ✅（v1.3.0）/ **Phase 3b ✅ 验收全过（v1.4.0+CLI p15）；设备端 launchd 78 修复待主人跑 xattr**
> 本文档是跨会话续命的真相源：新会话接手先读这里。

## 架构速览

- **mini**（172.16.120.11，运行 pi-web-ui）＝隧道 server；**笔记本 WDLMacBook-Pro.local**（用户 gxg）＝出口设备，经反向 WS 连入
- 源仓 `~/projects/pi-web-ui-upstream/plugins/tunnel/`（源仓有 auto 落仓守护，改动会被自动 commit，无需手动 git）
- 部署位 `~/.pi-web/plugins/tunnel/`（改完源仓必须 cp 过去，文件层级：index.mjs 根 / assets/cli.mjs / client/entry.mjs）
- 备份：`~/WorkSpace/pdd-backup/tunnel-plugin-pre-*`（历次部署前全量）
- 路由规范：REST 挂 `/plugins-api/tunnel/`（`?token=` 鉴权）；WS 8765；SOCKS5 1080（仅 127.0.0.1）
- token 来源：`~/.pi/secrets/com.xingshuyin.pi-web-ui.env` 的 `PI_WEB_TOKEN`

## 已交付

### Phase 1（SSH→SOCKS→控制通道闭环）✅

- SSH 方案废弃（笔记本 22 静默 drop，远程登录未开）；走 WS 控制通道
- `POST /plugins-api/tunnel/device/task` → 笔记本 pi agent 端到端 PONG ✅（模型通道 wildwork/glm-5.3，LAN baseUrl `http://172.16.120.11:7863/v1`）

### Phase 2（v1.2.0，模型通道三级解析）✅

- 修复：①正则误抓非会话模型（原 client-state.json 第一个 provider ≠ 会话）②标准 OpenAI 兼容 provider 的 key 不注入
- `resolveModelEnv(model?)` 三级：override（面板任务带 model）→ manual（storage.modelEnv 手动三元组）→ auto（会话 models.json + provider-keys.json）
- 面板新增"模型通道"卡（读取/手动指定/恢复自动）；REST `/modelenv`（GET/POST/clear）
- 设备端动态 models.json：`providers.tunnel` 注入 → `--model tunnel/<id>`（anthropic-messages 型 provider 设备端不支持，只走 openai-completions）
- 日志加 `src=auto/override/manual` 便于排障

### Phase 3a（pi_messenger 文件桥）— 代码全部完成，验收进行中

设计全文：[PHASE3-MESH-DESIGN.md](./PHASE3-MESH-DESIGN.md)（含实时性三层次分析）

已改动（源仓已同步部署位，v 提到 p10）：

1. `assets/cli.mjs`（p10）：`/task` 支持 `mesh/msgId/from` → 持久会话（`~/.pi-tunnel-agent/session.json` 记 sessionId，`--resume` 续聊）→ 完成后 WS 上行 `{t:'msg-res',msgId,to,ok,text,ms,err}`（text 取最后 message_end 的 assistant content）
2. `index.mjs`：mesh 桥模块（MESH_DIR=`~/.pi/agent/messenger`）——`meshAgentName()` 驼峰（WDLMacBook-Pro.local→RemoteWDLMacBookPro）、registry 读写（online/offline 自定义字段 `offline:true`）、inbox watch（只消费设备 agent 自己的 `<name>/*.json` 防环）、串行投递（deviceCtrl /task，mesh 用三级解析默认通道，tools=read,grep，10min 超时）、上线补发（限 5 条，更旧回写 skipped）、GET/POST `/mesh`（storage `meshEnabled` 开关）；WS `msg-res` case 写发起方 inbox（wake 靠 pi-messenger watcher，**pi-messenger 零改动**）
3. `client/entry.mjs`：Mesh 桥卡（开关+状态+队列）
4. 踩坑修复：startTunnel 里直接调 `meshEnabled()` 是 TDZ（const 箭头函数在启动路径之后才定义）→ 改 setTimeout(0) 延迟到 activate 完成后；activate failed 已消除
5. 备份：`~/WorkSpace/pdd-backup/tunnel-plugin-pre-p3a-20261024-081351/`

## 验收结果（2026-10-24 全部通过，v1.3.0）

| 验收项                                                                 | 结果                            |
| ---------------------------------------------------------------------- | ------------------------------- |
| 服务激活无错（TDZ 根治后 activate failed=0）                           | ✅                              |
| registry 自动注册 RemoteWDLMacBookPro + 设备 CLI p12                   | ✅                              |
| mesh 端到端首条（PONG 回到发起方 inbox + wake）                        | ✅                              |
| `--session` 持久会话跨消息记忆（设备答"第 2 条，第 1 条是 mesh 验收"） | ✅                              |
| TDZ 期滞留消息补发（3 条 .done）                                       | ✅                              |
| launchd KeepAlive 自愈（进程死自动拉起）                               | ✅ **主人实测盖屏重开自动回连** |

### "老要重跑"终审定论（2026-10-24）

1. ~~server 侧 TDZ~~（已根治）：meshEnabled const TDZ 竞态 → activate failed → WS 端点消失
2. **主因=Mac 睡眠**：电池模式自动睡眠 → 进程冻结 → WS 断（物理规律非故障）；开盖后 launchd KeepAlive 拉起回连——**主人实测盖屏重开自动回连，自愈链完整**
3. 历次"重跑"实为：唤醒后未等 5-10s 自愈就手动重跑（persistCmd 幂等，无害但没必要）

- 设备端 plist 已远程读取验真：`KeepAlive=true` + `RunAtLoad=true` + 路径全部正确展开（/Users/gxg/.local/bin/node）
- persistCmd 日志路径已改 `~/pi-tunnel-cli.log`（白名单内可远程读；设备端现有 plist 仍是 /tmp 旧值，下次主人刷新面板重跑时才换新）

### resume 误诊更正（p11→p12）

p11 注释"`-n` 污染 resume"是**误诊**：实际 args 是 `-ne`（no-extensions），`indexOf('-n')` 根本匹配不到；pi 源码实锤 `--resume` 无论组合什么 flag 都必弹 TUI 选择器。p12 改用 `--session <uuid>`（exact-id 本地匹配直接 open，零交互）——实测跨消息记忆通过。

### 收尾状态

- manifest 1.3.0 + CHANGELOG 1.3.0 条目已落；git auto 落仓静候守护
- 遗留：面板 /device/task 无执行命令通道（special:"full" 字段不存在，b9 摘要记错）；deviceCtrl 设备 id 为会话级递增（a1→a2…），调用方须从 GET /status 动态取，硬编码必撞 503

## Phase 3b（v1.4.0，2026-10-24）——打磨 + 多设备路由修复

### 已落改动（源仓=部署位，备份 pdd-backup/tunnel-plugin-pre-p3b-20261024-095829）

1. **mesh 投递按目标路由**：p3a 把所有消息投给 activeAgent()（单设备侥幸正确，多设备必投错）；现按 inbox 目录（目标设备 agent 名）→ registry.device 反查 aid 定向投递，目标离线滞留等补发。`meshEnqueueFile(fp, nm)` 签名变更，registry 设备名字段为 `device`（非 deviceName）
2. **设备端会话管理（CLI p14）**：`GET /session` 快照（sessionId/updatedAt/size）+ `POST /session/reset`（删 session.json）；server 侧 `GET /mesh/session`、`POST /mesh/reset`（支持 ?agent= 指定，审计 mesh.sessionReset）；面板 Mesh 卡「会话/重置会话」按钮
3. **README.md 重写**：架构图/能力矩阵/三级解析/排障表/mesh 用法，更新日志补齐 1.2.0/1.3.0/1.4.0；CHANGELOG 重排（1.4.0→1.3.0→1.2.0→1.1.1）

### P3b 验收（20261024 全部通过）

- [x] 设备上线 p15（persistCmd 强刷 + 手动前台跑验证 CLI 本体正常）
- [x] GET /mesh/session 快照（exists/sessionId/updatedAt/size）
- [x] POST /mesh/reset 返回 removed=旧 sessionId，复查 exists:false
- [x] reset 后 mesh 首条 → 设备回「PONG-p3b · 新会话已建立」→ 回复到达 WildIce inbox
- [x] 单设备路由回归：与 p3a 行为一致

### P3b 期事故与定论

1. **“设备死循环”误判**：日志 9 次「mesh 桥已启动」实为 pi-web-ui 每次重启各打一条，非设备重连——取证先分清日志是哪一端的
2. **connect 废弃卡死（CLI p15 修复）**：undici WebSocket 在 CONNECTING 态调 close() 不触发 onclose，connectGuard 废弃后重连链死亡（设备 18min 无动作实锤）。修复：废弃后 3s 复检 readyState 仍 0 → exit(0) 由 launchd 重拉
3. **launchd 78 EX_CONFIG 定论（%h 占位符）**：persistCmd 模板 plist `StandardOutPath=%h/pi-tunnel-cli.log`，launchd 不展开 %h → 日志文件建立失败 → spawn 即 78（"手动能跑、launchd 拉不起"）。修复=模板改 `$HOME`（已部署）；设备端主人 sed 改绝对路径后 11:00:54 常驻上线。取证教训：launchctl print 的 last exit code 是启动层退出码，先查 plist 路径展开再查二进制；quarantine/provenance 是红鲱鱼

## 关键陷阱备忘

- `cp $S/assets/cli.mjs $D/` 会丢 assets 层级（文件落部署位根目录）——必须 `cp ... $D/assets/cli.mjs` 且 diff 验证
- kickstart 重启服务会中断正在执行的 bash 工具调用（合成结果提示"可能已执行"）——重启命令单独发
- `meshEnabled()` **必须**用 function 声明（带提升）：hello/离线钩子可在 startTunnel await 让出期触发（const 箭头 TDZ 竞态已两次致 activate failed，20261024 根治）
- pi CLI：`--resume`（无值形式）必弹 TUI 选择器，与任何 flag 组合无关；跨进程续会话用 `--session <uuid>`（p12 实锤）
- deviceCtrl 设备 id 会话级递增（`a${nextAid++}`），设备进程重启后换号——调用方从 GET /status 动态取，硬编码必 503
- CLI 自更新会主动退出进程——设备端 launchd KeepAlive 已实锤自动拉起（主人盖屏→开盖实测回连）
- /device/fs browse 只返回 dirs 不返回文件；读文件用 POST /device/fsread（返回 b64）
- 环节文件：设备端 cfg `~/.pi-tunnel-cli.json`；会话 `~/.pi-tunnel-agent/`；CLI 进程由设备 launchd 常驻
- token 环境变量在 `~/.pi/secrets/com.xingshuyin.pi-web-ui.env`（32 字符）
