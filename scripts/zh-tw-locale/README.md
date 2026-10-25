# 繁體中文語言包產生工具（zh-TW / zh-Hant / zh-HK）

`locales/zh-TW.json`、`locales/zh-Hant.json` 與 `locales/zh-HK.json` 由簡中字典（`web/src/i18n.tsx` 的 `zh`）轉換產生：

- **zh-TW（台灣繁體）**：OpenCC `cn → twp`（台灣詞彙）→ `glossary.mjs` 台灣用語規則 → `manual.json` 逐 key 修正。
- **zh-Hant（通用繁體）**：OpenCC `cn → t`（通用字形）→ 標點符號正規化。
- **zh-HK（香港繁體）**：OpenCC `cn → hk`（香港字形）→ 香港常見用語對齊（如伺服器、終端機、登入、滑鼠等）→ 標點符號正規化。

| 檔案             | 用途                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| `build-all.mjs`  | **一鍵產生全部三個繁中語言包**（`zh-TW`、`zh-Hant`、`zh-HK`）            |
| `dump-zh.mjs`    | 傾印 `zh` / `en` 字典（保留 key 順序）                                   |
| `convert.mjs`    | 簡中 → 台灣繁中（OpenCC + 詞彙規則 + 手動修正）                          |
| `glossary.mjs`   | 台灣用語規則：`pre`（OpenCC 前）、`post`（OpenCC 後）、`punct`（標點）   |
| `manual.json`    | 逐 key 覆寫：字串＝整句取代；`[[from, to], …]`＝局部取代（找不到會報錯） |
| `verify.mjs`     | 驗證 key 順序、佔位符、殘留簡體字、重複詞、禁用詞                        |
| `build-pack.mjs` | 寫出 `locales/<code>.json`（version 預設取 `package.json`）              |
| `opencc.mjs`     | 從 `OPENCC_DIR` 載入 `opencc-js`                                         |

## 用法

推薦直接使用專案統一指令：

```bash
npm run i18n:sync
```

`npm run i18n:sync`（`scripts/sync-locales.mjs`）是專案唯一標準的語言包同步器，會調用本目錄的 `opencc.mjs`、`glossary.mjs` 與 `manual.json`，並同步全量 12 個語言包。

若需要 OpenCC 高精度轉換（避免純規則回退），可先安裝 `opencc-js`（若全域或環境中未安裝）：

macOS／Linux：

```bash
export OPENCC_DIR="${TMPDIR:-/tmp}/zhtw-deps"
npm i --prefix "$OPENCC_DIR" opencc-js
npm run i18n:sync
```

Windows（PowerShell）：

```powershell
$env:OPENCC_DIR = Join-Path $env:TEMP "zhtw-deps"
npm i --prefix $env:OPENCC_DIR opencc-js
npm run i18n:sync
```

`verify.mjs` 的「可能殘留簡體」是提示，不是錯誤：`核准`（准）、`干擾`（干）、`局限`（局）在台灣都是正確用法。

簡中新增或修改 key 後，重跑 `npm run i18n:sync` 即可同步。個別修正可寫進 `manual.json` 或 `glossary.mjs`。
