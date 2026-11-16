[English](./canvas-usability-review-2026-07.en.md) · [简体中文](./canvas-usability-review-2026-07.md) · **繁體中文**

# 畫布協同可用性審視

## 結論與範圍

畫布已經具有工程編輯、節點配置、真實引擎執行、人工審批、日誌、模板、自定義卡片和 AI 工具入口。但當前實現更適合有人觀察的簡單序列試跑；條件分支、審查返工、多 worktree 程式碼整合和多視窗共同編輯，尚不足以作為穩定自動協作流水線依賴。

本次以原始碼審查、臨時隔離儲存復現及相關單測為依據。未呼叫付費模型、未操作使用者已有畫布、未進行瀏覽器或真機端到端測試。另一併行任務正在修改刪除生命週期；該項不重複修復或計入下列新增缺陷。行號以審查時工作區為準，並行改動可能使其移動。

## 已有能力與實際邊界

| 能力           | 已實現                                                           | 實際邊界                                                  |
| -------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| 工程管理與搭圖 | 列表、新建、重新命名、儲存、模板、卡片、連線、匯入匯出、撤銷重做 | 儲存確認、切圖保護與多視窗版本衝突未閉環                  |
| 引擎執行       | Pi/DSH/Claude/Durable 的節點接入、模型選擇與強度配置             | 引擎或模型可能自動回落；實際執行配置應明顯展示            |
| 執行控制       | 單節點/全圖執行、停止、插話、人工批准/駁回協議                   | 圖狀態與節點狀態同步不足；返工和匯聚語義有缺陷            |
| 程式碼隔離     | Git worktree 建立與節點獨立 cwd                                  | 缺少整合工作區和產物合入；路徑命名未包含 graph/run        |
| 輸出與證據     | 工具日誌、節點對話、交接摘要、時間線                             | LLM 交接僅保留正文末尾 300 字元；執行輪次與產物版本未建模 |
| AI 建圖        | DAG 提示、解析、確認與 canvas 工具編輯                           | 工具路徑可編輯圖；介面的“智慧”入口請求與結果通道斷開      |
| 邏輯與資料節點 | 條件、人工、轉換、匯聚等角色                                     | cron/webhook/memory/loop 等部分角色只是配置說明透傳       |

## 優先修復的問題

### P1：儲存與協同編輯會丟失工作

1. **儲存未使用服務端的版本保護，傳送即顯示成功。** `web/src/components/canvas/CanvasStudio.tsx:757` 不傳 `baseRev/requestId`，忽略傳送結果並立即清除髒標記。服務端 `server/canvas/canvas-dispatch.ts:57`、`canvas-store.ts:215` 已有 revision 衝突能力。兩個標籤頁、AI 與使用者同時編輯時，舊拓撲可能覆蓋新拓撲；斷線也可能顯示已儲存。
2. **切換工程丟棄未儲存編輯。** `CanvasStudio.tsx:1021` 清髒標記後加載另一圖，自動儲存前的修改沒有暫存或儲存確認。
3. **其他工程的廣播會切走當前工程。** `CanvasStudio.tsx:196` 接收任意 `canvas_graph_state`；未儲存保護僅針對同 ID。`server/index.ts:2175` 全連線廣播 AI 改圖，因此編輯 A 時 B 的更新可替換 A。
4. **編輯態與執行態混在一個 graph 物件。** `CanvasStudio.tsx:218/288` 的節點事件會觸發整圖髒檢測與自動儲存；節點事件不同時更新圖級 status，執行/停止按鈕可能顯示錯誤。執行狀態變化不應產生使用者編輯版本。

### P1：流程執行與交付存在語義斷點

