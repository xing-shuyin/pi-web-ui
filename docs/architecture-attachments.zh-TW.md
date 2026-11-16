[English](./architecture-attachments.en.md) · [简体中文](./architecture-attachments.md) · **繁體中文**

# 附件、圖片與檔案處理

> 覆蓋附件模式、圖片問答、視覺橋、檔案上傳/下載/預覽協議。

## 活動內容隔離

`/api/file`、`/api/attachment/:hash` 和 `/api/preview` 在返回任何型別內容之前統一設定 CSP sandbox 與 nosniff，不能依賴 HTML/SVG 副檔名列舉。`allowJs=1` 僅允許 `sandbox allow-scripts`，不授予 `allow-same-origin`。因此 `.shtml`、`.xht` 等瀏覽器活動文件同樣不擁有宿主源。

即時預覽的模組與 SSE 通過外掛每次啟用生成的 256 位隨機 capability 路徑訪問；正常入口仍需宿主認證，僅這個已註冊外掛的 GET/HEAD capability 可免宿主口令代理。代理剝離宿主認證頭/cookie，響應保持 opaque origin、無憑據 CORS 和 no-referrer；停用關閉 SSE 並撤銷路徑。此路徑本身授予預覽資源讀取許可權，不應分享給無權檢視專案的人。

## 儲存與傳輸完整性

- 附件儲存首次查詢非同步建立舊目錄索引，併發查詢共享初始化；成功儲存增量更新索引，後續 hash 查詢不再同步全目錄掃描。HTTP 附件響應流式傳送，支援 Range 與斷開回收。執行期間外部匯入附件後需重新初始化索引。
- 本地已有檔案儲存先準備同卷臨時檔案，使用平臺原生後設資料保留和替換機制；失敗保留原檔案，不回退截斷寫入。符號連結跟隨實際目標，多硬連結檔案拒絕原子替換。原子可見性不代表斷電永續性；平臺無法保留後設資料時明確失敗。遠端已有檔案儲存仍使用 SFTP，不能承諾原子替換。
- 新檔案上傳以獨佔方式提交完整臨時檔案，同名競爭不得覆蓋。對話附件路徑包含 UUID，避免同毫秒同名覆蓋。
- HTTP 上傳在接收正文前校驗客戶端、路徑、型別和宣告大小；單檔案預設 32MiB，可通過設定調整至 1–100MiB；最多 4 個併發，總預留 200MiB。本地流式落盤；遠端 Buffer 受相同預算約束。取消必須等待實際寫流釋放後才歸還額度。

## 上傳限制與進度

設定中的上傳大小上限按入口分別儲存：聊天附件預設 20MiB、檔案面板預設 100MiB、資料夾上傳的每個檔案預設 32MiB，範圍均為 1–100MiB。配置全域性共享，前端預檢與服務端校驗使用相同值；舊配置自動補齊預設值。WebSocket 仍保留固定的 100MiB 原始檔案硬容量，不能通過設定繞過。

進度區分本地讀取、傳送等待確認與服務端儲存結果。檔案面板的 WebSocket 上傳通過 `uploadId` 與 `file_upload_result` 關聯，目錄變化不能作為上傳成功依據；HTTP 資料夾上傳通過請求傳輸進度與最終響應確認結果。

## 附件模式（一律只給路徑）

`ClientMessage.prompt.attachments[].mode` 決定附件如何傳送給模型。**檔案內容永遠不注入 prompt**
（小檔案也一樣）：服務端只發路徑引用，模型用自己的 read 工具按需讀（自帶截斷/分頁）。

| mode        | 含義   | 服務端處理                                                                                       |
| ----------- | ------ | ------------------------------------------------------------------------------------------------ |
| `reference` | 僅路徑 | 發 `<file path="..." size="..."/>`（上傳檔案是 uploads 目錄下的絕對路徑）                        |
| `lines`     | 行範圍 | 發 `<file path="..." lines="2-3" size="..."/>`，告訴模型使用者選的是哪幾行（不讀檔案、不帶內容） |
| `inline`    | 遺留   | **舊版「全文注入」的遺留值**（舊客戶端/舊草稿會發）：服務端按 `reference` 處理，不再注入內容     |

圖片（`imageData`、指向圖片的工作區路徑）仍作為 image 內容傳送（見下）；目錄、網頁引用、對話引用各有自己的卡片形態。

