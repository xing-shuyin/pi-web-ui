**English** · [简体中文](./issue-885-triage.md) · [繁體中文](./issue-885-triage.zh-TW.md)

# Issue #885 triage: Full Pi CLI inheritance + unified extension management

> Read-only verification, no logic changes. A parallel PR is running, so this round only writes this document and does not touch `SCMPanel` / `vscode-editor` files.
> Verification date: 2026-11-13; working directory `E:/pi-web-ui`; no gh token, the remote issue body wasn't fetched, so triage follows the "epic (7 sections, 11 acceptance items)" from the task description.

## Conclusion up front (for non-technical readers)

- **The "#885: no inheritance at all" claim does not hold**: WebUI and Pi CLI already share the same `agentDir` (default `~/.pi/agent`), and `auth.json / models.json / mcp.json / skills` are the same files; SDK built-in extensions load too.
- **The second half of #885 does hold**: what's missing is the "unified management UI" and "explicit declarations that prevent overwrites". That is: users can't see whether "this extension comes from Pi CLI / WebUI / external", can't see error details when it breaks, have to hunt through several places to toggle it, and there's no one-click refresh.
- **Worth doing, but not all at once**: the inheritance chain is the foundation (wired up), the management UI is the layer above (5–6 pieces missing). Doing it all at once touches runtime, settings, plugin marketplace and MCP hot reload simultaneously, conflicts easily with parallel PRs, and any single regression keeps sessions from starting. Split it into 6 independently shippable small tasks; the first step is only the "read-only inventory", zero risk.

## 1. What was read this time (evidence chain)

| File                                      | What was read                                                                                                                                                          | Conclusion                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `server/agent-service.ts:4055`            | `const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir()`                                                                                                    | Shares `agentDir` with the SDK; the env var can override                                            |
| `server/agent-service.ts:3743–3789`       | The `ClientSession` constructor stores `this.agentDir`, and `agentDir: () => this.agentDir` is passed to `SettingsService`                                             | All sessions share one directory identity                                                           |
| `server/agent-service.ts:4233, 4319`      | `getSdkBuiltinExtensionFactories()` + `disabledBuiltinExtensions: ["mcp"]`; `extensionsOverride` filters by `disabledExtensions`                                       | SDK built-ins are loaded; only `mcp` is explicitly disabled to use the in-house bridge              |
| `server/sdk-builtin-extensions.ts:25–81`  | `resolveSdkExtensionsIndexPath()` → `builtInExtensions` (skipping `mcp`), falling back to `codemode / tool-search` (`hidden: true, replaceable: true`)                 | Built-in extensions come from the SDK package itself; hidden but replaceable                        |
| `server/mcp-bridge.ts:13–36`              | `getGlobalMcpPath(agentDir)` → `<agentDir>/mcp.json`; `getProjectMcpPath(cwd)` → `<cwd>/.pi/mcp.json`; plus legacy `dataDir/mcp.json` compatibility                    | MCP two-layer inheritance: global + project                                                         |
| `server/agent-service.ts:4284–4315, 9295` | `discoverDiskSkills({ cwd, agentDir, workspaceRoots })` + `mergeSkillCollections(res.skills, discovered)`, then filtering by `disabledSkills / enabledSkills / preset` | Skill two-layer inheritance: SDK built-ins + disk discovery merged                                  |
| `server/client-state.ts:846–880`          | `isExtensionDisabled / isExtensionEnabled` + `extensionKeyCandidates`; `isInternalExtension` (`<inline: / <builtin: / hidden`) is never disabled                       | Custom Pi CLI extensions are inherited, but internal extensions are locked on and can't be disabled |
| `server/plugins.ts:2561–2720`             | `ensureLoaded({ scope: "all" \| "alwaysOn" })`; `ensureAlwaysOnLoaded` only pulls `manifest.alwaysOn` on boot without WS, the rest activate lazily                     | WebUI plugins are a separate system, fully separate from SDK extensions                             |
| `server/tool-manager.ts:1–60`             | Only tool-name constants and gates (`CANVAS / TERMINAL / MCP_MANAGE / SKILL` etc.), no extension loading                                                               | Tool toggles ≠ extension management; don't conflate them                                            |

