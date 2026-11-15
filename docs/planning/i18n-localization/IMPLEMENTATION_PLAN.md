# IMPLEMENTATION PLAN — Localization coverage for pi-web-ui UI and plugin UI

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: **DRAFT — NOT APPROVED**. Derived from `SPEC.md` + `DESIGN.md` (same directory).
Authorization note: this stage was requested by the owner; **no task below may be executed without a separate "start implementation" instruction.**

Applied guidance: `project-planning-process` (artifact model, gates), `writing-plans` (header, one-action steps, task right-sizing), `typescript-pro` (type-level key safety, `tsc --noEmit` gate), `find-skills` (evaluated `vudovn/ag-kit@i18n-localization` — generic best-practice checklist; only its RTL guidance would apply and RTL is out of scope per SPEC §4 N1, so no skill installed).

Artifact manifest (planning set):

| Role                         | Path                                                     |
| ---------------------------- | -------------------------------------------------------- |
| Specification                | `docs/planning/i18n-localization/SPEC.md`                |
| Design                       | `docs/planning/i18n-localization/DESIGN.md`              |
| Implementation plan          | `docs/planning/i18n-localization/IMPLEMENTATION_PLAN.md` |
| Scope lock / evidence ledger | `SPEC.md` §1, §3                                         |
| Owner decisions              | `SPEC.md` §8, `DESIGN.md` D1–D3, §11                     |

## Work products overview

| Path                                                                                   | Change        | Responsibility                                             |
| -------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------- |
| `scripts/i18n-literal-inventory.mjs`                                                   | new           | Scan scoped sources, emit normalized inventory             |
| `tests/fixtures/i18n-hardcoded-allowlist.json`                                         | new           | Shrink-only allowlist seeded from the 1271-entry inventory |
| `tests/unit/i18n-hardcoded-guard.test.ts`                                              | new           | Fail on new hardcoded literal                              |
| `web/src/components/SettingsModal.tsx` + `messages/core/{zh,en}.json`                  | edit          | First vertical slice (116 literals)                        |
| `web/src/components/Group*.tsx`, `DeviceGroupManager.tsx`, `device-group-messages.ts`  | edit          | Group/device slice (~370 literals)                         |
| `web/src/components/{LeftPanel,SubagentInspectorView}.tsx`, remaining scoped files     | edit          | Shell slice                                                |
| `web/src/mcp-catalog.ts`, `web/src/skill-catalog.ts`                                   | classify/edit | Decide data vs UI per entry (SPEC A-1)                     |
| `web/src/pick-locale.ts`, `web/src/ui-locale.ts`                                       | edit          | BCP 47 canonicalization + `zh-CN`/`zh-Hans` alias          |
| `web/src/i18n/plural.ts`                                                               | new           | `Intl.PluralRules` helper                                  |
| `plugin-sdk/client.mjs`, `plugin-sdk/client.d.ts`, `server/plugins.ts`                 | edit          | `host.i18n` contract                                       |
| `plugins/{notes,live2d,image-toolkit}/client/i18n.mjs` → `plugins/<id>/locales/*.json` | move/delete   | Migrate to host contract                                   |
| `scripts/lib/i18n-catalog.mjs`                                                         | edit          | Plugin dictionary discovery for `i18n:check`               |
| `tests/i18n-browser-test.mjs`                                                          | new           | Real-browser acceptance                                    |

---

## Task 1: Inventory scanner + shrink-only guard

**Purpose:** Turn "1271 hardcoded literals" into a measured, enforced baseline so every later slice is provably a reduction.
**Requirements:** FR-001, FR-002, AS-05.
**Dependencies:** None.
**Work products:** `scripts/i18n-literal-inventory.mjs`; `tests/fixtures/i18n-hardcoded-allowlist.json`; `tests/unit/i18n-hardcoded-guard.test.ts`.

### Steps

- [ ] Write the scanner: walk `web/src/**/*.{ts,tsx}`, skip `web/src/i18n/messages/**`, extract string literals matching `/[\u3400-\u9fff]/` plus UI attributes (`aria-label`, `placeholder`, `title`, `alt`), emit `{file,line,text}` sorted by file/line.
- [ ] Run it and record the baseline count (expect ≈1271 across ≈119 files, per SPEC F4); seed the allowlist with every entry marked `"reason":"pending"`.
- [ ] Add the guard test: rescan, diff against the allowlist, fail with file:line for unknown entries; also fail if an allowlist entry no longer exists (forces same-commit shrink).
- [ ] Run `npx vitest run tests/unit/i18n-hardcoded-guard.test.ts` — green against the seeded baseline.