附件作為獨立 custom message（`sendCustomMessage` + `deliverAs: "nextTurn"` asides）傳送，渲染成可摺疊卡片。客戶端 `stripFileWrapper` 的正則要相容 `lines="..."` 屬性。

**訊息序列化快取按 `role:timestamp` 為 key——同一 prompt 的多個 aside 同毫秒建立會碰撞，必須靠內容指紋（`contentFingerprint`）區分，否則只有第一個渲染（已修，勿回退）。**

### 待發附件的生命週期（跟會話走，不跟頁面走）

輸入框裡那排待發附件 chips（📎/🔗/💬/🖼/🌐）只活在 `App.tsx` 的 `attachments` state 裡
（不進服務端、不持久化），**傳送成功即清空**。它與正文草稿（按 `sessionId` 存、切回舊會話會恢復）
是同一個「本會話待發送內容」的兩半，所以**會話身份一變就一起清空**：

- 判據是 `UiState.sessionId`（pi/DSH 雙引擎都有；`conversationId` 重啟即變，不能當會話身份），
  純函式在 `web/src/composer-draft.ts` 的 `advanceComposerSession`（單測：`tests/unit/composer-draft.test.ts`）。
- 觸發場景：新建對話、切換對話、手動過戶、切專案（切 cwd）——新對話因此是乾淨開始。
- 瞬時態（斷線重連、快照裡 `sessionId` 短暫為空）不動水位也不清，避免誤清使用者的待發附件。
- 不做按會話儲存：切走再切回來時正文草稿會恢復、附件不會（若要「切回舊對話連引用一起回來」，
  得把 chips 也按 sessionId 存，屬於設計升級）。

## 聊天文字引用

在同一條聊天訊息內選中文字或程式碼，鬆開滑鼠後顯示「引用」按鈕。點選後通過 `composeToComposer` 新增待發送引用卡片，保留輸入框草稿。卡片可展開檢視原文、獨立移除；同一來源和原文的重複引用去重，不同片段可同時傳送。滾動、按 Escape 或切換會話時隱藏浮動按鈕。

- 協議：`PromptAttachment.mode = "quote"`，`path` 留空，`quote` 儲存選中文字、來源訊息標識、角色和會話標識。原文以副本儲存，保留換行和程式碼縮排。
- 前端：`quote-selection.ts` 校驗選區範圍，排除操作按鈕、輸入框和跨訊息選區；`SelectionQuoteButton` 定位浮動按鈕；`TextQuoteCard` 在輸入框、已傳送訊息和編輯重問中展示引用。
- 標準 pi 引擎：空閒時 `buildAttachmentMessages` 將引用編碼為獨立的 `customType: "file"` 上下文訊息，`details.mode = "quote"`，`details.quote` 用於歷史展示和編輯恢復。生成期間將引用編碼在對應排隊或插隊問題的末尾，避免引用滯留到下一條問題；序列化時還原為使用者訊息的 `details.quotes`。
- 標準 pi 引擎佇列：展示時拆出引用卡片；撤回時恢復提問草稿和引用附件；移除時連同引用一起刪除。輸入框和編輯重問均允許僅傳送引用。
- DeepSeek Harness 引擎：引用作為獨立文字塊傳送，`dsh-serialize.ts` 在歷史回放時還原為使用者訊息的 `details.quotes`；續聊、編輯和分支上下文重新編碼這些引用。編碼和校驗共用 `server/text-quote.ts`。
- 迴歸：`tests/unit/quote-selection.test.ts`、`text-quote.test.ts` 和附件/草稿相關單元測試；構建後執行 `node tests/quote-selection-ui-test.mjs`，使用真實 Chrome 和本地模擬模型服務驗證傳送、重新整理和編輯恢復，不訪問真實模型。

## 圖片問答（無工作區路徑）

貼上（Ctrl+V）/ 拖入輸入框（**整個視窗都是拖放目標**，issue #19：`.app` 根節點接檔案 dragover/drop + 全屏 `.app-drop-overlay` 高亮（唯一提示，輸入條不疊區域性遮罩）；輸入條與編輯器自身 handler 在 drop 上 stopPropagation 保優先順序，因此 App 另在 window 捕獲階段監聽 drop 復位遮罩——否則落點在輸入條時全屏遮罩會常駐）/ 🖼 上傳的圖片帶 `attachments[].imageData`（base64）+ `mimeType` + `name` 傳送——服務端直接作為 image content 附加，不走檔案路徑（`path` 忽略）。瀏覽器端（`web/src/image-paste.ts`）先把圖片等比縮到 ≤1568px、按需轉 PNG/JPEG，保證 payload 在服務端 2MB 上限內（`MAX_PASTED_IMAGE_BYTES`）。當前模型不支援識圖（`model.vision`）時前端提示警告。

