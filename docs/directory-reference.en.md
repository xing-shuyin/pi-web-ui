**English** · [简体中文](./directory-reference.md) · [繁體中文](./directory-reference.zh-TW.md)

# Directory tree reference (directory-reference)

> Source: the full §3 of `AGENTS.md` before the 2026-09 trim (backup at `AGENTS.md.bak`) plus files added since.
> Conventions: `★` = single source of truth / entry point, read first; numbers in inline comments (tool counts, slot counts, etc.) are authoritative only in the source;
> new files get a placeholder in the tree first, comments are filled in later (the file header comment is authoritative).
> When adding a top-level file, `server/*.ts`, `web/src/*` or a component, update this document in the same change.

## Top level

```
pi-web-ui/
├── server/                     # Backend (Node ESM, compiles to dist/server/)
├── web/                        # Frontend (React + Vite, compiles to web/dist/)
├── bin/pi-web-ui.mjs           # CLI: foreground start / server install|uninstall|start|stop|restart|status
├── desktop/                    # Electron desktop shell (sidecar: starts dist/server on a random free port + BrowserWindow)
│   ├── main.ts                 # Main process: ready → pick a free port → spawn server(ELECTRON_RUN_AS_NODE) → loadURL
│   ├── electron-builder.yml    # Packaging config (win nsis / mac dmg / linux AppImage; npmRebuild:false)
│   └── README.md               # Desktop app notes: getting it running / conventions / release / signing (SignPath)
├── deploy/                     # Deployment examples: launchd plist / systemd unit / Windows task XML
├── themes/                     # Built-in themes (full stylesheets: :root variables plus arbitrary selector/layout overrides; styles.css is only the shared baseline)
├── make-light-theme.mjs        # Theme generator (builds a pure palette from the :root variable list in styles.css)
├── tests/                      # All test scripts (self-contained: dedicated port ≥8900 + temporary data-dir)
│   ├── run-smoke.mjs           # Zero-token protocol smoke aggregator runner (ALL list; plugin background jobs / catalog sync plugin-jobs-test, multi-root workspace
│   │                           #   workspace-roots-test — both are in it)
│   ├── unit/                   # vitest pure-function unit tests (plugin UI extension points: plugin-ui-manifest / ui-slots / context-menu /
│   │                           #   plugin-grants / plugin-project / plugin-installer / plugin-catalog-sync; multi-root workspace: workspace-roots)
│   │                           #   plugin settings (declarative schema / select candidate values): plugin-settings / plugin-setting-options
│   ├── *-test.mjs              # Hand-written Playwright E2E / WS protocol tests
│   │                           #   ⚠ browser E2E that needs Chrome does **not join run-smoke**; run it manually with `node tests/<name>.mjs` (auto-SKIP when Chrome is missing):
│   │                           #     context-menu-ui-test (context menu slots) / ui-layout-ui-test (layout page ↔ UI consistency) / plugin-settings-page-test (plugin settings page) / plugin-settings-select-ui-test (plugin settings dropdown) / plugin-topbar-ui-test (top bar items + in-panel background uninstall) / elsewhere-click-takeover-ui-test (left-click two-step takeover confirmation on the 「另一处」(Elsewhere) row)
│   └── scratch/                # One-off debug scripts (gitignored, not committed)
├── scripts/check-protocol-sync.mjs  # Guards the types.ts shim single-source mechanism + protocol.ts pure-type constraints
├── scripts/safe-exec.mjs       # Cross-platform anti-hang executor: stdin grounded + hard timeout/idle timeout kills the process tree (reusing killPidTree) + logs to disk + --detach daemon hosting + --wait/--status(JSON) polling; logs land in .safe-exec/ (gitignored)
├── .github/workflows/ci.yml    # CI: protocol sync → typecheck → build → vitest → smoke
├── .github/workflows/release-notes.yml   # tag push → create/update the GitHub Release from CHANGELOG
├── .github/workflows/desktop-release.yml  # tag push → windows-latest builds the NSIS installer and attaches it to the Release (signing gets added here later)
├── extensions/                 # pi extension: webui.ts (/webui command starts the local server and opens the browser)
├── plugins/                    # Official plugins (webmail / db-client / vscode-editor / sftp / demo-mailbox / mermaid / run-trace / legado-web / wechat-ilink / image-toolkit / notes / live-preview / voice-input / desktop-use / pm2-manager, each directory has its own README.md; page-picker/extension is a **browser extension**, not a pi-web-ui plugin)
│   └── catalog.json            # ★ Plugin marketplace built-in list (shipped with the package; only accepts plugins/<id> from this repo, third-party plugins go through the community catalog repo)
├── dev/                        # Local dev helpers (notice/search previews etc., not in the npm package)
├── Dockerfile / docker-compose.yml
├── docs/                       # Detailed docs (architecture-core / architecture-attachments / architecture-terminal /
│                               #   architecture-plugins / architecture-system-prompt / goal-conversation-design /
│                               #   tool-context-budget / agent-rules (coding hard rules) /
│                               #   device-center / device-collaboration / architecture-canvas / architecture-sandbox /
│                               #   development / release / deployment / dsh-engine / antigravity-proxy / env-vars + this file)
└── tsconfig.server.json / tsconfig.extensions.json / tsconfig.tests.json / web/tsconfig.json
```