### Acceptance

- [ ] `node scripts/i18n-literal-inventory.mjs` output matches the allowlist exactly (zero drift).
- [ ] Guard test passes on the seeded tree and fails when a literal is added to any scoped file.

---

## Task 2: Settings surface (first vertical slice)

**Purpose:** Prove the migration pattern end-to-end on the largest single file before repeating it.
**Requirements:** FR-001, FR-003, FR-004, FR-005, NFR-001, NFR-004.
**Dependencies:** Task 1.
**Work products:** `web/src/components/SettingsModal.tsx`; `web/src/i18n/messages/core/zh.json` + `en.json` (new keys).

### Steps

- [ ] Record the baseline: open Settings in `en` and capture the CJK strings still visible.
- [ ] Add keys to `core/zh.json` and `en.json` with identical order and placeholder sets; replace literals with `t()` calls.
- [ ] Run `npx vitest run tests/unit/i18n-catalog.test.ts tests/unit/i18n-hardcoded-guard.test.ts`, then `npm run i18n:sync` and `npm run i18n:check`.
- [ ] Remove the migrated entries from the allowlist in the same commit.
- [ ] Verify in the browser (Settings, all three locales) and commit the slice.

### Acceptance

- [ ] `SettingsModal.tsx` has zero CJK literals; guard green; `i18n:check` exit 0.
- [ ] Settings renders English / Simplified / Traditional correctly with no missing-key fallback visible.
- [ ] NFR-002 holds: new keys live in the built-in `core` dictionaries and add no locale pack to the first-screen bundle (record the pre/post `web/dist` chunk for `core` in the commit message).

---

## Task 3: Group and device-center surfaces

**Purpose:** Migrate the densest cluster of remaining literals, where most of the user-visible Chinese lives.
**Requirements:** FR-001, FR-003, FR-004, FR-005, NFR-004.
**Dependencies:** Task 2.
**Work products:** `GroupWebhooks.tsx` (85), `GroupTaskDetails.tsx` (53), `GroupIntegration.tsx` (52), `DeviceGroupManager.tsx` (50), `GroupDeliveries.tsx` (45), `GroupWorkItems.tsx` (41), `device-group-messages.ts` (41), `messages/core/{zh,en}.json`.

### Steps

- [ ] Split by panel so each commit is reviewable; start with `GroupWebhooks.tsx`.
- [ ] Add module keys, replace literals, keep `device-group-messages.ts` run-state strings as `{key, vars}` metadata where they cross the SSE boundary (the Canvas pattern already used in `canvas-runtime`).
- [ ] After each file: guard test + `i18n:sync` + allowlist shrink + commit.
- [ ] Run the browser check for the group panels in all three locales.

### Acceptance

- [ ] All listed files report zero CJK literals; guard green; `i18n:check` exit 0.
- [ ] Group panels render translated labels in `en`/`zh`/`zh-TW` with no layout break in the panel headers.

---

## Task 4: Shell and remaining components

**Purpose:** Clear the long tail so the allowlist holds only justified data entries.
**Requirements:** FR-001, FR-003, NFR-004.
**Dependencies:** Task 3.
**Work products:** `LeftPanel.tsx` (52), `SubagentInspectorView.tsx` (57), and the remaining scoped files reported by the scanner (~50 files).

### Steps

- [ ] Work through the scanner output ordered by count; batch small files per commit (≤3 files).
- [ ] Reuse existing `core` keys where the meaning matches instead of adding duplicates (dead-key guard catches the opposite).
- [ ] Guard + `i18n:sync` + allowlist shrink per batch.

### Acceptance

- [ ] Guard green with an allowlist containing only `reason:"data"` entries.
- [ ] `npx vitest run tests/unit/i18n-dead-keys.test.ts` green (no orphan keys introduced).

---

## Task 5: Classify the data catalogs

