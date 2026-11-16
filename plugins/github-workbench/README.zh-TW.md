[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# GitHub 工作臺

在右側「檔案列表」旁的「工作臺」Tab 集中處理 PR 和 Issue，與對話並排使用。複用服務所在機器的 GitHub CLI 登入，無需另填 Token。

## 使用

1. 在執行 pi-web-ui 服務的機器安裝 [GitHub CLI](https://cli.github.com/)，執行 `gh auth login --hostname github.com`。
2. 在外掛市場安裝「GitHub 工作臺」。本地開發安裝：`node bin/pi-web-ui.mjs install ./plugins/github-workbench --data-dir <實際資料目錄>`。安裝後重新整理外掛列表。
3. 點選右側「檔案列表」旁的 **工作臺** Tab。自動識別開啟工作臺時的專案倉庫；不在 Git 倉庫裡也能使用個人待辦。
4. 選擇倉庫待辦、待我評審、分配給我、我建立的、提到我或自定義搜尋。通過「全部 / PR / Issue」切換型別，點選搜尋圖示展開搜尋條件。個人分類同樣受倉庫輸入框限制；清空倉庫可跨倉庫查詢。
5. 窄側欄中點選條目進入詳情，點選「返回列表」繼續瀏覽；側欄拉寬至 480px 後自動並排顯示列表和詳情。切換檔案列表與工作臺時保留篩選、頁碼、選中條目、滾動位置和評論草稿。

搜尋支援 GitHub 搜尋語法，例如 `is:pr draft:false`、`is:issue label:bug`、`is:closed`。預設分類已限定未關閉條目，查詢歷史狀態請選「自定義搜尋」。搜尋按更新時間倒序，每頁 50 條，最多瀏覽 GitHub 搜尋允許的前 1000 條。未完整返回的搜尋會提示縮小範圍。

## 操作

- **檢視詳情**：點選條目，檢視正文、標籤、最近一頁評論。PR 同時展示源／目標分支、草稿及合併狀態、檔案改動統計和待評審人。正文按純文本顯示，保留 Markdown 源文；完整 diff、CI 與程式碼行評審通過 GitHub 連結檢視。
- **引用到對話／交給 AI 處理**：在當前對話新增簡短引用附件，例如 `PR #749 · owner/repo`，附上 GitHub 連結，然後切回對話。處理要求由使用者填寫併發送；保留已有正文和附件，重複點選同一條目會去重。
- **發表評論**：輸入支援 Markdown 的評論並點擊發布，以當前 `gh` 賬號發到所選條目。失敗保留草稿；切換條目、切迴文件列表後仍分別保留草稿。草稿僅在當前頁面記憶體中儲存，重新整理頁面或過載外掛後清空。釋出中切換 Tab 會等待原操作完成，避免重複提交。網路中斷時先在 GitHub 確認是否已經發布，再重試。
- **關閉／重新開啟**：修改所選 PR／Issue 的狀態。已合併 PR 不提供重新開啟按鈕。列表會更新狀態，重新搜尋後按條件篩選。

## 實現約定

- 後端只有 `GET /status`、`GET /items`、`GET /detail`、`POST /comment`、`POST /state`，均掛在宿主已鑑權的 `/plugins-api/github-workbench` 下。客戶端從 bundle URL 保留應用根路徑。
- `gh api --hostname github.com` 通過非同步子程序執行，無 shell、無互動提示；寫入內容用 JSON stdin，不拼接評論到命令列。GitHub Enterprise 暫不支援。
- 倉庫、編號、狀態、評論、搜尋長度、分頁均在服務端校驗。請求限時 25 秒、輸出上限 4 MiB，解除安裝時結束子程序；詳情正文和評論有長度上限並顯式標註截斷。
- 使用現有 `compose` 宿主橋新增 `mode: "quote"` 附件，引用僅包含型別、編號、倉庫和連結；AI 可按使用者要求讀取最新詳情。當前會話不可用時顯示錯誤，不自行建立會話。
- 外掛版本 `0.1.4`，不新增 npm 依賴。許可權僅為 `ui` 和 `http`。通過 `rightpanel.tabs` 註冊帶 GitHub SVG 圖示的工作臺 Tab；客戶端的 `styles.mjs` 使用宿主主題變數及容器查詢，不依賴瀏覽器視窗寬度。

定向驗證：`npx vitest run tests/unit/github-workbench.test.ts tests/unit/github-workbench-client.test.ts`。
