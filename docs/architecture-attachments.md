# 附件、图片与文件处理

> 覆盖附件模式、图片问答、视觉桥、文件上传/下载/预览协议。

## 活动内容隔离

`/api/file`、`/api/attachment/:hash` 和 `/api/preview` 在返回任何类型内容之前统一设置 CSP sandbox 与 nosniff，不能依赖 HTML/SVG 扩展名枚举。`allowJs=1` 仅允许 `sandbox allow-scripts`，不授予 `allow-same-origin`。因此 `.shtml`、`.xht` 等浏览器活动文档同样不拥有宿主源。

实时预览的模块与 SSE 通过插件每次激活生成的 256 位随机 capability 路径访问；正常入口仍需宿主认证，仅这个已注册插件的 GET/HEAD capability 可免宿主口令代理。代理剥离宿主认证头/cookie，响应保持 opaque origin、无凭据 CORS 和 no-referrer；停用关闭 SSE 并撤销路径。此路径本身授予预览资源读取权限，不应分享给无权查看项目的人。

## 存储与传输完整性

- 附件存储首次查询异步建立旧目录索引，并发查询共享初始化；成功保存增量更新索引，后续 hash 查询不再同步全目录扫描。HTTP 附件响应流式发送，支持 Range 与断开回收。运行期间外部导入附件后需重新初始化索引。
- 本地已有文件保存先准备同卷临时文件，使用平台原生元数据保留和替换机制；失败保留原文件，不回退截断写入。符号链接跟随实际目标，多硬链接文件拒绝原子替换。原子可见性不代表断电持久性；平台无法保留元数据时明确失败。远端已有文件保存仍使用 SFTP，不能承诺原子替换。
- 新文件上传以独占方式提交完整临时文件，同名竞争不得覆盖。对话附件路径包含 UUID，避免同毫秒同名覆盖。
- HTTP 上传在接收正文前校验客户端、路径、类型和声明大小；单文件默认 32MiB，可通过设置调整至 1–100MiB；最多 4 个并发，总预留 200MiB。本地流式落盘；远端 Buffer 受相同预算约束。取消必须等待实际写流释放后才归还额度。

## 上传限制与进度

设置中的上传大小上限按入口分别保存：聊天附件默认 20MiB、文件面板默认 100MiB、文件夹上传的每个文件默认 32MiB，范围均为 1–100MiB。配置全局共享，前端预检与服务端校验使用相同值；旧配置自动补齐默认值。WebSocket 仍保留固定的 100MiB 原始文件硬容量，不能通过设置绕过。

进度区分本地读取、发送等待确认与服务端保存结果。文件面板的 WebSocket 上传通过 `uploadId` 与 `file_upload_result` 关联，目录变化不能作为上传成功依据；HTTP 文件夹上传通过请求传输进度与最终响应确认结果。

## 附件模式（一律只给路径）

`ClientMessage.prompt.attachments[].mode` 决定附件如何发送给模型。**文件内容永远不注入 prompt**
（小文件也一样）：服务端只发路径引用，模型用自己的 read 工具按需读（自带截断/分页）。

| mode        | 含义   | 服务端处理                                                                                     |
| ----------- | ------ | ---------------------------------------------------------------------------------------------- |
| `reference` | 仅路径 | 发 `<file path="..." size="..."/>`（上传文件是 uploads 目录下的绝对路径）                      |
| `lines`     | 行范围 | 发 `<file path="..." lines="2-3" size="..."/>`，告诉模型用户选的是哪几行（不读文件、不带内容） |
| `inline`    | 遗留   | **旧版「全文注入」的遗留值**（旧客户端/旧草稿会发）：服务端按 `reference` 处理，不再注入内容   |

图片（`imageData`、指向图片的工作区路径）仍作为 image 内容发送（见下）；目录、网页引用、对话引用各有自己的卡片形态。

附件作为独立 custom message（`sendCustomMessage` + `deliverAs: "nextTurn"` asides）发送，渲染成可折叠卡片。客户端 `stripFileWrapper` 的正则要兼容 `lines="..."` 属性。

