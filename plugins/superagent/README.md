# 内置外部渠道模块（Superagent 0.1.5）

GitHub / 飞书的内置渠道适配模块。将验证过的外部事件交给宿主工单服务，由**群组独立 AI Router 路由、Bot 执行**，再通过宿主持久 outbox 回写原渠道。插件不包含自己的 LLM、执行器或路由器。

后台回写只轮询已配置房间映射与发送凭据的渠道：GitHub 需要 API Token，飞书需要 App ID 和 App Secret。未配置时保持空闲，补全配置后自动恢复轮询，无需重启。正常每轮结束后等待 15 秒；宿主 outbox 调用失败时指数退避，重试间隔最长 5 分钟，每轮持续故障只警告一次，成功恢复后记录一次。警告仅包含可用的 HTTP 状态码与连接排查提示，不输出上游响应或密钥。

实现独立编写，没有复制 `dsh-superagent-prototype` 源码或引入其依赖。

## 内置入口与宿主要求

Superagent 随 pi-web-ui 主程序提供，首次启动自动准备并加载，无需另行下载或执行安装命令。从 **设备连接与跨平台协作 → 外部渠道** 进入配置，不再提供独立 Superagent 顶栏入口。默认观察模式，填写渠道凭据和房间映射后接收事件。

这是宿主内置功能，不出现在插件市场、已安装列表、插件菜单、布局编辑或启停开关中，也不能经普通插件安装 / 更新 / 卸载接口管理。内部复用插件宿主的隔离与路由能力，代码随主程序升级同步，密钥和设置保留。旧的插件禁用或卸载记录不会阻止内置渠道加载；模块文件缺失时由宿主在下次扫描准备。要暂停自动执行，将渠道设为 observe 或移除对应映射。

插件目录包含 `manifest.json`、`server.mjs`、`main.mjs`、`style.css`，以及兼容宿主固定发现规则的 `index.mjs` / `client/entry.mjs`。客户端入口通过插件自己的资源路由加载页面，兼容应用子路径部署。无额外 npm 依赖。

要求宿主提供：

- `host.route(method, path, handler)`，请求具备原始 **Buffer** `req.rawBody`，不能从已解析 JSON 重新构造；入站上限 1 MiB。
- `host.storage.get/set` 和加密 `host.secrets.get/set/delete`。配置只保存 secret 是否存在的状态，密钥明文只交给加密存储。
- `host.fetch`（或 Node fetch），支持标准 Response；插件测试注入 fetch，不访问真实渠道。
- `host.workItems`，由宿主隔离插件 connector 身份，要求 `chat` 权限；接口见下表。
- 宿主在主站认证前精确公开两条 `POST /api/superagent/webhooks/github`、`POST /api/superagent/webhooks/feishu`，转发给插件 `/webhooks/github` / `/webhooks/feishu`。这两条入口只接受渠道验证；配置和管理路由继续受主站认证保护。宿主 API 未安装或原始字节不可用时拒绝接收，不降级为不验签。

| 宿主接口                                        | 返回值 / 约定                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `rooms()`                                       | `[{id,name?}]`，用于配置映射                                              |
| `ingest(input)`                                 | 工单；持久去重键为 provider + eventId，同 ID 不同内容拒绝，重放不提升权限 |
| `list({roomId?})`                               | 工单数组                                                                  |
| `get(id)`                                       | 工单或 undefined                                                          |
| `update(id, patch)`                             | 更新后的工单；显式 `authorized:true` 表示人工授权，false 表示撤权         |
| `claimDelivery({provider,limit?})`              | delivery 数组，原子领取并附带租约                                         |
| `completeDelivery(id,{leaseToken,externalId?})` | 租约确认                                                                  |
| `failDelivery(id,{leaseToken,error})`           | 租约失败记录，宿主负责退避和后续重新领取                                  |

