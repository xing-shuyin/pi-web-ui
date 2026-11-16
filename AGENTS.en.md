**English** · [简体中文](./AGENTS.md) · [繁體中文](./AGENTS.zh-TW.md)

<!-- prettier-ignore-start -->
# AGENTS.md — pi-web-ui key features → source of truth → docs

> **This file only maps and indexes; it holds no detail rules**: to learn how a capability is changed and which bans apply, read the matching document under `docs/` from the table below.
> Put new rules into the matching `docs/` document (for hard-rule detail follow [`docs/agent-rules.md`](docs/agent-rules.en.md)), and **stop piling paragraphs into this file** — size and dead links are guarded by `tests/unit/agents-md.test.ts`.
> Run `/reload` in pi after changing this file. Full pre-trim backup: `AGENTS.md.bak`.

## 0. What it is

The web chat interface for the pi coding agent (`@earendil-works/pi-coding-agent` SDK): browser conversations, file tree, attachments, built-in terminal, model management, plugin marketplace, Device Center/groups, canvas workflows, Electron desktop shell.
Stack: Node (>= 22.19.0) + Express + `ws` backend · React 19 + Vite frontend · xterm.js + node-pty terminal · single-file `web/src/styles.css` theme baseline. The version number is synced in both `package.json` and `package-lock.json`.

## 1. Key feature → source-of-truth file → docs

