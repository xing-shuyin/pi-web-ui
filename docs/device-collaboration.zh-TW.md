[English](./device-collaboration.en.md) · [简体中文](./device-collaboration.md) · **繁體中文**

# 群組 / Bot / 跨裝置協作硬約束

> 服務端架構與部署鏈路見 [`device-center.md`](device-center.md)（Hub 與本機聯結器、繫結與配對、部署）
> 與 [`device-center-deployment.md`](device-center-deployment.md)；遠端桌面實現細節見 [`device-desktop.md`](device-desktop.md)；
> 分塊檔案同步細節見 [`device-file-sync.md`](device-file-sync.md)。
> 與單個 Bot 的私聊（`kind: "direct"` 的房間）與 Bot 獨立記憶見 [`agent-bot-design.md`](agent-bot-design.md)。
> **本文只收錄「改程式碼時必須遵守」的硬約束**（原 `AGENTS.md`「裝置中心與跨裝置協作」整段遷入）。

## 1. 裝置中心入口與本機 Hub

獨立 Hub 與本機聯結器位於 `server/device-center/`，部署與邊界見 [`device-center.md`](device-center.md)。主介面「裝置中心」為原生 `devices` 檢視（`DeviceCenter.tsx`），舊 `/devices` 重定向到該檢視；未繫結時通過程序內私有 loopback Hub 支援本機 Bot/群組（`local-hub.ts`，資料與外部繫結隔離），概覽保留群組管理及連線/建立引導，離線或請求失敗不得清空已知群組；本機 Hub 安裝走 `hub-setup.ts` 的 loopback 同源介面與獨立 Hub CLI，必須驗證引數、隔離資料目錄、互斥執行並在關閉時取消等待；配對介面僅允許迴環來源與同源寫入；群成員統一為 Bot，裝置僅負責承載與連線。

## 2. 群任務派發與上下文

群任務優先派給顯式 @ 的穩定 Bot ID；可選 `primaryBotId` 接收未指定目標的人類訊息並續接該 Bot 最近有效會話，Bot 公開訊息不觸發預設派發，移除主 Bot 時清除設定。`group-context.ts` 凍結主 Bot 身份，執行器按群與 Bot 雙重匹配注入協調職責，使用已有持久會話和相關請求回覆完成委派，角色不擴張許可權。機器人接力繼承父任務預算，禁止無界互派。Hub 持久化分兩層：`device-hub.json` 為索引（`version: 2` 同 schema，`messages`/`tasks`/`conversationMessages` 為空陣列），訊息、任務與轉錄寫入 `hub-log/` 下按群/按會話的追加日誌；每筆事務先將索引與三個集合的增刪差量寫入 `hub-wal.jsonl`（遞增序號與內容校驗和），重新整理到磁碟後才算提交；隨後更新追加日誌（`upsert`/`del` 行），最後原子替換帶 `checkpointSeq` 的索引並清理已投影 WAL。投影失敗不撤銷已提交事務，必須保留 WAL、推進已提交記憶體版本，並在後續寫入或重啟時冪等補投影；不得複用序號或把已提交結果報告為普通失敗。墓碑達到閾值後按存活行壓縮，載入時按群保留 500 條並修復崩潰半行；WAL 完整行損壞須拒絕開啟，僅不完整尾行可以修復。`readPersistedHub()` 只在記憶體重放，不修檔案、不建立目錄。舊版內聯資料在 `open()` 時自動遷移；回退舊版本前必須匯出完整狀態（舊版讀索引只能看到空集合）。群上下文由 `group-context.ts` 在派發前凍結，近期公開訊息隨任務傳輸（24 KiB），普通聊天不重複落盤；顯式契約任務將實際選入的上下文封存到下述 Manifest；`device_collab read_history` 按穩定游標回查原文（每群保留 500 條，超長訊息可分段），必須驗證來源 Bot 的裝置、賬號及群成員身份；清空/淘汰使舊遊標失效。歷史是參考資料，不能授權派發或執行。人類訊息未顯式給出 `targetBotIds` 時，由 Hub 按群成員解析正文 `@Name` / `@Name(<id>)`；同名多成員不猜、非成員不派發，不因客戶端未解析而回落到主 Bot。訊息可攜帶 `replyToMessageId`，必須指向同群訊息。

### 2.1 版本化契約與程式碼任務