**消息序列化缓存按 `role:timestamp` 为 key——同一 prompt 的多个 aside 同毫秒创建会碰撞，必须靠内容指纹（`contentFingerprint`）区分，否则只有第一个渲染（已修，勿回退）。**

### 待发附件的生命周期（跟会话走，不跟页面走）

输入框里那排待发附件 chips（📎/🔗/💬/🖼/🌐）只活在 `App.tsx` 的 `attachments` state 里
（不进服务端、不持久化），**发送成功即清空**。它与正文草稿（按 `sessionId` 存、切回旧会话会恢复）
是同一个「本会话待发送内容」的两半，所以**会话身份一变就一起清空**：

- 判据是 `UiState.sessionId`（pi/DSH 双引擎都有；`conversationId` 重启即变，不能当会话身份），
  纯函数在 `web/src/composer-draft.ts` 的 `advanceComposerSession`（单测：`tests/unit/composer-draft.test.ts`）。
- 触发场景：新建对话、切换对话、手动过户、切项目（切 cwd）——新对话因此是干净开始。
- 瞬时态（断线重连、快照里 `sessionId` 短暂为空）不动水位也不清，避免误清用户的待发附件。
- 不做按会话保存：切走再切回来时正文草稿会恢复、附件不会（若要「切回旧对话连引用一起回来」，
  得把 chips 也按 sessionId 存，属于设计升级）。

## 聊天文字引用

在同一条聊天消息内选中文字或代码，松开鼠标后显示「引用」按钮。点击后通过 `composeToComposer` 添加待发送引用卡片，保留输入框草稿。卡片可展开查看原文、独立移除；同一来源和原文的重复引用去重，不同片段可同时发送。滚动、按 Escape 或切换会话时隐藏浮动按钮。

- 协议：`PromptAttachment.mode = "quote"`，`path` 留空，`quote` 保存选中文字、来源消息标识、角色和会话标识。原文以副本保存，保留换行和代码缩进。
- 前端：`quote-selection.ts` 校验选区范围，排除操作按钮、输入框和跨消息选区；`SelectionQuoteButton` 定位浮动按钮；`TextQuoteCard` 在输入框、已发送消息和编辑重问中展示引用。
- 标准 pi 引擎：空闲时 `buildAttachmentMessages` 将引用编码为独立的 `customType: "file"` 上下文消息，`details.mode = "quote"`，`details.quote` 用于历史展示和编辑恢复。生成期间将引用编码在对应排队或插队问题的末尾，避免引用滞留到下一条问题；序列化时还原为用户消息的 `details.quotes`。
- 标准 pi 引擎队列：展示时拆出引用卡片；撤回时恢复提问草稿和引用附件；移除时连同引用一起删除。输入框和编辑重问均允许仅发送引用。
- DeepSeek Harness 引擎：引用作为独立文字块发送，`dsh-serialize.ts` 在历史回放时还原为用户消息的 `details.quotes`；续聊、编辑和分支上下文重新编码这些引用。编码和校验共用 `server/text-quote.ts`。
- 回归：`tests/unit/quote-selection.test.ts`、`text-quote.test.ts` 和附件/草稿相关单元测试；构建后运行 `node tests/quote-selection-ui-test.mjs`，使用真实 Chrome 和本地模拟模型服务验证发送、刷新和编辑恢复，不访问真实模型。

## 图片问答（无工作区路径）

粘贴（Ctrl+V）/ 拖入输入框（**整个窗口都是拖放目标**，issue #19：`.app` 根节点接文件 dragover/drop + 全屏 `.app-drop-overlay` 高亮（唯一提示，输入条不叠局部遮罩）；输入条与编辑器自身 handler 在 drop 上 stopPropagation 保优先级，因此 App 另在 window 捕获阶段监听 drop 复位遮罩——否则落点在输入条时全屏遮罩会常驻）/ 🖼 上传的图片带 `attachments[].imageData`（base64）+ `mimeType` + `name` 发送——服务端直接作为 image content 附加，不走文件路径（`path` 忽略）。浏览器端（`web/src/image-paste.ts`）先把图片等比缩到 ≤1568px、按需转 PNG/JPEG，保证 payload 在服务端 2MB 上限内（`MAX_PASTED_IMAGE_BYTES`）。当前模型不支持识图（`model.vision`）时前端提示警告。