## server/

```
server/
├── index.ts                # Entry: express static + /ws endpoint, message dispatch, heartbeat, graceful shutdown
├── protocol.ts             # ★ Single source of truth: wire protocol types (client↔server messages)
├── protocol-version.ts     # wire protocol version (a mutually incompatible old tab is displaced)
├── agent-service.ts        # Core: ClientSession (one session group per client, multiple conversations in parallel) + AgentService
├── serialize.ts            # SDK message → UiMessage serialization
├── message-window.ts       # On-demand server-side history loading: tail window (count + character budget) + load_earlier_messages paging backwards; hooked into the per-connection send funnel, works across all four engines
├── text-sniff.ts           # File preview pure functions (previewKind/looksLikeText/decodeText/sniffImageMime/hexDump/countLines)
├── queue-utils.ts          # Queued message pure functions (removeFirstOccurrence: removes only the first match, duplicate text is not removed along with it)
├── process-utils.ts        # Process utilities: snapshotListeningPorts/killPidTree/lookupProcessName
├── client-state.ts         # ClientStateStore: persists to <dataDir>/client-state.json
├── uploads.ts              # File conversation uploads + retention cleanup
├── bg-servers.ts           # Background task tracking (port snapshot diff before/after bash + liveness refresh + auto-cleanup past the idle threshold / 📌pin)
├── settings-service.ts     # Settings panel state machine
├── preset-share.ts         # ★ Settings preset import/export/sharing/community catalog (exchange format pi-web-ui-preset v1: allowlist sanitization, SSRF containment, gh issue fallback to a prefilled web page, 5-minute index.json catalog cache; orchestration goes through PresetSharePort, see docs/preset-sharing.md)
├── preset-fields.ts        # Fields a preset can carry + grouping (zero dependencies, shared by frontend and backend; a compile-time guard aligns the full ClientSettings set)
├── goal-service.ts         # Goal / review loop / research wizard
├── i18n.ts                 # Server-side language negotiation + translation table registration (resolveServerLang/pick/bilingual/getServerBlock)
├── locales.ts              # Downloadable language packs (the core ships zh/en only; other languages come from the serverStrings section of a language pack)
├── tool-manager.ts         # ★ Unified Agent tool switch: AGENT_TOOL_CATALOG + the tool_manage entry (setAgentToolEnabled/applyAgentToolsGating); only disabledAgentTools is persisted
├── tool-approval.ts        # Human-in-the-loop interception and rewrite-then-run (HITL: Edit & Run); the gate lives in ClientSession.askApproval
├── approval-rules.ts       # ★ Approval rule store and matching engine (ApprovalRulesStore: <dataDir>/approval-rules.json, multi-tool/multi-field/multi-pattern rules; ask/deny/allow actions; pure-function evaluation)
├── compact-context-tool.ts # ★ Active context compaction tool (compact_context): the AI trims the context for the current task on its own, controls the kept range, and it takes effect after the turn
├── compaction-markers.ts   # Compaction transcript markers + repair (issue #235)
├── context-budget.ts       # Multi-tier layered context budget trimming (gradient trimming before triggering an LLM full-text summary)
├── soft-cap.ts             # Custom context compaction soft cap (Soft Cap, issue #229/#773; pure functions normalize/effective/softCapToReserve/softCapReserveFor: the last computes reserve=cw-cap injected into the SDK, so compaction runs in tool gaps within the turn)
├── dangling-tools.ts       # Dangling toolCall detection and repair (issue #280)
├── edit-tool.ts            # Overrides built-in edit: forwards exact replacement unchanged, `soft: true` switches to line-core matching (the former edit_soft tool was merged in and has no separate switch)
├── read-tool.ts            # Overrides built-in read: lists directory entries when the path is a directory (reusing the SDK ls semantics, everything else forwarded to the built-in unchanged; the behavior switch readDirEnabled lives on the Tools page in settings and is not in AGENT_TOOL_CATALOG)
├── present-files-tool.ts   # ★ AI file presentation (present_files): read-only probe of stat / unknown-extension sniffing / text excerpt → structured items via toolResult details → frontend preview card; never auto-opens any window
├── skill-tool.ts           # Lets the AI fetch a skill's full text by name (catalog + skill tool)
├── claim-files-tool.ts     # File claiming (claim_files): a heads-up before parallel conflicts
├── claim-store.ts          # File claim store + touch sidecar
├── conversation-read-tool.ts # Lets the AI (subagents included) read other conversations (list shows runs + history, read pages through)
├── conversation-touches.ts # Extraction of a conversation's "touched file set" (pure functions, zero node dependencies)
├── question-params.ts      # ★ Single source for the structured question schema (the rich variant goes to ask_user_question; communicate / conversation accept only a plain-text message, and questions/answers are folded into the internal structure in the state machine)
├── delegate-task.ts        # Structured dispatch tool delegate_task (code-level hardening of the delegation protocol)
├── eval-tool.ts            # Controlled persistent code-evaluation sandbox tool (eval, opt-in)
├── hashline-engine.ts      # High-reliability patch engine anchored on content hashes with syntax-block parsing
├── patch-tool.ts           # Structured patch tool exposed to the AI (Hashline Patch Tool)
├── lsp-tool.ts             # Native LSP language-server tool exposed to the AI
├── plan-manager.ts         # Structured task plan board and step state machine (Plan Mode / Step State Machine)
├── schedule-agent-tool.ts  # Exposes the built-in scheduler to the agent (issue #193)
├── scheduler-tasks.ts      # Built-in scheduled task scheduling (issue #184): task CRUD + cron/interval triggers + headless execution
├── tool-info.ts            # Tool definition info (right-click a tool card → show tool details): fetch the SDK / DSH runtime tool definition by name → `tool_info` (the definition is a large object and stays out of the snapshot; returns `unsupported` when DSH cannot provide it)
├── tool-prompt-overrides.ts # Per-tool copy overrides (Settings → Tools → Edit copy): normalization + patches description/snippet/guidelines on the session _toolRegistry (factory definitions are never touched and can be restored)
├── load-tools-tool.ts      # Lazy tool loading entry (load_tools): the catalog (name + one-line summary) sits in the system prompt and the model pulls parameter schemas into the conversation on demand
├── tool-prompts.ts         # Single source of truth for the model-visible bash / edit tool copy (description/snippet/guidelines/parameter schema), shared by multiple execution paths
├── subagents.ts            # First-party subagents: the single conversation tool (spawn/get_result/steer/list/stop/templates/wait_all/handoff) + runtime snapshot
├── subagent-templates.ts   # Subagent template library (global <dataDir>/subagent-templates.json; allowlist semantics; optional model/thinking level, empty = follow the main conversation; enabled=false hides it from the AI)
├── subagent-templates-hant.ts # Traditional Chinese (Taiwan usage) copy for built-in subagent templates; shared by zh-TW/zh-HK/zh-Hant, a display/lookup view only, never written back to the store
├── wait-subscription-scan.ts # Pending wake subscription scan (keeps conversations that have a subagent wake pending)
├── slash-commands.ts       # Slash commands (NATIVE_COMMANDS built-in command interception + catalog push)
├── prompt-composer.ts      # Free-form composition template for the main session system prompt ({{token}} expands before every run)
├── model-admin.ts          # Model/provider configuration management (including multi-key built-in providers: provider-keys.json + add/activate/remove_provider_key; the model catalog reuses the system default instead of copying it; reasoning_levels / supported_reasoning_levels[].effort self-reported by a gateway /models derive a model-level thinkingLevelMap that carries through save/merge/publish, see issue #771)
├── model-enrich.ts         # Fills in parameters for custom provider model rows from the public model catalog
├── provider-oauth-flow.ts  # See the file header comment
├── resolve-global-sdk.ts   # Resolution hook preferring the global/ancestor pi SDK copy (issue #260)
├── sdk-origin.ts           # Which pi SDK copy this process actually loaded and which copies are shadowed (issue #260)
├── update-check.ts         # Update check across sources (app / pi core / DIRECT extensions)
├── managed.ts              # Externally managed instances (self-update: top bar update badge + panel)
├── attachments.ts          # Attachment building (path/line-range references + imageData/fileData + vision bridge; content is not injected)
├── attachment-store.ts     # Attachment storage based on SHA-256 content addressing (CAS)
├── file-archives.ts        # See the file header comment
├── file-transfer-routes.ts # See the file header comment
├── office-parse.ts         # Plain-text extraction from Office documents (docx / xlsx, for previews and attachments via file_content)
├── composer-drafts.ts      # Single central file for unsent composer drafts (<dataDir>/composer-drafts.json, issue #166)
├── webui-context.ts        # Extension UI bridge (WebUIContext: widgets/statuses/dialog → browser)
├── themes.ts               # Theme management (listThemes/resolveThemeFile)
├── tabs.ts                 # Instance capability tab selection (Chat / Terminal / Git / Search / …)
├── plugins.ts              # Optional UI component plugins (scans <dataDir>/plugins/<id>/ code; state lives in <dataDir>/plugin-data/<id>/; renderer plugins use view:false + renderers)
├── plugin-api-catalog.ts   # Machine-readable registration surface catalog (slot key/kind/occupants/example)
├── plugin-catalog.ts       # Plugin marketplace list (builtin plugins/catalog.json + user-defined <dataDir>/plugin-catalog.json) + catalog sync pure functions (normalizeSyncPayload/writeCustomCatalog, issue #148)
├── plugin-catalog-sync.ts  # Marketplace catalog sync orchestration (fetch/validate/atomic write/optional install/reload + re-push, issue #148)
├── plugin-conversation-view.ts # ★ Conversation-selection policy for plugin conversation snapshots (#542: pick the conversation this tab is viewing by clientId / skip subagents by default and fall back + model-change dedup key, pure functions)
├── plugin-dom.ts           # Privileged DOM access grant table (<dataDir>/plugin-dom.json)
├── plugin-facilities.ts    # Plugin host facilities: plugin-private KV storage + encrypted secrets
├── plugin-grants.ts        # Plugin directory grant table (<dataDir>/plugin-grants.json): "remember" grants for directories outside the workspace (a parent directory covers its subdirectories), revocable in the settings panel
├── plugin-install-spec.ts  # "Read the spec before installing" (guided install)
├── plugin-installer.ts     # ★ Plugin background jobs: install/update/uninstall run a CLI child process (no user terminal occupied, settings panel not interrupted), output streamed line by line + single-job lock + watchdog (issue #152)
├── plugin-llm.ts           # Plugin direct model calls (the layer under host.llm.complete: one-off isolated session with no tools)
├── plugin-manifest-validate.ts # manifest body validation (rejected as soon as the schema fails)
├── plugin-permissions.ts   # Dynamic plugin capability grant table (the layer under host.requestPermission)
├── plugin-project.ts       # ★ Plugin project assembly execution layer (host.project.create: clone/write files/git init; three path-escape checks, authorization is decided upstream, this module never touches grants)
├── plugin-bundled.ts       # First-time materialization of bundled plugins (built-in modules + `preinstall` candidates from the catalog; the acknowledgement decides "installed", a half-broken directory is repaired in place, issue #856)
├── plugin-materialize.ts   # ★ Single source for plugin directory materialization: staging + acceptance + acknowledgement (.pi-materialized.json) / fill missing only / overwrite upgrade
├── plugin-paths.ts         # ★ Single source for plugin code and state directories (`plugins/<id>` = pure cache; `plugin-data/<id>` = settings/secrets/schedules, idempotent migration from the old layout)
├── plugin-schedule.ts      # Cron parsing and persistence for plugin scheduled tasks (the layer under host.schedule; schedules.json goes to the state directory)
├── plugin-tool-guard.ts    # Plugin tool interception extension points (pre + post, covering only bash/read that have been taken over)
├── plugin-updater.ts       # Plugin update helper (code directory backup/rollback + remote sha comparison; the state directory is not involved)
├── fs-copy.ts              # ★ Directory copy primitive: skip rules are matched on **relative paths** (an absolute path containing node_modules would filter out the whole tree); includes file listing / empty-directory cleanup
├── mcp-bridge.ts           # MCP tool bridge (wires tools from external stdio MCP servers into a pi session)
├── mcp-hot-reload.ts       # mcp.json hot reload (takes effect on save, no restart)
├── icon-svg.ts             # Validation and normalization of plugin inline SVG icons (manifest `iconSvg`)
├── host-metrics.ts         # See the file header comment
├── http-proxy.ts           # Proxy setting pass-through (~/.pi/agent/settings.json + environment variables)
├── auth-cookie.ts          # pi_web_token cookie encode/decode (decodeCookieToken; dirty values are returned as-is)
├── auth-login.ts           # Logged-out page form login contract (POST /__pi/auth redirect sanitization sanitizeNextPath)
├── vision-bridge.ts        # Vision bridge: transcribes images for a text-only main model
├── files-service.ts        # File service (readDirForUI/readFile/searchFiles/watcher)
├── workspace-snapshot.ts   # Workspace version shadow snapshot (Workspace Snapshot / Dual-State Rollback)
├── scm.ts                  # Read-only SCM git queries (execFile git status/branches/history/filediff/commit)
├── scm-commitmsg.ts        # AI commit-message generation (prompt assembly + reply cleanup; git collection lives in scm.ts)
├── patch-node-pty.ts       # Self-healing patch for node-pty × Node --watch compatibility
├── patch-remote-catalog.ts # Whole-table model catalog replacement patch for pi.dev (idempotently rewrites the SDK remote-catalog-provider: after a refresh the built-in provider list equals the full official catalog, no built-in legacy models kept and no "N new models" report)
├── ensure-bash.ts          # Lightweight bash fallback for Windows (busybox-w32)
├── control-socket.ts       # Local control socket (status / quiesce / unquiesce)
├── launch-origin.ts        # ★ Launch origin detection: whether this instance is supervised by launchd/systemd/a Windows watchdog (a precondition for "Restart service" in the update panel)
├── terminals.ts            # TerminalManager (PTY management + incremental output/keystroke tools)
├── marker-service.ts       # Marker service (a built-in pi-marker-tools)
├── dsh/                    # DSH engine (see docs/dsh-engine.md for details): dsh-agent-service / dsh-client / dsh-serialize /
│                           #   dsh-sessions / dsh-usage (pure mapping for footer stats) / preset-clones (file: clones) / probe-*.mjs /
│                           #   runtime/{launcher.mjs, goal-rpc.mjs (questionnaire answerer + skill hooks attached to the agent scope), custom-prompt.mjs, cordis.yml, override.patch.yml, runtime-root.mjs}
└── markers/                # Marker subsystem (pairs with marker-service.ts): index / marker / registry / store / builtins
```