In one sentence: **the foundation is wired up (same agentDir + same MCP/Skill/Extension filters), the layer above is missing (unified view + unified toggles + error details + one-click refresh + overwrite declarations)**.

## 2. What is already inherited today

1. **Identity directory**: `agentDir` as a single source of truth; `auth.json` (login), `models.json` (models), `mcp.json` (global MCP), `skills/` (global skills), `sessions/`, `bot-sessions/` are all shared. Change the Pi CLI login and WebUI takes effect immediately, and vice versa.
2. **SDK built-in extensions**: `codemode / tool-search` etc. are injected into `createAgentSessionServices({ extensionFactories })` via `getSdkBuiltinExtensionFactories()`. `mcp` is the only disabled built-in extension (it uses WebUI's own `McpBridge` to avoid double-running).
3. **MCP config**: global `<agentDir>/mcp.json` + project `<cwd>/.pi/mcp.json` merged in two layers, plus legacy `dataDir/mcp.json` as a fallback. The `mcp_manage` tool description lists both paths too.
4. **Skills**: SDK `res.skills` merged with the local `discoverDiskSkills`, supporting `global / project / ancestor / package` scopes, then gated by presets and `disabledSkills`.
5. **Third-party extension filtering**: custom extensions installed by Pi CLI show up in `res.extensions`; WebUI toggles them via `disabledExtensions / enabledExtensions` (matched by `extensionKeyCandidates`), and internal extensions (`hidden / <inline: / <builtin:`) are forcibly kept.

## 3. What's missing (what #885 really needs)

1. **No unified list**: SDK extensions, WebUI UI plugins (`server/plugins.ts`) and MCP servers each speak their own language. The settings page shows WebUI plugins' `来源 owner/repo` (source owner/repo — `pluginCatalogSource` copy already exists), but not the source of SDK extensions (Pi CLI / WebUI / external).
2. **No unified toggle**: SDK extensions go through `disabledExtensions`, skills through `disabledSkills`, WebUI plugins through `alwaysOn + lazy activation`. To turn off one capability, users have to guess which kind it is.
3. **No error details**: errors from `bindExtensions({ onError: makeExtensionErrorReporter })` only go to notices / logs; there's no panel answering "which extension broke, why, and where to retry". `alwaysOnSnapshot()` has a health snapshot, but only `/api/health` uses it and the frontend never shows it.
4. **No one-click refresh**: MCP has hot reload (`mcp-hot-reload.ts` watches `mcp.json`), WebUI plugins have `rescanAlwaysOn` (only failed always-on plugins), SDK extensions have nothing. The three aren't combined into one "refresh" button.
5. **No explicit overwrite declaration**: the precedence of `<agentDir>/mcp.json` vs `<cwd>/.pi/mcp.json` vs `dataDir/mcp.json` exists only in code (`mcp-bridge.ts`), not in docs or the UI. Users don't know whether project config overrides global config, and are even more lost after changing `PI_CODING_AGENT_DIR`.

## 4. Breakdown: 6 independently deliverable subtasks

> Principle: read-only first → display only → then toggles → loading last. Each item can ship as its own PR and roll back on its own.

### T1 — Unified extension inventory read-only API + docs (S)

- What: assemble a read-only aggregate server-side (SDK `extensions` + WebUI `plugins.list()` + MCP `listAllMcpServers`), with at least `id / kind(sdk-extension | webui-plugin | mcp-server | skill) / source(Pi CLI / WebUI / external / built-in) / enabled / error?`; logs + docs only first, no UI wiring.
- Acceptance: call the new endpoint once and see all three kinds of entries with a non-empty `source`; built-in extensions with `hidden:true` are labelled "built-in" and excluded from counts; a unit test covers the aggregate function.
- Estimate: **S (under 1 day)**.
- Why first: zero UI risk, and T2–T6 all depend on this inventory contract.

### T2 — Add "source" display to the settings page / plugin marketplace (S)

- What: display only. Add `来源：Pi CLI / WebUI / 外部` (source: Pi CLI / WebUI / external) copy + an error-tip entry to existing plugin rows / extension rows, without touching any toggle logic. File changes limited to `docs/ + at most 1 display file`; `claim_files` first.
- Acceptance: the three source kinds are distinguishable in the UI; `无来源信息` (no source info, `uiPluginNoSource`) stays as is; no logic changes, `typecheck + related unit tests` pass.
- Estimate: **S**.
- Depends on: the `source` contract from T1.

### T3 — Unified toggles: connect the three switch systems (M)

- What: converge `disabledExtensions / disabledSkills / disabledAgentTools` and WebUI plugin enablement into one "desired extension state"; disabling an `alwaysOn` resident plugin requires explicit confirmation (so background-executor dependencies aren't cut off).
- Acceptance: clicking disable in the unified list → the matching `disabled*` persists + takes effect on session `reload`; re-enabling restores it; internal extensions (`isInternalExtension`) refuse disabling with a reason.
- Estimate: **M (2–4 days)**.
- Risk: touches runtime gates; needs joint testing with the goal-mode / delegate-mode tool gates.

### T4 — Error details + one-click refresh (M)

- What: converge `makeExtensionErrorReporter` errors, `alwaysOnSnapshot()` and `mcp-hot-reload` failures into an "extension details drawer"; one "refresh" button calls `session.reload() → rescanAlwaysOn() → mcp reload` in order, with progress and results per step.
- Acceptance: simulate a broken MCP server / broken plugin and see an error stack summary + a "retry" button; recovers after refresh without restarting the server.
- Estimate: **M**.
- Depends on: the T1 inventory; does not touch conversation takeover logic.

### T5 — Explicit overwrite declaration: precedence docs + UI hints (S)

- What: document `mcp-bridge.ts` precedence (`agentDir/mcp.json > dataDir/mcp.json` legacy, project `.pi/mcp.json` merged with global) and the `PI_CODING_AGENT_DIR` override semantics in docs + a small settings-page hint; when necessary, confirm with "you are overriding global config" on write.
- Acceptance: docs state clearly which of the three paths wins; changing project MCP in the UI shows an "affects this project only" hint; a unit test locks the `getGlobalMcpPath / getProjectMcpPath` order.
- Estimate: **S**.
- Why independent: docs + copy only, zero runtime risk, mergeable any time.

### T6 — MCP project runtime convergence (L)

- What: converge `mcp-project-runtime.ts` (project state), `McpBridge` (the bridge) and the background executor's `allowedServers` into the `mcp-server` entries of the T1 inventory; automatically `prepare/retain` on project switch, and a failure must not kill the whole session.
- Acceptance: the MCP list updates automatically after switching projects; a single server failing to start only marks that server red while the session stays usable; integration unit tests exist.
- Estimate: **L (about 1 week, can be split further)**.
- Last: involves multi-session concurrency + sandbox gates, the largest surface.

## 5. Why not do it all at once

1. **Too large a surface**: 7 sections and 11 acceptance items span runtime (`agent-service`), plugin host (`plugins`), the MCP bridge and settings UI; merging at once replaces three switch systems simultaneously, and you wouldn't know which part to roll back.
2. **Conflict-prone**: another parallel task is changing the display layer (this task avoided `SCMPanel` / `vscode-editor`); a big PR is guaranteed to collide.
3. **Asymmetric risk**: T1/T2/T5 are read-only + copy, mergeable any time; T3/T4/T6 touch the runtime, where one regression means "sessions won't start / all tools gone". Build the inventory contract with the small ones first; only then dare to touch the big ones.
4. **Acceptance testability**: once split, each item has a "visible done state" (inventory callable / source visible / toggle remembered / error retryable); done in one shot, the 11 acceptance items blur together and you can't tell what broke.

## 6. Recommended first step

**Do T1 only (read-only aggregate + unit test + this document)**. Reason: no UI, no runtime, no file contention with parallel PRs; once the inventory contract is fixed, T2's display copy, T3's toggles and T4's error details share a common language. If even T1 feels heavy, merge just this document and start on T1 next time.

As required, this task **made no T2 code changes** (only this one .md document was changed), so there are no display file changes and no `claim_files` reservation.

## 7. Whether to commit

- **Recommend committing this document**: it only adds `docs/issue-885-triage.md`, has no logic changes, `prettier` has been run, and it doesn't affect builds or parallel PRs.
- Before committing: `npx prettier --write docs/issue-885-triage.md` (already done) is enough; `typecheck / full build` are not run per the task requirements.
- Next (separate PR): T1 read-only API, or T2 pure display (remember `claim_files` + at most 1 display file + avoid `SCMPanel` / `vscode-editor`).

## Appendix: one sentence for maintainers

WebUI already inherits Pi CLI's stuff; stop spreading the "no inheritance at all" claim. The real debt is "can't see it, can't turn it off, don't know who to ask when it breaks". Add the inventory (T1) and the source display (T2) and #885 is half done.

## 8. Landing record (2026-11-13, T1–T6 fully wrapped up)

> This section was appended by the wrap-up PR: local changes only, no automatic commit; parallel PRs are still running, and plugins/vscode-editor and SCMPanel.tsx were avoided; new UI copy is written bilingually inline, without touching en.json/zh.json (avoiding #884).

### 8.1 What changed (file list)

| Task                   | File                                            | Notes                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 read-only inventory | server/extension-inventory.ts (new)             | Pure function buildExtensionInventory + read-only collection collectExtensionInventory, three source kinds with a unified shape; failures only record the original error, never throw, never change runtime |
| T1 query channel       | server/protocol.ts                              | Adds UiExtensionInventoryEntry/Source + ClientMessage extension_inventory + ServerMessage extension_inventory_data                                                                                          |
| T1 read-only branch    | server/dispatch-plugin-handlers.ts              | case extension_inventory: SDK built-ins + WebUI plugins + MCP + disabled set, aggregated read-only then send                                                                                                |
| T2 source display      | web/src/components/ExtensionInventory.tsx (new) | Source badge CLI/WebUI/external + enabled state + description, display only; error text in a red box + one-click refresh; overwrite hint at the bottom                                                      |
| T2 mounting            | web/src/components/SettingsModal.tsx            | Mounted at the top of the extensions tab, no new route; server data first, local snapshot as fallback; appSend on entering the tab                                                                          |
| T2/T3/T4 state         | web/src/use-chat.ts                             | Adds extensionInventory + extension_inventory_data intake                                                                                                                                                   |
| T3 unified toggles     | SettingsModal + ExtensionInventory              | WebUI uses disabledPlugins; CLI uses disabledExtensions (built-ins hidden with switchable:false, greyed out + reason); MCP parses mcp:scope:name and uses toggle_mcp_server; never silently skips           |
| T4 refresh             | same as above                                   | Original error + one-click refresh (extensions_reload + plugins_reload + reload_mcp + extension_inventory), no reinstall needed                                                                             |
| T5 overwrite           | section 8.2 of this doc + settings page hint    | Comparison table + inherited read-only, Web-only writable, overrides must be explicit and reversible                                                                                                        |
| T6 consistency         | section 8.3 of this doc                         | Session/model share agentDir, no broken chain; gaps are documented only, no extra process                                                                                                                   |
| Guard                  | tests/unit/extension-inventory.test.ts (new)    | 4 cases: three-kind assembly / disabled+error surfaced / stable ordering / one source failing doesn't throw                                                                                                 |

### 8.2 Inherited vs WebUI-specific comparison table (T5 overwrite declaration)

| Capability                    | Inherited (read-only display)                                                                                                         | WebUI-specific (writable)                                                                     | Override semantics (explicit, reversible)                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity directory agentDir   | PI_CODING_AGENT_DIR ?? getAgentDir(), auth.json / models.json / mcp.json / skills / sessions shared by all sessions                   | None (WebUI doesn't start its own directory)                                                  | Changing the env var switches identity and requires a session restart; documented explicitly, never silent                                                   |
| SDK built-in extensions       | codemode / tool-search (hidden:true, isInternalExtension exempts from disabledExtensions), source CLI, cannot be toggled individually | None                                                                                          | Greyed out + SDK doesn't support individual toggling, display only; no fake switch                                                                           |
| Pi CLI third-party extensions | resourceLoader.getExtensions() → settings.extensions, toggled via disabledExtensions, source CLI                                      | None (inherited)                                                                              | Off can be turned back on; persists disabledExtensions + takes effect via session.reload(), reversible                                                       |
| WebUI UI plugins              | None                                                                                                                                  | pluginMgr.list() → chat.plugins, via disabledPlugins + alwaysOn/lazy activation, source WebUI | Enabled on install; disabling a resident plugin requires explicit confirmation, reversible                                                                   |
| MCP global                    | agentDir/mcp.json, inherited with agentDir, source external                                                                           | Writable (global page)                                                                        | Project .pi/mcp.json overrides same-named globals (overriddenBy:project), UI shows scope; changing global affects all projects, reversible with confirmation |
| MCP project                   | cwd/.pi/mcp.json, inherited with cwd                                                                                                  | Writable (affects this project only)                                                          | Writes the project file only, never touches global; reload(cwd, scope) takes effect immediately, reversible                                                  |
| Skills                        | SDK built-ins + discoverDiskSkills(cwd, agentDir) merged, via disabledSkills                                                          | Project/global skill files can be added/removed                                               | Preset + disabled gates stack, docs state precedence explicitly, reversible                                                                                  |
| Model/session selection       | models.json / auth.json under the same agentDir, switching models doesn't break the chain or start a process                          | Switch model within the session (setModel)                                                    | Gaps are documented + architecture notes only, no duplicate process (T6)                                                                                     |

Settings page hint (already in ExtensionInventory.tsx, written inline in both languages):

> Inherited entries are read-only; only WebUI-specific entries are writable. Overrides must be explicitly marked reversible. / 继承的只读展示，Web 专属才可写；必须覆盖时显式标注可逆

### 8.3 T6 consistency verification (session/model share agentDir, no broken chain)

- Session: agent-service.ts constructs ClientSession as new ClientSession(clientId, cwd, agentDir), with agentDir = PI_CODING_AGENT_DIR ?? getAgentDir() as the single source; settingsSvc / mcpProjects / SessionManager all hang off the same directory.
- Model: auth.json / models.json in the same directory; setModel / setDefaultModel only swap the in-session model reference, never rebuild agentDir or start another SDK process.
- MCP: listAllMcpServers({agentDir, cwd, dataDir, bridge}) merges the same global+project set; after toggle/save/reload, mcpProjects.reload(cwd, scope) + broadcastMcpServers + pushSettings, no broken chain.
- Conclusion: no gaps require extra processes; this PR closes its gaps with docs + explicit architecture notes only, consistent with T6's no-duplicate-process rule.

### 8.4 The 11 acceptance items, one by one (this PR's scope)

1. T1 — all three inventory sources present: SDK built-ins + WebUI plugins + MCP global/project, all three source values non-empty — extension-inventory.ts + dispatch-plugin-handlers.ts, covered by unit tests.
2. T1 — unified read-only shape: name/source/enabled/version/description/error; collection failures only record error, no runtime changes — same as above + protocol.ts types.
3. T2 — source badge + state + description, display only: CLI/WebUI/external badge + enabled/disabled + description — ExtensionInventory.tsx.
4. T2 — mounted at an existing entry, no new route: mounted at the top of the SettingsModal extensions tab — same as above.
5. T3 — WebUI toggles use the existing path: disabledPlugins — toggleInventoryWebui.
6. T3 — CLI/MCP pass through or grey out: CLI built-ins hidden with switchable:false, greyed out + reason copy; MCP toggle_mcp_server; never silently skipped — ExtensionInventory + SettingsModal.
7. T4 — original error + one-click refresh, no reinstall: error text in a red box + extensions_reload/plugins_reload/reload_mcp — same as above.
8. T5 — comparison table + hint: section 8.2 of this doc + hint at the bottom of the component — docs + component.
9. T5 — overrides explicit and reversible: project overriding global with explicit scope + reversible reload/persistence — documented declaration + reuse of existing mcp-manager semantics.
10. T6 — shared agentDir, no broken chain: session/model/MCP in the same directory — verified in 8.3.
11. T6 — gaps documented only, no extra processes: no new processes/daemons — this PR adds no runtime process, as proven by unit tests + typecheck.