## 视觉桥

当**当前对话模型不支持识图**（DeepSeek/GLM 等 `input` 只有 `text`）时，`buildAttachmentMessages` 不再把图片直接作为 image content 发送（会被忽略），而是交给一个**已配置的视觉模型**转写成文字证据再喂给主模型（`server/vision-bridge.ts`）：

- **零配置自动发现**：`findVisionModels` 扫描 `ModelRuntime` 所有 **`hasConfiguredAuth`** 的 provider，找出 `input` 含 `"image"` 的模型（qwen-vl、GLM-4V、Gemini…）——复用 models.json/auth.json 里已有的凭据，不新增任何配置。⚠️ 必须过滤未配置的 SDK 内置 provider（如 amazon-bedrock 自带 Nova 视觉模型但无 auth，不滤会调用失败）。
- **转写**：`transcribeImages` 用 `runtime.completeSimple` 把整批图（多图合并一次调用）发给视觉模型，提示词要求证据优先——逐字 OCR、版面布局、图表坐标/图例、实体，读不清明说「读不清」不编造（沿用 modlens 的 evidence-not-imagination 契约）。默认 90s 超时（`PI_WEB_VISION_TIMEOUT_MS`），maxTokens 4000 防爆上下文。
- **结果形态**：附件卡片 content 变为 `[text(<vision-bridge>包装), image(缩略图)]`，`details.mode` = `"bridged"`（前端 AttachmentCard 显示「👁 已转写」标签 + 展开看缩略图与转写文字；`stripFileWrapper` 同时剥 `<vision-bridge>` 包装）。notice 提示转写开始/完成/失败（失败回退原样发送）。
- **文件列表引用图片同样触发**：`buildAttachmentMessages` 预处理阶段除 `imageData` 外，还把**路径指向图片的附件**（扩展名 ∈ IMAGE_EXT 且非 SVG，`sniffImageMime` 魔数嗅探确认，≤5MB `MAX_PATH_IMAGE_BYTES`）读成 base64——纯文本模型走视觉桥（bridged 卡片带 `path`），视觉模型直接作为 image content 发送（不再让模型用 read 工具读二进制乱码）；SVG 保持普通文件（模型读源码）。
- **缓存**：`visionBridgeCache` 按批次 hash（name + base64 前 48 字符）缓存转写文本——编辑重问重发相同图片不再重复耗视觉 token。
- **无视觉模型时**：warning notice 提示「未找到可用的视觉模型」+ 图片原样发送。

### 设置面板可指定模型/开关/提示词

`SettingsModal` 视觉桥区块，走 `set_settings` + `UiSettingsState`，存 client-state.json 按客户端持久化：

1. **开关** `visionBridgeEnabled`（默认开；关掉后图片原样发送 + warning notice「视觉桥已在设置中关闭」）
2. **转写模型** `visionBridgeModel`（"provider/id"，默认 null=自动选第一个；服务端 `buildAttachmentMessages` 里 `resolveReviewModel` 解析并校验 `getModel().input` 含 image，无效则回退自动发现）
3. **转写提示词** `visionBridgePromptMode`（"append"/"replace"，语义同 promptMode）+ `visionBridgePrompt`（自定义文本，空 = 内置默认）——经 `buildVisionBridgePrompt`（vision-bridge.ts 导出）组装后传给 `transcribeImages` 的 `systemPrompt`；append 在默认提示词后追加，replace 整体替换（空文本仍回退默认）；**提示词纳入批次缓存键**——改提示词后同图重发不再命中旧转写缓存

`settings_state` 带 `visionModels`（`collectVisionModels()` = `findVisionModels` 结果）供下拉选择；预设（preset）**不包含**视觉桥偏好（`SettingsPreset extends Omit<ClientSettings, "visionBridge…">`，apply 时保留当前值）；`setSettings` 里视觉桥字段变更**不触发** `applyRuntimeSettings()`（无需 reload，下次 prompt 即生效）。

