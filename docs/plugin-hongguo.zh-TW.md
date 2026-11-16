[English](./plugin-hongguo.en.md) · [简体中文](./plugin-hongguo.md) · **繁體中文**

# hongguo 外掛

`plugins/hongguo/` 是 [frostming/dsh-hongguo](https://github.com/frostming/dsh-hongguo) 的 pi-web-ui 移植，使用 [openhongguo](https://github.com/beilunyang/openhongguo) `0.1.0` 訪問匿名短劇介面。通過頂欄「hongguo」開啟，支援劇名搜尋、演員搜尋與參演作品、選集、續播、觀看記錄、播放速度、自動下一集、下一集預載入和瀏覽器畫中畫。

## 安裝與使用

開發環境從倉庫根目錄執行：

```bash
node scripts/link-plugins.mjs hongguo
```

在設定中重新載入外掛，然後點選頂欄「hongguo」。釋出到遠端目錄後，也可從外掛市場安裝。執行時首次訪問會通過宿主 `ensureDeps` 安裝外掛獨立的 `openhongguo@0.1.0`，根專案依賴不變。

播放器提供兩種模式，點選頂部按鈕即時切換：

- **懸浮**：拖動標題欄移動視窗；拖動四邊或四角調整大小；播放中可切換精簡檢視，精簡視窗的寬高獨立記憶並且同樣支援縮放。
- **分屏**：寬度至少 800px 時位於右側，拖動左邊緣調整寬度；窄屏自動改為上下分屏，拖動上邊緣調整高度。

搜尋框左側可選擇「劇名」或「演員」。演員搜尋使用平臺的使用者搜尋頁，點選姓名後加載參演作品，再選擇短劇和劇集；搜尋結果可能含普通賬號，沒有公開劇作時顯示空列表。演員作品和搜尋結果均支援「載入更多」。

「預載下一集」預設開啟，與「自動連播」獨立。當前集開始播放後，只提前下載並轉碼緊接的一集，成功時顯示「下一集已就緒」。切集複用已經完成的 H.264/AAC 快取；若任務仍在進行，播放請求等待同一個任務，不重複解析、下載或轉碼。關閉、換集或取消預載會中止瀏覽器等待；服務端已經開始的處理可以完成並進入有限快取，解除安裝外掛會中止任務。

分屏通過穩定的 `dom.anchors().app` 掛載點和可恢復的內邊距預留空間。視窗只使用外掛自己的樣式，不查詢宿主內部類名。佈局切換不移動或重新建立 `<video>`，切換對話也會繼續播放。關閉視窗暫停影片、退出畫中畫並釋放分屏空間；再次開啟後點擊原生播放按鈕即可繼續。

## FFmpeg 與播放限制

MP4 統一由服務端呼叫 FFmpeg 輸出為 **H.264 Main / yuv420p + AAC-LC**，避免 HEVC / H.265 在部分瀏覽器或桌面核心中只有聲音、進度正常卻沒有畫面。CENC 加密劇集使用 openhongguo 返回的內容金鑰，在同一次處理裡解密並轉碼。影片保持縱橫比，最長邊最多 1280 畫素；音訊統一為 AAC-LC。CDN 的 HEIC 封面也通過 FFmpeg 轉換成 JPEG。安裝 FFmpeg 後保持其位於 PATH，或在設定 → 外掛 → hongguo 中填寫 **FFmpeg 路徑**。路徑作為獨立執行檔引數傳給 `execFile`，不經過 shell。Windows 的 WinGet 連結目錄以及常用 macOS / Linux 安裝路徑也會自動探測。

播放器開啟時檢測 FFmpeg，有缺失時顯示提示。處理任務延遲到實際影片請求發生，首次播放需要等待下載和轉碼，完成後複用快取。MP4 播放不再依賴客戶端的 HEVC 解碼能力。匿名服務的限流、地區可用性、內容下架和網路問題由上游決定。

原生 MP4 由瀏覽器播放，HLS 使用瀏覽器原生支援或隨附 mpegts.js，DASH 使用隨附 dash.js。DASH 的 BaseURL / SegmentBase 格式走同源代理；SegmentTemplate 格式會明確返回不支援，避免生成無效的地址。

## 資料與生命週期

- 瀏覽器 `pi-web-ui:hongguo:prefs:v1` 儲存佈局、位置、視窗尺寸、音量、倍速、自動連播和下一集預載偏好；`pi-web-ui:hongguo:history:v1` 儲存最近 30 部劇的集數、時間點和標題。進度每約 4 秒及暫停 / 關閉時儲存。已播完的集數再次開啟從頭播放。
- 服務端 `<dataDir>/hongguo/anonymous.json` 儲存匿名裝置檔案，按使用者私有檔案許可權原子寫入。`media/` 最多保留最近 12 集已處理影片，相容快取使用 `<episodeId>.h264-aac-v1.mp4`；舊 `<episodeId>.mp4` 快取自動轉碼，無需重新下載或獲取金鑰。播放 URL 帶 `?format=h264-aac-v1`，防止瀏覽器複用舊 HEVC 響應。`covers/` 最多保留 300 張轉換後的封面。影片只快取到宿主資料目錄，不寫入原始碼 / 外掛目錄。
- 內容金鑰只保留在服務端。客戶端通過同源 `/plugins-api/hongguo/*` 地址播放，未加密流媒體的上游地址作為代理查詢引數傳遞。播放介面和 HLS / DASH 清單中的代理地址使用相對路徑，以支援應用子路徑反向代理。
- 外掛只申請 `ui`、`http`、`dom:anchor`。瀏覽器只訪問同源 HTTP 路由；服務端限定 CDN 域名，每次重定向重新校驗，拒絕憑據、非標準埠和可執行的上游內容。
- `client/entry.mjs` 將宿主過載紀元的查詢引數傳遞給 `player.mjs`，後者繼續傳遞給 `styles.mjs` / `state.mjs`，確保重新載入外掛時不會複用舊手柄樣式或尺寸邏輯。
- `client/entry.mjs` 預設匯出 `dispose()`。宿主在停用、移除、報錯、epoch 過載和過期非同步載入時清理常駐例項：暫停 / 釋放媒體、取消請求、移除事件 / 觀察器 / 浮層並恢復宿主樣式。服務端解除安裝會中止媒體請求和 FFmpeg 子程序，路由由宿主自動登出。

## 介面與事實源

| 路由（相對 `/plugins-api/hongguo`） | 返回 / 行為                                              |
| ----------------------------------- | -------------------------------------------------------- |
| `GET /config`                       | `{ ffmpegAvailable }`                                    |
| `GET /list`                         | `{ items }`，推薦內容快取 15 分鐘                        |
| `GET /search?q=&type=actor&cursor=` | `{ items, cursor, hasMore }`                             |
| `GET /actors/works?id=&cursor=`     | `{ person, items, cursor, hasMore }`，演員資料與參演作品 |
| `POST /preload?episode=`            | 下載並轉碼下一集，返回 `{ episodeId, ready }`            |
| `GET /series?id=`                   | `{ series, episodes }`                                   |
| `GET /play?episode=`                | `{ episodeId, duration, streams }`；不返回內容金鑰       |
| `GET /media/<episodeId>`            | 處理並快取 MP4，支援 Range / 206 / 416 和拖動進度        |
| `GET /stream?u=`                    | 受限 CDN 代理；重寫 HLS / DASH 清單                      |
| `GET /cover?u=`                     | 受限封面代理，必要時轉換 HEIC                            |

服務端：`plugins/hongguo/index.mjs`、`lib/media.mjs`。客戶端：`client/player.mjs`、`client/state.mjs`、`client/styles.mjs`。入口：`manifest.json`、`client/entry.mjs`。宿主常駐生命週期：`web/src/plugin-loader.ts`。

## 來源與驗收

移植參考 dsh-hongguo v1.2.1，保留上游歸屬；原倉庫沒有提供根許可證，本移植沒有為上游原始碼另行宣告許可證。隨附播放器庫保留原檔案及許可證：`client/vendor/LICENSE-mpegts.js.txt`、`LICENSE-dashjs.md`、`LICENSE-dashjs-third-party.txt`。openhongguo 為獨立 npm 依賴，許可證隨其包分發。內容版權歸相應權利人。

```bash
npm run typecheck
npx vitest run tests/unit/hongguo-server.test.ts tests/unit/hongguo-client.test.ts tests/unit/plugin-preload-dispose.test.ts tests/unit/plugin-loader-scope.test.ts
```

測試覆蓋 CDN / 重定向邊界、播放金鑰隔離、MP4 快取與 Range、搜尋與選集、佈局切換保留影片、觀看進度、自動下一集、銷燬後的非同步結果，以及停用 / 過載常駐模組的清理。