## 視覺橋

當**當前對話模型不支援識圖**（DeepSeek/GLM 等 `input` 只有 `text`）時，`buildAttachmentMessages` 不再把圖片直接作為 image content 傳送（會被忽略），而是交給一個**已配置的視覺模型**轉寫成文字證據再餵給主模型（`server/vision-bridge.ts`）：

- **零配置自動發現**：`findVisionModels` 掃描 `ModelRuntime` 所有 **`hasConfiguredAuth`** 的 provider，找出 `input` 含 `"image"` 的模型（qwen-vl、GLM-4V、Gemini…）——複用 models.json/auth.json 裡已有的憑據，不新增任何配置。⚠️ 必須過濾未配置的 SDK 內建 provider（如 amazon-bedrock 自帶 Nova 視覺模型但無 auth，不濾會呼叫失敗）。
- **轉寫**：`transcribeImages` 用 `runtime.completeSimple` 把整批圖（多圖合併一次呼叫）發給視覺模型，提示詞要求證據優先——逐字 OCR、版面佈局、圖表座標/圖例、實體，讀不清明說「讀不清」不編造（沿用 modlens 的 evidence-not-imagination 契約）。預設 90s 超時（`PI_WEB_VISION_TIMEOUT_MS`），maxTokens 4000 防爆上下文。
- **結果形態**：附件卡片 content 變為 `[text(<vision-bridge>包裝), image(縮圖)]`，`details.mode` = `"bridged"`（前端 AttachmentCard 顯示「👁 已轉寫」標籤 + 展開看縮圖與轉寫文字；`stripFileWrapper` 同時剝 `<vision-bridge>` 包裝）。notice 提示轉寫開始/完成/失敗（失敗回退原樣傳送）。
- **檔案列表引用圖片同樣觸發**：`buildAttachmentMessages` 預處理階段除 `imageData` 外，還把**路徑指向圖片的附件**（副檔名 ∈ IMAGE_EXT 且非 SVG，`sniffImageMime` 魔數嗅探確認，≤5MB `MAX_PATH_IMAGE_BYTES`）讀成 base64——純文本模型走視覺橋（bridged 卡片帶 `path`），視覺模型直接作為 image content 傳送（不再讓模型用 read 工具讀二進位制亂碼）；SVG 保持普通檔案（模型讀原始碼）。
- **快取**：`visionBridgeCache` 按批次 hash（name + base64 前 48 字元）快取轉寫文本——編輯重問重發相同圖片不再重複耗視覺 token。
- **無視覺模型時**：warning notice 提示「未找到可用的視覺模型」+ 圖片原樣傳送。

### 設定面板可指定模型/開關/提示詞

`SettingsModal` 視覺橋區塊，走 `set_settings` + `UiSettingsState`，存 client-state.json 按客戶端持久化：

1. **開關** `visionBridgeEnabled`（預設開；關掉後圖片原樣傳送 + warning notice「視覺橋已在設定中關閉」）
2. **轉寫模型** `visionBridgeModel`（"provider/id"，預設 null=自動選第一個；服務端 `buildAttachmentMessages` 裡 `resolveReviewModel` 解析並校驗 `getModel().input` 含 image，無效則回退自動發現）
3. **轉寫提示詞** `visionBridgePromptMode`（"append"/"replace"，語義同 promptMode）+ `visionBridgePrompt`（自定義文本，空 = 內建預設）——經 `buildVisionBridgePrompt`（vision-bridge.ts 匯出）組裝後傳給 `transcribeImages` 的 `systemPrompt`；append 在預設提示詞後追加，replace 整體替換（空文本仍回退預設）；**提示詞納入批次快取鍵**——改提示詞後同圖重發不再命中舊轉寫快取

`settings_state` 帶 `visionModels`（`collectVisionModels()` = `findVisionModels` 結果）供下拉選擇；預設（preset）**不包含**視覺橋偏好（`SettingsPreset extends Omit<ClientSettings, "visionBridge…">`，apply 時保留當前值）；`setSettings` 裡視覺橋欄位變更**不觸發** `applyRuntimeSettings()`（無需 reload，下次 prompt 即生效）。

