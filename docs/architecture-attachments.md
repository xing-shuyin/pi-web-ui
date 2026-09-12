# 附件、图片与文件处理

> 覆盖附件三种模式、图片问答、视觉桥、文件上传/下载/预览协议。

## 附件三种模式

`ClientMessage.prompt.attachments[].mode` 决定附件如何发送给模型：

| mode | 含义 | 服务端处理 |
| --- | --- | --- |
| `inline` | 内联全文 | ≤ `PI_WEB_INLINE_FILE_MAX`（默认 12KB）内联，超出自动降级为 reference |
| `reference` | 仅路径 | 发 `<file path="..." size="..."/>`，模型按需用 read 工具读 |
| `lines` | 选中行 | 发 `<file path="..." lines="2-3">```选中行```</file>`，只读该范围（读取上限 2MB，超限降级 reference） |

附件作为独立 custom message（`sendCustomMessage` + `deliverAs: "nextTurn"` asides）发送，渲染成可折叠卡片。客户端 `stripFileWrapper` 的正则要兼容 `lines="..."` 属性。

**消息序列化缓存按 `role:timestamp` 为 key——同一 prompt 的多个 aside 同毫秒创建会碰撞，必须靠内容指纹（`contentFingerprint`）区分，否则只有第一个渲染（已修，勿回退）。**

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

拖入输入框 / 📎 上传的任意文件带 `attachments[].fileData`（base64）发送——服务端写入全局目录 `~/.pi-web/uploads/<clientId>/`（**不放项目内**，`MAX_UPLOAD_BYTES` 20MB 上限），小文本（≤ `PI_WEB_INLINE_FILE_MAX` 且嗅探为文本）直接内联，其余以**绝对路径** reference 附加（read 工具支持绝对路径）。前端分流（`isRasterImage`）：**只有栅格图片**（png/jpeg/gif/webp/bmp/avif…）走 imageData 管线；**SVG 等矢量格式排除**——createImageBitmap 解码 SVG 会失败，SVG 作为普通文件附加让模型读源码更有用，其余文件走 fileData。

## 文件预览协议

- 客户端发 `{ type: "read_file", path }` → 服务端回 `{ type: "file_content", path, name, text, truncated, binary, lines, size }`。
- 只读文件前 **512KB**（`MAX_PREVIEW_BYTES`）；**内容嗅探决定文本还是二进制**：无 NUL、控制字符占比 < 2% 即按文本预览（`looksLikeText`）——未知/无扩展名文件（jsonl、.log.1 等）也能打开；**文本解码带 GBK 回退**（`decodeText`：严格 UTF-8 失败 → GBK → latin1，预览/内联附件/行附件都用它），Windows 老中文文件不再乱码；二进制返回 `binary: true`，`text` 为前 4KB 的**十六进制视图**（`hexDump`，前端 `.fp-hex` 渲染，可下载完整文件）。路径经 `resolve + relative` 校验，`..` 越界直接拒。
- **媒体预览走 HTTP**：image/video 经 `/api/file?clientId=…&path=…` 流式返回（`sendFile` 支持 Range），路径按**该客户端的会话 cwd**（打开的项目）解析，而非服务启动目录——两者可能不一致；`clientId` 缺失或会话不存在时回退到服务启动 `CWD`。路径校验统一走 `workspacePath()`（agent-service 导出）。
- **HTML 渲染走目录映射的 HTTP**：`/api/preview/<工作区相对路径>`（机器浏览的绝对路径加 `__abs__/` 前缀，各段 URI 编码），iframe 文档 URL 自带文件所在目录，页面里的相对引用（`<link href="../web/src/styles.css">`、`./app.js`、图片…）按浏览器正常语义解析加载，无需改写 HTML；HTML 文档带沙箱 CSP（`sandbox`，`?allowJs=1` 时 `sandbox allow-scripts`，永不加 `allow-same-origin`），其余子资源按真实 content-type 直送；`..` 越界由 `workspacePath()` 拒绝（路由层归一化兜底则落进 SPA 404，不会泄露文件）。
- 行号语义：**尾随换行不产生空行**（`countLines` 已修正），前后端 split 逻辑必须一致。

### 下载

`web/src/download.ts`：不用 `<a download href>`（Chrome Safe Browsing 会拦截非 HTTPS 源的无信誉文件类型如 .zip/.exe），而是 fetch → blob 保存；>200MB 回退原生导航流式下载；失败 toast 显示服务端错误正文（`downloadFailed` i18n key）。

**Windows 特例**：blob 锚点下载在 Windows 上仍可能被 Safe Browsing 静默拦截（无 JS 错误，表现为「点了没反应」）——Chromium 安全上下文（localhost/HTTPS）下优先用 `showSaveFilePicker` 直接写入用户选中的文件（绕过下载管线）；Windows 上保存名经 `sanitizeFileName` 清洗（`<>:"\|?*`、尾随点/空格、CON/COM1 等保留设备名）；取消保存对话框不算错误（`cancelled`，不弹 toast）。`download-test.mjs` 覆盖回归（已禁用 picker 以测 blob 路径）。