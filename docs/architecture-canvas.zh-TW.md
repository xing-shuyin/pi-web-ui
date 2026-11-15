[English](./architecture-canvas.en.md) · [简体中文](./architecture-canvas.md) · **繁體中文**

# Canvas 協同：編輯版本、執行與產物

畫布入口是 `web/src/components/canvas/CanvasStudio.tsx`，獨立 WebSocket 在 `canvas-client.ts`。服務端協議單源為 `server/protocol.ts`；`canvas-dispatch.ts` 處理使用者請求，`canvas-agent-tool.ts` 提供 AI 編輯和除錯入口。兩者共用儲存及排程器。

## 本地化

Canvas 介面與內建模板的展示文案在 `web/src/i18n/messages/canvas/`，後端系統狀態和日誌在 `canvas-runtime/`；兩個模組均維護全部 14 種語言，共用全域性翻譯執行時。後端廣播訊息 key 與引數，由各瀏覽器按自己的當前語言渲染；使用者內容和 AI 回覆保留原文。字典維護、相容欄位與同步流程見 [`i18n.md`](i18n.zh-TW.md)。

## 對話呼叫與引用

輸入框 `@` 候選包含儲存的畫布工程，可用 `@畫布`、`@canvas`、`@工作流` 或名稱檢索。列表通過當前聊天連線請求，不快取跨專案列表；選中後傳送 `mode: "canvas"` 附件，`path` 儲存穩定 graphId。引用不會啟動工作流，也不作為工作區檔案讀取。

服務端驗證工程存在後注入精簡 `<canvas-ref>`，模型先通過 `canvas` 的 `get` 讀取最新配置，再根據使用者要求呼叫 `run_all`、`stop` 或 `get_log`。pi 會話在延遲載入開啟時對捕獲的目標 session/Conversation 載入現有工具，保留開關、預設和許可權門控；工具不可用時顯示提示，不自動放寬許可權。

## 編輯與儲存

`CanvasGraph.rev` 只隨拓撲儲存增加，執行進度不推進編輯版本。儲存帶 `baseRev` 與 `requestId`；服務端成功回執才確認儲存。衝突返回 `canvas_error/rev_conflict` 和權威圖，不能用舊圖覆蓋或把衝突當成功。

拓撲儲存保留磁碟上的節點、邊執行欄位和 `graph.run`，避免舊瀏覽器快照抹掉進度。執行態儲存僅合併相同 ID 的執行欄位，不能回滾節點配置、重建已刪除圖。畫布載入響應繫結請求；其他圖的廣播不得切換當前工程。草稿與日誌都按 graphId 隔離。

`canvas-validation.ts` 校驗節點、邊、列舉、唯一性、端點、大小及正向無環；受限返工邊不參與前向環判斷。匯入和 AI 修改也必須經過校驗。工具 details 保持在 64KB 以下，大圖可通過文字結果取回。

畫布工具動態返回文案的 `pick()` 必須顯式傳入插值變數，鍵名與語言包 `serverStrings` 的 `{表示式}` 槽位逐字一致（如 `"card.title"`、`"nodes.length"`），避免向用戶返回未替換的佔位符。

## 定時觸發

內建定時任務支援 `target: "canvas"` 與穩定 `graphId`，面板和 `schedule` 工具共用儲存及 cron/間隔/單次規則。未指定目標的舊任務繼續執行對話。儲存畫布任務前校驗工程存在和圖結構；觸發時重新讀取最新配置，傳入任務 prompt 與 cwd 作為本輪輸入和執行根，不改變節點各自的引擎或模型。

`canvas-scheduled-task.ts` 複用同一個 `CanvasOrchestrator.runAll`，等待該輪執行結果並在任務歷史中儲存 graphId/runId。人工審批暫停、阻塞、錯誤、取消、刪除或執行被替換均不得報告完成；同一工程的執行與等待審批狀態由排程器統一拒絕重入。畫布刪除後定時任務會失敗，不會復活 default 工程。單次任務消費由 `SchedulerStore` 統一持久化，記錄失敗仍推進記憶體狀態，防止每個 tick 重複執行。

## 每輪執行

`CanvasGraph.run` 記錄執行 ID、起始圖版本、開始/結束時間與範圍。節點的 runId、attempt、artifact 和實際引擎/模型屬於執行態；邊的啟用、交接及返工計數也須持久化。

排程按本輪啟用邊判斷前驅就緒。未選分支標 skipped，避免分支匯聚等待永不執行的節點。審批批准與駁回有獨立邊；返工有次數邊界，不能將 reject/review/loop_back 當普通完成邊無條件觸發。停止和刪除撤銷執行代次，跨 await 後必須檢查取消與身份，舊執行不得清除新執行或繼續派發。

服務啟動呼叫 `markInterruptedCanvasRuns`，把磁碟遺留的 running/queued 標成 paused，並記錄中斷原因；磁碟執行標籤不能代表真實引擎仍存在。恢復通過明確重跑完成。

cron、webhook、memory、loop 等尚無確定性執行器的角色不得偽裝成功。引擎或模型不可用應明確失敗；不能在介面仍顯示原配置時靜默替換。

## Git 隔離與產物

`canvas-workspace.ts` 提供 prepare/capture/cleanup 三個 Canvas 邊界，共享的非同步 Git、路徑和工作樹身份校驗、scratch index 快照與補丁原語位於 `server/workspace-handle.ts`。裝置程式碼任務通過獨立的 `device-center/task-workspace.ts` 適配相同原語，不借用 graph/run/node 身份；協議與證據約束見 [`device-collaboration.md`](device-collaboration.zh-TW.md#21-版本化契約與程式碼任務)。Canvas 的型別、產物層語義和公開 API 繼續由本適配層維護。隔離目錄位於 dataDir/canvas/workspaces/graph/run/node-attempt；使用 detached worktree，保留原 cwd 子目錄。不會 reset 使用者分支、自動 commit 或合併主樹。

隔離要求本地 Git 和乾淨源基線；不支援的 SSH/非 Git 隔離、髒基線、路徑逃逸、建立失敗均明確報錯，不回落為共享目錄。dataDir 必須在源倉庫外。

節點產物用臨時 Git index 生成樹和 binary patch，覆蓋 tracked、刪除和非 ignored 新檔案；不修改使用者 index。產物層包括 SHA-256、統一 baseline 和來源，按順序去重共同祖先。下游有上游隔離產物時，即使 useWorktree=false，也在整合 worktree 應用上游層；衝突停止並保留工作區。QA 驗證的因此是組合產物。

`CanvasArtifact` 保留完整交付正文與 workspace 證據，短摘要僅用於閱讀。待採納 patch 與工作區保留供使用者檢查，不自動寫回主分支。清理是顯式且非強制的，只清理乾淨、未產生額外提交的隔離目錄，不刪除產物。

## 驗證

相關單測以 `canvas-*` 命名，覆蓋儲存確認/衝突、斷線丟 ACK 後核對恢復、執行態不覆蓋拓撲、刪除遲到完成、分支匯聚、審批返工與產物繼承、模板與匯入、互動純演算法、臨時 Git 倉庫產物整合。測試不得使用使用者畫布、真實模型或修改使用者倉庫。

`node tests/canvas-browser-test.mjs` 使用 `tests/lib/ensure-build.mjs` 與 Chrome 探測器，自起隔離服務驗證首屏工程載入、儲存 ACK 與草稿清理、Portal 選單、零 token 條件匯聚、後臺執行不切圖，以及 390px 窄屏佈局。截圖寫入 `.artifacts/canvas/`。真實引擎與真機觸屏體驗仍需另外驗證。