**两个 replace 输入框都会预填"原本的提示词"**（settings_state 带 `defaultSystemPrompt` + `visionBridgeDefaultPrompt`）：切换替换模式时空输入框自动填入内置默认文本供直接修改，内容与默认一致时保存为空（= 使用默认），切回 append 不会出现重复追加。

## 文件对话（无工作区路径）

拖入输入框 / 📎 上传的任意文件带 `attachments[].fileData`（base64）发送——服务端写入全局目录 `~/.pi-web/uploads/<clientId>/`（**不放项目内**，`MAX_UPLOAD_BYTES` 20MB 上限），一律以**绝对路径** reference 附加（read 工具支持绝对路径），不再内联小文本。前端分流（`isRasterImage`）：**只有栅格图片**（png/jpeg/gif/webp/bmp/avif…）走 imageData 管线；**SVG 等矢量格式排除**——createImageBitmap 解码 SVG 会失败，SVG 作为普通文件附加让模型读源码更有用，其余文件走 fileData。

## 统一图片预览、OCR 与附件标注

- `web/src/components/ImageLightbox.tsx` 是图片预览唯一实现：消息附件、待发附件、工具结果、工具详情、Markdown 图片、`present_files` 卡片、文件树图片预览和图片工作台生图画廊都复用它。入口走 `image-lightbox-bridge.ts`，文件预览面板的图片分支直接使用同一组件。支持 Esc、背景关闭、键盘焦点约束与窄屏布局。
- 弹窗默认是**小巧浮卡**：`.img-lightbox-panel` 用 `width: fit-content` + `--lb-image-max-w/-h`（`min(78vw, 880px)` / `min(62dvh, 620px)`）按图片尺寸收着开，小图不撑大、大图才缩到上限；满屏由工具栏全屏按钮 / 双击图片 / `F` 键切换，锚在根节点 `data-fullscreen` 上（全屏时覆盖层 `padding: 0`、浮卡铺满视口）。进“标注图片”自动切全屏，保证画布够大；Esc 顺序为「退出标注 → 退出全屏 → 关闭」。窄屏（≤640px）改为贴底小卡，底部吃 `env(safe-area-inset-bottom)`。
- 工具栏一律是图标按钮（`.img-lightbox-btn`）：不写可见文字，提示走 `data-tip` 伪元素（`opacity` 0.09s，无原生 `title` 的延迟；`@media (hover: none)` 下不显示），无障碍名同源 `aria-label`（OCR 安装态例外，`label` 单独给）；无损裁剪：浮卡不 `overflow: hidden`，图片圆角自己收。层级仍由 `useOverlayZIndex()` 发放。
- “识别文字”按钮始终显示；没有 OCR 提供者时，点击通过已有 `plugin_job` 安装官方 `image-ocr`，已禁用时通过 `set_settings` 启用，已有但未加载时重载。安装进度和失败原因在当前预览内展示；安装授权弹窗通过 Portal 挂到 body，位于预览上层，预览的焦点约束暂时让位给授权窗口。安装后无需关闭图片，按钮切换为识别。
- `plugins/image-ocr` 是 `view:false` / `preload:true` 的浏览器插件：顶层只注册提供者，点击才下载固定版本 Tesseract.js 6.0.1、WASM 和中英文字库。图片从应用原始地址读取为字节，识别在本地 Worker 完成；CDN 只提供程序和字库。首次下载依赖网络，远程图片需允许 CORS，否则先保存成附件。结果支持选择、复制、无文字提示和失败重试。
- OCR 任务绑定当前图片和提供者；取消、关闭、换图、插件禁用/卸载/重载均使旧任务失效，插件终止执行 Worker（含初始化阶段的子 Worker）。引擎只输出文本，不自动发送给对话。
- 所有图片预览都有“标注图片”：每次打开默认选中画笔，可切换箭头、矩形、文字、颜色与撤销，Pointer Events 支持鼠标/触摸/笔。编辑独立画布；取消丢弃本次修改。待发附件通过 `onSaveAnnotation` 按原附件对象身份替换草稿中的图片；其余入口保存后继续留在预览，可再次标注或还原原图。已发送消息和工作区原文件不会被覆盖。附件已发送/移除或切换草稿时，不会把迟到结果写到其他附件。
- 统一工具栏提供“附加到输入框”“复制图片”“下载文件”。操作使用当前预览中的图片，包含已保存的标注；只追加草稿附件，保留输入框文本，不自动发送。同一张图附加成功后禁用重复附加；待发附件预览直接显示已附加。异步图片处理前捕获 `composerSessionId`，完成后复核，切换会话或关闭预览不会把结果写进其他对话。
- 附加结果复用 `image-paste.ts` 的 ≤1568px / ≤2MB 图片处理后写入 `imageData`；大于限制的结果明确失败。编辑画布最长边限 4096px 以控制内存。`image-preview-actions.ts` 保留原图下载字节，剪贴板按浏览器要求将非 PNG 转为 PNG，并在点击时立即发起写入以保留用户激活；下载复用 `saveDownloadBlob`，取消另存为不误报成功。失败在预览内反馈，不关闭图片。
- 预览提供图片尺寸、放大/缩小、100% 原始尺寸与适应窗口，放大后可滚动查看细节。`ImageLightboxTarget.actions` 保留调用方上下文动作（带文字标签，其余按钮只留图标）；文件预览直接使用统一下载，插件不再另建图片灯箱。
- 提供者及插件桥协议见 `architecture-plugins.md` 的“图片预览与 OCR 提供者”。回归：`tests/unit/image-ocr.test.ts`、`tests/unit/image-preview-actions.test.ts`（原始字节、MIME、剪贴板激活、下载取消与失败）、`tests/image-preview-ui-test.mjs`（`PI_TEST_REAL_OCR=1` 验证真实中英文引擎下载/识别）、`tests/image-ocr-install-ui-test.mjs`（构建后验证未安装点击安装、授权层级及禁用后重新启用，不调用模型）。

