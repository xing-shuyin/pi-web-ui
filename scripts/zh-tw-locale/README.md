# zh-TW 語言包產生工具

`locales/zh-TW.json` 由簡中字典（`web/src/i18n.tsx` 的 `zh`）轉換產生：
OpenCC `cn → twp`（台灣詞彙）→ `glossary.mjs` 台灣用語規則 → `manual.json` 逐 key 修正。

| 檔案             | 用途                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| `dump-zh.mjs`    | 傾印 `zh` / `en` 字典（保留 key 順序）                                   |
| `convert.mjs`    | 簡中 → 台灣繁中（OpenCC + 詞彙規則 + 手動修正）                          |
| `glossary.mjs`   | 台灣用語規則：`pre`（OpenCC 前）、`post`（OpenCC 後）、`punct`（標點）   |
| `manual.json`    | 逐 key 覆寫：字串＝整句取代；`[[from, to], …]`＝局部取代（找不到會報錯） |
| `verify.mjs`     | 驗證 key 順序、佔位符、殘留簡體字、重複詞、禁用詞                        |
| `build-pack.mjs` | 寫出 `locales/zh-TW.json`（version 預設取 `package.json`）               |
| `opencc.mjs`     | 從 `OPENCC_DIR` 載入 `opencc-js`                                         |

## 用法

`opencc-js` 不在專案依賴裡，要先裝到獨立目錄。腳本從 `OPENCC_DIR` 載入它；沒設定時預設是系統暫存目錄下的 `zhtw-deps`。

macOS／Linux：

```bash
export OPENCC_DIR="${TMPDIR:-/tmp}/zhtw-deps"
npm i --prefix "$OPENCC_DIR" opencc-js

T=$(mktemp -d)
node --import tsx scripts/zh-tw-locale/dump-zh.mjs . "$T/zh.json" "$T/en.json"
node scripts/zh-tw-locale/convert.mjs "$T/zh.json" "$T/tw.json" \
	scripts/zh-tw-locale/glossary.mjs scripts/zh-tw-locale/manual.json
node scripts/zh-tw-locale/verify.mjs "$T/tw.json" "$T/zh.json"
node scripts/zh-tw-locale/build-pack.mjs "$T/tw.json" .
```

Windows（PowerShell）：

```powershell
$env:OPENCC_DIR = Join-Path $env:TEMP "zhtw-deps"
npm i --prefix $env:OPENCC_DIR opencc-js

$T = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "zhtw-$(Get-Random)")
node --import tsx scripts/zh-tw-locale/dump-zh.mjs . "$T/zh.json" "$T/en.json"
node scripts/zh-tw-locale/convert.mjs "$T/zh.json" "$T/tw.json" `
	scripts/zh-tw-locale/glossary.mjs scripts/zh-tw-locale/manual.json
node scripts/zh-tw-locale/verify.mjs "$T/tw.json" "$T/zh.json"
node scripts/zh-tw-locale/build-pack.mjs "$T/tw.json" .
```

`verify.mjs` 的「可能殘留簡體」是提示，不是錯誤：`核准`（准）、`干擾`（干）、`局限`（局）在台灣都是正確用法。

簡中新增或修改 key 後，重跑上面的流程即可同步。流程會整份重新產生，直接手改 `zh-TW.json` 的內容不會保留；個別修正一律寫進 `manual.json` 或 `glossary.mjs`。
