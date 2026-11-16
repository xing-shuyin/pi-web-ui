# DESIGN — Localization coverage for pi-web-ui UI and plugin UI

Status: **DRAFT — NOT APPROVED** (design stage; implementation not authorized)
Traceability base: `SPEC.md` (same directory, revision at 2026-11-15 run)
Owner: MidnightPhreaker

## 1. Design goals and constraints

| Goal                                             | Constraint from SPEC   |
| ------------------------------------------------ | ---------------------- |
| Extend, don't replace, the existing catalog      | NFR-001, NFR-004, F1   |
| One localization contract for host and plugins   | FR-007, FR-009, F5, F6 |
| Locale identifiers correct per BCP 47            | FR-006, R1, F2, F3     |
| Plurals resolved at runtime, not in dictionaries | FR-008, R2             |
| Every migrated surface proven in a real browser  | AS-01…AS-07, F8        |

## 2. Requirement → design mapping

| Requirement     | Design element                                                           |
| --------------- | ------------------------------------------------------------------------ |
| FR-001, FR-002  | §4 string inventory + shrink-only allowlist guard                        |
| FR-003, NFR-003 | §3 catalog/module rules (unchanged ownership, single-pass interpolation) |
| FR-004, FR-005  | §5 locale resolution + fallback chain                                    |
| FR-006          | §5 alias table (`zh-CN`/`zh-Hans` → `zh`)                                |
| FR-007, FR-009  | §6 plugin contract and migration of 3 private implementations            |
| FR-008          | §7 plural helper on top of `Intl.PluralRules`                            |
| FR-010          | §8 tooling extension of `scripts/lib/i18n-catalog.mjs`                   |
| AS-07           | §9 browser validation through the existing Playwright harness            |

## 3. Catalog and module rules (no structural change)

`web/src/i18n/catalog.ts` keeps aggregating `messages/<module>/{zh,en}.json` into a literal key union. New work stays inside the owning module: `core` for shell/settings/left panel, `canvas` and `canvas-runtime` untouched unless a Canvas literal is found, `desktop`/`native-cli-session` only where their surface is implicated.

Rules carried over from `docs/i18n.md` and enforced by `tests/unit/i18n-catalog.test.ts`:

- `zh.json` and `en.json` must have identical key order (the catalog throws otherwise).
- Named placeholders only (`{name}`, `${name}`, `{{name}}`); placeholder sets must match across source and target.
- Interpolation stays single-pass (NFR-003).
- Adding a module means registering it in `catalog.ts`; the tools read modules through `scripts/lib/i18n-catalog.mjs`, not by file-layout inference.

**Decision D2 — no new i18n library, no ICU MessageFormat 2.** The requirement is coverage of hardcoded literals plus one plugin contract; the existing typed catalog already delivers compile-time key safety, which `react-i18next`/`react-intl` would not improve without migrating 3571 keys. Plurals are the only capability gap and are solved at runtime with `Intl.PluralRules` (R2). _Rejected:_ `i18next` (dependency + runtime bundle + key migration, no requirement), `react-intl`/MF2 (parser + compiler step, spec is not yet implemented in the Chromium baseline used for tests).

## 4. Hardcoded-string inventory and shrink-only guard

**Type-level guarantees to preserve** (NFR-001, per `typescript-pro` guidance): `createCatalog()` derives `ModuleKey<T>` from the `zh` dictionary literal, so `t("…")` is checked at compile time and a typo fails `tsc` rather than runtime; `plugin-sdk/client.d.ts` must type `host.i18n.t` with the plugin dictionary's key union instead of `string`, so plugin key errors surface during `npm run typecheck`; new exported helpers declare explicit return types. `tsc --noEmit` is a per-task gate (plan Tasks 2–10), not a final-only check.

- `scripts/i18n-literal-inventory.mjs` (new) scans `web/src/**/*.{ts,tsx}` excluding `web/src/i18n/messages/**`, extracts string literals containing CJK or known UI-attribute values, and emits a normalized JSON inventory (`{file, line, text}`) plus per-file counts.
- The committed allowlist `tests/fixtures/i18n-hardcoded-allowlist.json` seeds from today's 1271 entries (F4). Entries carry a mandatory `reason` (`pending` or `data`).
- `tests/unit/i18n-hardcoded-guard.test.ts` (new) fails when the scanner reports an entry not in the allowlist. Removal from the allowlist happens in the same commit that migrates the string, so the list only shrinks.
- Data catalogs (`mcp-catalog.ts`, `skill-catalog.ts`) are classified per entry as `data` (third-party descriptions, not UI chrome) or `pending`; `data` entries are excluded from FR-001 by the SPEC's A-1.

_Why a scanner + allowlist rather than an ESLint rule:_ the repo lints with `oxlint`, which has no custom-rule plugin path configured, and the inventory doubles as the progress metric the SPEC's done-when needs.

## 5. Locale resolution

Current path: `web/src/ui-locale.ts` (persistence) → `initializeUiLocale(savedLocale(), navigator.languages)` → `web/src/pick-locale.ts` (matching) → `web/src/i18n.tsx` (pack loading + fallback).

Design change is confined to matching:

| Input                                           | Resolves to                         | Note                                               |
| ----------------------------------------------- | ----------------------------------- | -------------------------------------------------- |
| `zh`, `zh-CN`, `zh-Hans`, `zh-Hans-CN`, `zh-SG` | `zh`                                | Simplified source dictionary; no new file (FR-006) |
| `zh-TW`, `zh-Hant`, `zh-Hant-TW`                | `zh-TW`                             | pack                                               |
| `zh-HK`                                         | `zh-HK`                             | pack                                               |
| `en`, `en-US`, `en-GB`                          | `en`                                | source dictionary                                  |
| unmatched                                       | `zh` → `en` fallback order as today | F2                                                 |