## 文件预览协议

- 客户端发 `{ type: "read_file", path }` → 服务端回 `{ type: "file_content", path, name, text, truncated, binary, lines, size }`。
- 只读文件前 **512KB**（`MAX_PREVIEW_BYTES`）；**内容嗅探决定文本还是二进制**：无 NUL、控制字符占比 < 2% 即按文本预览（`looksLikeText`）——未知/无扩展名文件（jsonl、.log.1 等）也能打开；**文本解码带 GBK 回退**（`decodeText`：严格 UTF-8 失败 → GBK → latin1，预览/行附件都用它），Windows 老中文文件不再乱码；二进制返回 `binary: true`，`text` 为前 4KB 的**十六进制视图**（`hexDump`，前端 `.fp-hex` 渲染，可下载完整文件）。路径经 `resolve + relative` 校验，`..` 越界直接拒。
- **媒体预览走 HTTP**：image/video 经 `/api/file?clientId=…&path=…` 流式返回（`sendFile` 支持 Range），路径按**该客户端的会话 cwd**（打开的项目）解析，而非服务启动目录——两者可能不一致；`clientId` 缺失或会话不存在时回退到服务启动 `CWD`。路径校验统一走 `workspacePath()`（agent-service 导出）。
- **HTML 渲染走目录映射的 HTTP**：`/api/preview/<工作区相对路径>`（机器浏览的绝对路径加 `__abs__/` 前缀，各段 URI 编码），iframe 文档 URL 自带文件所在目录，页面里的相对引用（`<link href="../web/src/styles.css">`、`./app.js`、图片…）按浏览器正常语义解析加载，无需改写 HTML；HTML 文档带沙箱 CSP（`sandbox`，`?allowJs=1` 时 `sandbox allow-scripts`，永不加 `allow-same-origin`），其余子资源按真实 content-type 直送；预览弹窗**始终**以 `allowJs=1` 请求并在 iframe 上给 `allow-scripts`（脚本直接运行，没有开关），顶栏统一工具栏的 `host:fp-external` 提供“在新标签页打开”；`..` 越界由 `workspacePath()` 拒绝（路由层归一化兜底则落进 SPA 404，不会泄露文件）。
- 行号语义：**尾随换行不产生空行**（`countLines` 已修正），前后端 split 逻辑必须一致。