`device_collab` 的 `send_task`、`conversation_create`、`conversation_send` 以及對應 Hub / 本機代理入口接收 `executionMode` 和巢狀 `contract`。預設模式為 `chat`。`code` 必須提供確定的 `baseline: { repositoryId, commit }`；commit 為完整 SHA，repositoryId 由本機規範化網路 origin（剝除憑據，保留倉庫路徑大小寫）或無 origin 倉庫的全部排序根提交摘要推導，不能用任意標籤或本機路徑代替。常見 SSH、SCP 與 HTTPS 預設埠地址可對映到相同 host/path；本地、file 與未知傳輸 origin 明確拒絕。`contract` 支援業務 `id`、遞增 `revision`、目標、約束、驗收條件與有序 `inputArtifacts`。Hub 計算內容摘要；客戶端不能提供權威 Manifest 或審批證據。相同冪等鍵的精確重試複用契約，內容衝突拒絕；同一業務 id/revision 只能對應一個內容摘要；舊版本仍 queued、running、持有已發租約或處於恢復視窗時，新版本請求返回 409。舊版本結算後才可建立新版本；已提交舊結果丟 ACK 後仍可精確重放確認，舊業務版本不能為新版本提供接受證明。

`work-contract.ts` 是契約、`ContextManifest` 和 `DeviceArtifact` 的摘要與驗證入口。契約任務首次派發前，將實際選入的群上下文、taskState、有序輸入產物 id/digest 引用、執行裝置/Bot/revision 的策略引用和實際預算連同契約版本一次封存到任務事務。延期、重試與重啟派發使用原 Manifest，不重新選取歷史。摘要覆蓋規範 JSON，輸入必須複製並深度凍結；未知欄位、損壞摘要和不匹配的契約引用均拒絕。

`task-workspace.ts` 將源倉庫、裝置、Bot revision、task/attempt、契約和 Manifest 摘要繫結到本機註冊的 opaque handle。網路傳入的目錄或仿製 JSON 不能成為執行能力。本批程式碼任務要求 Bot.cwd 為本地 Git 頂層目錄、源 checkout 乾淨，且工作區資料目錄位於源倉庫之外；子目錄 Bot 明確拒絕且不留下臨時工作樹，Canvas 原有子目錄行為不變。程式碼任務沿用按 Bot 與源根的保守排程鎖，建立隔離工作樹不自動放寬併發。程式碼任務使用新執行會話，真實工具 cwd 必須來自經過驗證的 handle；不得在另一工作區恢復舊轉錄。基線、HEAD、Git common-dir、gitdir 回指與真實路徑須在跨 await 的關鍵邊界複核。工作樹只隔離修改位置，**不構成檔案系統或網路安全沙盒**，原有工具許可權與審批繼續生效。

契約 JSON 上限 256 KiB，Manifest 上限 96 KiB，契約建立請求上限 384 KiB；輸入產物至多 8 份且受契約總量限制。已封存的 context/taskState 只隨 Manifest 傳輸，外層不重複複製；派發前按完整 JSON 幀檢查 512 KiB 上限，超限拒絕投遞且不切斷裝置連線。輸入產物攜帶內容與 SHA-256，不能引用傳送裝置的本地路徑。每份輸入補丁先證明其從宣告基線生成的 outputTree，再按契約順序合成；衝突、篡改或過大補丁明確失敗。本批支援累計補丁的單父鏈與多個不重疊輸入；將某祖先及已包含它的後繼同時作為輸入會顯式衝突，不自動推斷或去重依賴圖。空補丁是合法的無修改產物。輸出為從固定 baseline 到 outputTree 的累計 binary patch，同時記錄本次執行的 inputTree；原始補丁上限 128 KiB。首次捕獲固定產物身份與摘要，重發不得重新生成。Git retention ref 保留基線與產物物件，使用者源 checkout 和 index 保持不變。準備與快照期間停用 hooks、fsmonitor 以及所有配置來源的命令過濾器；快照按原始檔案位元組生成，避免隱式 clean/smudge 轉換。

執行結束、產物捕獲、獨立驗證、交付接受是四類不同事實。程式碼執行階段記錄 `executionCompleted`、`artifactProduced` 和產物內容；獨立驗證與交付接受使用下節的 Integration / Review 證據閉環，不因終態 `completed` 或 Bot 自報檢查自動成立。程式碼任務必須在確認執行器停止併成功捕獲產物後才能報告完成；捕獲失敗仍可儲存執行已結束這一事實。產物和證明進入持久 Outbox、終態指紋及 Hub 的不可變接納記錄，ACK 對應實際提交內容。