## web/src/

Commented entries are frequently used or carry mechanism; the rest are self-describing by filename, read the source (`use-*.ts` are all React Hooks; `*.css` has a single exception, model-management.css):

```
web/src/
├── App.tsx             # Top-level layout
├── main.tsx            # Entry: apply the theme before the first frame to avoid a flash + initAuthToken
├── use-chat.ts         # ★ useChat(): WebSocket connection management, reducer state machine, terminal bridge
├── app-globals.ts      # ★ Global runtime store (engine/managed/tabs/version + global sender appSend)
├── types.ts            # ★ wire protocol re-export shim (export type * from "../../server/protocol")
├── protocol-version.ts # Protocol version constants
├── i18n.tsx            # ★ Localized copy (core zh/en; add a new key to both; value must be a string literal, see the UI layout and style rules in docs/agent-rules.md)
├── pick-locale.ts      # Locale selection helper
├── styles.css          # ★ All styles (sectioned per component, with commented dividers); also the default dark theme itself
├── model-management.css # Styles specific to the model management page (the only second css file)
├── theme.ts            # Theme switching (/api/themes list + localStorage persistence + applyTheme)
├── wallpaper.ts        # Wallpaper (a theme companion resource)
├── sounds.ts           # WebAudio notification sounds
├── notify.ts           # Desktop/OS notifications (PWA): decision on whether to swallow a notification (Windows minimized detection) + diagnostics
├── download.ts         # Downloads (fetch→blob, bypassing Chrome Safe Browsing)
├── base-url.ts         # appUrl(): prefixes server URLs with the app root (required for subpath deployments)
├── auth-token.ts       # PI_WEB_TOKEN passphrase injection
├── ui-slots.ts         # ★ Host UI extension point engine: BUILTIN_UI_ITEMS + buildUiSlots (four-layer merge: host defaults → plugin contributions → plugin arrange → user preferences) + splitOverflow/restoreUiItem
├── slot-toolbar.tsx    # Per-component *HostNodes + renderMergedToolbar
├── topbar-fit.ts       # ★ Pure function for "whatever does not fit goes into ⋯" in the top bar (fitTopbar): drops from the tail by measured width, zero-width items take no space and do not enter the menu, everything is kept when width cannot be measured, unit tested
├── context-menu-state.ts # ★ Generic context menu state (open/close for contextmenu.* slots + positioning/disable/keyboard-navigation pure functions, unit tested)
├── use-floating-panel.ts # ★ Unified floating panel hook (scroll/resize only recomputes the anchor; only mousedown/Escape close it)
├── composer-bridge.ts  # ★ Composer injection bridge: the module-level sink registration point where the host (extensions/plugins) pushes content into the composer draft, unit tested
├── composer-draft.ts   # Draft merge/dedup + advanceComposerSession (attachments follow the conversation) pure functions, unit tested
├── use-composer-session.ts # Composer-to-conversation binding hook
├── caret-visual-line.ts # ★ First/last visual line detection for the composer caret (measures offsetTop on a mirror div), used by ↑/↓ to page through input history, unit tested + real-browser regression
├── prompt-history.ts   # Input history (↑/↓) storage
├── message-delta.ts    # message_delta incremental patch pure functions, unit tested
├── lazy-window.ts      # Message list lazy windowing pure functions, unit tested
├── search-folded.ts    # Search helper for collapsed regions
├── present-items.ts    # ★ present_files card pure functions (argument parsing / merge with details / capability decision / auto-open gate), unit tested
├── present-settings.ts # Card preferences: auto-open the preview dialog (localStorage, off by default) + dedup table of toolCallIds already opened
├── file-preview-bridge.ts # Module-level sink from tool cards → file preview dialog (App registers the opener)
├── file-transfer.ts    # Frontend file transfer logic (pairs with FileTransferDialog + file-transfer-routes)
├── tool-info-state.ts  # Module-level store for the tool definition dialog (open/close/response → view, pure functions + unit tests)
├── footer-status.ts    # ★ Footer built-in status slot module store (plugin setFooterStatus → the host:cost cell; `content.render` is handed to the host floating panel, useSyncExternalStore)
├── tool-prompt-state.ts # Default-value store for the per-tool copy editor (get_tool_prompt response → view, pure functions)
├── tool-schema.ts      # Parameter JSON Schema → table rows (name/type/required/description, pure functions + unit tests)
├── tool-args.ts        # Tool card header argument hint pure functions (safe extraction of path/timeout, dirty arguments never throw), unit tested
├── skill-block.ts      # parseSkillBlock: <skill> block parsing, unit tested
├── image-paste.ts      # Proportional downscale of pasted images to ≤1568px + PNG/JPEG transcode
├── message-image.ts    # In-message image rendering helper
├── export-image-state.ts # Image export state
├── uuid.ts             # randomUuid (crypto fallback), unit tested
├── pending-question.ts # Pending question recovery (UiState.pendingQuestion → restores the dialog)
├── optimistic-queue.ts # Pure functions reconciling local optimistic updates for streamed queued/jumped messages and withdrawals against the authoritative snapshot (unit tested)
├── question-attachments.ts # Question attachment chips
├── plugin-host.ts      # Plugin host bridge (window.__piWebUiHost, host API timing)
├── plugin-loader.ts    # Plugin client bundle loading (including view:false lazy loading / preload)
├── plugin-fence.ts     # Fenced-code renderer plugin matching
├── plugin-file-handlers.ts # Plugin file handlers
├── plugin-logs.ts      # Plugin log view data
├── plugin-phase.ts     # Plugin lifecycle phases
├── plugin-setting-options.ts # Plugin setting select candidate values
├── plugin-icon.tsx     # Plugin icon rendering
├── at-mention.ts       # @-mention completion
├── slash-filter.ts     # Slash command filtering
├── quick-phrases.ts    # Quick phrases
├── conv-groups.ts      # Conversation grouping (left panel)
├── copy-text.ts        # Copy-text helpers
├── use-copy-feedback.ts # Copy feedback hook
├── scroll-classify.ts (in components/, see below)
├── banner-notice.ts    # Top bar notice data
├── browser-control.ts  # Browser control bridge logic (pairs with the BrowserControl component + page-picker extension)
├── cache-stats.ts      # Cache stats (footer)
├── chat-width-settings.ts # Chat column width setting
├── code-lines.ts       # Code line-number helpers
├── desktop.ts / desktop-updater.ts # Desktop shell frontend side (update check/restart)
├── model-usage.ts      # Model usage stats
├── panel-sash.ts       # Panel sash (drag to resize)
├── provider-oauth-state.ts # Provider OAuth frontend state (pairs with ProviderOAuthControls)
├── rollback-state.ts   # Rollback (workspace-snapshot) frontend state
├── scm-commit-history.ts / scm-history-filter.ts / scm-quote.ts / scm-sidebar.ts # SCM panel helper modules
├── scrollbar-gutter.ts # Scrollbar gutter
├── shortcut-stack.ts   # Shortcut stack
├── stream-markdown.ts  # Streaming Markdown rendering
├── swipe-drawer.ts / use-swipe-drawer.ts # Mobile drawer swipe gesture (pure decision + DOM glue)
├── term-touch.ts       # Terminal touch support
├── thinking-levels.ts  # Thinking level tiers
├── tip-position.ts     # Tip positioning
├── title-settings.ts   # Title settings
├── token-input.ts      # Token input field
├── touch-device.ts     # Touch device detection (IS_TOUCH)
├── update-command.ts   # Update command assembly
├── use-click-outside.ts # Close on outside click (shared by floating panels)
└── components/         # See below
```

