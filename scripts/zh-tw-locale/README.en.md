**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Traditional Chinese locale pack generator (zh-TW / zh-Hant / zh-HK)

`locales/zh-TW.json`, `locales/zh-Hant.json`, and `locales/zh-HK.json` are produced by merging `web/src/i18n/messages/<module>/zh.json` and then converting it. All tools read the source through `scripts/lib/i18n-catalog.mjs` without loading React or executing TSX. `core` comes first, the remaining modules sort by name; an already-translated `<locale>.json` in the same module overrides generated keys of the same name:

- **zh-TW (Taiwan Traditional)**: OpenCC `cn → twp` (Taiwan vocabulary) → `glossary.mjs` Taiwan usage rules → per-key fixes in `manual.json`.
- **zh-Hant (generic Traditional)**: OpenCC `cn → t` (generic glyphs) → punctuation normalization.
- **zh-HK (Hong Kong Traditional)**: OpenCC `cn → hk` (Hong Kong glyphs) → alignment with common Hong Kong usage (such as 伺服器, 終端機, 登入, 滑鼠) → punctuation normalization.

| File             | Purpose                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `build-all.mjs`  | **Generate all three Traditional Chinese packs in one go** (`zh-TW`, `zh-Hant`, `zh-HK`)                           |
| `dump-zh.mjs`    | Dump the `zh` / `en` dictionaries (key order preserved)                                                            |
| `convert.mjs`    | Simplified Chinese → Taiwan Traditional (OpenCC + glossary rules + manual fixes)                                   |
| `glossary.mjs`   | Taiwan usage rules: `pre` (before OpenCC), `post` (after OpenCC), `punct` (punctuation)                            |
| `manual.json`    | Per-key overrides: a string replaces the whole sentence; `[[from, to], …]` replaces a part (errors when not found) |
| `verify.mjs`     | Verify key order, placeholders, leftover Simplified characters, duplicate words, banned words                      |
| `build-pack.mjs` | Write `locales/<code>.json` (version defaults to `package.json`)                                                   |
| `opencc.mjs`     | Load `opencc-js` from `OPENCC_DIR`                                                                                 |

## Usage

Prefer the project's unified command:

```bash
npm run i18n:sync
```

`npm run i18n:sync` (`scripts/sync-locales.mjs`) is the project's only standard locale synchronizer; it calls this directory's `opencc.mjs`, `glossary.mjs`, and `manual.json`, and syncs all 12 locale packs.

For high-precision OpenCC conversion (avoiding the pure-rule fallback), install `opencc-js` first (if not already installed globally or in the environment):

macOS/Linux:

```bash
export OPENCC_DIR="${TMPDIR:-/tmp}/zhtw-deps"
npm i --prefix "$OPENCC_DIR" opencc-js
npm run i18n:sync
```

Windows (PowerShell):

```powershell
$env:OPENCC_DIR = Join-Path $env:TEMP "zhtw-deps"
npm i --prefix $env:OPENCC_DIR opencc-js
npm run i18n:sync
```

`verify.mjs`'s "possible leftover Simplified" is a hint, not an error: `核准`(准), `干擾`(干), `局限`(局) are all correct usage in Taiwan.

After adding keys in Simplified Chinese, just re-run `npm run i18n:sync` to sync; existing flat translations are kept, while translated module sources override keys of the same name. Individual fixes go into the module's `<locale>.json`, `manual.json`, or `glossary.mjs`. A module translation's key set and placeholders must match zh, and the zh/en order must match too; duplicate keys error out before merging.

For a standalone conversion flow, export the merged dictionary with `node scripts/zh-tw-locale/dump-zh.mjs <repo> <zh.json> <en.json>`, then run `convert.mjs` and `build-pack.mjs`. `build-pack.mjs` also applies module translations and preserves the existing `serverStrings`.
