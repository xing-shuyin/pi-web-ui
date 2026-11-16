[English](./app-playbook.en.md) · [简体中文](./app-playbook.md) · **繁體中文**

# 常見桌面軟體操作手冊與最佳實踐（Desktop App Playbook）

> 本文件記錄 `desktop-use` 外掛在操作 Windows 常見軟體（尤其是微信、QQ 等自繪介面與複雜多視窗應用）時的操作範式、避坑指南與跨回合穩定性規範。

---

## 1. 核心穩定性鐵律（必讀）

### 鐵律 1：跨回合/使用者確認後「必先重新 Focus」

- **現象**：當 AI 呼叫 `ask_user_question` 彈出問卷彈窗讓使用者確認，或者使用者在瀏覽器聊天介面進行了點選後，**系統的當前前臺視窗（Foreground Window）必然變成了瀏覽器**。
- **後果**：如果此時直接呼叫 `desktop_key(keys="enter")`，按鍵事件會被派發到瀏覽器（或被當前焦點的網頁元素吃掉），目標軟體根本收不到！
- **正確做法**：**在任何需要向目標軟體傳送按鍵、輸入或點選的操作之前，無條件先呼叫一次 `desktop_window(action="focus", title="...")`**。

### 鐵律 2：自繪介面「能用貼上就別盲點座標」

- **現象**：微信、QQ 等採用 Qt / 自繪引擎的應用，輸入框在視窗獲得焦點時通常**預設處於啟用狀態（游標閃爍）**。
- **風險**：如果盲目傳入猜想或縮放有偏差的座標（`shot+x+y`）去「先點再輸」，一旦座標偏移點在輸入框外，反而會把原本已經聚焦的輸入框打成失焦！
- **正確做法**：
  1. 先 `desktop_window(action="focus", title="...")` 啟用視窗；
  2. 直接呼叫 `desktop_type(text="...")`（不傳 x/y，內部自動通過剪貼簿貼上 + Ctrl+V）；
  3. 截圖複查，如果發現確實未聚焦，再通過 `desktop_screenshot` 觀察實際游標或輸入框位置後精確點選。

### 鐵律 3：多顯示器與 DPI 縮放防護

- 多顯示器環境下可能存在負座標（如副屏在主屏左側時 X < 0）。
- 外掛的 `input.ps1` 與 `screenshot.ps1` 均已開啟 `SetProcessDpiAwareness(2)` 並採用 `MOUSEEVENTF_VIRTUALDESK` 虛擬螢幕座標歸一化，嚴禁在外部自行做錯誤的整數取整或忽略 DPI 縮放。

---

## 2. 軟體專章：微信 (WeChat / Weixin)

### 軟體特徵

| 屬性         | 說明                                                                                            |
| :----------- | :---------------------------------------------------------------------------------------------- |
| **程序名**   | `Weixin.exe`                                                                                    |
| **視窗類名** | `Qt51514QWindowIcon`                                                                            |
| **視窗標題** | 動態變化，通常是**當前登入使用者的微信暱稱**（如「邢書印」）                                    |
| **UI 架構**  | Qt 自繪介面；`desktop_elements` (UI Automation) 只能列舉到外層容器，**內部控制元件無 UIA 節點** |
| **互動通道** | 截圖流（`desktop_screenshot`）+ 剪貼簿貼上（`desktop_type`）+ 頂層按鍵（`desktop_key`）         |

### 標準操作流程（發訊息範式）

```
[1. 啟用微信視窗]
  desktop_window(action="focus", title="<使用者暱稱或Weixin>")

[2. 截圖確認當前會話]
  desktop_screenshot(process="Weixin")
  - 檢視左側聊天列表或上方會話標題是否為目標物件（如「檔案傳輸助手」）
  - 若不是：在搜尋框或聊天列表對應位置點選切換

[3. 輸入訊息內容]
  desktop_type(text="要傳送的內容")
  - 注意：微信輸入框預設是啟用的，直接 type 會通過剪貼簿貼上，無需傳 x/y

[4. 截圖複查輸入框]
  desktop_screenshot(process="Weixin")
  - 確認文字已在輸入框內，右下角「傳送」按鈕變為綠色

[5. 涉及不可逆操作：向用戶確認]
  ask_user_question(...) 提示使用者即將傳送的內容與目標物件

[6. 使用者確認後的傳送步驟（核心！）]
  a. desktop_window(action="focus", title="<使用者暱稱>")  <-- ★ 必須重新聚焦！
  b. desktop_key(keys="enter")                           <-- 傳送訊息
  c. desktop_screenshot(process="Weixin")                <-- 截圖驗證氣泡上屏
```

### 常見問題與排查

1. **Q: 為什麼按了 Enter 沒有傳送？**
   - **A**: 檢查前一步是否有彈窗或瀏覽器互動。若有，必須在 `enter` 前執行 `desktop_window(action="focus")`。另外檢查微信設定中「傳送快捷鍵」是否為 Enter（預設 Enter 傳送，Ctrl+Enter 換行）。
2. **Q: 為什麼輸入的文字漏掉了或亂碼？**
   - **A**: `desktop_type` 會自動識別中文並使用系統剪貼簿貼上；確保執行時微信處於前臺且輸入游標處於閃爍態。

---

## 3. 軟體專章：QQ / 釘釘 / 飛書

- **QQ (QQ.exe)**：NT 架構（Electron 自繪）。輸入框同樣在視窗聚焦時保持啟用，操作邏輯與微信基本一致。
- **釘釘 (DingTalk.exe)** / **飛書 (Feishu.exe)**：Electron 架構。若 UIA 能列舉到部分輸入框可優先用 `dump+id`，若列舉為空殼則完全遵循微信的截圖+貼上流程。

---

## 4. 軟體專章：瀏覽器 (Chrome / Edge)

- **UI 架構**：支援 UI Automation（需開啟無障礙/具有輔助功能支援）。
- **位址列/標籤頁**：
  - 切換標籤頁：`desktop_key(keys="ctrl+tab")` 或 `ctrl+1`..`ctrl+9`。
  - 開啟新標籤：`desktop_key(keys="ctrl+t")`。
  - 聚焦位址列：`desktop_key(keys="ctrl+l")` 或 `desktop_key(keys="alt+d")`。
  - 網頁內查詢：`desktop_key(keys="ctrl+f")`。

---

## 5. 軟體專章：Windows 終端 / 命令提示符

- **Windows Terminal (wt.exe)** / **cmd.exe** / **powershell.exe**：
  - 聚焦後可直接通過鍵盤傳送按鍵，但需注意如果處於選擇模式（游標變為白塊/暫停輸出），需按 `esc` 或 `enter` 解除。
  - 貼上到終端建議使用 `desktop_key(keys="ctrl+shift+v")` 或 `desktop_type`。