**兩個 replace 輸入框都會預填"原本的提示詞"**（settings_state 帶 `defaultSystemPrompt` + `visionBridgeDefaultPrompt`）：切換替換模式時空輸入框自動填入內建預設文本供直接修改，內容與預設一致時儲存為空（= 使用預設），切回 append 不會出現重複追加。

## 檔案對話（無工作區路徑）

拖入輸入框 / 📎 上傳的任意檔案帶 `attachments[].fileData`（base64）傳送——服務端寫入全域性目錄 `~/.pi-web/uploads/<clientId>/`（**不放專案內**，`MAX_UPLOAD_BYTES` 20MB 上限），一律以**絕對路徑** reference 附加（read 工具支援絕對路徑），不再內聯小文本。前端分流（`isRasterImage`）：**只有柵格圖片**（png/jpeg/gif/webp/bmp/avif…）走 imageData 管線；**SVG 等向量格式排除**——createImageBitmap 解碼 SVG 會失敗，SVG 作為普通檔案附加讓模型讀原始碼更有用，其餘檔案走 fileData。

## 統一圖片預覽、OCR 與附件標註

- `web/src/components/ImageLightbox.tsx` 是圖片預覽唯一實現：訊息附件、待發附件、工具結果、工具詳情、Markdown 圖片、`present_files` 卡片、檔案樹圖片預覽和圖片工作臺生圖畫廊都複用它。入口走 `image-lightbox-bridge.ts`，檔案預覽面板的圖片分支直接使用同一組件。支援 Esc、背景關閉、鍵盤焦點約束與窄屏佈局。
- 彈窗預設是**小巧浮卡**：`.img-lightbox-panel` 用 `width: fit-content` + `--lb-image-max-w/-h`（`min(78vw, 880px)` / `min(62dvh, 620px)`）按圖片尺寸收著開，小圖不撐大、大圖才縮到上限；滿屏由工具欄全屏按鈕 / 雙擊圖片 / `F` 鍵切換，錨在根節點 `data-fullscreen` 上（全屏時覆蓋層 `padding: 0`、浮卡鋪滿視口）。進“標註圖片”自動切全屏，保證畫布夠大；Esc 順序為「退出標註 → 退出全屏 → 關閉」。窄屏（≤640px）改為貼底小卡，底部吃 `env(safe-area-inset-bottom)`。
- 工具欄一律是圖示按鈕（`.img-lightbox-btn`）：不寫可見文字，提示走 `data-tip` 偽元素（`opacity` 0.09s，無原生 `title` 的延遲；`@media (hover: none)` 下不顯示），無障礙名同源 `aria-label`（OCR 安裝態例外，`label` 單獨給）；無損裁剪：浮卡不 `overflow: hidden`，圖片圓角自己收。層級仍由 `useOverlayZIndex()` 發放。
- “識別文字”按鈕始終顯示；沒有 OCR 提供者時，點選通過已有 `plugin_job` 安裝官方 `image-ocr`，已停用時通過 `set_settings` 啟用，已有但未載入時過載。安裝進度和失敗原因在當前預覽內展示；安裝授權彈窗通過 Portal 掛到 body，位於預覽上層，預覽的焦點約束暫時讓位給授權視窗。安裝後無需關閉圖片，按鈕切換為識別。
- `plugins/image-ocr` 是 `view:false` / `preload:true` 的瀏覽器外掛：頂層只註冊提供者，點選才下載固定版本 Tesseract.js 6.0.1、WASM 和中英文字型檔。圖片從應用原始地址讀取為位元組，識別在本地 Worker 完成；CDN 只提供程式和字型檔。首次下載依賴網路，遠端圖片需允許 CORS，否則先儲存成附件。結果支援選擇、複製、無文字提示和失敗重試。
- OCR 任務綁定當前圖片和提供者；取消、關閉、換圖、外掛停用/解除安裝/過載均使舊任務失效，外掛終止執行 Worker（含初始化階段的子 Worker）。引擎只輸出文本，不自動傳送給對話。
- 所有圖片預覽都有“標註圖片”：每次開啟預設選中畫筆，可切換箭頭、矩形、文字、顏色與撤銷，Pointer Events 支援滑鼠/觸控/筆。編輯獨立畫布；取消丟棄本次修改。待發附件通過 `onSaveAnnotation` 按原附件物件身份替換草稿中的圖片；其餘入口儲存後繼續留在預覽，可再次標註或還原原圖。已傳送訊息和工作區原檔案不會被覆蓋。附件已傳送/移除或切換草稿時，不會把遲到結果寫到其他附件。
- 統一工具欄提供“附加到輸入框”“複製圖片”“下載檔案”。操作使用當前預覽中的圖片，包含已儲存的標註；只追加草稿附件，保留輸入框文本，不自動傳送。同一張圖附加成功後停用重複附加；待發附件預覽直接顯示已附加。非同步圖片處理前捕獲 `composerSessionId`，完成後複核，切換會話或關閉預覽不會把結果寫進其他對話。
- 附加結果複用 `image-paste.ts` 的 ≤1568px / ≤2MB 圖片處理後寫入 `imageData`；大於限制的結果明確失敗。編輯畫布最長邊限 4096px 以控制記憶體。`image-preview-actions.ts` 保留原圖下載位元組，剪貼簿按瀏覽器要求將非 PNG 轉為 PNG，並在點選時立即發起寫入以保留使用者啟用；下載複用 `saveDownloadBlob`，取消另存為不誤報成功。失敗在預覽內反饋，不關閉圖片。
- 預覽提供圖片尺寸、放大/縮小、100% 原始尺寸與適應視窗，放大後可滾動檢視細節。`ImageLightboxTarget.actions` 保留呼叫方上下文動作（帶文字標籤，其餘按鈕只留圖示）；檔案預覽直接使用統一下載，外掛不再另建圖片燈箱。
- 提供者及外掛橋協議見 `architecture-plugins.md` 的“圖片預覽與 OCR 提供者”。迴歸：`tests/unit/image-ocr.test.ts`、`tests/unit/image-preview-actions.test.ts`（原始位元組、MIME、剪貼簿啟用、下載取消與失敗）、`tests/image-preview-ui-test.mjs`（`PI_TEST_REAL_OCR=1` 驗證真實中英文引擎下載/識別）、`tests/image-ocr-install-ui-test.mjs`（構建後驗證未安裝點選安裝、授權層級及停用後重新啟用，不呼叫模型）。