`ingest` 输入：`{provider,channelId,threadId,eventId,title,text,authorId,kind,roomId,mode,authorized}`。这组字段由适配器逐项构造，payload 中的授权、房间和执行配置不透传。工单 DTO 至少具备 `id/provider/channelId/threadId/roomId/authorId/status/authorized/manualAuthorized`。`manualAuthorized` 对应领域 `authorization.mode==='auto' && authorization.origin==='manual'`。delivery：`{id,leaseToken,workItemId,provider,channelId,threadId,text}`。宿主负责重试时间、租约到期恢复和持久化。

## 页面与权限

在设备中心的 **外部渠道** 中，可配置两渠道的凭证、模式、作者白名单和房间映射，查看工单列表 / 完整详情，暂停、恢复、完成、人工授权或撤销授权。点击“重试到期回写”只领取已到宿主重试时间的队列项目。

- 默认 `observe`。只有本机保存的配置为 `auto`、作者在允许名单中、渠道已映射到房间，而且 GitHub 仓库也在允许名单中，事件才携带自动授权。
- GitHub 作者填写**数字用户 ID**，不使用可改名的登录名；飞书作者填写 `open_id`。仓库名大小写不敏感，其他身份精确匹配。
- 映射每行 `owner/repo=roomId` 或 `chat_id=roomId`。未知渠道返回 `ignored`，提示先设置映射，不创建无房间工单。已映射的未授权作者仍创建观察工单。
- 配置修改、工单管理和手动触发回写额外检查 socket 是 loopback；存在 Origin 时必须与 Host 同源。通过远程设备访问页面可以读列表，但需要本机连接修改。此检查依赖真实 socket，不信任转发 IP 请求头。
- 密钥不返回 UI 明文。每项有“保留 / 替换 / 清空”：默认保留，替换必须输入新值，清空必须显式选择；保存后输入框再次留空。所有变更先验证配置和房间，再写密钥。
- 回写先重读工单，并在真正发送消息前再次核对授权。工单必须 `authorized`，自动授权还要通过当前配置、作者、仓库和房间映射检查；人工授权可独立允许单工单执行和回写。`blocked` / `cancelled` 禁止回写，`completed` 允许发送最终结果。撤销工单授权会停止后续消息发送；已经被渠道接受的消息不能撤回。

## GitHub

1. 在页面保存 Webhook Secret、GitHub API Token、仓库和房间映射。Token 需要目标仓库 issue / PR 评论写入权限及评论读取权限。
2. GitHub webhook Content type 设置 `application/json`，URL 填页面显示的 `/api/superagent/webhooks/github`，Secret 与页面一致。
3. 订阅 Issues、Issue comments、Pull requests、Pull request reviews、Pull request review comments。

接收的动作：

| GitHub 事件                   | 动作                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| `issues`                      | opened / edited / reopened / closed                                  |
| `issue_comment`               | created / edited                                                     |
| `pull_request`                | opened / edited / reopened / closed / synchronize / ready_for_review |
| `pull_request_review`         | submitted / edited                                                   |
| `pull_request_review_comment` | created / edited                                                     |

使用 `X-Hub-Signature-256` 对原始字节做 HMAC-SHA256 并恒时比较。`X-GitHub-Delivery` 作为事件 ID；`repository.full_name` 作为渠道；`#number` 作为线程；`sender.id` 作为作者。Bot 事件和带本插件回写标记的内容不再创建工单。PR review 和行内评论的回写统一写入 PR 的普通会话评论。

回写只访问固定 `https://api.github.com`，拒绝重定向，不接受 payload 提供的 API URL。每条回复带稳定 `<!-- pi-superagent:sha256(deliveryId) -->` 标记。重试前逐页查找原评论，找到则只确认宿主 delivery。最多检查 2,000 条评论；超过此范围停止发送并报告失败，避免遗漏旧标记导致重复。宿主确认丢失、插件重启后仍可靠原渠道标记恢复。

## 飞书支持范围