Implementation: a canonicalization step (script subtag preferred when both region and script are present, per R1) applied before the existing exact-then-prefix matching in `pickLocale`. The `zh-CN` alias is a mapping table entry, not a duplicated dictionary.

**Decision D1** — keep `zh` as the internal id and accept `zh-CN`/`zh-Hans` as aliases rather than renaming the dictionary. Renaming would churn 3571 keys across 6 modules, all `locales/*.json` packs, saved `localStorage` values and the download endpoints, with no user-visible gain; the alias delivers BCP 47 correctness at the boundary where user input arrives. Evidence: R1 (script subtags are authoritative for Chinese), F3 (packs already split by script/region).

## 6. Plugin localization contract

**Decision D3** — the host owns one implementation; plugins supply dictionaries only.

- Host surface, added to `plugin-sdk/client.mjs` (+ `client.d.ts` types) and wired in `server/plugins.ts` next to `host.ui`/`host.fs`:
  - `host.i18n.locale` — active UI locale id (same value the web app resolved).
  - `host.i18n.available` — locale ids with a dictionary for this plugin.
  - `host.i18n.t(key, vars?)` — namespaced lookup, single-pass interpolation, same placeholder rules as the host.
- Plugin dictionaries: `<plugin>/locales/{zh,en,zh-TW}.json`, flat keys, namespaced by the host as `<pluginId>.<key>` so collisions are impossible.
- Fallback order: active locale → `en` → key. Missing dictionaries degrade to `en`, never to a crash (mirrors F2's runtime behavior).
- Delivery: the dictionaries are read by the plugin host and pushed to the client with the existing plugin payload, so no new endpoint and no new build step (NFR-002 applies to the app, plugins are loaded on demand).
- Migration of the 3 existing implementations (`plugins/{image-toolkit,live2d,notes}/client/i18n.mjs`, F5): their private `DICT` moves to `plugins/<id>/locales/zh.json` + `en.json`, `t()` calls keep working through the host, and the private files are deleted (FR-009).

_Rejected:_ a published npm i18n package for plugins (adds a distribution channel and version skew for a <10-user project); per-plugin `detectLang` kept but pointed at a shared helper (still leaves 40 plugins without a contract and keeps locale detection duplicated).

## 7. Plural handling

`web/src/i18n/plural.ts` (new, ~20 lines): `pluralForm(locale, count)` → `Intl.PluralRules(locale).select(count)`, plus dictionary keys `…_count.one` / `…_count.other` where a count-dependent phrase exists. `zh`/`zh-TW` use a single `other` form, so no dictionary growth there. Only applied where the SPEC's AS-01…AS-05 surfaces show a count phrase; no bulk rewrite of existing keys (NFR-004).

## 8. Tooling

`scripts/lib/i18n-catalog.mjs` gains plugin dictionary discovery (`pluginModule(pluginId)`), reusing its existing key/placeholder validation so `i18n:check`, `i18n:sync` and the scanner share one parser. `i18n:check` exit semantics unchanged (FR-010). Existing behavior for `locales/*.json` is untouched (N4).

## 9. Validation strategy (bounded)

| Layer        | Command                                                                                                                                                    | Covers                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Unit         | `npx vitest run tests/unit/i18n-catalog.test.ts tests/unit/i18n-dead-keys.test.ts tests/unit/i18n-runtime.test.ts tests/unit/i18n-hardcoded-guard.test.ts` | FR-001…FR-003, NFR-003, AS-05, AS-06 |
| Pack drift   | `npm run i18n:check`                                                                                                                                       | FR-010                               |
| Types/build  | `npm run typecheck`                                                                                                                                        | NFR-001, NFR-004                     |
| Real browser | `node tests/i18n-browser-test.mjs` (new, pattern of `tests/canvas-browser-test.mjs`: `playwright-core` + `tests/lib/chrome.mjs` + `ensure-build`)          | AS-01…AS-04, AS-07                   |

The browser test boots one server, then for each of `en`, `zh-TW`, `zh-CN` sets the locale, opens Settings + the group panels + one plugin panel, and asserts (a) expected label text present, (b) no CJK in `en` runs, (c) no Simplified-only glyph set in `zh-TW` runs, (d) locale switch without reload for the plugin surface. This is the SPEC's live-browser requirement; no Lighthouse, coverage or performance instrumentation is added.

## 10. Trade-offs and risks

| Risk                                                                            | Mitigation                                                                                                                        |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| The 1271-entry inventory is large; a single big-bang migration is unreviewable. | Vertical slices per surface (Tasks 2–6); each commit shrinks the allowlist and keeps NFR-004.                                     |
| CJK detection could flag legitimate data strings.                               | `reason: data` classification with the file/line recorded; guard reads the allowlist, not heuristics.                             |
| Plugin dictionaries grow the plugin payload.                                    | Dictionaries are small key/value JSON, pushed only for the active locale + `en`; accepted for <10 users.                          |
| Locale alias could mask a real `zh-CN` translation.                             | Alias table is explicit and unit-tested (Task 7); adding a distinct `zh-CN` dictionary later is a mapping change, not a refactor. |

## 11. Open design question

`Q-2` — Should `host.i18n` be exposed to server-side plugin code too, or client-only in v1? Default: client-only; server-side plugin code emits `CanvasMessage`-style `{key, vars}` metadata (existing pattern) if it ever needs translation. Recorded as a reversible decision.