## 檔案預覽協議

- 客戶端發 `{ type: "read_file", path }` → 服務端回 `{ type: "file_content", path, name, text, truncated, binary, lines, size }`。
- 只讀檔案前 **512KB**（`MAX_PREVIEW_BYTES`）；**內容嗅探決定文本還是二進位制**：無 NUL、控制字元佔比 < 2% 即按文本預覽（`looksLikeText`）——未知/無副檔名檔案（jsonl、.log.1 等）也能開啟；**文本解碼帶 GBK 回退**（`decodeText`：嚴格 UTF-8 失敗 → GBK → latin1，預覽/行附件都用它），Windows 老中文檔案不再亂碼；二進位制返回 `binary: true`，`text` 為前 4KB 的**十六進位制檢視**（`hexDump`，前端 `.fp-hex` 渲染，可下載完整檔案）。路徑經 `resolve + relative` 校驗，`..` 越界直接拒。
- **媒體預覽走 HTTP**：image/video 經 `/api/file?clientId=…&path=…` 流式返回（`sendFile` 支援 Range），路徑按**該客戶端的會話 cwd**（開啟的專案）解析，而非服務啟動目錄——兩者可能不一致；`clientId` 缺失或會話不存在時回退到服務啟動 `CWD`。路徑校驗統一走 `workspacePath()`（agent-service 匯出）。
- **HTML 渲染走目錄對映的 HTTP**：`/api/preview/<工作區相對路徑>`（機器瀏覽的絕對路徑加 `__abs__/` 字首，各段 URI 編碼），iframe 文件 URL 自帶檔案所在目錄，頁面裡的相對引用（`<link href="../web/src/styles.css">`、`./app.js`、圖片…）按瀏覽器正常語義解析載入，無需改寫 HTML；HTML 文件帶沙箱 CSP（`sandbox`，`?allowJs=1` 時 `sandbox allow-scripts`，永不加 `allow-same-origin`），其餘子資源按真實 content-type 直送；預覽彈窗**始終**以 `allowJs=1` 請求並在 iframe 上給 `allow-scripts`（指令碼直接執行，沒有開關），頂欄統一工具欄的 `host:fp-external` 提供“在新標籤頁開啟”；`..` 越界由 `workspacePath()` 拒絕（路由層歸一化兜底則落進 SPA 404，不會洩露檔案）。
- 行號語義：**尾隨換行不產生空行**（`countLines` 已修正），前後端 split 邏輯必須一致。

