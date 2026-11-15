[English](./hub-upgrade-release-testing.en.md) · [简体中文](./hub-upgrade-release-testing.md) · **繁體中文**

# Hub 釋出包升級驗收

釋出前測試應安裝 npm 將要交付的 `.tgz`，從已釋出的 Hub 升級到該包，並使用真實的系統服務和瀏覽器。只在原始碼目錄啟動服務或單測中模擬 `/health`，不能證明打包內容、安裝路徑、npm 依賴和服務重啟正確。

## 本地執行

```bash
node scripts/prepare-hub-release.mjs
node tests/hub-upgrade-release-test.mjs --candidate /absolute/path/pi-web-ui-VERSION.tgz --baseline pi-web-ui@0.117.0 --output /absolute/path/results
```

第一條命令將當前原始碼複製到獨立臨時目錄，完整執行釋出構建，再執行 `npm pack --ignore-scripts`，不覆蓋正在使用的工作區 `dist/`。構建使用當前工作區已安裝的依賴；CI 使用乾淨 `npm ci` 構建同一個候選包。可通過 `PI_HUB_TEST_TMP` 指定臨時目錄（Windows 開發環境建議 `E:/tmp`）。

第二條命令會安裝候選包與指定 npm 公開版本，用真實服務管理器執行舊版本，再升級到候選包。它使用唯一的 `pi-device-hub-smoke-<隨機值>` 名稱、獨立服務配置和資料目錄，結束後解除安裝測試服務，不改動預設 Hub。首輪基線啟動使用候選 CLI 生成隔離名稱的服務定義，服務入口和執行程式碼來自實際公開包；格式與舊版本安裝的定義相同。需要 npm registry 網路、可用的使用者服務會話、服務管理許可權和 Chromium/Chrome。已有 Chrome 會自動檢測；否則執行 `npx playwright-core install chromium --with-deps`。

可以傳 `--background` 後臺執行並檢視輸出目錄的 `acceptance.log`、`commands.log` 和 `result.json`。指令碼返回結果或 `result.json` 的終態為 `passed` 才算通過。失敗時保留安裝目錄和診斷資訊；清理服務失敗也會使驗收失敗。

## 實際驗證的行為

1. 安裝準確的候選 tarball 和公開版本依賴，檢查真實包內容及獨立 Hub 啟動。
2. 通過真實 OS 服務啟動公開版本，建立賬號、配對裝置、同步 Bot 並建立群組。
3. 用候選 CLI 將舊服務升級到候選包，檢查例項 ID、登入 Cookie、裝置和群組仍存在。相容舊版不含版本/啟動標識的健康介面。
4. 用真實 Chromium 點選網頁「一鍵升級」，繫結本次 POST 返回的新任務 ID，經過真實 npm 安裝、獨立更新任務、服務停止和重啟；只接受本次任務與介面的預期終態、目標版本及新啟動標識。意外失敗會立即報告，舊任務結果不能代替本次結果。
5. 使用不存在的包模擬安裝失敗，斷言頁面顯示失敗、舊 Hub 的啟動標識沒有變化。
6. 建立可正常匯入但啟動函式會拋錯的候選包，讓真實服務實際嘗試啟動該包；確認自動恢復舊服務，介面報告失敗且群組資料保留。預期失敗即使返回 HTTP 503，也須確認磁碟記錄的是本次新建的失敗任務，不能把網路錯誤或舊任務當作通過。
7. 解除安裝隔離測試服務並清理受管安裝目錄。

輸出包含報告 JSON/Markdown、候選包 SHA-256、基線和候選版本、Node 與作業系統，以及瀏覽器成功/失敗/回滾截圖。失敗時還會在解除安裝服務前收集本次任務的允許欄位、限量脫敏日誌和服務管理器狀態；macOS 分別檢查 gui/user 域，Windows 儲存任務狀態、啟動事件，以及失敗埠的 TCP 狀態和所屬 PID；不記錄遠端地址或其他程序命令。升級和回滾在停止任務後都要完成有界的 TCP 資源釋放檢查，再啟動對應版本；隨後繼續檢查版本、例項和新啟動標識。診斷不復制完整配置、資料目錄、環境塊或憑據。

## 釋出門禁

`.github/workflows/hub-upgrade.yml` 先構建一次候選 tarball，再將同一檔案交給 Windows、Linux、macOS × Node 22/24 的六組真實服務驗收。基線預設為 npm 當前 `latest`，可通過手動觸發指定具體版本。Linux 會準備 systemd 使用者會話。報告和截圖作為工作流產物上傳。

釋出應等待相關單測、型別檢查和六組驗收通過，核對 `result.json` 中的 tarball SHA-256，然後釋出**同一份已測試檔案**：

```bash
npm publish /absolute/path/to/the-tested-candidate.tgz
```

不要在測試後重新構建或直接對原始碼目錄執行釋出，否則校驗過的檔案與使用者獲得的檔案可能不同。工作流本身不執行 npm 釋出；分支保護和釋出許可權應將這個檢查設為門禁。

## 結果的適用範圍

本機通過證明該候選包在本機 OS、Node、賬號許可權及服務配置下完成了這些升級場景。矩陣通過再增加對應乾淨系統環境的證據。它們不能保證所有使用者機器的網路、代理、磁碟、許可權、系統版本和自定義部署都相同；生產資料相容性也需要隨 schema 改動增加歷史資料夾具。

更強的交付約束是：擴大已支援環境矩陣，使用上一公開版本的真實歷史資料樣本，釋出同一份驗證過的包，並保留明確失敗狀態、診斷日誌和舊執行版本。未跑過的平臺應標記待驗證，不能用原始碼單測通過替代。