本版本支持**携带有效签名的明文或 AES 加密回调**：URL challenge 和 v2 `im.message.receive_v1` 用户文本事件。先校验原始请求字节的签名及时间窗，再按飞书官方 `IV || AES-256-CBC` 格式解密，最后校验 Verification Token 和 App ID；错误密钥、密文或 Token 均拒绝。算法格式参考[飞书官方 Node SDK](https://github.com/larksuite/node-sdk/blob/main/utils/aes-cipher.ts)。不支持卡片回调、富文本、图片和应用机器人消息。

需配置 Verification Token、签名使用的 Encrypt Key、App ID；外发还需 App Secret，应用具备相应机器人发消息权限并在目标群内。事件订阅 URL 填页面显示的 `/api/superagent/webhooks/feishu`。

同时校验事件 token、`X-Lark-Signature = SHA256(timestamp + nonce + EncryptKey + rawBody)`、五分钟时间窗和 App ID。challenge 也校验 token 与签名。消息使用 `sender.sender_id.open_id` / `chat_id` / `header.event_id` 识别身份，并关联 `root_id || parent_id || message_id`。只回复原线程，不接受外部 payload 指定收件目标。租户 token 只在内存缓存，凭证保存后清缓存。

每个 delivery 使用固定 UUID 回写；该 UUID 的渠道防重时间有限，插件不会把它当作永久幂等保证：

- 发送前持久记录第一次尝试时间；成功取得消息 ID 后先持久保存回执，再确认宿主租约。即使宿主确认丢失，后续重试可直接确认该回执，无需重发。
- 未取得回执的网络错误可能已经在渠道落地。只在首次尝试后 **45 分钟内**自动使用同一 UUID 重试，为渠道一小时防重窗口留出余量。
- 超过 45 分钟仍无回执则停止自动发送，delivery 错误标记 `manual reconciliation`，需要用户在飞书核对和人工处理；插件不会清空尝试记录后盲目重发。

## 插件 API

以下路径以 `/plugins-api/superagent` 为前缀，继续由宿主主站认证保护：

| 方法 / 路径                                     | 用途                                  |
| ----------------------------------------------- | ------------------------------------- |
| `GET /config`                                   | 配置和密钥存在布尔值                  |
| `PUT /config`                                   | `{config, secrets:{key:{action:'keep' | 'set'    | 'clear',value?}}}` |
| `GET /rooms`                                    | 可用群组房间                          |
| `GET /items?roomId=`                            | 工单列表                              |
| `GET /item?id=`                                 | 工单详情                              |
| `POST /items/update`                            | `{id,action:'pause'                   | 'resume' | 'complete'         | 'authorize' | 'observe'}` |
| `POST /deliver`                                 | 领取到期回写并返回本轮成功 / 失败数   |
| `GET /assets/main.mjs`、`GET /assets/style.css` | 页面资源                              |

页面 pause 对应 `blocked`、resume 对应 `open`、complete 对应 `completed`。所有更新只接受上述动作对应的固定 patch，不接受任意字段修改。后台每 15 秒领取到期 outbox，单次每渠道只领取一条，避免批量领取后等待导致租约过期；卸载清除轮询和路由。单个网络请求超时 15 秒，每条 delivery 共用 40 秒网络预算，为宿主当前 60 秒租约预留确认时间；错误记录不保存上游响应或密钥。

入站另有 4,096 个最近事件的持久回执缓存，用于并发和重启去重；**永久防重仍以宿主工单存储为事实源**。GitHub 验签本身没有新鲜度窗口，重放安全依赖宿主事件唯一约束。

## 验证

```sh
npx prettier --write plugins/superagent tests/unit/superagent-plugin.test.ts
npx vitest run tests/unit/superagent-plugin.test.ts
npm run typecheck
```

测试直接调用伪 host 注册的真实路由，注入 fetch，不启端口或访问真实 GitHub / 飞书。覆盖配置保留 / 清空、页面操作、签名与原始字节、身份与授权、并发 / 重启重放、租约确认、失败重试、撤权、回写防重及飞书超出防重窗口后的拒绝发送。