### 文件管理右键：压缩、解压与文件夹上传

- `contextmenu.file` 新增压缩、解压、上传文件夹、压缩并下载；复用统一菜单，在 `FileTransferDialog` 确认并显示错误/上传进度。
- 压缩递归生成同目录 `{文件夹名}-{UTC时间}.tar.gz`；单文件生成 `{原文件名}.tar.gz`，已有同名归档不会被覆盖。
- 解压仅对 ZIP、TAR、TAR.GZ/TGZ、GZ 显示；选择已有目标目录，冲突策略为跳过（默认）、覆盖文件、遇冲突停止。先在私有临时目录解包并完整检查冲突，再写目标目录。非冲突类 I/O 错误仍可能留下部分已写文件。
- `server/file-archives.ts` 使用 Node 库，不调用 shell 或依赖系统 tar/unzip。拒绝归档越界路径、Windows 特殊路径、链接和设备文件；检查目标的符号链接，覆盖时先 unlink，防止修改硬链接指向的其他文件。上限为 20,000 项 / 1 GiB；解析 TAR 的解压流也有字节上限。
- 两个引擎共用 `/api/file-transfer/archive` 和 `/api/file-transfer/upload`，位于现有鉴权中间件后，要求已连接的 clientId 与自定义请求头，路径规则与文件管理一致（包括机器浏览的绝对路径）。前端通过 `appUrl()` 保留反代前缀。
- 文件夹上传保留顶层文件夹及递归层级，按文件顺序发送二进制 HTTP 请求（每文件 32 MiB，不走 base64/WS），不会覆盖已有文件。支持 File System Access 的浏览器也上传空目录；其余使用 `webkitdirectory` 回退，仅包含文件及父目录。失败时已上传部分保留。
- 压缩并下载使用私有临时目录，HTTP 下载完成、断开或处理失败后清理；浏览器通过已有 blob 保存逻辑保存，不进行第二次下载请求。临时下载限 200 MiB，以控制浏览器内存；更大文件可先原地压缩再用原有流式下载。
- 回归：`tests/unit/file-archives.test.ts`、`tests/unit/file-transfer-routes.test.ts`、`tests/file-archives-ui-test.mjs`（构建后运行，独立端口/数据目录，零模型调用）。

### 系统截图（Windows / macOS 本机）