### 檔案管理右鍵：壓縮、解壓與資料夾上傳

- `contextmenu.file` 新增壓縮、解壓、上傳資料夾、壓縮並下載；複用統一選單，在 `FileTransferDialog` 確認並顯示錯誤/上傳進度。
- 壓縮遞迴生成同目錄 `{資料夾名}-{UTC時間}.tar.gz`；單檔案生成 `{原檔名}.tar.gz`，已有同名歸檔不會被覆蓋。
- 解壓僅對 ZIP、TAR、TAR.GZ/TGZ、GZ 顯示；選擇已有目標目錄，衝突策略為跳過（預設）、覆蓋檔案、遇衝突停止。先在私有臨時目錄解包並完整檢查衝突，再寫目標目錄。非衝突類 I/O 錯誤仍可能留下部分已寫檔案。
- `server/file-archives.ts` 使用 Node 庫，不呼叫 shell 或依賴系統 tar/unzip。拒絕歸檔越界路徑、Windows 特殊路徑、連結和裝置檔案；檢查目標的符號連結，覆蓋時先 unlink，防止修改硬連結指向的其他檔案。上限為 20,000 項 / 1 GiB；解析 TAR 的解壓流也有位元組上限。
- 兩個引擎共用 `/api/file-transfer/archive` 和 `/api/file-transfer/upload`，位於現有鑑權中介軟體後，要求已連線的 clientId 與自定義請求頭，路徑規則與檔案管理一致（包括機器瀏覽的絕對路徑）。前端通過 `appUrl()` 保留反代字首。
- 資料夾上傳保留頂層資料夾及遞迴層級，按檔案順序傳送二進位制 HTTP 請求（每檔案 32 MiB，不走 base64/WS），不會覆蓋已有檔案。支援 File System Access 的瀏覽器也上傳空目錄；其餘使用 `webkitdirectory` 回退，僅包含檔案及父目錄。失敗時已上傳部分保留。
- 壓縮並下載使用私有臨時目錄，HTTP 下載完成、斷開或處理失敗後清理；瀏覽器通過已有 blob 儲存邏輯儲存，不進行第二次下載請求。臨時下載限 200 MiB，以控制瀏覽器記憶體；更大檔案可先原地壓縮再用原有流式下載。
- 迴歸：`tests/unit/file-archives.test.ts`、`tests/unit/file-transfer-routes.test.ts`、`tests/file-archives-ui-test.mjs`（構建後執行，獨立埠/資料目錄，零模型呼叫）。

### 系統截圖（Windows / macOS 本機）

