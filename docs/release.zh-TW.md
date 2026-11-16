[English](./release.en.md) · [简体中文](./release.md) · **繁體中文**

# 釋出流程

> npm 釋出者賬號是 `xingshuyin`（`npm whoami` 驗證）。`dist/server/`、`web/dist/` 被 gitignore 不進 git，但 `package.json` 的 `files` 白名單會把它們打進 npm 包；`dist/` 根目錄的本地測試檔案與桌面產物不進入 npm 包。`prepublishOnly` 會編譯 P2P 助手、檢查 Windows 桌面編碼元件及其原始碼和重連結材料，再執行 `npm run build`；服務端構建先清理 `dist/server/`，避免已刪除原始碼的舊輸出留在釋出包。釋出前必須先準備下文所述的 Windows 構建產物。

## 步驟

```bash
# 1) 升版本（patch/minor 視改動；npm 上已存在該版本會 404 拒絕）
#    兩處都要改，保持一致：
#      package.json 的 "version" 和 package-lock.json 的 "version"（第 3 行 + packages[""]）

# 2) 寫 CHANGELOG（每次釋出固定一步，不可跳過）
#    在 CHANGELOG.md 頂部加新版本小節：Added / Fixed / Changed / i18n 四類，
#    按「實際合入該版本釋出的提交」歸檔（git log 上個版本 bump 提交..HEAD），
#    日期寫 npm 釋出時間（UTC+8 日曆日）；底部的版本連結定義同步加一條。
#    Unreleased 小節有內容就併入新版本、清空；無內容就只建空小節佔位。
#    i18n 小節不用手寫：改完文案後跑一次，自動記入 ## [Unreleased]（冪等，可反覆跑）：
#    npm run changelog:i18n

# 3) 自檢 + 構建
npm run typecheck
npm run build

# 4) 提交（Conventional Commits：feat/fix/perf/chore(scope): 描述，說明 why）
git add -A
git commit -m "feat(files): <一句話描述>"

# 5) 推送 GitHub（倉庫公開：xing-shuyin/pi-web-ui，分支 main）
git push origin main

# 5.5) CI 綠標守護：按本次提交 SHA 找到 main 的 CI，等待全部成功。
#      失敗則 gh run view <run-id> --log-failed，定位根因、本地複驗、提交推送，
#      重新等待新 SHA 的 CI；舊提交的綠標不能替代本次提交。
#      全綠後展示版本和最終 Release Notes，取得使用者釋出確認，才可繼續 tag / npm。
gh run list --branch main --workflow CI --commit "$(git rev-parse HEAD)"
gh run watch <run-id> --exit-status

# 6) 打 tag 並推送（tag 帶 v 字首，數字與 npm 版本一一對應；issue #103 前缺的 tag 已回補）
#    漏打 tag 會導致 GitHub 看到的"最新版"落後於 npm，務必每次都打。
git tag vX.Y.Z
git push origin vX.Y.Z

# 7) GitHub Release（自動公示，無需手寫）
#    tag 一推送，Action（.github/workflows/release-notes.yml）自動跑：
#    安裝鎖定的解析依賴（不執行安裝指令碼），取 CHANGELOG 小節 + 按上個 tag 生成 ### i18n，
#    建立 Release（已存在則更新 notes）。本地可先預覽：
node scripts/release-notes.mjs X.Y.Z --base v<上個版本>   # 預覽（輸出到 stdout）
#    自動任務失敗並修復工作流後，從 main 的工作流重新處理已釋出 tag；會校驗並檢出該 tag，
#    再安裝該 tag 的鎖定依賴、生成及更新說明：
# gh workflow run release-notes.yml --ref main -f tag=vX.Y.Z
#    若工作流仍不可用，可在本地依賴齊備後手動補發：
# node scripts/release-notes.mjs X.Y.Z --base v<上個版本> --out /tmp/notes.md --create

# 8) 釋出 npm（會自動跑 prepublishOnly 構建）
#    賬號開了 2FA：用「繞過 2FA 的 granular token」直接 npm publish 會被 registry 降級成
#    staged 釋出（版本幾分鐘後才落庫，期間重試只會 409 Cannot publish over previously
#    staged version；unpublish / 改 dist-tag 更是直接 403）。走帶 OTP 的封裝：
NPM_OTP=123456 npm run release:npm     # 預檢髒工作區/賬號/tag + 帶 OTP 釋出 + staged 自愈
#    等價手工命令：npm publish --otp=123456
#    只想看會打出什麼：npm run release:npm -- --dry-run

# 8.5) 桌面安裝包（自動，三平臺並行，無需手寫）
#    同一個 tag 也觸發 .github/workflows/desktop-release.yml，三個 job 同時跑
#    （都是 npm run build + build:desktop + electron-builder）：
#      windows-latest  --win            → *.exe (+ .blockmap) + latest.yml
#      macos-latest    --mac            → *.dmg + *.zip + latest-mac.yml
#      ubuntu-latest   --linux AppImage → *.AppImage + latest-linux.yml
#    三者都把產物附到該 tag 的 Release（--clobber，重推 tag 即整批重跑+覆蓋資產；
#    workflow_dispatch 只出 workflow artifact、不動 Release 資產）。
#    注意兩點：
#      - runner 默認出宿主架構：Windows/Linux 是 x64，macos-latest 是 arm64
#        （Intel Mac 需另加 --mac --x64，一行事，當前沒做）；
#      - 三平臺都未簽名（Windows 首啟 SmartScreen 提示、macOS 首次需右鍵→開啟，
#        macOS 證書也不在 SignPath 範圍內）；首啟/終端沒把握就先在真機上跑一遍
#        dmg/AppImage 再廣而告之。
#    簽名（SignPath Foundation）以後加在這個 workflow 裡——SignPath 只籤 CI 產物，
#    本地 npm run desktop:dist 永遠籤不上（本地打包只能驗證 Windows）。

# 8.6) 手機端 APK + 桌面安裝包（本地一鍵，推薦）
#    一條命令出齊：桌面（當前平臺）+ 手機 arm64（含引擎執行時），並掛到該 tag 的 Release：
npm run release:local -- vX.Y.Z                # 全量：桌面 + 手機（手機那步 qemu 構建 15–25 分鐘）
npm run release:local -- vX.Y.Z --skip-mobile  # 只打桌面
npm run release:local -- vX.Y.Z --skip-desktop # 只打手機
npm run release:local -- vX.Y.Z --skip-desktop --reuse-runtime  # 只打手機且不重建執行時（引擎沒變時首選，幾分鐘）
npm run release:local -- vX.Y.Z --no-upload    # 只打包，不碰 Release
npm run release:local -- vX.Y.Z --portable     # 額外出便攜版（內建 Git/Node，較慢）
#    注意：手機包不會跟著 tag 自動出。tag 只觸發 desktop-release / release-notes / 擴充套件；
#    mobile-release 是手動 workflow（CI 每次新生成 debug keystore，裝不上舊包還會清引擎資料），
#    所以每個版本的 APK 都得本地跑一次上面的命令。
#    --reuse-runtime 只在「服務端程式碼沒變、只動了外殼/外掛」時成立：執行時裡裝的就是本倉庫
#    npm pack 的服務端包，piWebUi 版本對不上時指令碼會直接攔下（確認真沒改可加 --allow-stale-engine）。
#    指令碼會先校驗 tag 與 package.json 版本一致，然後：npm run build → 桌面打包 → （可選）構建
#    arm64 執行時並打 APK → 生成 SHA256SUMS.txt → gh release upload --clobber。
#    為什麼本地優先：手機 APK 裡帶 280 MB 引擎執行時，CI 那份 qemu 又慢又每次換 debug 簽名
#    （新包裝不上舊包，連手機上的引擎資料一起清）；桌面 Windows 安裝包本地幾分鐘就出。
#    兩個已知限制：
#      - Windows 的 NSIS 安裝包本地生不出來（electron-builder 打完要執行剛產出的 setup.exe
#        生成解除安裝器，本機被系統攔下：ERR_ELECTRON_BUILDER_CANNOT_EXECUTE / exit code null），
#        所以本地出的是免安裝 zip（release/pi-web-ui-desktop-<版本>-win-x64-portable.zip）；
#        需要正式安裝包時用 CI 的 desktop-release windows job。
#      - macOS / Linux 安裝包只能在對應系統上打，仍由 .github/workflows/desktop-release.yml 出。
#    .github/workflows/mobile-release.yml 保留但改成手動觸發（Actions 裡點），用於雲端兜底；
#    它需要可選的 MOBILE_KEYSTORE_BASE64 等 secrets 才能發出可升級的包。

# 9) 驗證
npm run release:check -- vX.Y.Z  # Release 資產是否齊全：桌面 3 平臺 + 擴充套件 + 手機 APK + SHA256SUMS
npm view pi-web-ui version        # 應顯示新版本（registry 有快取延遲屬正常）
curl -s https://registry.npmjs.org/pi-web-ui/latest | jq .version
git ls-remote --tags origin       # 應能看到 vX.Y.Z
```