若 Hub 已持久結算其他終態，或原 attempt 已永久失效，裝置收到繫結原 task/attempt/status/fingerprint 的永久拒收回執後，將完整原結果與有限原因碼原子移入持久隔離區；此後不繼續重放該條，也不妨礙其他結果上傳。欄位或摘要不匹配、一般請求失敗、網路錯誤與持久化錯誤不得觸發隔離。隔離區獨立限制為 128 條 / 2 MiB，滿時保留原待發結果並拒絕繼續清除；不會淘汰舊證據。統一 `task-recovery-state.json` 寫為 version 2，相容讀取 version 1 及舊雙檔案狀態，隔離區與活躍租約、待發結果同次原子提交，總狀態檔案上限 8 MiB。回退不認識 version 2 的舊裝置程式碼前須備份並轉換全部恢復狀態，不能刪除隔離區以繞過檢查。

所有顯式契約任務及其會話（包括聊天契約、無產物的失敗程式碼任務）均不受普通 500 條歷史 / 已關閉會話裁剪影響，重啟載入也必須保留；契約身份和最高版本不能因歷史裁剪消失。普通無契約聊天仍按原策略保留。歷史頁面及工具結果只展示有界的契約、Manifest、產物身份與獨立事實，原任務保留完整證據。`device_collab task_evidence` 使用 `evidenceKind: "artifact"`、`taskId`、`expectedDigest` 和位元組 `offset` / `limit` 分頁讀取原始補丁；每頁最多 24 KiB 原始位元組，返回 base64 內容與補丁 SHA-256、產物摘要及來源 metadata。讀取必須通過同賬號、裝置、群與會話校驗，後續輸入須重組完整內容並校驗摘要。自動清理不得刪除髒工作樹或額外提交；已捕獲產物的 retention refs 暫不自動過期，顯式清空或刪除群會清除 Hub 側的契約、會話和證據記錄並重置該群的業務版本權威，裝置倉庫中的保留物件需要另行顯式維護。

### 2.2 產物驗證與按契約驗收

沿用 `Delivery → Integration → Review`，不另建驗收集合。當前執行中的作者 Bot 可用 `conversation_deliver` 的 `artifactTaskId` 登記同一會話內、同 Bot / revision / 裝置先前完成的程式碼產物；當前任務提供寫入許可權，已完成任務提供不可變產物身份，二者不得混用。Hub 從已提交任務派生 `artifactRef` 和封存的 `acceptanceCriteria`，不接受呼叫方自造引用、摘要、criteria 或驗證結論。產物交付不需要也不偽造 commit；舊 commit 交付繼續要求 repository、完整 baseCommit / commit 與自報 checks。

產物可在驗收前準備 Integration。裝置核對規範倉庫身份、基線、累計補丁與 outputTree，物化真實 Git commit 後複用現有臨時合併與 CAS 介面卡；本階段要求目標分支 HEAD 等於產物基線，preparedTree 必須等於 outputTree，不自動 fetch、變基或合併已前進的目標。inputTree 僅用於審計，補丁始終從 baseline 重放。公開記錄只攜帶產物引用和摘要，原始補丁仍經受控證據入口讀取。`task_evidence` 按 deliveryId 讀取產物時必須定位該交付的 artifactTaskId，顯式 taskId / expectedDigest 衝突應拒絕。工具摘要保留每條完整條件並標明 `acceptanceCriteriaCount` / `acceptanceCriteriaTruncated`，不得把截短的條件當作完整要求。條件總量超出摘要預算時，用 `evidenceKind: "acceptance"`、deliveryId 和 `expectedDigest: artifactRef.contractDigest` 按位元組分頁讀取封存陣列的規範 JSON，每頁至多 24 KiB；重組 base64 後驗證 criteriaDigest，再解析全部條件。

驗證命令計劃由已鑑權的賬戶所有者在驗證介面首次明確提交併凍結，包含有序 commands、內容摘要、授權賬號和時間；Bot 呼叫身份必須保留到 Hub 判定，不能將 Bot 請求當作賬戶所有者授權。Bot 只能重用既有且完全相同的授權計劃。模型文本、自報 checks、補丁內的 package.json 或一個正確摘要都不產生命令授權。裝置仍核對目標 Bot 的工具 / 命令許可權、revision 和根佔用；驗證只執行受信計劃中的前臺命令，單條最多 300 秒、總計 600 秒，輸出有界並記錄摘要；RPC、代理與介面的截止時間統一由 `verification-limits.ts` 留出停止及傳輸餘量。工作樹不構成惡意程式碼安全沙盒。