- 輸入框動作欄的 `host:composer-screenshot`（剪刀圖示，預設排在附件、模板之後，即左側第三個位）由 `SystemScreenshotButton.tsx` 渲染，沿用欄位排序、顯隱及圖示編輯。**點選即直接「保留當前視窗截圖」**（不彈選單、不隱藏視窗）；**滑鼠懸停**時在其上方展開懸浮面板，裡面只有一個入口「隱藏當前視窗截圖」。選擇後拖動框選並鬆開完成；Esc（macOS 亦可用）取消，Windows 可右鍵取消，超時自動取消。懸浮面板複用 `useFloatingPanel` 與 `ctx-menu`，指標離開按鈕/面板 180ms 後收起，支援點選外部 / Esc 關閉；觸屏與鍵盤使用者仍有可用的預設點選行為。
- 位置遷移：`web/src/ui-slots.ts` 的 `migrateScreenshotOrder` 把早期佈局快照中尚未登記進 `order` 的截圖按鈕錨定在模板（無模板時附件）之後——否則未排序條目會排到所有已排序條目之後而飄到右側；新佈局直接按 `order: 115` 落位。
- `server/system-screenshot.ts` 在正常鑑權後註冊 `/api/system-screenshot`：GET 查詢能力，POST 發起截圖；`hideWindow` 僅接受布林值，省略時預設 `true`，相容原有客戶端。同一服務同時只允許一張截圖；僅限 Windows / macOS、迴環 TCP 與迴環 Host，拒絕代理轉發頭和跨源請求；其他平臺 GET 返回 `available:false`、POST 返回 501。遠端客戶端不能擷取服務端桌面。
- `server/system-screenshot-windows.ts` 通過非同步 PowerShell STA 輔助程序呼叫 Win32 / WinForms。隱藏模式下前端臨時給視窗標題附加隨機 nonce，輔助程序僅在前臺視窗標題匹配時最小化，避免焦點切換後誤操作其他視窗；成功、取消和異常均恢復原視窗（含最大化狀態）。保留模式不改標題、不最小化或恢復視窗，也不登記視窗恢復資訊。斷連通過 stdin 取消；輔助程序監測父程序退出，超時強制結束時服務端另行恢復隱藏的視窗。
- `server/system-screenshot-macos.ts` 非同步呼叫原生 `/usr/sbin/screencapture -i -x -t png <私有臨時檔案>`：原生浮層內拖動框選（空格切換視窗模式），Esc 取消且不寫檔案，空檔案即視為取消。隱藏模式先用 `osascript` 讀取前臺應用名 / `unix id` / 前臺視窗標題，兩個訊號任一命中才把該應用 `visible` 置 false：① 視窗標題包含前端設定的 nonce（瀏覽器會把 `document.title` 寫進視窗標題）；② 前臺應用的 pid 屬於承載本服務端的宿主程序祖先鏈（`ancestorPids()` 用一次 `ps -A -o pid=,ppid=` 向上推導）。② 是必需的：桌面端前臺視窗常是內嵌瀏覽器面板的固定標題「pi Browser」，nonce 永遠進不了標題，只靠 ① 會把正常的隱藏請求誤判成焦點變化。兩個都不命中（使用者已切到無關應用）才返回 `window-not-focused`。隨後 `screencapture`，最後恢復 `visible` + `frontmost`。未授予自動化 / 輔助功能許可權時探測指令碼失敗，降級為「保留視窗截圖」而不斷言失敗。macOS 首次使用還需在「系統設定 → 隱私與安全性 → 螢幕錄製」中授權實際執行程序（Node / 終端 / Electron 應用），否則截到的是空白桌面。臨時檔案讀取後連同私有臨時目錄一起刪除，不修改剪貼簿。
- 擷取全部顯示器構成的虛擬桌面後再框選，支援負座標與混合 DPI；只返回所選 PNG，不落臨時圖片、不修改剪貼簿。結果通過 `image-lightbox-bridge.ts` 的 `openImageLightbox` 開啟通用預覽，可標註、附加到輸入框、複製、下載與縮放；取消無彈窗，不自動加入對話附件。非 Windows / macOS 或遠端訪問停用按鈕並說明原因。
- 迴歸：`tests/unit/system-screenshot.test.ts`、`tests/unit/system-screenshot-windows.test.ts`、`tests/unit/system-screenshot-macos.test.ts`、`tests/unit/ui-slots.test.ts`（截圖位置與老佈局遷移）、`tests/image-preview-ui-test.mjs`（懸停展開 / 點選即截圖）；覆蓋兩種模式、平臺能力、舊請求預設值、引數校驗、nonce 校驗、降級路徑與懸浮面板互動；原生 C# 編譯驗證與 macOS 指令碼編譯驗證都不觸發真實桌面截圖。

### 下載

`web/src/download.ts`：不用 `<a download href>`（Chrome Safe Browsing 會攔截非 HTTPS 源的無信譽檔案型別如 .zip/.exe），而是 fetch → blob 儲存；>200MB 回退原生導航流式下載；失敗 toast 顯示服務端錯誤正文（`downloadFailed` i18n key）。

**Windows 特例**：blob 錨點下載在 Windows 上仍可能被 Safe Browsing 靜默攔截（無 JS 錯誤，表現為「點了沒反應」）——Chromium 安全上下文（localhost/HTTPS）下優先用 `showSaveFilePicker` 直接寫入使用者選中的檔案（繞過下載管線）；Windows 上儲存名經 `sanitizeFileName` 清洗（`<>:"\|?*`、尾隨點/空格、CON/COM1 等保留裝置名）；取消儲存對話方塊不算錯誤（`cancelled`，不彈 toast）。`download-test.mjs` 覆蓋迴歸（已停用 picker 以測 blob 路徑）。