5. **條件分支無法可靠匯聚、結束。** `server/canvas/canvas-orchestrator.ts` 的 `handleDownstreamEdges` 按所有入邊源節點是否 done 決定啟動；未選分支沒有 skipped 狀態。全圖完成也要求所有節點 done。已復現：true 分支完成、false 分支 idle 時，join 未啟動，圖仍 running。
6. **返工邊未繫結審查決策。** 正常完成會遍歷 reject/review/loop_back 並遞增重試、派發；`reviewNode(reject)` 只改成 waiting_approval，不派發返工。已分別復現“普通完成觸發 reject”和“人工駁回不啟動返工”。反向邊還參與正向入度和匯聚計算，環圖啟動策略缺少明確入口。
7. **程式碼隔離缺少整合閉環。** `resolveNodeCwd` 使用 `.worktrees/canvas-${node.id}` 和 `canvas/${node.id}`，沒有 graph/run 名稱空間；啟用 worktree 後返回倉庫根而非原來的 web/server 子目錄。預設模板 FE/BE 使用 worktree，QA 在主樹，排程器沒有彙總兩者改動再驗證的步驟。worktree 建立失敗還會靜默回落原目錄。應明確產物提交、基線、衝突處理、整合測試目錄和最終採納流程。
8. **節點交接丟失大部分正文。** `executeRealEngineNode` 返回 `replyText.slice(-300)` 加 diff stat。架構契約、介面、檔案清單和驗證證據可能被截掉，僅傳末段套話。交接還依賴邊上的 lastHandoffSummary，但 `saveCanvasRuntimeState` 只持久化節點欄位與圖 status，不儲存邊摘要和迴圈次數；重新整理/重啟後的證據與重試預算不完整。

### P1/P2：介面承諾與真實能力不一致

9. **“智慧”建圖未接通結果。** `App.tsx:2826` 未給 CanvasStudio 傳 lastMessage；`CanvasStudio.tsx:493` 通過獨立 WS 發 prompt，DAG 解析卻僅依賴 propLastMessage，獨立通道沒有對應 snapshot 解析。pending 缺少超時/取消。應繫結明確會話和 requestId，返回結構化建圖提案。
10. **部分角色只有外形沒有執行器。** `canvas-orchestrator.ts` 的 CANVAS_PASSTHROUGH_ROLES 含 cron/webhook/memory/loop。它們執行時生成配置摘要然後完成；不能據此認定具備定時註冊、Webhook 接入、持久記憶或可控迴圈。應逐項補執行器與驗收，或顯式標註為說明節點。
11. **AI DAG schema 無法表達已有分支能力。** `web/src/components/canvas/canvas-dag.ts:12/88/126` 的邊只有 from/to，轉換後全為 handoff，缺少 condition_true/false、approve/reject 與節點 config；生成的條件圖可能兩邊都執行。

## 互動與恢復問題

| 優先順序 | 問題與影響                                                                      | 證據                                                                       |
| -------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| P1       | 窄屏工具欄缺少摺疊/滾動，內部 absolute 選單可能被裁切；模板選單缺少高度上限     | styles.css:27669/27680/27779；CanvasToolbar.tsx:389；需瀏覽器驗證尺寸      |
| P2       | 50%/200% 縮放拖動不跟手，螢幕增量未除 zoom                                      | CanvasNodeCard.tsx:313                                                     |
| P2       | 觸屏拖線依賴目標端 pointerup，可能被起點隱式捕獲；缺少命中測試與取消清理        | CanvasNodeCard.tsx:288；CanvasStudio.tsx:394；需真機驗證                   |
| P2       | 畫布隱藏仍響應全域性 Ctrl+Z/Ctrl+D/Ctrl+S/Delete                                | CanvasStudio.tsx:938；App.tsx:2824                                         |
| P2       | 日誌快取僅按 nodeId，模板複用節點 ID 時跨圖串日誌；時間線不主動載入歷史         | CanvasStudio.tsx:81/244/922；CanvasTimeline.tsx:19                         |
| P2       | JSON 匯入只校驗陣列與懸空邊，缺少節點必填欄位、型別、唯一性驗證，可導致渲染錯誤 | CanvasStudio.tsx:657；CanvasNodeCard.tsx:94                                |
| P2       | 小地圖按 %800 近似對映且點選只選中；定位不移動視口，佈局不按真實卡片高度        | CanvasStudio.tsx:823/1221/1240；canvas-p0.ts:6                             |
| P2       | 多處文案未接應用 i18n；儲存/斷線/匯入失敗缺少統一可見反饋                       | CanvasToolbar.tsx、CanvasAiBar.tsx、CanvasNodeDrawer.tsx、canvas-client.ts |