**Purpose:** Decide, per entry, whether `mcp-catalog.ts` (80) and `skill-catalog.ts` (54) hold UI chrome or third-party content, so the SPEC's A-1 exclusion is explicit rather than assumed.
**Requirements:** FR-001, SPEC A-1.
**Dependencies:** Task 4.
**Work products:** `web/src/mcp-catalog.ts`, `web/src/skill-catalog.ts`, allowlist reasons.

### Steps

- [ ] For each CJK literal, record whether it is user-visible chrome (migrate) or shipped third-party text (keep, `reason:"data"`).
- [ ] Migrate the chrome subset; leave content text untouched and documented in the allowlist.
- [ ] Re-run the guard; the allowlist now holds only `data` reasons.

### Acceptance

- [ ] Every remaining allowlist entry has a non-empty `reason` and a file:line that still exists.
- [ ] No third-party catalog description was rewritten (spot-check the diff).

---

## Task 6: BCP 47 locale aliasing

**Purpose:** Accept `zh-CN`/`zh-Hans` as the Simplified source without duplicating dictionaries.
**Requirements:** FR-006, R1, NFR-001.
**Dependencies:** Task 1 (independent of 2–5, may run in parallel).
**Work products:** `web/src/pick-locale.ts`, `web/src/ui-locale.ts`, `tests/unit/pick-locale.test.ts` (extend the existing matrix).

### Steps

- [ ] Add canonicalization (script subtag wins over region when both present) and the alias table from DESIGN §5.
- [ ] Unit-test the matrix: `zh-CN`, `zh-Hans`, `zh-Hans-CN`, `zh-SG` → `zh`; `zh-TW`, `zh-Hant`, `zh-Hant-TW` → `zh-TW`; `zh-HK` → `zh-HK`; `en-US` → `en`; unknown → existing fallback.
- [ ] Run the locale unit tests and the existing `tests/unit/i18n-runtime.test.ts`.

### Acceptance

- [ ] Matrix test green; no new dictionary or pack file added.
- [ ] Saved `localStorage` values from before the change still resolve to the same language.

---

## Task 7: Plural helper

**Purpose:** Cover count-dependent phrases without pulling in an ICU runtime.
**Requirements:** FR-008, R2, NFR-001.
**Dependencies:** Task 2 (first consumer exists).
**Work products:** `web/src/i18n/plural.ts`, unit test, keys where a count phrase exists.

### Steps

- [ ] Implement `pluralForm(locale, count)` over `Intl.PluralRules`.
- [ ] Apply to the count phrases surfaced in Tasks 2–3; keep `zh`/`zh-TW` single-form.
- [ ] Unit-test `en` (`one`/`other`) and `zh` (single form) plus a 0-count case.

### Acceptance

- [ ] `1 file` / `2 files` render correctly in `en`; `zh` renders one form.
- [ ] No existing key renamed; dead-key guard green.
- [ ] NFR-003 preserved: `tests/unit/i18n-runtime.test.ts` still passes with a value containing `{count}` and `$&` (single-pass interpolation unchanged).

---

## Task 8: `host.i18n` plugin contract

**Purpose:** One localization contract for plugins, replacing three private implementations.
**Requirements:** FR-007, FR-009, FR-010, DESIGN D3, Q-2 (client-only).
**Dependencies:** Task 3 (app-side locale plumbing proven).
**Work products:** `plugin-sdk/client.mjs`, `plugin-sdk/client.d.ts`, `server/plugins.ts`, `plugins/{notes,live2d,image-toolkit}/locales/{zh,en}.json`, deletion of the 3 `client/i18n.mjs` files, `scripts/lib/i18n-catalog.mjs` extension, new `tests/unit/plugin-i18n.test.ts`.

### Steps

- [ ] Extend `scripts/lib/i18n-catalog.mjs` with plugin dictionary discovery and reuse its placeholder validation.
- [ ] Add `host.i18n` (`locale`, `available`, `t`) in `server/plugins.ts` and type it in `plugin-sdk/client.d.ts`; push only the active locale + `en` per plugin.
- [ ] Move the 3 dictionaries to `plugins/<id>/locales/`, delete the private `i18n.mjs`, repoint call sites.
- [ ] Unit-test: namespacing, active-locale hit, `en` fallback, key fallback, placeholder mismatch rejection.
- [ ] Verify one migrated plugin in the browser across all three locales (AS-04).

### Acceptance