## web/src/components/

| Component                                                                                 | Responsibility                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FilePreview.tsx`                                                                         | File preview dialog: line numbers, click/drag/Shift selection, add to conversation; the Markdown preview can toggle the raw text; editable and saveable                                                                                                                                                                                                                                            |
| `PluginFilePreview.tsx`                                                                   | Host for file previewers provided by plugins                                                                                                                                                                                                                                                                                                                                                       |
| `PresentedFiles.tsx`                                                                      | `present_files` tool card body: inline display/playback for images/video/audio, leading excerpt for text + a Preview button; each row offers preview/open locally/show in folder/download/copy path; a `focus` entry auto-opens the preview dialog per preference (three gates)                                                                                                                    |
| `ToolInfoDialog.tsx`                                                                      | Tool details dialog (right-click a tool card): shows the tool **definition** (description/parameter schema table + raw JSON), fetched on open and kept out of the snapshot; portals to body (message flow ancestors have overflow/transform)                                                                                                                                                       |
| `ToolPromptEditor.tsx`                                                                    | Per-tool copy editor (Settings → Tools → Edit copy): description/snippet/guidelines fields, empty = default; saving goes through `set_settings.toolPromptOverrides`                                                                                                                                                                                                                                |
| `ToolApprovalDialog.tsx`                                                                  | Approval dialog (human-in-the-loop interception when an ask rule matches + rewrite-then-run)                                                                                                                                                                                                                                                                                                       |
| `LeftPanel.tsx`                                                                           | Left panel: recent projects, running conversations, conversation history (with delete)                                                                                                                                                                                                                                                                                                             |
| `RightPanel.tsx`                                                                          | Right panel tab container (file tree / source control / plugin tabs): file tree browsing (list_files); clicking a filename → preview, with buttons for 🔗 reference path (path only, no content injected) / 👁 preview / ⬇ download; native recursive watcher on the server                                                                                                                         |
| `ChatInput.tsx`                                                                           | Composer + attachment chips (reference/line range/image/upload/web page/conversation, color-coded); whole-window drop target; followUp queueing / steer jumping in; slash command picker                                                                                                                                                                                                           |
| `Message.tsx` / `MessageList.tsx`                                                         | Message rendering (attachment cards, streaming cursor, tool result linkage); edit-and-reask keeps the original attachments; skill card collapsing; lazy windowing; dual-channel question navigation; streaming StreamMarkdown                                                                                                                                                                      |
| `StreamMarkdown.tsx`                                                                      | Streaming Markdown rendering component (pairs with stream-markdown.ts)                                                                                                                                                                                                                                                                                                                             |
| `ToolCallBlock.tsx` / `ThinkingBlock.tsx` / `BashBlock`                                   | Tool call cards (card header shows key argument hints `.toolcall-path`/`.toolcall-timeout`, dirty arguments stay silent), thinking block, bash output                                                                                                                                                                                                                                              |
| `TerminalPanel.tsx` / `TermXterm.tsx`                                                     | Terminal view + xterm instance bridging; the instance tab strip lives in the panel header, the left column is a persistent command rail (`.term-cmd-rail`, width draggable) and the tab strip only appears at the top of the right column, degrading to a second-level page covering the right column on narrow screens                                                                            |
| `BottomDock.tsx`                                                                          | Bottom full-width panel: height (`pi-web-ui:bottom-dock-h`), collapse, drag handle, all tabs kept mounted (terminal + plugin `bottomdock.tabs`)                                                                                                                                                                                                                                                    |
| `SCMPanel.tsx`                                                                            | Source control (Git) view: status/branch/diff; commit/push/pull/switch branch; the left panel width is adjustable with a drag sash, resets on double-click, width stored in localStorage (#139)                                                                                                                                                                                                    |
| `BrowserControl.tsx`                                                                      | Top bar Browser entry + status panel; one-click reference to conversation for authorized pages (with a single page, the button becomes the page title)                                                                                                                                                                                                                                             |
| `TopBar.tsx` / `FooterBar.tsx`                                                            | Top bar (model/thinking level/background tasks/sound/new conversation/view switch), footer (context/cost/working directory); a single flat flow, slots laid out in order + `hostNodes`                                                                                                                                                                                                             |
| `FooterSlotPopover.tsx`                                                                   | **Shell** of the footer built-in status slot floating panel (owned by the host): portal + `use-floating-panel` positioning (above the anchor by default, flips when it does not fit, clamped to the viewport) + scroll/resize following + close on outside click/Esc + focus return; plugins fill content only through `content.render(container)` in `footer-status.ts` and never touch the shell |
| `Dialog.tsx`                                                                              | Extension `ui.select/confirm/input` → browser dialog (body/options render richly through `Markdown(rawHtml)`)                                                                                                                                                                                                                                                                                      |
| `Modal.tsx`                                                                               | Generic modal shell                                                                                                                                                                                                                                                                                                                                                                                |
| `QuestionDialog.tsx`                                                                      | Model question dialog (`question_pending`, shared by DSH via goal-rpc / pi via `ask_user_question`): single choice/multi choice/custom text + rich `preview` for options; attached to `UiState.pendingQuestion` and restored after a refresh                                                                                                                                                       |
| `DshPresetBar.tsx`                                                                        | DSH Agent preset bar (mode switch + first-turn lock)                                                                                                                                                                                                                                                                                                                                               |
| `DshPermissionBar.tsx`                                                                    | DSH permission notice bar                                                                                                                                                                                                                                                                                                                                                                          |
| `ModelConfigModal.tsx` / `PiSetupModal.tsx`                                               | models.json management / first-run setup wizard                                                                                                                                                                                                                                                                                                                                                    |
| `ProviderOAuthControls.tsx`                                                               | Provider OAuth authorization controls                                                                                                                                                                                                                                                                                                                                                              |
| `SettingsModal.tsx`                                                                       | Settings panel (the extension group lays out three menus side by side: skills/MCP/plugins; the plugin page splits into installed plugins / plugin marketplace; DSH additionally has a questionnaire page and a patch page, and no tools page)                                                                                                                                                      |
| `InstalledPluginsPanel.tsx`                                                               | Installed plugins as a single-column collapsible list: UI plugins and Pi extensions in one list, clicking a row expands its config / plugin pages / logs or registered capabilities, and enable/disable writes back to the two fields respectively                                                                                                                                                 |
| `PluginSettingsForm.tsx`                                                                  | Plugin declarative settings form (schema-driven)                                                                                                                                                                                                                                                                                                                                                   |
| `PromptTemplates.tsx`                                                                     | Prompt template management                                                                                                                                                                                                                                                                                                                                                                         |
| `GoalBar.tsx`                                                                             | Goal bar above the composer: set goal/clear/AI refinement/round count dropdown                                                                                                                                                                                                                                                                                                                     |
| `PlanBoard.tsx`                                                                           | Structured task plan board (pairs with plan-manager.ts)                                                                                                                                                                                                                                                                                                                                            |
| `BgTasksModal.tsx`                                                                        | Background tasks dialog: processes listening on ports that the AI started                                                                                                                                                                                                                                                                                                                          |
| `SchedulerPanel.tsx`                                                                      | Scheduled tasks panel (pairs with scheduler-tasks.ts)                                                                                                                                                                                                                                                                                                                                              |
| `ModelThinking.tsx`                                                                       | Model + thinking level dropdown (filter by provider + search at the top)                                                                                                                                                                                                                                                                                                                           |
| `GlobalSearchModal.tsx`                                                                   | Global search dialog (Ctrl+K): search conversation history/recent projects/workspace filenames; the result row context menu goes through `contextmenu.search`                                                                                                                                                                                                                                      |
| `ProjectPicker.tsx`                                                                       | Project picker                                                                                                                                                                                                                                                                                                                                                                                     |
| `LocaleModal.tsx`                                                                         | Language switcher dialog                                                                                                                                                                                                                                                                                                                                                                           |
| `PluginView.tsx`                                                                          | Plugin view host: a thin React shell + dynamic import of the client bundle                                                                                                                                                                                                                                                                                                                         |
| `PluginViewFallback.tsx`                                                                  | Fallback when a plugin view fails to load                                                                                                                                                                                                                                                                                                                                                          |
| `PluginFenceBlock.tsx`                                                                    | Fenced-code renderer plugin block (pairs with plugin-fence.ts)                                                                                                                                                                                                                                                                                                                                     |
| `PluginMenu.tsx`                                                                          | Plugin menu panel (floating, via useFloatingPanel)                                                                                                                                                                                                                                                                                                                                                 |
| `PluginModal.tsx`                                                                         | Plugin modal host (host.openModal)                                                                                                                                                                                                                                                                                                                                                                 |
| `SlotTabs.tsx`                                                                            | Slot-driven tab container (shared by `rightpanel.tabs` and the settings panel): everything except the current selection stays unmounted and unmounts on switch; no tab strip is drawn with only one tab; selection stored in localStorage                                                                                                                                                          |
| `SlotErrorBoundary.tsx`                                                                   | Error boundary for slot content                                                                                                                                                                                                                                                                                                                                                                    |
| `ContextMenu.tsx`                                                                         | Generic context menu render layer (`contextmenu.*` slots): portal + fixed + render first, then clamp by measured size; render only, item clicks go back to the host's `onAction`                                                                                                                                                                                                                   |
| `PluginPage.tsx`                                                                          | Host for plugin custom settings pages (`settings.pages` slot): mounts/unmounts with the selection; only the plugin writes the container's children                                                                                                                                                                                                                                                 |
| `CollapsedMessage.tsx` / `LazyMount.tsx`                                                  | Collapsed message summary row / message-level lazy mount wrapper                                                                                                                                                                                                                                                                                                                                   |
| `SearchBar.tsx`                                                                           | In-conversation search bar (Ctrl+F, CSS Custom Highlight API highlighting)                                                                                                                                                                                                                                                                                                                         |
| `HoverDetail.tsx`                                                                         | Floating detail (the body of a ? hint, pairs with HintTip positioning)                                                                                                                                                                                                                                                                                                                             |
| `RollbackDialog.tsx`                                                                      | Workspace rollback confirmation (pairs with workspace-snapshot.ts)                                                                                                                                                                                                                                                                                                                                 |
| `SaveImageDialog.tsx`                                                                     | Image save dialog                                                                                                                                                                                                                                                                                                                                                                                  |
| `FileTransferDialog.tsx`                                                                  | File transfer dialog (pairs with file-transfer.ts)                                                                                                                                                                                                                                                                                                                                                 |
| `BannerContainer.tsx`                                                                     | Notice bar container (pairs with banner-notice.ts)                                                                                                                                                                                                                                                                                                                                                 |
| `NotifyToggle.tsx`                                                                        | Sound/notification toggles (including the hidden notification diagnostics panel `SHOW_NOTIFY_TEST_PANEL`)                                                                                                                                                                                                                                                                                          |
| `Markdown.tsx` / `Dropdown.tsx` / `copy-button.tsx` / `HintTip.tsx` / `SoundSettings.tsx` | Shared pieces (HintTip: `?` floating hint rendered by a top-level portal)                                                                                                                                                                                                                                                                                                                          |
| `mermaid.ts` / `scroll-classify.ts`                                                       | Non-component helpers (mermaid rendering / scroll classification, stored alongside the components)                                                                                                                                                                                                                                                                                                 |