| Feature | Source-of-truth file (★ = single source of truth) | Docs |
| --- | --- | --- |
| **Docs master index** (topics / weight / read-by-scenario routes) | — | [`docs/README.md`](docs/README.en.md) |
| Snapshot-driven / protocol single source / concurrent conversations | `server/protocol.ts`★ · `server/agent-service.ts` · `web/src/app-globals.ts` · `web/src/types.ts` (shim) | [`architecture-core.md`](docs/architecture-core.en.md) |
| Sidebar session ordering / user sends pinned to top / conversation↔history-row ownership and identity | `web/src/conversation-order.ts`★ · `server/conversation-rows.ts`★ · `web/src/session-identity.ts`★ · `web/src/components/LeftPanel.tsx` · `web/src/use-chat.ts` | [`architecture-core.md`](docs/architecture-core.en.md#sidebar-history-session-loading) |
| Security boundary (loopback/Origin/Cookie/appUrl) | `server/index.ts` · `server/auth-cookie.ts` | [`architecture-core.md`](docs/architecture-core.en.md) · [`agent-rules.md`](docs/agent-rules.en.md#一communication-protocol-and-data-security) |
| Quick ask / explain selected text | `server/quick-ask.ts` · `web/src/quick-ask.ts` · `web/src/components/QuickAskPopover.tsx` | [`architecture-core.md`](docs/architecture-core.en.md#quick-ask-floating-window) |
| System prompt assembly / settings-save acknowledgement | `server/prompt-composer.ts`★ · `web/src/settings-sync.ts`★ (pending overlay + acknowledgement) | [`architecture-system-prompt.md`](docs/architecture-system-prompt.en.md) |
| Tool toggles / tool prompts / built-in tool overrides | `server/tool-manager.ts`★ · `server/tool-prompts.ts`★ · `server/tool-overrides.ts` · `server/bash-timeout.ts` (single source for the bash/powershell default timeout) | [`agent-rules.md`](docs/agent-rules.en.md#二tool-definitions-and-prompt-rules) · [`tool-context-budget.md`](docs/tool-context-budget.en.md) |
| Context budget / lazy loading / evidence offloading | `server/soft-cap.ts` · `server/request-context.ts` · `server/evidence-tool-hooks.ts` | [`tool-context-budget.md`](docs/tool-context-budget.en.md) |
| Tool approval gate and rule library | `server/tool-approval.ts` | [`architecture-core.md`](docs/architecture-core.en.md#approval-queue-and-shared-display) |
| Built-in browser / three desktop modes / native web bridge | `browser/` · `desktop/browser-host.ts` · `web/src/browser-control.ts` | [`architecture-browser.md`](docs/architecture-browser.en.md) |
| Credential vault (passwords + TOTP, icon toolbar / QR scan / per-site matching / code filling) | `browser/renderer/vault.ts`★ · `browser/runtime/totp.ts`★ · `browser/runtime/qr.ts` · `browser/runtime/credentials.ts` · `desktop/browser-host.ts` (only a projection of passwords is sent down) · `browser/storage/index.ts` | [`architecture-browser.md`](docs/architecture-browser.en.md#credential-vault-passwords--totp) |
| Page script injection (temporary / permanent, `browser_script`) | `browser/runtime/scripts.ts` · `browser/automation/scripts.ts` · `server/browser-script-tool.ts` | [`architecture-browser.md`](docs/architecture-browser.en.md) |
| Custom new-tab page / theme override (`browser_design`) | `browser/runtime/customize.ts`★ · `browser/runtime/manager.ts` · `desktop/browser-host.ts` · `server/browser-design-tool.ts` | [`architecture-browser.md`](docs/architecture-browser.en.md#custom-new-tab-page-and-theme-override-user-edits--agent-designs) |
| Top-left device overlay (list / phone drawer) | `web/src/components/DevicePanel.tsx`★ · `BrandDeviceMenu.tsx` · `DeviceDirectory.tsx` · `use-coarse-pointer.ts` · `styles.css` (`.dp-*`) | [`device-center.md`](docs/device-center.en.md#top-left-device-overlay-desktop-popover--phone-drawer) |
| Mobile app / multi-device switching / native notifications | `mobile/` · `web/src/mobile-runtime.ts` · `server/mobile-push.ts` · `server/device-center/hub-mobile.ts` | [`mobile.md`](docs/mobile.en.md) |
| Terminal PTY / native CLI / bash takeover / SCM | `server/terminals.ts` · `server/terminal-query.ts` (single source for terminal queries/replies) · `server/native-cli.ts` · `server/engine-catalog.ts`★ · `server/engine-cli.ts` · `web/src/components/NativeCliPanel.tsx` · `web/src/components/BottomDock.tsx` · `web/src/components/TerminalPanel.tsx` · `web/src/components/SCMPanel.tsx` | [`architecture-terminal.md`](docs/architecture-terminal.en.md) |
| Command execution anti-hang / hard timeout / background hosting | `server/job-runner.ts`★ (in-process job for `bash({background:true})`) · `scripts/safe-exec.mjs` (source-repo / CI executor) · `server/process-utils.ts` (single source for `killPidTree`) | [`development.md`](docs/development.en.md#command-execution-hang-protection) · [`agent-rules.md`](docs/agent-rules.en.md#七terminal-command-execution-stall-prevention) |
| Attachments / image preview / OCR / annotation / system screenshot | `server/file-save.ts` · `web/src/components/ImageLightbox.tsx` · `plugins/image-ocr/` · `server/system-screenshot.ts` · `server/system-screenshot-macos.ts` | [`architecture-attachments.md`](docs/architecture-attachments.en.md) |
| Plugin system / UI slots / MCP project runtime | `server/plugins.ts` · `web/src/ui-slots.ts`★ · `server/mcp-project-runtime.ts` | [`architecture-plugins.md`](docs/architecture-plugins.en.md) |
| Plugin materialization (code is pure cache) / state directory | `server/plugin-paths.ts`★ · `server/plugin-materialize.ts`★ · `server/fs-copy.ts`★ | [`architecture-plugins.md`](docs/architecture-plugins.en.md#plugin-directories-code-is-a-pure-cache-state-lives-separately-plugin-pathsts--plugin-materializets) |
| Unified TTS / system speech / plugin voices / QQ voice replies | `server/tts-service.ts`★ · `server/tts-system.ts` · `server/tts-routes.ts` · `web/src/tts-client.ts` · `plugins/qq/voice.mjs` | [`architecture-tts.md`](docs/architecture-tts.en.md) |
| Subagent / conversation messaging / worktree / takeover | `server/subagents.ts` · `server/conversation-identity.ts` · `#take_over_conversation` | [`architecture-core.md`](docs/architecture-core.en.md) · [`root-cause-boundaries.md`](docs/root-cause-boundaries.en.md) |
| Goal mode 2.0 / delegation / plan mode | `server/goal-service.ts` · `server/delegate-mode.ts` · `server/plan-mode.ts` | [`goal-conversation-design.md`](docs/goal-conversation-design.en.md) · [`agent-rules.md`](docs/agent-rules.en.md#四architecture-and-runtime-constraints) |
| Unattended / always-on executor / `alwaysOn` plugin | `server/background-executors.ts`★ · `server/plugins.ts` (`ensureLoaded` scope) · `manifest.alwaysOn` | [`unattended-operation.md`](docs/unattended-operation.en.md) |
| DSH preset / questionnaire / bottom-bar stats | `server/dsh-*.ts` · `server/dsh/dsh-usage.ts` | [`dsh-engine.md`](docs/dsh-engine.en.md) |
| Sandbox workspace | the execution session identity chain listed in `docs/architecture-sandbox.md` | [`architecture-sandbox.md`](docs/architecture-sandbox.en.md) |
| Device Center / group Bot / remote desktop / file sync | `server/device-center/` (`hub-conversations.ts` · `task-recovery.ts` · `desktop*.ts`) | [`device-center.md`](docs/device-center.en.md) · [`device-collaboration.md`](docs/device-collaboration.en.md) · [`device-desktop.md`](docs/device-desktop.en.md) · [`device-file-sync.md`](docs/device-file-sync.md) |
| **Bot independence / direct chat / independent memory** | `server/device-center/direct-rooms.ts`★ · `server/device-center/bot-memory.ts`★ · `server/bot-memory-tool.ts` · `web/src/components/AgentBotsSection.tsx` | [`agent-bot-design.md`](docs/agent-bot-design.en.md) |
| Hub online upgrade / release-package acceptance | `bin/hub-upgrade.mjs`★ · `server/device-center/hub-upgrade.ts` · `tests/hub-upgrade-release-test.mjs` | [`device-center.md`](docs/device-center.en.md#hub-online-upgrade) · [`hub-upgrade-release-testing.md`](docs/hub-upgrade-release-testing.en.md) |
| Canvas collaboration (versions / runs / artifacts) | `server/canvas/` · `server/workspace-handle.ts` (shared worktree primitives) | [`architecture-canvas.md`](docs/architecture-canvas.en.md) |
| Preset import and export / community sharing | `server/preset-share.ts` · `server/preset-fields.ts` | [`preset-sharing.md`](docs/preset-sharing.en.md) |
| Localization / module dictionaries / language-pack sync | `web/src/i18n/catalog.ts`★ · `web/src/i18n/messages/` · `scripts/lib/i18n-catalog.mjs` | [`i18n.md`](docs/i18n.en.md) |
| UI layout / theme / style hard rules | `web/src/styles.css` · `themes/` | [`agent-rules.md`](docs/agent-rules.en.md#三ui-layout-and-style-rules) |
| Directory structure and full file inventory | — | [`directory-reference.md`](docs/directory-reference.en.md) |

## 2. Engineering flow

| Topic | Docs | Common entry points |
| --- | --- | --- |
| Dev workflow / CI | [`development.md`](docs/development.en.md) | `npm run dev` · `npm run typecheck` · `npm run lint` · `npm test` · `npm run test:smoke` · `npm run ci:local` (reproduces the CI gate locally) |
| Test conventions | [`development.md`](docs/development.en.md) | ports ≥8900, data-dir `mkdtemp`, `pkill -f` banned, smoke tests must not use `ensure-build.mjs` |
| Release | [`release.md`](docs/release.en.md) | `npm run changelog:i18n` → commit → tag `vX.Y.Z` (desktop/notes automatic) → mobile bundle `npm run release:local -- vX.Y.Z --skip-desktop` → `npm run release:npm` → `npm run release:check` |
| Deployment | [`deployment.md`](docs/deployment.en.md) | `pi-web-ui server install` · `docker compose up -d` |
| Full environment-variable table | [`env-vars.md`](docs/env-vars.en.md) | `PI_WEB_PORT` · `PI_WEB_HOST` · `PI_WEB_CWD` · `PI_WEB_DATA_DIR` · `PI_WEB_TOKEN` · `PI_WEB_SDK` |

## 3. Hard rules (detail in `docs/agent-rules.md`; every guard test maps to `tests/unit/<guard>.test.ts`)

| Domain | One-line ban | Guard test |
| --- | --- | --- |
| **Security/protocol** | `details` ≤64KB; server URLs must be wrapped in `appUrl()`; decode the Cookie before validating it; the passphrase form on the unauthenticated page must be a native `POST /__pi/auth` (never assemble `?token=` in JS) | `auth-login` |
| **Prompts/tools** | Tool prompts keep three separate responsibilities and are concise, English only; exported schemas keep only field names/types (no decorative constraints, no self-explanatory field descriptions) | `tool-prompt-hygiene` · `tool-schema-slim` · `lazy-tools-test` |
| **Prompts/tools** | A new toggleable tool is wired in three places (catalog / customTools / registration unit test) | `tool-registration` |
| **Prompts/tools** | The prompt base (SYSTEM.md / APPEND_SYSTEM.md) belongs to the session's loader; a client-level "most recent" field is banned | `prompt-base-scope` |
| **Server/runtime** | Compaction soft cap is monitored at two layers; switching models goes only through `applySessionModel` | — |
| **Server/runtime** | Session takeover must roll back transactionally; use stable identity across awaits, never read active | `takeover-rollback-test` |
| **Server/runtime** | Workspace commands (set_cwd/new_chat/switch_*/sandbox) always go through the `server/workspace-queue.ts` queue; if `new_chat.cwd` cannot switch, no session is created | `workspace-queue` · `pending-workspace` |
| **Server/runtime** | No synchronous child processes on the server (`spawnSync`/`execSync`/`execFileSync`); hot paths use async spawn or static derivation | `sync-child-process-guard` |
| **Server/runtime** | Far-future timers >6h must be chunked with `armDelay`; preset sharing must sanitize against a whitelist + dryRun | `plugin-cron-overflow-test` · `preset-share` |
| **Frontend/styles** | Solid-filled text in accent/semantic colours goes through `--accent-contrast` / `--on-*`; theme text tokens have a contrast floor | `accent-contrast` · `semantic-contrast` · `theme-text-contrast` |
| **Frontend/styles** | Long text/path overflow triad; `overscroll-behavior: contain` only on standalone floating layers; a card header only carries its own copy button | `text-wrap` · `messages-behind-composer` |
| **Frontend/styles** | Stacked floating layers never hard-code z-index — always `useOverlayZIndex()`; the strip above the composer has the single source `--composer-strip`; never turn the phrase row back into `absolute` | `overlay-stack` · `messages-behind-composer` |
| **Frontend/state** | Left-panel 「运行中对话 / 历史会话」 (running conversations / historical sessions) row ownership is decided only by `server/conversation-rows.ts` (`rowKind`), identity goes only through `web/src/session-identity.ts`; never write an ad-hoc key in a component | `session-identity` · `conversation-row-declared` |
| **Plugins/dependencies** | Host-provided packages go only into `peerDependencies` (child-process copies into `optionalDependencies`) | `extension-host-packages` |
| **Plugins/dependencies** | The copy blacklist is decided only by `server/fs-copy.ts` on relative paths; plugin code directories are rebuildable and state lives only in `plugin-data/<id>/` | `plugin-copy-single-source` · `plugin-bundled` |
| **Plugins/dependencies** | The marketplace builtin list `plugins/catalog.json` only holds plugins shipped in this repo under `plugins/<id>`; third-party plugins register in the community catalog repo | `plugin-catalog-builtin-scope` |
| **Plugins/dependencies** | Changing a built-in plugin always bumps the `manifest.json` version and syncs the data directory; a plugin `arrange.label` rename must land in the render layer | `plugin-version-bump-guard` · `bar-item-unified` |
| **Test conventions** | Session/guard fakes always go through `tests/helpers/fake-session.ts` (defaults derived from production source); hand-rolled `Object.create` is banned (the existing allowlist may only shrink; delete the line once migrated) | `fake-session-sync` · `fake-session-adoption` |
| **Terminal/execution** | Long-running services use `bash({background:true})` (stoppable from the panel); dead commands in the source repo/CI use `safe-exec` (hard timeout + process-tree kill + logs on disk first); no foreground watch/pager/waiting on stdin, no hand-written `timeout`/`nohup` prefixes | `safe-exec` |

## 4. Pre-commit triple check (CI hard gate)

1. `npx prettier --write <changed files>`
2. `npm run typecheck` (zero errors across 5 tsconfigs; unit-test mocks use `{} as any`)
3. `npx vitest run <related unit tests>`
<!-- prettier-ignore-end -->
