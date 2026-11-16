**English** · [简体中文](./preset-sharing.md) · [繁體中文](./preset-sharing.zh-TW.md)

# Preset Sharing (Import / Export / Community Repository)

> Code: `server/preset-share.ts` (pure logic + orchestration), `server/settings-service.ts` (port adapter),
> `server/dsh/dsh-agent-service.ts` (port adapter for DSH), `web/src/components/PresetShareModal.tsx` (three-tab panel),
> shared repository [xing-shuyin/pi-web-ui-presets](https://github.com/xing-shuyin/pi-web-ui-presets).

Settings presets (**「设置 → 预设」(Settings → Presets)**) used to be savable/applicable only on the local machine. They are now **interchangeable files**: export to JSON, import by URL, push to the community repository in one click, and browse presets others have shared right in the panel.

## 1. Three Paths

| Path           | Entry                                                                                                                          | Channel                                                 | Destination                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Export / share | The primary 「分享预设」(Share preset) button at the top of the presets area, the share icon on a preset row, or the panel tab | `preset_export` / `preset_share`                        | Clipboard / `.json` download / community repository Issue                         |
| Import         | The 「导入预设」(Import preset) button at the top of the presets area, or the panel's 「导入」(Import) tab                     | `preset_import` (paste/file), `preset_import_url` (URL) | Local `presets` storage (same name overwritten), optionally apply immediately     |
| Browse shared  | The 「浏览共享」(Browse shared) button at the top of the presets area, or the panel's 「浏览分享」(Browse shared) tab          | `preset_catalog`                                        | Fetch the repository's `index.json` → list → one-click import (reuses URL import) |

All three top buttons open the same panel (`PresetShareTab` decides which tab it lands on), so there is no need to switch tabs inside the panel first.

The settings area merges three blocks into a single card (**engine preset / permission dropdowns + the settings preset list**): the Agent preset and permission each used to have a read-only list of their own (every name + description), now compacted into a dropdown plus one line describing the current value; permissions are down to a single dropdown.

**Why import/fetch must happen server-side**: the `UiSettingsPreset` sent to the browser is a **trimmed view** (only
name/promptMode/customSystemPrompt/promptTemplate/promptOverrides/disabledSkills/disabledExtensions/
reviewPrompt/reviewDisabledSkills), while the full field set exists only in the server-side `SettingsPreset`; and a
browser fetching raw.githubusercontent.com directly runs into CORS. So parse → sanitize → persist all happens
server-side; the front-end only displays and confirms.

## Plugin Dependencies and Apply Results

The share panel lets you explicitly check the plugins that should travel with the preset. The exchange document's top-level `plugins` holds at most 32 entries, keeping only `id`, display `name`, a reference `version` and a portable GitHub `source`. Local paths, credentialed URLs, plugin configuration, secrets, storage and permission grants are never exported. The source allowlist lives in `server/preset-plugin-dependencies.ts`, separate from settings field sanitization; a dependency without a usable source is still displayed but cannot be installed directly.

Dependencies are saved together with the preset and are not lost on a later export; `plugins` is preset metadata only and must not be merged into `ClientSettings`. Preview and ordinary import never perform installs. An explicit front-end install of missing plugins reuses `plugin_job` (install confirmation, managed-mode restrictions, logs, failure results and retries); installed plugins are not auto-upgraded or re-authorized. The reference version flags differences, it is not a version lock. Plugin install and preset save/apply are independent operations, with no transactional rollback promised.

An import acknowledgement with `ok: true` means the preset has been saved. With immediate apply checked, the server returns `applied` only after apply finishes; if apply throws, the saved preset is kept and `applyError` is returned. The UI must distinguish save results from apply results. Partial presets must keep missing fields missing when read from storage — no retry/compaction/review defaults are filled in; only fields actually carried may change settings.

## 2. Exchange Format (`pi-web-ui-preset` v1)

```jsonc
{
	"format": "pi-web-ui-preset",
	"version": 1,
	"name": "预设名", // required, ≤60 chars; preset name after import (same name is overwritten)
	"description": "适合什么场景", // ≤500 chars
	"author": "github 用户名", // ≤80 chars
	"tags": ["编程", "极简"], // ≤8 entries, ≤24 chars each
	"createdAt": "2026-01-01T00:00:00.000Z",
	"appVersion": "0.99.0", // package version of the generating side
	"plugins": [{ "id": "notes", "name": "Notes", "source": "owner/repo/plugins/notes", "version": "1.0.0" }], // optional dependencies
	"settings": {/* see below */},
}
```

`settings` is isomorphic to `SettingsPreset` in `server/client-state.ts`; **the field allowlist is the full `ClientSettings` set**
(47 fields, listed and grouped in `server/preset-fields.ts`, shared by front-end and back-end):

| Group                                     | Fields                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt` prompts                          | `promptMode` · `customSystemPrompt` · `promptTemplate` · `promptOverrides` · `reviewPrompt` · `reviewDisabledSkills`                                                                                                                                                                                                         |
| `tools` tools and toggles                 | `disabledAgentTools` · `disabledPluginTools` · `toolPromptOverrides` (per-tool text) · `toolLazyLoading` · `readDirEnabled` · `toolApprovalEnabled` · `toolWatchdogTimeoutMs` · `questionnaireEnabled` · `terminalToolsEnabled`                                                                                              |
| `terminal` terminal takeover              | `terminalBash` · `terminalBashIdleMs` · `terminalBashMaxForegroundMs`                                                                                                                                                                                                                                                        |
| `skills` skills and extensions            | `disabledSkills` · `disabledExtensions` · `skillsFullText`                                                                                                                                                                                                                                                                   |
| `ai` model behavior and dedicated prompts | `retryMaxAttempts` · `softCapTokens` · `softCapByModel` · `subagentDefaultModel` · `visionBridgeEnabled` · `visionBridgeModel` · `visionBridgePromptMode` · `visionBridgePrompt` · `scmCommitMsgPromptMode` · `scmCommitMsgPrompt` · `planModePromptMode` · `planModePrompt` · `goalModeEnabled` · `parallelReminderEnabled` |
| `ui` UI and interaction preferences       | `uiLayout` · `disabledPlugins` · `thinkingWrap` · `toolsWrap` · `toolImagesEnabled` · `keepRecentMessages` · `showForkedParentSessions` · `quickPhrases` · `quickPhrasesEnabled` · `devNoCache` · `autoReload`                                                                                                               |
| `engine` engine defaults                  | `defaultAgentPreset` · `defaultPermissionPreset`                                                                                                                                                                                                                                                                             |

**Still outside presets** (not in `ClientSettings`; each has its own storage): marker toggles (`disabledMarkers`; no separate global switch — turning all of them off is global off),
the approval rule library (`approval-rules.json`), the subagent template library (`subagent-templates.json`), and pure front-end localStorage
preferences (wallpaper, wide-screen chat column, present auto-preview, title settings, sound/TTS, notifications, input history).

**Fields are optional**: legacy documents (only 19 fields) and “import just a part” both rely on the `Partial` semantics of `SettingsPreset` —
any missing field **keeps its current value** when the preset is applied. A unit test guards “every field of `ClientSettings` is in the list” with a compile-time assertion.

The JSON Schemas also live in the shared repository: `schema/preset.schema.json`, `schema/index.schema.json`.

## 3. Import Discipline (Allowlist + Limits + Chokepoints)

Imported external JSON is **never spread directly into settings**. Four gates:

1. **Shape**: `format` must equal `pi-web-ui-preset`, `version` must be `1`, `name` must be non-empty, `settings` must be an object;
   on failure a **stable errorKey** is returned (`presets.import.format` / `.version` / `.name` / `.settings` / `.parse` /
   `.tooLarge` / `.empty` / `.shape` / `.noFields`) plus localized text. A single-element array is also accepted (people wrap one in an array).
2. **Allowlist + types**: only the 47 fields above are recognized; mismatched types are **dropped** (not thrown) and listed in the preview (`rejected`);
   unknown fields go into `ignored` (a hint for old clients / typos). List fields are trimmed, deduped, ≤200 chars per entry, ≤500 entries;
   map fields ≤200 entries; long-text fields ≤100KB. `disabledAgentTools`/`softCapTokens`/`softCapByModel`/
   `retryMaxAttempts`/`skillsFullText` go through **the same normalization functions** on the app side (`tool-manager` / `soft-cap` /
   `client-state`), so an “imported preset” and a “locally saved preset” mean the same thing.
3. **Limits**: a single document ≤512KB (`PRESET_JSON_MAX_BYTES`, matching the repository ingest script).
4. **Fetch chokepoint**: URL import allows only `http(s)` and **rejects private networks / loopback / link-local / `.local` / `.internal` / local IPv6**
   (`isBlockedHost`, the SSRF chokepoint); with a 10s timeout and a size cap, using only the injected `Fetcher` (by default
   `defaultFetcher` from `update-check.ts`, so it follows the global proxy configuration).

**Two-phase**: the front-end first sends `dryRun: true` for a preview (name, description, author, tags, fields to be written, ignored/dropped fields,
summary badges, custom prompt/template/review-prompt snippets, whether a same-named preset is overwritten); only after the user confirms does it send `dryRun: false` to actually persist
(optionally `apply: true` for immediate apply). A successful import pushes `settings_state` + one notice.

**Selective import**: the confirmation carries `fields: string[]` (field names from the last `dryRun` preview, checked per group / per field, all selected by default) →
the server writes only the checked fields into the preset; unchecked fields are not persisted and keep their current value when applied. Names outside the allowlist are filtered out of that list;
an empty array = nothing checked, so the server replies `ok:false` and refuses to write. Omitting `fields` = full set (old client behavior unchanged).

## 4. Community Repository

Default repository is `xing-shuyin/pi-web-ui-presets` (`PI_WEB_PRESET_REPO` can point at your own fork / self-hosted repository). Structure:

```
index.json                     # catalog (the only source for the browse list)
presets/<slug>-<sha1前7>.json  # ingested preset files
schema/…                       # the two JSON Schemas
scripts/ingest-preset.mjs      # Issue → ingest (validate → write file → update index.json)
scripts/validate-repo.mjs      # repository self-check (runs on PR/push)
.github/workflows/ingest-preset.yml    # Issues whose title starts with [preset]: open/edit → auto-ingest → comment → close
.github/workflows/validate-presets.yml # index ↔ file consistency
```

**One-click share** (`preset_share`) — the server tries three landing paths in ascending order of how much the user must do:

1. **gh CLI** (installed and signed in) — fully automatic:
   `gh issue create --repo <repo> --title "[preset] <name>" --body-file <临时文件>`
   (`PI_WEB_PRESET_GH` can point at a gh path; the body goes through a temp file, so it is not limited by command-line length);
2. **GitHub API + token** (fully automatic without gh): the token is taken from `PI_WEB_PRESET_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`;
   with a token it does `POST https://api.github.com/repos/<repo>/issues` (through the same injected Fetcher, so it follows proxy settings);
   when the token is invalid / unauthorized, the message from the error body is reported back too;
3. **Pre-filled web page** (needs no credentials) — the front-end copies the JSON and opens the new-Issue page. **In most cases one click on Submit is enough**:
   when the body fits in the URL (≤7K after encoding) the link **pre-fills the body and omits `template=`** (GitHub ignores body when a template is present, so
   supplying both forces a manual paste); only when the body is too large does it fall back to the template page and put the JSON on the clipboard for the user to paste.

The acknowledgement's `method` is `"gh"` / `"api"` (both have already created the Issue, so the front-end just opens the URL) or `"browser"` (the front-end copies the JSON + opens the link).
After the repository Action validates, it writes into `presets/`, updates `index.json`, comments and closes the Issue (on failure it comments the reason + labels `needs-fix`, and retries automatically once the body is edited).

**Browse list** (`preset_catalog`): fetch `PI_WEB_PRESET_CATALOG_URL` (default
`https://raw.githubusercontent.com/<repo>/main/index.json`), parse `index.json` →
filter entry by entry (`id`/`name`/`file` required, `file` must be a repository-relative path, `..` and absolute addresses are blocked, `id` deduped,
≤500 entries) → sort by `updatedAt` descending → acknowledgement. **5-minute in-process cache** (`refresh: true` bypasses it);
on fetch failure it **keeps the last successful list** (`cached: true`), so offline only makes the list stale. Every entry can be
imported directly (reusing URL import, with the URL built from the raw base) or open its source Issue.

## 5. Environment Variables

| Variable                    | Default                                                    | Purpose                                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_WEB_PRESET_REPO`        | `xing-shuyin/pi-web-ui-presets`                            | Shared repository `owner/name` (also accepts `https://github.com/owner/name(.git)`); `off`/`0`/`false`/`no` = sharing disabled (import/export still work)                                    |
| `PI_WEB_PRESET_CATALOG_URL` | `https://raw.githubusercontent.com/<repo>/main/index.json` | Catalog document URL; empty string or `off` = 「浏览分享」(Browse shared) disabled                                                                                                           |
| `PI_WEB_PRESET_GH`          | `gh`                                                       | Path to the GitHub CLI invoked for one-click share                                                                                                                                           |
| `PI_WEB_PRESET_TOKEN`       | empty                                                      | Direct API token when gh is unavailable (fallback order: `PI_WEB_PRESET_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`); when unset it uses the “pre-filled web page” path, which needs no credentials |

See `docs/env-vars.md` for the full table.

## 6. Privacy

Presets contain **settings only**: API keys, provider logins and project paths are not in a preset (the `SettingsPreset` type definition excludes them).
But a preset **can** carry custom system prompts, compose templates and review prompts — **read the preview before importing**; the preview shows these text blocks
truncated, nothing is persisted until 「导入」(Import) is clicked, and nothing takes effect until 「应用」(Apply) is clicked. Sharing to a public repository = these texts go public, so do not send private prompts out.

## 7. Protocol Messages

```
client → server
  preset_export      { source?: "preset"|"current", name?, description?, author?, tags?, requestId? }
  preset_import      { json, dryRun?, name?, apply?, fields?, requestId? }
  preset_import_url  { url, dryRun?, name?, apply?, fields?, requestId? }
  preset_catalog     { refresh?, requestId? }
  preset_share       { source?, name?, description?, author?, tags?, requestId? }

server → client
  preset_export_result { requestId?, ok, name?, fileName?, json?, error? }
  preset_import_result { requestId?, ok, dryRun, preview?: UiPresetImportPreview, applied?, error? }
  preset_catalog_result{ requestId?, ok, entries: UiPresetCatalogEntry[], source, cached, fetchedAt, error? }
  preset_share_result  { requestId?, ok, method?: "gh"|"browser", url?, name?, json?, error? }
```

`requestId` is echoed back verbatim; the front-end encodes the import source in the prefix (`paste:` / `file:` / `url:`), and the preview header is labeled from it
(the server does not care about the source). `fields` = field names for selective import (see the end of §2); omitted = full set. Both engines share the same orchestration
(`PresetSharePort`): `SettingsService` (pi) and `DshClientSession` (DSH) each implement the four operations “get preset / save preset /
apply preset / push settings”.

## 8. Tests

- `tests/unit/preset-share.test.ts` — 60 pure-function/orchestration unit tests: slug/short hash, allowlist sanitization (47 fields + selective-import
  selection filtering), parsing and errorKey, SSRF chokepoint, catalog parsing and caching, env reading, Issue text, port orchestration
  (export/import/share fallback/catalog).
- `tests/settings-test.mjs` — real-server protocol round trip (isolated data-dir): export → dryRun preview → rename import + apply
  (current settings are changed and must be restored after import) → selective import (only checked fields written / empty selection refused) → sanitization (unknown fields / type mismatches)
  → bad JSON → URL import blocking loopback and non-http(s) → share explicitly refused when disabled via env but still returning the JSON → catalog shape.
  This test **explicitly disables sharing** and never opens an Issue on the shared repository.
- `tests/scratch/preset-share-live.mjs` — manual integration (real network): pull the official repository catalog with default env → import a
  real preset by URL → export round trip. Needs network; not part of smoke tests.
- `tests/scratch/preset-share-nogh-live.mjs` — fallback verification without gh (real network): an invalid token against the real api.github.com
  must yield a clean `HTTP 401: Bad credentials` (no throw), plus the web-fallback URL's pre-fill / length / either-or `template` rules.
- `tests/scratch/preset-share-api-live.mjs` — the **success** path for token + direct API (real network + real repository): create one
  Issue → read it back to verify title/body → delete it with GraphQL `deleteIssue`. Run `gh workflow disable "Ingest shared preset"` first.