真實驗證結果必須包含與計劃完全同序同數量的檢查、退出碼、輸出摘要、物化 commit，以及執行前後樹身份。只有全部 exitCode=0、檢查狀態一致且前後樹均等於 preparedTree 時，Hub 才能按白名單事實計算 verification 摘要。單獨的 verified 狀態、空檢查或漏項不能構成憑證。每個 Integration 的成功憑證不可被重驗覆蓋；需要不同計劃或重新驗證時新建 Integration。

獨立 Review 必須繫結 delivery 的 artifactDigest、integrationId、verificationDigest 及同一契約 / Manifest。accepted 還須按封存 acceptanceCriteria 的索引逐項提交 `criteriaResults: { criterionIndex, verdict, evidence }`，完整覆蓋且全部 met，作者不能評審自己的交付。changes_requested 可以先於成功驗證，但仍繫結確切產物。契約升級、裝置 / Bot revision / 群成員變化、錯誤產物或其他 Integration 的憑證不能為當前交付提供接受證明；純 commit 相等或兩個缺失 commit 相等都不能匹配產物 Review。

確認整合的所有模式都要求真實成功憑證，不能從 prepared / failed 直接應用，也不將舊的無憑證 verified 標誌升級成可信證據。產物還要求當前匹配的 accepted Review 與契約版本。開始 apply 前凍結證據身份，並阻止同一交付 / Review / 契約在未關閉的釋出意圖存在期間被替換；發出新的寫操作前重核 operation、成員身份與目標。已授權寫操作的歷史結果按原意圖核驗，釋出後的許可權變化不會抹除已發生的效果。裝置確認前再次核對驗證憑證、工作樹、preparedTree 和目標 SHA。取消先中止並等待擁有的程序樹停止，再清理；停止無法確認時保留根佔用、Bot lease 和工作區，不報告成功或強制刪除。賬戶所有者可按原持久會話身份取消舊整合，目標 Bot 被停用、換 revision 或移出群不會授予新的執行許可權，也不應阻止單純停止與清理。升級前完全缺少明確停止標記和真實驗證憑證的舊會話，會保守隔離對應 Bot / 根；只有 Hub 明確記錄為 prepared、尚未啟動驗證的舊現場可按原身份取消。舊 failed 也可能來自未確認停止的超時，不能據此自動清理；其他不確定現場需要本機維護者核查，不自動刪除或據缺標記放行新任務。釋出意圖、裝置持久回執及回查規則見下一節。

### 2.3 釋出意圖與崩潰後回查

Hub 在首次傳送釋出 RPC 前，先通過現有 WAL 事務持久儲存不可變 `publishIntent`。意圖繫結原賬號、群、會話、Integration、裝置、Bot revision、交付與 Review 快照、真實驗證憑證、倉庫身份、目標 ref、舊提交和待發布樹。共享原始 Git commit 建構子以固定身份、時間、父提交順序及含意圖摘要的訊息計算唯一候選提交；重試不得重新生成不同提交。協議為 48。包含摘要與候選 SHA 的完整意圖按實際序列化 UTF-8 位元組限制為 384 KiB；各欄位單獨合法但總證明超限時，Hub 在意圖提交與 RPC 前明確拒絕，避免觸發 512 KiB 中繼幀上限。建構子識別 SHA-1 / SHA-256 物件格式，但程式碼產物路徑的既有 SHA-1 限制仍然適用，不能由建構子支援推匯出全部產物鏈支援 SHA-256。

裝置釋出日誌獨立於驗證會話與臨時工作樹。日誌先預留有界記錄，再建立候選物件和保留 ref；CAS 前持久記錄 `cas_started`，確知 CAS 成功後持久記錄 `publishReceipt`，再返回或清理會話。日誌損壞、容量不足或儲存失敗會阻止新的 CAS，未決記錄與取消柵欄不會自動淘汰。候選保留 ref 使關聯樹和父提交不因工作樹清理或通常的 Git GC 丟失。檔案採用原子替換並重新整理；該恢復承諾覆蓋程序崩潰。Windows 目錄後設資料與 Git 物件閉包的掉電永續性不在此承諾內，不能等同於主機突然斷電後的完整事務保證。

