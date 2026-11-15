[English](./daily-ai-maintainer-setup.en.md) · [简体中文](./daily-ai-maintainer-setup.md) · **繁體中文**

# 每日 GitHub 維護畫布

已儲存工程並啟用每日任務，未立即執行。

- 工程名稱：每日 GitHub Issue 與 PR 維護。
- 工程 ID：`graph_1793377347784_-GitHub-Issue-PR-`。
- 定時任務 ID：`task-pdjues`，cron `0 9 * * *`，已啟用。
- 已核對本機時區為 `Asia/Shanghai`，每天北京時間 09:00；下次 2026-10-31 09:00。
- 共 8 個節點、7 條依賴邊。舊工程及舊任務已刪除。

節點順序：啟動核對 → GitHub 完整收集 → 分類排優先順序 → PR 靜態審查與實現 → 獨立逐行復核 → 組合產物實際驗證 → 單一合併釋出與回覆 → 狀態歸檔。

範圍僅為 GitHub Issue、PR、審查與評論，以及相關 npm/GitHub Release 釋出。不需要其他社群平臺的連線或許可權。

節點目錄為 `E:/pi-web-ui`，引擎為 pi，模型留空以跟隨預設配置。實現、複核、驗證節點啟用隔離工作樹，源基線必須乾淨。第三方程式碼執行仍需容器或虛擬機器；工作樹隔離不能替代執行沙箱。

首次執行核對 GitHub 許可權、倉庫外私有狀態目錄、可靠鎖和隔離執行環境；缺失能力時報告阻塞，不能偽造驗證通過。對外寫操作集中於釋出節點，連線完成不代表可以跳過審查和保護規則。

備份工程為 `daily-ai-maintainer.canvas.json`，可通過畫布匯入 JSON 恢復；匯入會生成新 ID，恢復時須重新繫結定時任務，避免重複啟用。完整規範見 `../daily-ai-maintainer-workflow.md`，並已內嵌節點指令。
