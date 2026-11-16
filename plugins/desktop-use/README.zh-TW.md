[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 桌面控制（desktop-use）🖱️

讓 AI 操作 **Windows / macOS 桌面**：通過系統原生無障礙介面定位控制元件，自繪介面通過視窗截圖與離線 OCR 定位。Windows 輸入走 nut-js（自動安裝），PowerShell 兜底；macOS 使用本外掛內建的 Swift 原生後端，不依賴外部外掛或第三方輸入庫。

## macOS 準備與邊界

- 需要 macOS 12+ 與 Apple Command Line Tools（`xcode-select --install`）。首次呼叫通過系統 `xcrun swiftc` 編譯隨外掛提供的原始碼，快取到當前使用者臨時目錄；不下載可執行程式。
- 在「系統設定 → 隱私與安全性 → 輔助功能」允許啟動服務的宿主（如 Terminal 或 Electron 桌面應用）；截圖和 OCR 另需「螢幕錄製」許可權。授權後可能需要重啟宿主。外掛只檢查許可權，不主動彈出系統授權。
- 控制元件查詢使用 Accessibility，截圖使用 CoreGraphics，離線 OCR 使用 Vision；視窗截圖按實際畫素縮放後換算螢幕邏輯座標，支援 Retina。
- `desktop_key` 支援 `cmd+c` / `command+c` / `meta+c`（對映 Command），`option` 對映 Alt；`ctrl` 保留 Control 語義。
- 中文和 emoji 通過原生 Unicode 鍵盤事件輸入，不改剪貼簿。點選、輸入、快捷鍵、滾動和拖拽會影響當前滑鼠/鍵盤與焦點，**不是隔離後臺桌面**；不承諾操作非當前 Space 或最小化應用。
- 當前 Windows 開發環境只能驗證 JS 路由和協議，Swift 編譯、系統授權、多屏與目標應用互動需在 Mac 上驗收。

## 裝與卸

- **安裝**：`pi-web-ui install <倉庫>/plugins/desktop-use`（或把本目錄拷到 `<dataDir>/plugins/desktop-use/`）。裝完服務端熱重掃自動啟用。
- **Windows 依賴自動裝**：輸入庫 `@nut-tree-fork/nut-js` 不在安裝包裡，啟用後外掛**後臺自動 `npm install`**（目錄鎖防併發 + 10 分鐘看門狗 + 頂欄通知進度，db-client 同款）。裝好前點/輸類工具報“安裝中稍後”，**查元素不受影響**（純 PowerShell，零依賴）。
- **解除安裝**：`pi-web-ui uninstall desktop-use` 即刪整目錄，`node_modules` 在裡面，**依賴一起消失**，不留東西。手動裝失敗時按通知裡的命令在外掛目錄手裝一次即可。

## AI 工具（8 個，設定 → 外掛工具裡可逐個關）

| 工具                 | 幹什麼                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `desktop_elements`   | 無截圖查控制元件：`scope=foreground/desktop/window` + `query`過濾，返回 `dump` 快照 key + `id` 列表（90 秒有效）                           |
| `desktop_click`      | 點元素：① 按 `dump+id` 點 UIA 元素中心；② 截圖流：傳 `shot+x+y`（畫素座標）或 `shot+text`（直接按 OCR 識別文字點選）；左/右/中鍵、雙擊可選 |
| `desktop_type`       | 打字；中文/emoji 自動走剪貼簿貼上；支援 `shot+click_text`（按 OCR 文字先點聚焦）或 `shot+x+y` 或 `id` 先點再輸                             |
| `desktop_key`        | 按鍵，如 `enter` / `ctrl+c` / `alt+F4` / `win+r`                                                                                           |
| `desktop_window`     | `list` 列頂層視窗 / `focus` 按標題子串頂到前臺                                                                                             |
| `desktop_screenshot` | 按視窗截圖：返回圖 + 視窗左上角螢幕座標與縮放比 + **圖內文字 OCR 識別與確切座標**（自繪介面互動入口）                                      |

| `desktop_scroll` | 在 `shot+x+y/text` 或 `dump+id` 位置滾動，支援四方向，`amount=1–100`（預設 3 格） |
| `desktop_drag` | 同一張新截圖中從 `x+y` 拖到 `to_x+to_y`，`duration_ms=100–2000`（預設 500ms）；完成後重查 |

約定：**先查後點**，id 不猜、不復用過期快照；關閉/刪除/提交/付款先向使用者確認。

## 自繪介面互動（截圖流 + OCR 文字識別，微信已驗證）

`desktop_elements` 看不到的介面（微信/QQ/遊戲）走這條：

1. `desktop_screenshot`（`process=Weixin` 或 `dump+id`）→ 拿到圖 + `shot` key + 視窗左上角 + **圖內文字 OCR 識別清單（含精確矩形與中心座標）** + **當前滑鼠指標位置**（圖裡畫出真實指標並附帶座標，可確認上次落點）
2. **定位方式（雙通道）**：
   - **方式 A（文字直接點，最推薦）**：`desktop_click` 直接傳 `shot="s1"` + `text="傳送"`，外掛自動在 OCR 結果中匹配文字中心並換算點選，無需手算座標。同名匹配會報出候選座標，需傳 `occurrence=1/2/…`（按 OCR 清單順序）明確選擇；`desktop_type` 的 `click_text` 也支援此引數。OCR 可能誤識別，點選前應核對截圖。
   - **方式 B（畫素座標點）**：看 OCR 返回的文字列表中的 `中心 (cx, cy)`，或看圖自選畫素 `{x, y}`，傳 `desktop_click(shot="s1", x=cx, y=cy)`。
3. **輸入文字**：直接調 `desktop_type` 傳 `shot="s1"` + `click_text="搜尋"`（或 `x+y`）+ `text="張三"` → 外掛自動**一步完成**：先點選目標文字中心聚焦，等待 250ms 後立即輸入（中文走剪貼簿貼上、英文走鍵盤），**避免分兩步呼叫因跨回合切回瀏覽器導致視窗失焦、文字漏輸**。

截圖 90 秒內有效（視窗挪走就重截）。實現細節：

- 系統原生支援 Windows 10/11 內建的 `Windows.Media.Ocr`（WinRT API），完全離線、零外部依賴、耗時僅 ~150ms。
- PrintWindow `flags=2` 才能截出 Qt 內容（`flags=0` 是黑圖）；空白檢測只看中央 80%（邊框會抬高整圖方差）；被遮擋也能截，截出空白才需要先 `focus` 到前臺。

## 找視窗：認程序，不認標題

很多應用的視窗標題是會變的（微信主視窗標題就是你的暱稱），`desktop_window list` 和
`desktop_elements scope=window` 因此都支援按**程序名**找：

- 微信：`process=Weixin`（老版 `WeChat`），視窗類 `Qt51514QWindowIcon`
- 瀏覽器：`process=msedge` / `chrome` / `firefox`

## 侷限

- 僅 Windows（`process.platform !== win32` 時工具直接報錯）。
- 微信這類 Qt/自繪應用：視窗可定位，內部元素可能在 UIA 樹裡不可見。內建 WinRT OCR 可輔助定位可見文字，識別質量受字型、縮放和對比度影響；無文字按鈕仍需看圖定位。
- 純圖示按鈕（沒有文字且 UIA 為空的極少數情況）：走截圖流圖內畫素 `{x, y}` 點選，並可參考圖內畫出的滑鼠指標位置進行校準。
- 自繪介面（遊戲、Canvas、部分 Electron 自繪區）在 UIA 樹裡是空的——這類目標現在也可以直接通過 OCR 文字定位互動。
- 中文輸入依賴剪貼簿：輸入期間不要切走焦點；傳定位引數時會先點目標，未傳則輸入當前焦點。粘貼後等待目標讀取再恢復原文本剪貼簿；圖片等非文本內容暫不能恢復。
- 截圖座標必須位於圖內；視窗移動、遮擋或內容變化後應重新定位，90 秒有效期不代表介面期間保持不變。
- 拖拽一旦按下滑鼠，會在最多約 2.2 秒內完成並釋放，再響應取消，避免強殺輔助程序留下按住狀態。

## 實現參考

0.4.0 參考 [Windows-MCP](https://github.com/cursortouch/windows-mcp) 的輸入工具設計，獨立實現四方向滾動和有時長邊界的拖拽；未引入 Python/MCP 依賴，也未複製上游原始碼。修復快捷鍵未釋放、OCR 重名預設點選第一處與截圖越界座標問題。