- 输入框动作栏的 `host:composer-screenshot`（剪刀图标，默认排在附件、模板之后，即左侧第三个位）由 `SystemScreenshotButton.tsx` 渲染，沿用栏位排序、显隐及图标编辑。**点击即直接「保留当前窗口截图」**（不弹菜单、不隐藏窗口）；**鼠标悬停**时在其上方展开悬浮面板，里面只有一个入口「隐藏当前窗口截图」。选择后拖动框选并松开完成；Esc（macOS 亦可用）取消，Windows 可右键取消，超时自动取消。悬浮面板复用 `useFloatingPanel` 与 `ctx-menu`，指针离开按钮/面板 180ms 后收起，支持点击外部 / Esc 关闭；触屏与键盘用户仍有可用的默认点击行为。
- 位置迁移：`web/src/ui-slots.ts` 的 `migrateScreenshotOrder` 把早期布局快照中尚未登记进 `order` 的截图按钮锚定在模板（无模板时附件）之后——否则未排序条目会排到所有已排序条目之后而飘到右侧；新布局直接按 `order: 115` 落位。
- `server/system-screenshot.ts` 在正常鉴权后注册 `/api/system-screenshot`：GET 查询能力，POST 发起截图；`hideWindow` 仅接受布尔值，省略时默认 `true`，兼容原有客户端。同一服务同时只允许一张截图；仅限 Windows / macOS、回环 TCP 与回环 Host，拒绝代理转发头和跨源请求；其他平台 GET 返回 `available:false`、POST 返回 501。远程客户端不能截取服务端桌面。
- `server/system-screenshot-windows.ts` 通过异步 PowerShell STA 辅助进程调用 Win32 / WinForms。隐藏模式下前端临时给窗口标题附加随机 nonce，辅助进程仅在前台窗口标题匹配时最小化，避免焦点切换后误操作其他窗口；成功、取消和异常均恢复原窗口（含最大化状态）。保留模式不改标题、不最小化或恢复窗口，也不登记窗口恢复信息。断连通过 stdin 取消；辅助进程监测父进程退出，超时强制结束时服务端另行恢复隐藏的窗口。
- `server/system-screenshot-macos.ts` 异步调用原生 `/usr/sbin/screencapture -i -x -t png <私有临时文件>`：原生浮层内拖动框选（空格切换窗口模式），Esc 取消且不写文件，空文件即视为取消。隐藏模式先用 `osascript` 读取前台应用名 / `unix id` / 前台窗口标题，两个信号任一命中才把该应用 `visible` 置 false：① 窗口标题包含前端设置的 nonce（浏览器会把 `document.title` 写进窗口标题）；② 前台应用的 pid 属于承载本服务端的宿主进程祖先链（`ancestorPids()` 用一次 `ps -A -o pid=,ppid=` 向上推导）。② 是必需的：桌面端前台窗口常是内嵌浏览器面板的固定标题「pi Browser」，nonce 永远进不了标题，只靠 ① 会把正常的隐藏请求误判成焦点变化。两个都不命中（用户已切到无关应用）才返回 `window-not-focused`。随后 `screencapture`，最后恢复 `visible` + `frontmost`。未授予自动化 / 辅助功能权限时探测脚本失败，降级为「保留窗口截图」而不断言失败。macOS 首次使用还需在「系统设置 → 隐私与安全性 → 屏幕录制」中授权实际执行进程（Node / 终端 / Electron 应用），否则截到的是空白桌面。临时文件读取后连同私有临时目录一起删除，不修改剪贴板。
- 截取全部显示器构成的虚拟桌面后再框选，支持负坐标与混合 DPI；只返回所选 PNG，不落临时图片、不修改剪贴板。结果通过 `image-lightbox-bridge.ts` 的 `openImageLightbox` 打开通用预览，可标注、附加到输入框、复制、下载与缩放；取消无弹窗，不自动加入对话附件。非 Windows / macOS 或远程访问禁用按钮并说明原因。
- 回归：`tests/unit/system-screenshot.test.ts`、`tests/unit/system-screenshot-windows.test.ts`、`tests/unit/system-screenshot-macos.test.ts`、`tests/unit/ui-slots.test.ts`（截图位置与老布局迁移）、`tests/image-preview-ui-test.mjs`（悬停展开 / 点击即截图）；覆盖两种模式、平台能力、旧请求默认值、参数校验、nonce 校验、降级路径与悬浮面板交互；原生 C# 编译验证与 macOS 脚本编译验证都不触发真实桌面截图。

### 下载

`web/src/download.ts`：不用 `<a download href>`（Chrome Safe Browsing 会拦截非 HTTPS 源的无信誉文件类型如 .zip/.exe），而是 fetch → blob 保存；>200MB 回退原生导航流式下载；失败 toast 显示服务端错误正文（`downloadFailed` i18n key）。

**Windows 特例**：blob 锚点下载在 Windows 上仍可能被 Safe Browsing 静默拦截（无 JS 错误，表现为「点了没反应」）——Chromium 安全上下文（localhost/HTTPS）下优先用 `showSaveFilePicker` 直接写入用户选中的文件（绕过下载管线）；Windows 上保存名经 `sanitizeFileName` 清洗（`<>:"\|?*`、尾随点/空格、CON/COM1 等保留设备名）；取消保存对话框不算错误（`cancelled`，不弹 toast）。`download-test.mjs` 覆盖回归（已禁用 picker 以测 blob 路径）。