## 根本最佳化方向

### 第一階段：建立可信的編輯與執行邊界

- GraphDefinition 單獨儲存拓撲、配置和位置，revision 樂觀併發；RunState 儲存 runId、圖版本、節點 attempt、狀態和執行配置。
- 儲存以服務端成功回執為準；失敗保留草稿。切圖先儲存成功或存本地草稿。載入響應帶 requestId；後臺廣播不得隱式切圖。
- 執行時固定一份圖版本；編輯生成下一版本，不能讓舊執行物件覆蓋新配置。
- 打通智慧建圖的會話和請求歸屬、超時、取消、錯誤與確認。

驗收：兩標籤頁競爭儲存有明確衝突；離線儲存不顯示成功；A/B 工程更新互不切換；執行狀態更新不觸發編輯儲存；一次智慧生成可完成確認落圖。

### 第二階段：重建可收斂的排程語義

- 狀態至少區分 pending/running/succeeded/failed/skipped/cancelled/waiting_review，並讓每個狀態有明確可執行動作。
- 邊按本輪令牌/決策啟用；匯聚區分“所有啟用前驅”與“任一前驅”。未選路徑顯式 skipped。
- 迴路以 attempt/iteration 建模；批准走主線，駁回帶意見返回指定節點；定義次數、超時、成本上限與人工接管。
- graph 狀態由排程器根據所有本輪任務推導，不由 UI 推測；出現 error 或無可執行節點時明確失敗/阻塞原因。
- 服務重啟將遺留 running 標為 interrupted，明確支援續跑、重跑或人工確認，不能僅恢復一個執行標籤。

驗收：條件菱形圖可結束；駁回後返工再審批可結束；非選分支不阻塞；停止後不派發後繼；重跑不復用舊輸出與重試次數。

### 第三階段：把協作從文字交接升級為產物交接

- 產物 envelope 含摘要、完整正文引用、檔案/commit/patch、測試結果、基線與來源 attempt；摘要供閱讀，執行按引用取證據。
- worktree 用 graphId/runId/nodeId 命名並保留子目錄；失敗明確報錯或由使用者選擇共享目錄模式。
- 專設整合工作區：收集併合入節點產物，解決衝突，QA 對同一整合產物執行檢查；最終呈現待採納 diff。
- 執行前預檢引擎、模型、目錄、Git 基線、必填配置和節點執行能力；展示真實使用的回落配置。
- 排程併發有佇列和預算；同目錄寫任務需檔案認領或互斥；重試必須保留歷史 attempt。

驗收：兩個隔離節點的修改進入同一測試產物；可追溯每個檔案來源；模型回落可見；重試和恢復不會混用別輪產物。

### 第四階段：降低使用門檻

先提供少而可靠的序列實現、開發—測試—人工驗收、隔離開發—整合三個模板；每個模板有零 token 契約測試與可選真引擎端到端檢查。再補響應式工具欄、Portal 選單、拖拽縮放、觸控連線、真實小地圖和鍵盤焦點邊界。能力未完成的節點應明確標識，避免依靠名稱形成自動化預期。

## 本次驗證

臨時指令碼使用 mkdtemp 獨立目錄和排程入口替身，不啟動模型、不建立 worktree。輸出：

```json
{"probe":"branch_join","scheduled":[],"joinStatus":"idle","graphStatus":"running"}
{"probe":"unconditional_reject_edge","scheduled":["coder"],"loopCount":1}
{"probe":"human_reject","scheduled":[],"nodeStatus":"waiting_approval"}
```

執行 canvas-orchestrator、canvas-history、canvas-cards、canvas-picker-isolation、canvas-pstack-skills 五組 Vitest：50 項中 49 通過，1 項失敗。失敗為審查回路測試 expected 2 / actual 1，與並行生命週期修復新增執行圖身份檢查有關；已交接修復方核對夾具，不能將當前工作區稱作全綠。測試通過也不代表瀏覽器操作、觸屏和真實多模型流水線已經驗證。

本報告僅新增審查文件，未修改業務實現。
