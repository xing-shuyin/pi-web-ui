[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 📬 webmail —— pi-web-ui 網頁郵箱外掛

在 pi-web-ui 介面裡提供一個完整的郵箱管理檢視（頂欄 📬 標籤頁）：
IMAP 收件 + SMTP 發信 + 新郵件通知，還可以把郵箱開放給 AI 直接管理。

## 功能

- **收件箱**：瀏覽 / 關鍵詞搜尋（主題、發件人、收件人）/ 閱讀完整正文 /
  標記已讀未讀 / 刪除郵件 / **一鍵翻譯**（中英雙語互譯、支援選擇 AI 模型、原文對照、複製譯文）/ **引用郵件到對話**（一鍵將郵件注入主聊天輸入框）
- **發信**：SMTP 發信，支援純文本與 **HTML 正文**（`multipart/alternative`，自動攜帶純文本降級），支援抄送
- **新郵件通知**：週期輪詢 INBOX 未讀數，發現新郵件經 `host.notify` 彈通知條
  （輪詢間隔可配，預設 60s）
- **AI 管理郵箱**：依賴裝好後註冊一個 action 式 `mail` 工具（`action` =
  `list` / `read` / `search` / `send` / `manage` / `folders`），支援傳送 HTML 郵件與純文本郵件，對話裡直接說
  「看看最近有什麼郵件」即可；要下架就在設定 →「工具」頁的「註冊的 AI 工具」
  分組裡逐條關（依賴沒裝齊時工具不註冊）

## 配置

設定面板存 `<dataDir>/plugins/webmail/config.json`（本機檔案，與 pi
auth.json 同級安全模型；密碼見下，優先走加密機密）：

| 欄位                 | 說明                             |
| -------------------- | -------------------------------- |
| IMAP 主機 / 埠 / TLS | 收件伺服器（如 imap.qq.com:993） |
| SMTP 主機 / 埠 / TLS | 發件伺服器（如 smtp.qq.com:465） |
| 使用者名稱 / 密碼    | 郵箱賬號與密碼或授權碼           |
| 輪詢間隔 pollSec     | 未讀檢查週期，預設 60s           |

配置回顯脫敏：只返回 `hasPass` 是否存在，密碼不回傳瀏覽器。

密碼優先存宿主的加密機密（`host.secrets`，AES-256-GCM →
`<dataDir>/plugin-data/webmail/secrets.bin`），寫入成功後 config.json 裡的 `pass` 為空。
舊版宿主沒有機密設施、或機密寫盤失敗（目錄只讀 / 磁碟滿）時，密碼會
回退為明文寫進 config.json 並提示一次——寧可明文，也不能儲存後丟密碼。

## 安裝 / 解除安裝 / 更新

```bash
# ── 安裝 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail
pi-web-ui install plugins/webmail        # 或本地目錄（開發態）
# 可選：--data-dir <dir> 自定義資料目錄（預設 ~/.pi-web）

# ── 檢視 ──
pi-web-ui plugins                            # 列出已裝外掛與 id

# ── 更新 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail --force
                                             # --force 覆蓋重灌即更新
                                             # ⚠ 先備份外掛目錄裡的 config.json（賬號憑據）

cp -r plugins/webmail ~/.pi-web/plugins/ # 本地開發態：直接複製覆蓋
                                             # Windows: %USERPROFILE%\.pi-web\plugins\webmail

# ── 解除安裝 ──
pi-web-ui uninstall webmail                  # 移除外掛目錄（config.json 一併刪除）
# 手動方式：rm -rf ~/.pi-web/plugins/webmail
```

重新整理瀏覽器即生效。依賴 imapflow / mailparser / nodemailer **不隨包分發**：
首次啟用自動 npm 補裝到外掛目錄，失敗可在視圖裡點「安裝依賴」手動觸發。

## 迴歸測試

- `tests/unit/plugin-tools.test.ts`：同步 diff + 註冊生命週期（vitest）
- `tests/unit/webmail-secrets.test.ts`：密碼持久化（機密可用時只進機密、寫盤失敗
  回退明文、二次儲存留空則沿用已存密碼）