- [ ] `plugin-sdk/README.md`-documented surface compiles (`npm run typecheck`).
- [ ] `i18n:check` reports plugin drift with non-zero exit on a deliberately broken dictionary.
- [ ] The 3 migrated plugins render translated labels; `md5sum` shows no remaining private i18n copies.

---

## Task 9: Remaining plugin UI labels

**Purpose:** Bring the plugins that actually render labels onto the contract, without a speculative sweep of all 43.
**Requirements:** FR-007, SPEC A-2.
**Dependencies:** Task 8.
**Work products:** `<plugin>/locales/{zh,en}.json` + call-site edits for the plugins whose client entry renders user-visible labels (selection recorded from a scan of `plugins/*/client/entry.mjs`).

### Steps

- [ ] Scan `plugins/*/client/entry.mjs` for rendered label literals; record the list and the accepted count in the plan's evidence log.
- [ ] Migrate in ascending size order, 2–3 plugins per commit, each with its dictionaries.
- [ ] Verify each migrated plugin in the browser once (single locale suffices per plugin; full three-locale run is Task 10).

### Acceptance

- [ ] Every plugin in the accepted list renders no hardcoded label in `en`.
- [ ] Plugins left unlocalized are listed with a reason (no user-visible labels).

---

## Task 10: Real-browser acceptance

**Purpose:** Satisfy the owner's explicit "test in a real live browser" requirement with the repo's existing harness.
**Requirements:** AS-01…AS-07, DESIGN §9.
**Dependencies:** Tasks 2–9.
**Work products:** `tests/i18n-browser-test.mjs`; optional `npm run test:i18n-browser` script entry.

### Steps

- [ ] Model the harness on `tests/canvas-browser-test.mjs` (`playwright-core` + `tests/lib/chrome.mjs` + `tests/lib/ensure-build.mjs`), reusing the port/data-dir helpers.
- [ ] For each locale in `en`, `zh-TW`, `zh-CN`: set the locale, open Settings + group panels + a migrated plugin, assert expected label text and absence of the wrong-script text.
- [ ] Assert runtime locale switch updates the plugin surface without reload (AS-04).
- [ ] Record the run output in the task evidence; wire the script into the existing smoke/CI pattern only if the owner asks.

### Acceptance

- [ ] `node tests/i18n-browser-test.mjs` exits 0 with three per-locale assertion blocks in its output.
- [ ] A deliberately un-migrated string makes the test fail (proving it can detect the regression).

---

## Milestones and push points

| Milestone               | Tasks     | Push                                |
| ----------------------- | --------- | ----------------------------------- |
| M1 Baseline enforceable | 1         | yes (branch `feat/i18n-dehardcode`) |
| M2 Web app migrated     | 2–5, 6, 7 | yes                                 |
| M3 Plugin contract live | 8–9       | yes                                 |
| M4 Browser-proven       | 10        | yes, then PR                        |

## Verification summary (whole plan)

```
npx vitest run tests/unit/i18n-catalog.test.ts tests/unit/i18n-dead-keys.test.ts \
  tests/unit/i18n-runtime.test.ts tests/unit/i18n-hardcoded-guard.test.ts \
  tests/unit/plugin-i18n.test.ts tests/unit/pick-locale.test.ts
npm run i18n:sync && npm run i18n:check
npm run typecheck
node tests/i18n-browser-test.mjs
```

## Out-of-plan (parked, per SPEC non-goals)

- Translation quality review of existing packs; new languages; operator/AI prompt strings; `locales/*.json` format changes; CI restructuring.

## Measured findings while executing (2026-11-15)

The remaining literals are **not** predominantly the mechanical `zh ? "中文" : "…"` form, so no codemod is used:

| Pattern                                                                                                                      | Occurrences      |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `zh ? "中文" : "English"` inside a file that already has `useT()` (mechanical)                                               | 62 (3 files)     |
| Everything else: inline label objects, `isZhLocale(...)` branches, JSX text nodes, thrown error strings, standalone literals | 1,139 (71 files) |

Consequence: Task 4 proceeds per file, reusing an existing `core` key whenever the Chinese text already exists, and the shrink-only allowlist measures each slice. Files are ordered by count (currently `GroupTaskDetails` 56, `GroupIntegration` 54, `DeviceGroupManager` 53, `GroupBlackboardView` 52, `GroupDeliveries` 47, `GroupWorkItems` 44 …).
