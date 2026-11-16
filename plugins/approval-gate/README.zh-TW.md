[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 定時任務拍板中心 (Approval Gate)

面向定時任務、後臺批處理及外部呼叫的非同步待辦拍板中心外掛。

> **架構概念辨析**：
> 本外掛為**非同步任務決策臺賬**（定時任務發現待辦事項後登記，人工在介面集中查閱並跳轉會話處理）；
> 智慧體執行時的高危工具即時呼叫攔截、彈窗放行、白名單記憶管理與決策流日誌屬於服務端**內建安全能力**（`server/tool-approval.ts`），不依賴本外掛。

## 功能特性

1. **集中待辦臺賬**：頂欄「拍板」選項卡與紅點徽標展示待拍板數量，聚合所有未決事項。
2. **通用 CLI 工具**：提供命令列工具 `bin/approval-gate.mjs`，供任意 Cron 指令碼或自動化任務一鍵登記。
3. **會話聯動與自動清賬**：
   - 登記時關聯指定 `conversationId`；
   - 點選待辦項一鍵切入該會話進行審查；
   - 支援 `--auto-session` 模式：先登記待辦項，自動由 `pi -p` 啟動快照會話生成提示模板，使用者在會話內拍板後自動清賬。
4. **安全鑑權**：CLI 通過 HTTP 請求頭（`x-pi-token` / `Authorization: Bearer`）安全傳遞鑑權口令，杜絕在 URL 查詢串中洩露 Token。

## CLI 用法

```bash
# 登記普通拍板項
approval-gate register --task "每日備份檢查" --title "發現 3 個過期未歸檔映象，是否清理？" --project /path/to/project

# 自動建立快照會話並聯動
approval-gate register --task "依賴安全告警" --title "發現 CVE-2026-xxxx" --auto-session "請審查依賴漏洞並評估升級方案"

# 檢視待辦列表
approval-gate list --pending

# 標記完成或忽略
approval-gate resolve --id apv-xxx --status resolved
approval-gate resolve --id apv-xxx --status dismissed
```