`publishReceipt` 表示已觀察到的歷史釋出效果，保留 `cas_exit`、`target_exact` 或 `target_descendant` 的證明來源；看到候選或後代不單獨證明是誰執行了寫操作。`publishObservation` 單獨記錄當前目標 ref，後續移動不會把歷史回執改成失敗。`conversation_read` 的工具摘要只投影意圖示識、候選 SHA、回執來源、當前觀察和停止事實，保留現有輸出預算；不復制完整封存證明、私有倉庫路徑、程序 ID 或原始日誌。CAS 已開始但沒有回執時，即使分支仍等於舊 SHA，也不能證明發布從未發生：它可能被其他操作者回退。此時保留未知，不自動重試或覆蓋外部修改。

啟動、裝置重連和手動 `POST .../integrations/:id/reconcile` 只查詢原發布日誌與倉庫身份。Git 回查不建立物件、ref、工作樹或提交，不執行驗證，也不執行 CAS；它不依賴原工作樹仍存在、當前 Bot 仍啟用或新的執行 lease。對未知結果的回查可以補存證據，但不會自動續發寫操作。重複 apply 在已有意圖時返回當前記錄，不能充當隱式重試。

只有持有賬號所有者身份的人工請求可以呼叫 `POST .../integrations/:id/resume`，並須提交完全匹配的意圖 ID、摘要及候選 SHA，通過當前許可權與版本校驗。裝置還必須有持久證據證明 CAS 尚未開始，或已經明確拒絕且確認停止；`cas_started` 後結果未知不滿足恢復條件。Bot 憑證不能恢復未知釋出。取消先在同一操作門禁內持久封閉未來寫入，遲到 confirm 也受柵欄約束；CAS 已成功則返回已釋出事實。`publishStop.closed` 只表示未來寫入已封閉，`stopConfirmed` 單獨表示原發布子程序已確認停止；`fencedAt` 與僅在正向停止證明下存在的 `stoppedAt` 分開記錄。若不能判明過去效果，保留 `publishStop.pastEffect = unknown`，介面展示歷史結果未知，不能解釋成確定未釋出。釋出子程序停止未知時，原 Bot / 根佔用繼續隔離並持久恢復；驗證程序的停止標記或從分支推斷的釋出回執都不能替代釋出子程序停止證明。本批對重啟後無法確認停止的 Git 子程序採用保守隔離，需本機維護者核查，未擴充套件為 Git Job 監管。

舊的已應用記錄保留原有歷史標記，不補造意圖或回執；缺少意圖的舊進行中記錄不自動釋出，也不從舊狀態推導新證據。工作樹、程序監管與日誌不是安全沙盒；第三方直接修改倉庫、同賬號惡意程序及 POSIX 自行脫離程序組仍受既有邊界限制。

## 3. Bot 登錄檔與持久會話

`bots.ts` 按本機裝置身份儲存 Bot 的固定專案根、角色、模型及工具/Skill/MCP 白名單；群使用 `botIds`，訊息使用 `targetBotIds`，任務與 `device_collab` 檔案同步共用 Bot registry lease/revision；執行會話不得冒用其他 Bot。群 Bot 持久會話由 `hub-conversations.ts` 登記穩定地址及不可變的委派來源（sourceBotId/sourceConversationId/parentTaskId），新建與繼續均可攜帶關聯請求，裝置 `runtime.ts` 原子儲存精確轉錄對映，恢復須驗證 Hub/裝置/群/Bot 版本/目錄；僅精確能力路徑允許 `switch_session`。

## 4. 併發、排程與進度推送

同裝置預設 4 個執行 + 32 個等待，可配置併發 1–16、等待 0–128，按群公平排程；房間公平歷史持久化到裝置資料目錄 `task-scheduler-state.json`（防抖原子寫入、重啟恢復、損壞按中性啟動）；按 Bot 與真實路徑重疊工作區序列，獨立工作區可併發；同一會話繼續訊息在前輪終態後投遞，不打斷工具。群進度經有界、按 attempt 校驗的 SSE 推送，斷線回退輪詢並重同步；原生問卷與一次性工具審批使用任務繫結互動橋。請求/回覆繫結原始會話與 requestId，結果只喚醒原發起者，自動繼續共享任務鏈預算，人工新輸入可開新鏈。忙碌或停止未確認時禁止換根，舊檔案包不得落入新根。Hub 側「哪個任務先下發」與裝置側「本地哪些任務真的併發跑」是兩層職責，見本文 §12「排程分層（Hub 派發 vs 裝置執行）」。