## 注意事項

- 版本號**必須**高於 npm registry 上已有的（用 `npm view pi-web-ui version` 查當前值）。
- 版本號格式：npm 不帶 `v` 字首（`0.70.0`），git tag / GitHub Release 帶 `v` 字首（`v0.70.0`）。
- 提交資訊不要帶 `Co-authored-by`（P1 規則，倉庫 hook 會攔）。
- `.pi/commands.json` 是**每個專案各自**的個人命令（當前 cwd 的 `.pi/ 下），已被 gitignore，永遠不會進公開倉庫；切換 cwd 時命令列表自動重新整理為該專案的命令。
- CI 綠標守護模式下，必須先完成最終提交的 CI 驗證，再展示版本與 Release Notes 請求釋出確認；同一次確認涵蓋該版本的 tag 推送及 `npm publish`。
- **升級後的重啟**：`npm i -g` 只更新磁碟檔案，已執行程序記憶體裡還是舊程式碼——前端是每次請求即時讀盤的（會先變新），但 WS 訊息處理是程序內舊邏輯，新舊混跑會表現為「介面是新的、某功能一直載入中」。介面內「立即更新」（頂欄更新下拉）現在是在可見終端 tab 中跑 `npm i -g pi-web-ui@latest`（複用 SCM/外掛解除安裝同款 tab 模式），完成後需手動重啟服務生效：`pi-web-ui server restart`（launchd/systemd 由服務管理器拉起；Docker 需 `docker compose restart`）。服務端保留 `PI_WEB_RESTART_CHILD` 埠等待握手（restart-handoff-test 迴歸），供外部編排的替換子程序使用。
- **改桌面出包 workflow 先空跑再重推 tag**：`gh workflow run desktop-release.yml --ref main` 先驗證三個平臺 job 全綠，再重推 tag——重推 tag 會重建並 `--clobber` 覆蓋 Release 資產，是正式出包的唯一路徑。
- **釋出前檢查示例檔案不洩密**：`deploy/`、`README` 等隨 npm 包（`files` 白名單含 `deploy/`）和 GitHub 分發的檔案**絕不放真實 IP / 域名 / 金鑰**——用佔位符（如 `<LAN_IP>`、`<PUBLIC_IP>:<PUBLIC_PORT>`、`your-host`）。真實環境配置只在本地改，不進倉庫。

## 程式碼及文件不要洩露任何公網IP

## P2P npm 候選包

完整候選包通過 `npm run pack:p2p` 生成，需要 Node.js 與 Go ≥1.24。釋出者先在 Windows x64 構建機執行 `npm run build:desktop-codec`；如果在 macOS/Linux 打包，須先將該構建機的 `bin/desktop-codec/win32-x64/` 和 `bin/ffmpeg/win32-x64/nvenc-compat/` 一同複製到釋出工作區。命令會交叉編譯五個平臺助手、準備預設 Windows FFmpeg、校驗原生元件和材料、構建 Web/服務端並打包。釋出前也可單獨執行 `npm run verify:desktop-codec`。缺少或篡改必需產物時，`pack:p2p` 和 npm 釋出前檢查會失敗；不要用 `npm pack --ignore-scripts` 繞過檢查釋出。

`bin/device-p2p/` 助手以及 Windows 編碼器和重連結材料是生成物，不提交 Git，由 npm 的 `bin/` 檔案白名單收錄。Windows 桌面安裝包的 release workflow 會從原始碼構建這些元件。原始碼、許可證與重連結材料隨包提供，正式釋出前由維護者檢查第三方依賴的適用許可要求。

釋出前執行 `node --import tsx tests/device-p2p-test.mjs` 和相關裝置許可權/訪問單測；從打出的 tarball 安裝並檢查五份助手及清單，驗證包內而非工作區的連線助手。Go 交叉編譯通過不等於 macOS/Linux 實機通過，釋出說明必須區分。