## 5. 檔案同步

檔案同步先暫存預覽後按 revision 匯入，已有差異必須顯式覆蓋；`sync_files recursive:true` 支援有界目錄傳遞，拒絕軟連結/聯接，跳過敏感/忽略項須返回排除摘要，不刪除目標檔案；憑據不得進入工具回執。

## 6. 遠端頁面隔離與跨裝置代理

Hub 預設單埠 `/device/<id>/` 路徑訪問裝置，以 CSP sandbox（禁止 allow-same-origin）與裝置專屬隨機能力路徑隔離遠端頁面；舊獨立域/埠保留相容。跨裝置代理只放行賬號範圍群聊介面，不得暴露本機繫結、目錄與設定介面。

## 7. 群任務恢復與報告

群任務恢復由 `task-recovery.ts` 管 task/attempt/lease 認領與持久終態 outbox，網路斷開保留持有租約的本機執行，Hub 重啟提供有界認領視窗；裝置程序崩潰不盲重跑副作用。裝置租約與終態統一儲存在版本化的 `task-recovery-state.json`：完成時一次原子替換同時加入結果、移除租約，恢復中再次崩潰也必須保留可恢復記錄；舊 `task-active-leases.json` / `task-recovery-outbox.json` 只在新檔案寫入成功後清理，損壞狀態不得覆蓋。記錄與重放按 Hub/裝置身份隔離，執行前為活躍租約預留結果容量。相同 task/attempt 的結果不可變：同內容重放冪等，不同內容拒絕；終態傳輸使用持久條目，ACK 必須繫結 Hub 已持久結果且與條目匹配，禁止未經結算確認直接回顯請求摘要或無摘要刪除結果。舊摘要格式僅用於相容已持久結果；新摘要按欄位明確編碼，避免文本分隔符歧義。

v0.116.0 的舊 `task-recovery-outbox.json` 在完成時未儲存 leaseToken/generation，並已刪除對應活躍租約；遷移不會憑 attemptId 或舊摘要補造租約。此類結果只在連線憑據認證通過、裝置/賬號/Bot/群/attempt 全部匹配，且 Hub 已持久的終態、報告、錯誤及報告後設資料逐欄位相同時得到冪等正 ACK，不修改結果、租約或觸發下游；不得藉此補寫產物或執行證明。確認後回傳條目原有舊摘要，即使 Hub 已儲存新摘要也能清除此條重放。尚未結算的舊結果因無法證明租約，收到 `legacy_lease_missing` 永久負 ACK；已結算但內容不同使用 `terminal_conflict`，過期 attempt 使用 `attempt_expired`。裝置按原 task/attempt/status/fingerprint 校驗回執後，把完整結果和原因原子寫入 version 2 的持久 quarantine，重啟及重連不再自動傳送該條，連線繼續服務其他任務。`legacy_lease_missing` 表示需要人工恢復核查的失敗：維護者可從隔離記錄取回報告、核驗實際副作用後決定後續處理，不能將其當作任務成功，也不能直接重新執行原副作用。新任務及任何攜帶錯誤或不完整租約的結果仍執行原有 token/generation fencing。

終態接納校驗 task/attempt、Bot/裝置身份與已頒租約 token/generation；舊執行不得覆蓋已停止任務或推進新任務。建立、完成和啟動恢復共用依賴就緒規則：前驅 completed 才可放行，失敗、取消或中斷必須阻塞或級聯終止，不能只檢查“前驅已終態”。未發出租約的 queued 任務可恢復派發；已頒租約但尚未持久 running 的 queued 任務也可能在執行，必須進入認領視窗，不能立即換代重派。視窗到期統一冪等結算，並通知父任務與下游。排隊任務本身作為持久派發意圖，記憶體中的已傳送集合只能防當前程序重複傳送，不能承擔恢復事實源。原始完整報告由獨立 `task-report-outbox.ts` 持久後分塊上傳，結果 ACK 不能誤刪未上傳報告；事件、報告與詳情見 `task-journal.ts` / `task-report.ts`。**審計流空態不是錯誤**：任務存在但從未寫入 journal 分段（排隊中、首個進度事件前失敗、早於日誌功能）時，Hub `GET /tasks/:id/journal` 返回 200 空頁（`items: []`，附加 `journalUnavailable`），只有任務/群不存在才 404；UI 的詳情與日誌必須獨立載入，日誌降級不得清空任務概覽。**本地代理必須透傳 Hub 的已脫敏失敗原因**（`scrubHubMessage` 抹掉已知憑據與令牌樣式串後回傳 `error` + `hubStatus`），禁止把 4xx/5xx 統一塌縮成固定的「Hub rejected group request」。群計劃複用只讀硬閘門，本輪成功 `plan_update` 與最終計劃匹配並獲 Hub 確認後才就緒，人類批准另起實施輪次。畫布繫結與 Bot 預設須校驗真實 graph/cwd 和 registry revision，不以引用自動執行或熱改在途許可權。分塊檔案傳輸的暫存與後臺任務必須繫結 Hub/裝置/群/Bot/revision/真實目錄；停止未確認禁止繼續，雙端實際 I/O fence 確認後才釋放。

## 8. 交付與審查（交付 ≠ 驗收）

群組開發交付獨立於執行狀態：`completed` 不代表驗收通過。交付與審查協議統一在 `server/protocol.ts`，Bot 交付必須繫結自身執行任務、穩定對話及完整提交 SHA；審查繫結交付 ID 與 SHA，禁止 Bot 自審，新版本不得沿用舊版本驗收。檢查來源固定為 `bot_reported`，不得聲稱宿主或 CI 已驗證，不自動執行宣告的命令或合併。人類可啟動獨立整合流水線：目標裝置固定 Bot 工作區建立隔離預合併，顯式選擇驗證命令，最後確認按目標 SHA 原子更新；目標分支在任何工作樹被檢出時拒絕，禁止 hard reset 或自動推送，整合會話與操作代次須持久並繫結 exact delivery/review/Bot revision。交付/審查先持久化，冪等衝突明確拒絕，有界歷史不得靜默淘汰。詳情見 [`device-center.md`](device-center.md)，完整迴歸 `tests/device-project-collaboration-test.mjs`。

## 9. 遠端桌面

裝置中心遠端桌面由 `desktop.ts` 經既有 WebSocket 傳輸原生 JPEG，`desktop-native.ts` 管 Windows/macOS 助手，`desktop-linux.ts` 管 Linux X11（ffmpeg/xdotool）；不再依賴 VNC/noVNC。只讀由服務端按連線強制，瀏覽器繪製 ACK 限制跨裝置待確認幀，斷開須釋放輸入。macOS 14+ 需螢幕錄製/輔助功能許可權，授權申請僅由裝置本機「裝置中心 → 本機遠端桌面」按鈕發起，遠端連線只檢查；`/api/device-desktop/local/*` 禁止經過 Hub/connector 中繼。Wayland 尚不支援；啟用狀態儲存在 `desktop-settings.json`。詳見 [`device-desktop.md`](device-desktop.md)。

## 10. 群組 Webhook 整合

群組支援入站（Incoming）與出站（Outgoing）雙向 Webhook：

- **入站 Webhook**：每個群組可建立多個入站端點，生成獨立的安全 Token。外部系統（如 CI/CD、報警、指令碼）向 `/api/rooms/:id/webhooks/incoming/:webhookId?token=...` 傳送 HTTP POST JSON 請求（支援 `text`、`senderName`、`targetBotIds`、`replyToMessageId`）。若開啟 `allowBotTrigger`（預設），外部訊息按群規則自動分發給顯式提及或主 Bot（`primaryBotId`），喚醒 Bot 執行任務並在群內協作。
- **出站 Webhook**：群組可配置多個外部通知地址，訂閱群事件（`message`、`task_completed`、`task_failed`、`delivery`）。事件產生時異步向外部發送 JSON 載荷；支援配置 `secret`，通過 `X-Pi-Signature: sha256=...` 附帶 HMAC-SHA256 簽名校驗。出站請求帶 5 秒超時保護與異常隔離，不阻斷主流程。
- **Hub 中轉支援**：入站支援切換或配置公共 Hub 中轉地址（`hubRelayBaseUrl`），外部請求由公網 Hub 集中接收並排程給內網裝置上的 Bot；出站 Webhook 支援可選開關 `relayViaHub`，開啟時由 Hub 伺服器作為出口代理代發，關閉時供區域網內網直連模式使用。
- **入站鑑權只認 webhook token**：取值與比對單源在 `server/device-center/hub-webhooks.ts`（`incomingWebhookToken` 支援 query `token` / `Authorization: Bearer` / `X-Webhook-Token` / body `token`，`secureCompareTokens` 定長比較），主 Web app 與 Hub 共用 `isSelfAuthenticatedWebhook` 判定。主 app 的登入閘門只放行這一條精確路徑（`POST /api/rooms/:id/webhooks/incoming/:webhookId`）：外部平臺不可能持有本機口令，把它歸進賬號登入會讓公網回撥恆 401；但也**只能**用這個判定，禁止放寬到整個 `/api/rooms`。守衛：`tests/unit/incoming-webhook-auth.test.ts`。

## 11. 群組獨立 AI Router 與外部工單

群組頂部 **AI Router** 可獨立選擇執行裝置、`provider/id` 模型、思考級別及 `reply` / `dispatch` / `work_items` 工具。Router 理解訊息和排程，Bot 在自身執行約束下完成任務；未啟用時沿用 legacy 主 Bot 協作。Hub 可無 SDK 獨立執行，模型推理由指定裝置的 daemon `ModelRuntime` 提供，不依賴 active session 或專案執行工具。缺少配置、裝置離線或模型不可用時明確報錯。

頂部**工單抽屜**展示有界分頁的最近工單和 Router 執行，業務狀態與多次 Bot 執行獨立。工單、事件、Router jobs、回寫 outbox 由 Hub WAL 持久化，通過業務 revision、凍結計劃、租約 / 配置 fence 和持久動作回執恢復；失敗執行可人工重試。清空群聊 fence 舊 plan 但保留工單，刪除群組清理對應域記錄。

內建渠道模組 Superagent 0.1.3 將 GitHub / 飛書事件接入宿主工單服務並回寫原執行緒。每個外部事件獨立校驗授權，auto 工單不授權未通過作者白名單的 followup；人工授權僅綁定當前最新 `authorizedEventId`。初始工單描述保留，後續事件追加為證據，關閉 / 重開 / 合併事件不自動等於業務完成。飛書支援明文或 AES 加密的簽名 text 回撥，投遞不確定超過 45 分鐘需人工核對；渠道 mock 測試不代表真實渠道已聯通。

統一入口是 **裝置連線與跨平臺協作**：裝置與連線、群組與工單、外部渠道。群組列表內可直接管理 AI Router 和工單；渠道介面內嵌宿主模組，不再增加獨立頂欄按鈕，也不顯示在普通外掛列表、市場或外掛開關中。完整職責、使用步驟、手動恢復、公開 webhook 邊界、分頁 / 上下文預算和恢復語義見 [群組獨立 AI Router 與 Superagent](group-orchestration.md)；渠道配置欄位見 [Superagent README](../plugins/superagent/README.md)。

## 12. 排程分層（Hub 派發 vs 裝置執行）

「同一 Bot 不能併發」是一條共享語義，但兩層負責不同的事，**不是兩套重複佇列，也不應合併**：

| 層         | 模組                                                                | 負責                               | 語義                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hub 派發層 | `server/device-center/hub-task-queue.ts`（純排序在 `bot-queue.ts`） | 決定哪個 `queued` 任務先下發到裝置 | 每 Bot 一個執行位；優先順序 0 人私聊 / 1 群內人訊息 / 2 自動觸發；同優先順序 FIFO；`BOT_QUEUE_MAX_PENDING=12`；中位數 ETA；只喚醒 `blockReason: "bot_busy"` 的任務 |
| 裝置執行層 | `server/device-center/task-scheduler.ts`（`runtime.ts` 持有）       | 決定本地哪些任務真的併發跑         | 4 併發 / 32 等待、工作區重疊鎖、群公平、飢餓提升、停止未確認隔離                                                                                                   |

`bot-queue.ts` 的 `sameBotConflict` 是兩層共用的衝突判定單源：`task-scheduler.ts` 的 `checkConflict` 與 `runtime.ts` 的 `conflicts` 都複用它；`activeTaskForBot` / `rankBotQueue` 只服務 Hub 派發層。Hub 的 `store.subscribe` 觸發 `createBotQueueDispatcher().drain()`，裝置側 `DeviceTaskScheduler.drain()` 是另一條獨立路徑，二者不互相呼叫。

守衛：`tests/unit/hub-task-queue.test.ts`（派發仲裁）、`tests/unit/bot-queue.test.ts`（純排序與 ETA）、`tests/unit/device-center-resource-locks.test.ts`（裝置側鎖）。
