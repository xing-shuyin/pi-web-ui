**English** · [简体中文](./dsh-engine.md) · [繁體中文](./dsh-engine.zh-TW.md)

# pi-web-ui × DeepSeek Harness (dsh) dual-engine rework — handoff document

> This document is for **cross-conversation handoff**: it records settled decisions, completed work, in-progress/blocked state, remaining plans and all environment facts.
> When a new conversation starts: **read this file first**, then read the code and comments under `E:/pi-web-ui/server/dsh/`, and continue from "what to do next".
> Current time: early morning 2026-09-01 (the conversation has driven the dsh engine core conversation path through full-chain verification).

---

## 0. Goals (three decisions the user signed off)

1. **Engine switchable**: switch at startup with the `PI_WEB_ENGINE=pi|dsh` environment variable (default pi), effective after restart; the frontend shows an engine badge; `/api/health` returns an `engine` field.
2. **Identical UI features**: the dsh engine must fully align with the current pi-web-ui wire protocol (protocol.ts) — goals/review, SCM, background tasks, settings panel, model config, plugins, terminal, message deltas (message_delta/snapshot/snapshot_delta/tool_status) all work.
3. **Architecture = server-side engine dispatch**: keep the existing pi path unchanged; add `server/dsh/` (ported and adapted from ds-web-ui + upgraded to the current protocol); `server/index.ts` picks the implementation class by engine. Same wire protocol, minimal frontend changes.

---

## 1. Environment facts (measured, don't re-check)

| Item                             | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace                        | `E:/pi-web-ui` (pi-web-ui repo, current project)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Reference implementation         | `E:/ds-web-ui` (xing-shuyin's DSH port of pi-web-ui, **reference only**, uses the old split packages `0.1.0-rc.6`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Node                             | v24.20.0 (managed by fnm)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| DeepSeek key                     | `deepseek.key` in `~/.pi/agent/auth.json` (**user re-supplied sk-f0e6…d99 on 2026-09-01, len 35**), **reusable by the dsh runtime** (that is what ds-web-ui does). ⚠️ clear-provider-key-test wipes it — back it up before running, restore it afterwards (dsh already honors PI_CODING_AGENT_DIR, so normal tests no longer touch the real auth.json)                                                                                                                                                                                                                                                                                                                                                                                 |
| Global dsh runtime               | Install the latest version (e.g. `npm i -g @deepseek-ai/dsh` or `@deepseek-ai/dsh@0.2.1-rc.2`). Its **nested tree** `dsh/node_modules/@deepseek-ai/` (300+ packages) is the complete runtime tree (dsh-base/dsh-app-boot/all tools/loader peers are all in there). ⚠️ **dsh-base is not under top-level `npm root -g/@deepseek-ai/` (only the dsh package is), so runtime tree resolution must check the nested location** (runtime-root.mjs handles it)                                                                                                                                                                                                                                                                               |
| pi-web-ui local dsh dependencies | Already updated to the latest in package.json: `@deepseek-ai/dsh-sdk-jsonrpc-server@^0.2.1-rc.2`, `@deepseek-ai/dsh-sdk-protocol@^0.2.1-rc.2`. `goal-rpc.mjs` automatically prefers linking dependencies of the same origin as the current runtime tree, keeping the tree self-consistent.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Version families and policy**  | Latest baseline alignment: `dsh@0.2.1-rc.2`, `dsh-sdk-jsonrpc-server@0.2.1-rc.2`, `dsh-sdk-protocol@0.2.1-rc.2`. Version families are split by major.minor (e.g. `0.2`). ✨ **Default permissive runtime policy (no version pinning, latest by default)**: the launcher tries to start with the newest available runtime it detects in the environment or globally (preferring the highest version in the same family); on a different version family it only prints an advisory instead of exiting early, staying as forward-compatible as it can; only when boot actually fails and versions mismatch does it suggest version troubleshooting; to force blocking cross-version mixing, explicitly set `PI_WEB_DSH_STRICT_VERSION=1`. |

---

## 2. DSH research findings (critical, they determine the implementation strategy)

### 2.1 JSON-RPC protocol surface (latest official 0.1.5-rc.3, still a minimal surface)

- **Only 3 RPC methods**: `initialize` (cwd/provider/model/maxTokens), `session/prompt` (sessionId + contentBlocks → returns `{messageId}`, **creating a session implicitly on demand**), `shutdown`.
- **Notifications**: `session.event` (sessionId + event, all persisted events), `session.status` (running/idle), `subagent.started` / `subagent.finished`.
- **Explicit official limits**: no per-session close, no prompt cancellation, no per-prompt result → **abort = hard-kill the runtime process**, **model switch = restart the runtime**, **session management/listing/replay = read JSONL directly**.
- One provider/model per process; when `initialize` has no provider adapter, the dsh-llm-deepseek fallback is attached automatically.

### 2.2 Runtime composition (proven bootable)

- Use `boot(binName, configPath, patches, prepare, bareModuleBaseUrl)` from `@deepseek-ai/dsh-app-boot`: config = empty `[]`, patches = [dsh-base bundle patch, override patch].
- **dsh-base bundle** = the shared base of every official profile (78 lines: llm/session/agent/agent-loop/settings-file/credentials-local/jsonl persistence/all tools/goal/plan-mode/skill/subagent/workflow/search/approval).
- **bareModuleBaseUrl** (the sole base for bare package name resolution) → the runtime tree; **a jsonrpc plugin hung onto a mixed tree with project dependencies must use an absolute path**.
- Patch syntax hard rule: **for an id that duplicates base, replace it in place with `- id: … name: … config: …` (last-write-wins); for new lines use `- insert: [...]`**.
- ⚠️ **The patch list must be flat**: boot's patches argument is a "list of patch entries" (`[{insert:...}, {id:...,...}]`); a nested array makes applyEntryPatches silently skip it as an entry without an id (the pitfall hit in this round, see §6.10).
- ⚠️ **The loader only interpolates !!js on an entry's config; the name field does not support !!js** (disabled does) → the launcher writes the jsonrpc plugin's absolute path back into the patch entry's name in JS (§6.9).
- ⚠️ **permission-presets replaces the whole row's config wholesale**: the approval=never + workspace-write combination requires explicitly adding a preset (workspace-write-never) and setting defaultPreset, otherwise it reports "composed sandbox and approval defaults match no preset".
- Headless caveat: base's approval policy `ask` deadlocks tool calls → override changes it to `policy: 'never'` (the web UI's Stop button is the user's means of control).
- The second argument of `installFailLoud(BIN_NAME, process, release)` is a process object, not a pid.
- The loader's AggregateError details live in `err.aggregateErrors ?? err.errors` (you only see them by recursively printing each layer's cause).

### 2.3 Event surface ground truth (measured dump, the basis for serialization)

`session.event` notification params = `{ sessionId, event: { type, seq, time, data } }`:

- **user/message** data: `{ content[], source: {kind}, role, id }`. ⚠️ source.kind of system-injected messages = `agent-instructions` / `plugin` / `skill-catalog` / `goal` (workspace instructions/runtime context snapshot/skill catalog/goal rounds, or containing `<system-reminder>`/`<goal_round>`) — must be filtered, otherwise the UI shows junk bubbles.
- **assistant/message** data: `{ turn, step, message: { role, content[], id, time } }` (the full message; content holds reasoning/text/tool-call blocks).
- **tool/result** data: `{ turn, step, message: { role:"user", content:[{type:"tool-result", toolCallId, content[], isError}] } }`.
- **assistant/chunk** data.chunk: `block-start {index, blockType: reasoning|text|tool-call}`, `reasoning-delta {index, text}`, `text-delta {index, text}`, `tool-call-delta {index, id, name, argumentsDelta}`, `block-end {index, block}`, `usage {usage:{inputTokens,outputTokens,cacheReadTokens}}`, `finish {reason}`.
- **Newer runtimes switch the event surface** (the persistent `assistant/chunk` of old 0.1.1-rc.2 is gone): per-chunk output moves to the agent scope's
  `agent/assistant-stream` (`{agent, frame}`, frame = `start` / `chunk{index,time,chunk}` / `end`, chunk shape isomorphic to the above);
  the usage of a single model call is written once at settlement with the persistent `assistant/message.usage` (`{inputTokens,outputTokens,cacheReadTokens?,cacheWriteTokens?}`).
  The host side never receives that live event → the wrapper the launcher installs (`runtime/goal-rpc.mjs`) subscribes in its constructor with `{ global: true }` and converts it into an
  `assistant.stream` notification (`{sessionId, frame}`); the server's `handleAssistantStream` shares `applyStreamChunk` with the old `assistant/chunk`,
  using the `conv.liveChunks` flag to keep them mutually exclusive. The pure mapping behind the bottom bar (context usage / cache hits / reply rate) = `server/dsh/dsh-usage.ts`.
- **turn/end** data.reason: `{kind: "completed"|"max-tokens"|"error", error?: {message, code}}`. ⚠️ When resuming a session, kind="error" + message contains "id collision" (see §2.4).
- **session/title** data: `{title}`.
- **agent/inbox/spliced** data: `{target, start, inserted: [messages], removedCount}` (prompt injection; use it to drain the followUp queue).

### 2.4 ⚠️ Key limitation (largely solved by the 2026-09-15 preset rework): session recovery goes through resume

- **Multi-turn conversation within one process**: normal (live session reused, turn completed).
- **Recovery across processes / after restart**: when the id already exists on disk, the SDK's agents.create throws session already exists (the store hydrates from disk at boot). The wrapper's createSession catches it and hands over to agents.resume (the official recovery path, which stitches the interrupted turn back together automatically; setup still runs, presets are mounted by log priority) — all three creation paths (prompt/goal/select) go through here, so chatting after a restart no longer hits the wall.
- **Fork logic retained**: switch_session is read-only replay (fromDisk flag) → prompt automatically forks a new session (history injected as context); turn/end's id collision auto forkAndReprompt is still there (a fallback for the case where the original session cannot be continued after an abort/restart).
- ds-web-ui hit the same limitation (Resuming a persisted session is not supported... disk log → id collision); its workaround is also to create a new session and continue (we go further with the official resume, continuing when possible).

### 2.5 Extensibility conclusion (answering the user's "does npx dsh web still have extensibility")

- **Agent-side extensibility is fully retained**: the runtime is the same official Cordis plugin tree (MCP client, subagent, goal, plan, skill, workflow, search are all there).
- **The dsh web UI ecosystem** and the pi-web-ui frontend are two separate interfaces and do not exclude each other.
- **User plugin extension seam (implemented, see §4.2)**: the launcher loads the `<dataDir>/dsh-patches/*.yml` user patch layer.
- pi-web-ui's own "plugin AI tools" (registerAgentTool) have no injection point; v1 declares them unsupported, and phase two will build a "tool bridge" Cordis plugin.

### 2.6 ⭐ DSH native goal mechanism (user decision: adapt goal to DSH directly, don't invent a review conversation)

The runtime tree ships a complete goal stack (enabled by default in the base bundle): `dsh-goal` (state domain) + `dsh-goal-round-driver` (round driver) + `dsh-tool-goal` (model tools) + `dsh-command-goal` (/goal command).

- **State domain dsh-goal**: event-sourced same-session goal state; the `ctx.goals` service exposes the verbs get/create/edit/pause/resume/complete/block/clear; every mutation appends a durable `goal/change` event (full snapshot). Lifecycle: active → complete | blocked | paused; the armed flag **is not persisted** — it disarms after a process restart/session resume/fork and needs a resume to re-arm.
- **Round driver dsh-goal-round-driver**: agent idle + active armed goal + rounds remaining → automatically queue a `<goal_round>` user message (source.kind=goal, carrying the round number) → the model keeps working → until the model calls update_goal complete/blocked or the rounds run out. **No driving on our side.**
- **Model tools dsh-tool-goal**: get_goal/create_goal/update_goal (edit/pause/resume/complete/blocked); goal policy demands sufficient evidence before complete; blocked needs the same condition for 3 consecutive rounds (blockedAfterConsecutiveRounds: 3).
- **⚠️ No independent reviewer (the official docs are explicit)**: "evaluator-backed certification is deferred" — completion/blocking is self-assessed by the model, not a separate review conversation. That differs from the pi engine's review philosophy, but it is DSH's design intent (goal rounds = automatic iteration, not a review-revise loop).
- **Trigger (critical)**: the JSON-RPC surface has only initialize/session/prompt/shutdown, and the `/goal` command goes through ctx.commands (a prompt goes straight into the inbox and cannot be intercepted); the only reliable trigger = **write a wrapper plugin that adds goal RPC to jsonrpc** (see below).
- **goal/change events**: arrive naturally through the official jsonrpc's `ctx.on("session/event")` full forwarding (including operation/goal{phase,roundsStarted,maxGoalRounds,blockedReason}/roundsStarted).
- **Round message filtering**: `<goal_round>` is a user/message with source.kind=goal and must be filtered out of the UI (while using it to update the round display, with round in source.round).
- **The view is a flat structure**: `{id,revision,objective,phase,maxGoalRounds,roundsStarted,blockedReason?,activation}`, with no nested goal field; get returns undefined when there is no goal.
- **Wrapper plugin implementation** (server/dsh/runtime/goal-rpc.mjs): import the official `HarnessSdkJsonRpcServer` (the official package exports it), subclass it + add goal/set|get|clear|resume|edit branches to handleRequest, add "goals" to inject, and copy the official apply semantics for shutdown/transport. The launcher patch points sdk-jsonrpc's name at the wrapper (the official entry is passed in via the env PI_WEB_DSH_JSONRPC_ENTRY).
- **UI mapping**: phase active→reviewing=true/「目标进行中（第 N 轮）…」(goal in progress, round N); complete→verdict=pass/「✅ 目标已达成」(goal reached); blocked→verdict=fail+feedback=blockedReason; clear→empty. Goal state is per-conversation (DshConversation.goal + dsGoal) and pushes goal_status on conversation switch.

### 2.7 ⭐ Phase two: vision bridge + user question bridge + interactive scoping wizard (all empirically verified)

**Vision bridge** (real images, replacing the v1 text placeholder):

- DSH attachment mechanism: `dsh-attachment` (the ctx.attachments service; base already mounts the attachment-local storage backend) + `ImageAttachmentRef` (durable, including the sha256 hash) + `EncodedImageAttachment` (base64 wire format). image block = `{type:'image', attachment: ref}`.
- **Only the `deepseek-v4-flash-vision-exp` model supports images** (the adapter's default catalog has inputModalities: [text,image]); flash/pro are text-only routes → images are dropped (the model says it "only accepts text"). DSH_MODELS now carries a per-model vision flag, and the frontend enables/disables image pasting accordingly.
- RPC: `attachment/save` (base64 → ref, calls ctx.attachments.saveImage, with byte/media-type validation) + `attachment/read` (ref → base64, rehydrating images on replay). On the model request side the dsh-llm-deepseek adapter turns the ref into file-id/inline parts automatically.
- Integration: imageData/workspace image files in buildContentBlocks → save → image block; optimistic messages carry dataUrl image blocks; on user/message replay hydrateImageBlocks reads them back asynchronously to refill dataUrl.
- Measured: the vision-exp model describes project screenshots accurately ("pi-web-ui settings panel" + reading the UI text aloud).

**User question bridge** (= the pi engine's WebUIContext equivalent):

- DSH mechanism: `dsh-user-questions` (ctx.userQuestions.ask() blocks waiting for an answer; registerProvider registers the UI side) + `dsh-tool-ask-user` (the ask_user_question tool, **not mounted by the base bundle, needs a manual insert in override.patch.yml**).
- Bridge implementation (goal-rpc.mjs): in apply, `ctx.userQuestions.registerProvider({ ask })` → send a `question.pending` notification → wait for the `question/answer` RPC (carrying answers/cancelled) → restore the tool result. Isolated per client (one runtime per client). Cancel → reject → the tool errors → the model continues.
- Protocol: client `question_answer`; server `question_pending` (questions carry options{label,description,preview?}/multiSelect).
- Frontend: QuestionDialog.tsx (single/multi choice per question + free-text supplement + submit/cancel, reusing the .dialog-inline styles). `question/detail/description/preview` go through `Markdown(rawHtml)` rich rendering (the model can choose markdown or HTML); selecting an option with a `preview` shows an 「选项预览」(option preview) box, matching rpiv-ask-user-question. `preview` is an optional addition; when the DSH model does not send it, the frontend falls back to plain text.
- Measured: model ask_user_question → browser receives "what color do you like: red/blue/green" → answers "blue + a darker blue" → the model replies "you chose blue (darker blue)".

**Interactive scoping wizard** (startGoalWizard rewritten, replacing the one-click setup):

- The main-session prompt carries the wizard instruction (wizardPrompt: converge by asking one question at a time with ask_user_question, output only the GOAL: line at the end, never call create_goal directly); conv.turnWaiter waits for this round's turn/end (question-answer-convergence all in the same round); parse the GOAL: line → setGoal. clearGoal interrupts a running wizard.
- Measured: the model asks 4 rounds (delivery form/storage/feature scope/technical constraints, with options) → converges to "GOAL: add a standalone to-do web app to the pi-web-ui project (React+Vite, Chinese UI, localStorage persistence)…" → the goal is set automatically → the round-driver enters round 1 by itself.

### 2.8 ⭐ Phase three: tool bridge (the plugin AI tool injection point, ⚠ proven E2E with a real key)

Bridge the AI tools that pi-web-ui plugins register via `host.registerAgentTool` into native DSH tools so the DSH model can call them (the server runs the plugin implementation). Injection point = `ctx.tools.register(defineTool({...}))` (dsh-tools exports defineTool; dsh-tool-goal uses it the same way).

**Protocol (goal-rpc.mjs wrapper, already folded into the transport):**

- `tools/sync` (server→runtime): register/replace a batch of plugin tools. Each uses `defineTool({name, description, parameters, output:{schema:{type:'string'}, render}, execute:trampoline})`. The trampoline execute sends a `tools.call.request` notification (with id/name/args/sessionId) → await; after the `tools/call-result` RPC arrives it resolves and the tool result string goes back to the model.
- `tools/list` (server→runtime): returns `ctx.tools.schemas()` (for zero-key validation/debugging).
- `tools/invoke` (⚠ only with `PI_WEB_DSH_DEBUG=1`): triggers a full round trip of a registered bridged tool directly, bypassing the model, so a zero-key probe can verify trampoline → notification → call-result restoration.
- `tools/call-result` (server→runtime): after the server runs the plugin implementation it returns `{id, result, isError}`, restoring the bridged call (isError→reject→the model sees a tool error).

**Server side (dsh-client.ts + dsh-agent-service.ts):**

- `DshRuntime.onStarted`: after every successful initialize (initial/after a model switch/after a watchdog restart) the host's `syncPluginTools()` registers the plugin tools from `pluginToolsProvider()` into the runtime (ctx.tools is brand new after a respawn, so re-registration is mandatory).
- `handleToolCallRequest`: receives `tools.call.request` → finds the tool by name in `pluginToolsProvider()` → calls `tool.execute(id, args, signal)` (the server runs the plugin) → normalizes with `normalizeToolResult` (`{content}` / string / object) → returns it via `tools/call-result`.
- `applyPluginAgentTools`: when the plugin tool list changes → re-sync every client's runtime.

**Schema conversion**: pi plugins use standard JSON Schema (`{type,properties,required[]}`), while DSH wants per-property mapping (`required` hangs off each property) — the `piParamsToDshSpec` pure function converts (DSH only supports a strict subset: `type` arrays such as `["string","null"]` map to `oneOf`, `anyOf` becomes `oneOf`, `object` gets an explicit `additionalProperties: true`, nested fields are normalized recursively and unsupported DSL keys are dropped; a single failing tool registration is isolated by exception and does not block the whole sync).

**v1 simplifications**: the model only sees name/description/parameters; promptSnippet/promptGuidelines/label never reach the model; onUpdate partial streaming results are not forwarded; no tools_delta (DSH does not stream tool output); `tools/invoke` is debug-only.

**Measured (real-key E2E)**: minimal plugin registers `test_echo` → the model, told to, calls it (message=marker) → the plugin returns `ECHO:<marker>` on the server → `tools/call-result` returns it → the tool result and the model's reply both show up in the conversation. The zero-key probe (`dev/dsh-probes/probe-tools.mjs`) verifies registration/listing/schema conversion/`tools/invoke` round trip; `tests/dsh-tools-test.mjs` is the real-key gated test.

### 2.9 ⭐ MCP tool bridge (#16, proven E2E with a real key)

**Reuse pi's McpBridge + the #15 tool bridge directly**, no need to start from scratch. MCP tools are already `PluginAgentTool` (`adaptMcpTool`), and `index.ts` already merges `mcpBridge.getTools()` into `pluginToolsProvider` → #15's `tools/sync` bridges them automatically.

Chain: `<dataDir>/mcp.json` (`{servers:{<名>:{command,args,cwd,env}}}`) → `McpBridge.load()` starts the stdio MCP server (NDJSON JSON-RPC) → handshake `initialize`/`notifications/initialized` → `tools/list` discovers tools → `adaptMcpTool` adapts them (sanitized tool name + inputSchema as parameters + execute→`McpClient.call`) → `pluginToolsProvider()` returns them → `syncPluginTools` registers them into DSH → the model calls → `handleToolCallRequest` runs `execute` → `McpClient.call` forwards to the MCP server → the result goes back to the model via `tools/call-result`.

**Trade-off**: the DSH runtime tree ships its own MCP client (a cordis plugin), but that needs separate mcp definitions and lifecycle management; pi's McpBridge is a mature implementation with logging/timeouts/multi-server fault tolerance and is already wired in through `pluginToolsProvider`. **On the DSH side, MCP tools and plugin tools have exactly the same shape (both are bridged tools), with no special-casing.**

**Proven**: `tests/dsh-mcp-test.mjs` (real-key gated) — a fake stdio MCP server exposes `mcp_echo` → the model calls it → `MCP_ECHO:marker` goes back to the model and the conversation (2/2 PASS).

### 2.10 ⭐ Skill enable/disable UI (#18, proven by a zero-key probe)

Expose native DSH skills (`dsh-skill` SkillRegistry) in the frontend settings panel and make `disabledSkills` actually take effect (the runtime filters the skill catalog visible to the model).

**RPC (goal-rpc.mjs, wired straight to ctx.skills)**:

- `skills/list` → `ctx.skills.list()` (name/description/invocation); `skills/get` → `ctx.skills.get(name)`; `skills/set-disabled` → stores the server instance's `disabledSkills` set.
- `skills/register` (⚠ only with `PI_WEB_DSH_DEBUG=1`) → registers a runtime skill so a zero-key probe can verify list.

**Server side**: `settings_state.skills` is pulled from `runtime.listSkills()` and mapped into `UiSkillInfo` (`enabled = !disabledSkills.has(name)`), cached in `skillsCache` for pushSettings; when `set_settings.disabledSkills` changes, `pushDisabledSkillsToRuntime()` syncs it + `refreshSkillsFromRuntime()` refreshes. `runtime.onStarted` refreshes in parallel too.

**Runtime disabling (critical)**: the DSH skill catalog is injected by `dsh-tool-skill`'s `agent/pre-step` hook (`ctx.skills.snapshot()` → renderCatalogMessage, the message carries `source.kind='skill-catalog'` and structured `source.entries`); skills themselves support no per-skill exclusion. So goal-rpc installs a **late** `agent/pre-step` hook (registered after base → runs later), filters `source.entries` by `server.disabledSkills` and rebuilds the `<available_skills>` block (`filterSkillCatalogMessage` pure function, self-contained escapeText/rebuildCatalogText — **it does not import dsh-skill**, because that is not a direct project dependency and Node's native resolution would fail).

**Trade-off**: disabling goes through runtime catalog filtering (a late hook) rather than "reconfigure the patch layer/restart" — it takes effect without a restart; when everything is disabled it shows a 「本会话无可启用技能」(no skills available in this session) placeholder. Model-visible filtering is verified by the pure function + an RPC round trip (end-to-end would need seeded skill files plus the model listing them, which the dev environment does not provide).

**Proven**: `dev/dsh-probes/probe-skills.mjs` (zero key) — `filterSkillCatalogMessage` unit tests (partial disable/all disabled/no-op) + a `skills/register`→`list`→`get`→`set-disabled` round trip. `settings_state.skills` is filled during `refreshSkillsFromRuntime` (an empty array when there are no skill files, no crash).

### 2.11 ⭐ Browser UI E2E (#23, zero-key Playwright)

`tests/dsh-ui-test.mjs` (Playwright + `CHROME_PATH`, auto-detecting the local Chrome):

1. **Engine badge** — after `ready(engine=dsh)` the FooterBar renders `.engine-badge.engine-dsh` showing "DSH".
2. **Goal bar** — GoalBar renders normally under the Dsh engine.
3. **Settings panel 「界面插件」(Interface plugins)** — the 「DSH 用户补丁」(DSH user patches) block lists the `<dataDir>/dsh-patches/*.yml` files (the test drops in a harmless persona override patch and verifies scanning and display).
4. **Skills tab** — shows the DSH explanation text (`dshSkillsNote`).

**Scope trade-off**: browser-level rendering of streaming / image paste (vision-exp) / the question dialog needs a real key plus model timing and is flaky, so it is covered by protocol-level dsh tests (`dsh-goal/question/vision`) plus engine-agnostic shared components (StreamMarkdown/QuestionDialog/image-paste); this E2E focuses on DSH-specific UI chromium (badge/patches/goal bar/skill notes), zero key, CI-ready.

### 2.12 ⭐ Agent presets (replicating dsh-web's four modes, 2026-09-15)

The official dsh-web session composition mechanism: the host keeps only the registry/sandbox/persistence, all agent tools sink into preset compositions (standard/ptc/minimal/cordis + user-built ones), one mount per session. pi-web-ui used to be a single global composition (all sessions sharing tools + persona); this section replicates the official semantics.

- **Runtime**: override.patch.yml adds the personaPrefix fix key + code-runtime/ptcRuntime + subagent-model-selection-settings + cordis-host-runner + pi-webui-custom-prompt (a separate host section, delivered for standard/ptc/cordis and suppressed for minimal) + tool-ask-user (the host row stays); agent-plane disable is a full table and the roster is generated dynamically by the server as dsh-preset-plane.patch.yml (applied atomically, falls back to legacy when missing).
- **file: cloning** (server/dsh/preset-clones.ts): under launcher boot the shipped presets' bare package names cannot be resolved (baseUrl=config directory), so compositions are copied and bare names rewritten as file: URLs of the runtime tree entry files (resolved via exports→main→lib/index.js, subpaths likewise), with the clone directory as the roster's only system root. Regenerated on every start (following runtime tree upgrades); unit test tests/unit/preset-clones.test.ts.
- **wrapper** (goal-rpc.mjs): createSession override (meta.agentPreset into the header + mount in setup/questionnaire waterfall/skill filter hook/fail over to a direct host connection) + same-id handover to agents.resume + projection-prior (log record > creation params > default); preset/list|assign|select + DEBUG-only preset/tools, debug/assemble; under minimal the bridged tools and questionnaire reject at call time (bilingual error); question bridge P0 fix (registerProvider was removed upstream, switched to an agent scope waterfall).
- **Node side**: conv.agentPreset/presetLocked/assignedGen (re-register per runtimeGen generation) + default preset persistence (client-state) + replay determining the preset (selected event/header, sessionLogPreset) + fork inheritance; protocol UiAgentPreset/dsh_presets/select/default/new_chat{preset}/snapshot agentPreset/conversation summary fields (pure addition, PROTOCOL_VERSION not bumped).
- **Frontend**: DshPresetBar (current badge + empty-state switch dropdown + start a new conversation with that preset) + left-panel preset-badge + settings preset page (default dropdown + roster cards); the whole set is hidden in legacy mode (empty roster).
- **Known limitations**: user-built presets that write bare package names cannot be mounted (baseUrl limitation, the roster reports broken); host bridged tools (plugins/questionnaire) are visible in minimal's tool catalog but calls are rejected; the questionnaire waterfall and the skill filter hook's real-turn delivery are not yet proven (no usable model key: the direct deepseek key has no balance, the opencode-go gateway wants an x-opencode-session header); minimal on the current runtime tree is a single persistent shell (the user's dsh-web copy's dual tools are a newer version; the runtime tree wins on both sides).
- **Verification**: tests/dsh-smoke-test.mjs gains section 2.5 (four presets in the roster with no broken + snapshot/new_chat/switch/default/invalid rejection); tests/unit/dsh-sessions.test.ts; a real zero-token boot verification (tool catalogs standard27/minimal2/ptc27+run_code/cordis34, assemble section, NO_PROVIDER path).

### 2.13 ⭐ Three permission presets (replicating the official /permission popover, 2026-09-15)

The official dsh-web permission row: a permissions projection (options + currentValue, custom is display-only) + hot switching via the /permission command (written to the session log) + per-new-session default (settings permission.defaultPreset). pi-web-ui used to hardcode workspace-write-never (approval=never); this section replicates three switchable levels.

- **wrapper** (goal-rpc.mjs): add `permissionPresets` to inject (⚠️ that is the service registration name, not the plugin id `permission`; a typo makes boot report pending waiting for service) + `approval`; permission/get|set RPC (set copies the official command: `permission.apply(session, name, policy => approval.setPolicy(agent, policy))`, unknown presets return a {ok:false} envelope; the handleRequest switch must register the method names, otherwise unknown method).
- **Node side**: conv.permissionPreset (the snapshot's permission field) + option table cache + per-client default persistence (client-state defaultPermissionPreset) + replay determining permission (the last permission/preset event, sessionLogPermission); fetched on attach/conversation switch/runtime start/before the first prompt, and the per-client default is hot-applied before the first round (no event, zero noise, when it already matches).
- **Three-level mapping**: the frontend offers only read-only / workspace-write-never (labelled 「工作区内修改」(modify within workspace)) / danger-full-access; the official workspace-write (approval ask) has nobody to answer when headless and is bound to fail closed, a dead end, so it is not offered. Full access goes through an inline two-step confirmation (the same semantics as the official confirm).
- **Protocol**: ClientMessage dsh_permission_set/default + ServerMessage dsh_permission{options,defaultPreset} + UiState.permission + DshPermissionOption (pure addition; PROTOCOL_VERSION 16→17).
- **Frontend**: DshPermissionBar (next to the preset strip above the composer) + the default dropdown on the settings preset page; hidden in legacy/not-ready state (empty options).
- **Verification**: tests/scratch/verify-permission.mjs, a real zero-token boot (get defaults to workspace-write-never + three-level switch read-back + unknown rejection + idempotence).

---

## 3. Completed work

### 3.1 server/dsh/ deliverables (all files)

```
E:/pi-web-ui/server/dsh/
├── runtime/
│   ├── launcher.mjs          # DSH runtime child-process launcher (boot composition + event pipeline + user patch layer)
│   ├── goal-rpc.mjs          # ⭐ jsonrpc wrapper plugin: goal/* + attachment/* + question/* RPC (straight to ctx.goals/attachments/userQuestions)
│   ├── runtime-root.mjs      # shared runtime tree resolution module (flat + dsh nested layouts)
│   ├── cordis.yml            # empty root [] (both patch layers live in the boot patches argument)
│   └── override.patch.yml    # session root/default model/persona/sandbox/approval=never/permission preset/jsonrpc
├── dsh-client.ts             # DshRuntime (TS): spawn launcher + JSON-RPC + goal RPC + kill/restart
├── dsh-serialize.ts          # event → UiMessage + DshStreamAccumulator (chunk deltas)
├── dsh-sessions.ts           # JSONL read-only (zstdDecompressAll/readSessionLog/projectKey/replay)
├── dsh-agent-service.ts      # DshClientSession (protocol alignment, goal=DSH native event-driven) + DshAgentService
└── (no probes — manual verification probes moved to dev/dsh-probes/, not shipped in release artifacts)

> Dev/verification probes (`probe-mixed` / `probe-tools` / `probe-skills` / `probe-vision` /
> `probe-native-goal` / `probe-patch-seam`) now live in `dev/dsh-probes/` (`dev/` is not part of the npm package).
> They take the launcher from `server/dsh/runtime/`; paths were fixed after the move (see `DSH_DIR` in each file).
```

- **launcher runtime tree resolution**: `$PI_WEB_DSH_RUNTIME` → this package's node_modules → node_modules next to execPath → `npm root -g` (win32 shell:true). **Supports the dsh nested tree** (`<root>/@deepseek-ai/dsh/node_modules`).
- **jsonrpc plugin entry**: `createRequire(import.meta.url).resolve("@deepseek-ai/dsh-sdk-jsonrpc-server")` (the main entry is enough; ⚠️ the package exports only expose "." and "./invariant", **resolving the subpath lib/index.js reports "not defined by exports"**).
- **launcher fixes the jsonrpc absolute path**: the loader's name field does not support !!js → the launcher writes the env/project resolution back into the patch entry in JS.
- **Build**: `npm run build:dsh-runtime` (scripts/copy-dsh-runtime.mjs) copies the runtime's .mjs/.yml into dist/server/dsh/runtime/ (tsc only compiles .ts); the build chain is already wired up.

### 3.2 Engine dispatch + frontend badge

- `server/index.ts`: `ENGINE = PI_WEB_ENGINE === "dsh" ? "dsh" : "pi"`; `new DshAgentService(CWD, stateFile, DATA_DIR, getAgentDir())` vs `new AgentService(...)`; defines `DispatchSession` (the dispatch table contract) and the `EngineService` interface, with the pi/dsh engines structurally compatible. **agentDir is threaded through**: auth.json read/write and DshRuntime's key reading both honor PI_CODING_AGENT_DIR (so smoke tests' temporary agent directory stays isolated).
- `/api/health` returns the `engine` field; the `ready` message carries `engine`.
- `server/control-socket.ts`: startControlServer's service type is widened to `ControlService` (Pick serviceStatus/quiesce/unquiesce).
- `server/protocol.ts`: ready gains `engine?: string`; `dsh_patches_list`/`dsh_patches_rescan` (client) + `dsh_patches` (server) protocol messages; the types.ts shim syncs automatically (check:protocol ✓).
- Frontend: `web/src/use-chat.ts` state gains `engine` + `dshPatches`; `FooterBar.tsx` shows the DSH badge; `SettingsModal.tsx` adds a 「DSH 用户补丁」(DSH user patches) block under the plugins tab (list + rescan, shown only when the engine is dsh); i18n gains the matching keys (zh/en).

### 3.3 Verified (empirical)

- ✅ **probe-mixed.mjs full chain**: initialize → prompt → event stream (all kinds) → text-delta concatenation produces "mixed tree works" → shutdown.
- ✅ **probe-patch-seam.mjs**: the user patch layer takes effect (the patch redirects the session persistence root to a marker directory; after the prompt the JSONL lands under the marker).
- ✅ **probe-native-goal.mjs**: goal/set → create+arm → **round-driver continues rounds automatically** (<goal_round> round=1) → the model calls update_goal complete → goal/change event → goal/clear tombstone. The full DSH native goal chain.
- ✅ **Goal (DSH native, through DshClientSession)**: setGoal → goal_status transitions (waiting for generation→in progress (round 1)→✅ reached, verdict=pass) → clearGoal empties it; <goal_round> messages do not leak into the UI.
- ✅ **launcher unit test** (dist build output) boots successfully and answers initialize.
- ✅ **DshRuntime standalone test**: start 856ms, prompt 7ms, complete event stream; multiple turns completed within one process.
- ✅ **Real-key E2E (full WS chain, new key)**: ready(engine=dsh) → real model reply ("4; by arithmetic 2+2 equals 4.") → native goal loop passes (「✅ 目标已达成」/goal reached) → dsh_patches list message → session JSONL persisted. All passing.
- ✅ **System message filtering + duplicate dedup**: user/message keeps only genuine user messages (agent-instructions/plugin/goal filtered; duplicate text deduped).
- ✅ **Session list/switch**: list_sessions (JSONL scan) → switch_session (replays 4+ messages).
- ✅ **Continuing historical sessions**: prompting a fromDisk session forks automatically + injects context, and the model replies normally.
- ✅ **abort**: kill the runtime + automatic restart + turn/end id collision auto fork-and-resend, and the model recovers with a reply.
- ✅ **Terminal**: terminal_create/list/input/output (bash echo TERM_OK echoed back).
- ✅ **quiesce**: attach rejects with QuiesceRejectedError (index.ts turns it into a 4403 close) + prompt/newChat/setGoal rejections emit an error notice (including quiesce).
- ✅ **SCM**: scmQuery goes through FilesService (git-dir watcher → external commits push scm_changed, scm-features-test 9/9).
- ✅ **API key management**: set/clearProviderApiKey aligned with the pi shape ({provider:{type,key}}) + PI_CODING_AGENT_DIR isolation (clear-provider-key-test 4/4).
- ✅ **Quality gate**: `npm run typecheck` (server+web+tests) 0 errors; `npm run build` OK; `npm run test` 246 passed.
- ✅ **pi engine regression**: with the default PI_WEB_ENGINE=pi behavior is unchanged (typecheck/build/unit tests/smoke sampling all green).

### 3.5 dsh engine smoke assessment (PI_WEB_ENGINE=dsh, 22/32 pass after round two + 2 environment skips)

Reusable (✓ 22 items): global-search / goal-prefs / goal-test / plugin-cwd / plugin-http / mcp-bridge / plugin-settings / plugin-update / preview / quiesce / recursive-watch / scm-features / steer-queue-smoke / ssh-plugin / clear-provider-key (4/4 after alignment) / snapshot-delta / **conv-cwd (turned green in round two)** / **plugin-test (turned green in round two)** / **plugin-bgtask (turned green in round two)** / **plugin-command (turned green in round two)** / **slash-commands (turned green in round two)**.
Not reusable (engine differences, expected failures): conv-cross-project / switch-session-background (depends on the pi mock provider "main/switch-session-mock", **the same failures occur on the local pi baseline on Windows, so not a regression**); fetch-models / refresh-models / vision-bridge (custom providers/vision bridge v1 unsupported); left-panel-delete (assumes pi's session directory layout); settings (only 1 assertion left: visionBridgeDefaultPrompt non-empty, DSH has no vision bridge concept). Environment issues: db-client / vscode-editor (dev/plugins/ missing, fail the same way under pi).

### 3.4 Process pitfalls (see §6)

---

## 4. What to do next (in order)

### 4.1 Engine core wrap-up (essentially done; goal has moved to DSH native, see §2.6)

- **Goal**: ✅ done — DSH native goal domain (goal-rpc wrapper RPC + goal/change event translation + round-driver automatic rounds + model self-assessed complete/blocked). Differences from the pi engine (by design): no independent review conversation; completion is self-assessed by the model; the locked switch is passed through but not mapped to behavior (a DSH goal runs until complete/blocked/out of rounds); reviewModel is ignored (no independent reviewer).
- **Settings panel**: after round two, full storage echo (promptMode/customSystemPrompt/terminalToolsEnabled/terminalBash/thinkingWrap/toolsWrap/disabledSkills/disabledExtensions/disabledPlugins/reviewPrompt persisted through ClientStateStore, surviving reconnects); only prompt-related changes restart the runtime (DSH_PERSONA env injection); engine-contributed settings mechanism surfaces DSH presets and the three permission levels, patches and the marketplace, questionnaire scoping dynamically; generic base settings are fully compatible.
- **Vision bridge**: ✅ done (§2.7) — real image blocks (attachment/save + read RPC + vision-exp model + replay image hydration). Image attachments and workspace image files both go through attachment storage. Note: only the deepseek-v4-flash-vision-exp model can see images.
- **Third-party custom endpoints and model integration (models.json)**: ✅ done — the DSH engine hooks into the shared model base and automatically enumerates third-party custom endpoint models configured in `models.json` (e.g. `antigravity-openai/gemini-3.8-flash`); on switch it resolves BaseURL and API Key dynamically and injects them into the child process environment as `DEEPSEEK_BASE_URL` and `DEEPSEEK_API_KEY`, with the RPC handshake carrying the real model ID, so third-party OpenAI-compatible endpoints are called and executed directly by the DSH runtime.
- **Universal Agent base driverization (DshAgentDriver)**: ⚠️ retired — an attempt was made to implement `BaseAgentDriver` in `server/universal/drivers/dsh-driver.ts`, but because DSH is a composite engine (4 preset clones mounted, a dedicated RPC daemon and a native Goal state machine — not a simple single-process driver), demoting a composite engine to a lightweight Driver is an abstraction-level mismatch. To avoid shipping an unvalidated third DSH runtime, that driver was fully removed in #733; convergence between DSH and the universal base will go through #469 (top-down extraction of a shared `BaseAgentService`).
- **Dialog (dialog_response) / extension UI bridge**: the DSH side already has the question bridge (question_pending/question_answer, §2.7); pi extensions' dialog (dialog_response) is still ignored in v1.
- **Goal scoping wizard (startGoalWizard)**: ✅ done (§2.7) — interactive (the model asks one question at a time with ask_user_question + frontend dialog + GOAL: convergence + automatic goal set).

### 4.2 User patch extension seam ✅ implemented

- The launcher reads `PI_WEB_DSH_DATA_DIR` (injected by dsh-client) → `<dataDir>/dsh-patches/*.yml` (in filename order, after override) appended to the boot patches; failing files are skipped + logged to stderr. The jsonrpc path write-back applies to user patches too.
- Engine methods: `listDshPatches()` (scan + dsh_patches message) / `rescanDshPatches()` (restart the runtime so new patches take effect). Protocol: `dsh_patches_list` / `dsh_patches_rescan`.
- Frontend: the 「DSH 用户补丁」(DSH user patches) block under the 「界面插件」(Interface plugins) settings tab (file list + rescan button + directory hint).

### 4.3 dsh engine smoke ✅ assessed (see §3.5)

- `PI_WEB_ENGINE=dsh node tests/run-smoke.mjs` ran in full: 22/32 + 2 environment skips (round two; conv-cwd/plugin-test/plugin-bgtask/plugin-command/slash-commands turned green); every remaining failure is attributed to pi-only behavior/design differences/environment (see the §3.5 list).
- The manual real-key full flow (conversation/tools/session persistence/model switch/abort) was verified earlier; the native goal loop is verified by the real-key probe.

### 4.4 Known v1 simplifications (differences from the pi engine the frontend can perceive)

- **No character-by-character streaming**: on a fast local completion the 60ms snapshots miss streaming entirely, but the message_delta channel is implemented (thinking/text go through message_delta token by token; the frontend patches streamingMessage), so long responses stream visibly.
- **queue semantics**: DSH has no mid-run steering — while isStreaming every prompt goes to followUp (queued in the runtime inbox, consumed when the run ends); the frontend queue shows "cleared on send" (optimistic message + agent/inbox/spliced cleanup).
- **Tool execution status**: tool/call (start) + tool/result (end) → tool_status is emitted; no tool_delta (DSH does not stream tool output).
- **Background tasks**: tool/call bash → bg.snapshotBefore; tool/result bash → bg.trackAfterBash (port diff) is wired.
- **Goal review semantics** (see §2.6): DSH has no independent reviewer — 「目标进行中（第 N 轮）…」(goal in progress, round N) is driven by the round-driver continuing rounds automatically, and completion/blocking is self-assessed by the model; blocked needs the same condition for 3 consecutive rounds.
- **Slash commands** (supported since round two): NATIVE_COMMANDS (new/model/cwd/resume/help/copy/reload/quit and friends) + plugin registerCommand all intercepted and executed (parseSlash before prompt, only non-commands go to the model); `/model` matches against the dynamic model catalog.

---

## 5. Task list status

| #   | Task                                                                                                                     | Status                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Research the DSH JSON-RPC protocol surface                                                                               | ✅ Done (§2.1/§2.3 event ground truth)                                                                                                                                                                                |
| 2   | Read through pi-web-ui agent-service.ts                                                                                  | ✅ Core read (snapshot/event/session/model methods, as the alignment reference)                                                                                                                                       |
| 3   | Read through the ds-web-ui port material                                                                                 | ✅ Core read (dsh-client/serialize/agent-service JSONL parts)                                                                                                                                                         |
| 4   | Design server/dsh/ + engine dispatch + badge                                                                             | ✅ Done (DispatchSession/EngineService interfaces + ENGINE dispatch + health/ready engine + frontend badge)                                                                                                           |
| 5   | dsh core conversation engine                                                                                             | ✅ Done (prompt/event folding/snapshot/snapshot_delta/message_delta/tool_status/message filtering and dedup)                                                                                                          |
| 6   | dsh session management                                                                                                   | ✅ Done (JSONL list/replay/switch/delete + fork to continue + auto fork on id collision)                                                                                                                              |
| 7   | Terminal/SCM/background tasks/file service integration                                                                   | ✅ Done (TerminalManager/scm.ts/FilesService/BgServerTracker reused + verified over WS)                                                                                                                               |
| 8   | Settings/model config/goal/vision bridge/plugin alignment + user patch seam                                              | 🔶 Partial (**round two: full settings storage and echo ✅, model config unsupported in v1, goal = DSH native ✅, vision bridge ✅, question bridge + interactive wizard ✅, user patch seam ✅, slash commands ✅**) |
| 9   | Frontend badge + engine state                                                                                            | ✅ Done                                                                                                                                                                                                               |
| 10  | typecheck/build/smoke test (both engines)                                                                                | ✅ typecheck/build/vitest all green; pi smoke sampled regression green; **dsh smoke assessed (§3.5, 22/32 + 2 environment skips, all failures attributed)**                                                           |
| 11  | Phase two: vision bridge (real image block + vision-exp model + replay hydration)                                        | ✅ Done (§2.7, proven by probe-vision.mjs)                                                                                                                                                                            |
| 12  | Phase two: user question bridge (question_pending/question_answer + QuestionDialog)                                      | ✅ Done (§2.7, proven over WS: question→answer→model reply)                                                                                                                                                           |
| 13  | Phase two: interactive scoping wizard (startGoalWizard rewritten)                                                        | ✅ Done (§2.7, proven: 4 question rounds→GOAL convergence→automatic goal set)                                                                                                                                         |
| 14  | Round two: P0 stability (watchdog/races/memory reclamation/DEBUG/retries/question timeout)                               | ✅ Done (§8.1 all)                                                                                                                                                                                                    |
| 15  | Round two: P1 UX alignment (vision validation/settings panel/round detection/locked semantics/conv-cwd/retention/search) | ✅ Done (§8.2 all; conv-cwd-test turned green)                                                                                                                                                                        |
| 16  | Round two: part of P2 (dynamic model catalog/fork notice/question queueing/thinking folding)                             | ✅ Done (§8.3 #17/19/20/21)                                                                                                                                                                                           |
| 17  | Round two: slash command system (NATIVE + plugin command interception and execution)                                     | ✅ Done (slash-commands/plugin-command/plugin-bgtask turned green)                                                                                                                                                    |

---

## 6. Pitfalls and notes (avoid stepping on them again)

1. **npm hangs in the bash tool environment** — have the user run it in their own terminal; don't install large packages in the background from the tool.
2. **fnm multishell**: an empty bucket from `npm root -g` in a bash/node spawn is normal; the launcher already puts node_modules next to execPath first. **Each bash command is a separate multishell (different execPath), so junction paths only live in the current shell.**
3. **cordis patch syntax**: targeted replacement by id vs insert; getting it wrong reports duplicate loader entry id.
4. **Keep JSON-RPC stdout clean**: the runtime's stdout may only contain protocol frames; every log goes to stderr (debug output is gated by PI_WEB_DSH_DEBUG and written to stderr).
5. **Abort = kill the process**: on win32 use `taskkill /pid X /T /F`; session JSONL is on disk, so a process rebuild loses nothing. **After an abort the original session cannot be continued (id collision) → fork is mandatory.**
6. **`.jsonl.zstd` multi-frame decompression**: zstdDecompressSync only decompresses the first frame; each frame must be decompressed separately (zstdDecompressAll in dsh-sessions.ts).
7. **Session directory names**: projectKey style (`--<cwd>--`, separators turned into `-`, invalid characters as `~XXXX`).
8. **Protocol version**: after adding fields to protocol.ts run `npm run check:protocol` (types.ts shim is the single source).
9. **The loader's name field does not support !!js** (only config is interpolated) → the jsonrpc plugin's absolute path is written back by the launcher in JS (the jsonrpcEntry resolution block in launcher.mjs).
10. **boot's patches must be flat**: `[...baseList, ...overrideList]`; a nested array is silently skipped by applyEntryPatches (it shows up as "the plugin isn't mounted").
11. **permission-presets replaces the row wholesale**: the approval=never combination needs an explicit preset + defaultPreset (workspace-write-never in override.patch.yml).
12. **The runtime tree lives in a nested location**: global `npm root -g/@deepseek-ai/` only has the dsh package; dsh-base/dsh-app-boot are under `@deepseek-ai/dsh/node_modules/@deepseek-ai/` (runtimeBaseFor in runtime-root.mjs checks both layouts).
13. **require.resolve subpath limitation**: dsh-sdk-jsonrpc-server's exports only expose "." and "./invariant", so resolution must use the main entry.
14. **Snapshot delta trap**: if `emittedMessages = cur` keeps an array reference, appendMessage pushing into the same array keeps prev/cur identical → slice(prev.length) is always empty → messages never reach the frontend. Copy it (`[...conv.messages]`).
15. **Streaming timing**: on fast local completions the 60ms delayed snapshot is always beaten by assistant/message (streaming is never captured) → an independent message_delta channel is mandatory (text_delta/thinking_delta, matching the pi SDK event types).
16. **DSH duplicate user messages**: a user/message with the same text is replayed → dedupe by text; filter agent-instructions/plugin; **also filter goal-source <goal_round> round messages** (do not render them, but use them to update the round display, with round in source.round).
17. **Windows test process management**: `pkill -f` cannot match node processes in Git Bash (leftover pids + EADDRINUSE); use `taskkill //PID <pid> //T //F`.
18. **Server startup race**: concurrent DshRuntime.start() calls must share one startPromise (otherwise the launcher is spawned twice and the prompt goes to the wrong stdin).
19. **Windows ESM dynamic import of absolute paths**: `import("E:\\...")` reports ERR_UNSUPPORTED_ESM_URL_SCHEME — `import(pathToFileURL(p).href)` is required (goal-rpc.mjs hit this).
20. **dsh-goal view is a flat structure**: `{id,revision,objective,phase,maxGoalRounds,roundsStarted,activation}`, with no nested goal field; get() returns undefined when there is no goal (not {goal:null}).
21. **goal/change events fire only on mutations** (create/edit/resume/complete/block/clear), not on round acknowledgement — the round display is updated from the <goal_round> user/message's source.round.
22. **auth.json shape and path**: the pi engine's shape is `{<provider>:{type:"api_key",key}}` and dsh must match it (clear-provider-key-test asserts it); the path honors PI_CODING_AGENT_DIR (getAgentDir()), and hardcoding ~/.pi/agent breaks isolation for test/deployment temporary agent directories. ⚠️ **clear-provider-key-test destroys the deepseek key in the real ~/.pi/agent/auth.json** (pi and dsh alike) — back it up before running, restore it afterwards.
23. **The sdk-jsonrpc plugin is extensible**: the official package exports HarnessSdkJsonRpcServer/apply/Config/inject/name, so you can import and subclass it to add RPC methods (the goal-rpc.mjs pattern); inject must add new service dependencies ("goals"); the loader resolves the plugin file's bare imports through node ESM (mixed-tree safe, same as official plugins).
24. **The /goal command cannot be triggered from the JSON-RPC surface**: prompts go straight into the inbox and the command runtime (ctx.commands) cannot intercept them; the only reliable trigger = an extra RPC method calling the ctx.goals service verbs directly.
25. **Images only work with vision models**: in the dsh-llm-deepseek adapter's default catalog only `deepseek-v4-flash-vision-exp` has inputModalities:[text,image]; flash/pro are text-only → images are dropped (the model says it "only accepts text"). The vision flag must be per-model.
26. **dsh-tool-ask-user is not in the base bundle**: base only mounts the user-questions service; the ask_user_question tool must be inserted manually in override.patch.yml (otherwise the model says "there is no such tool").
27. **The question bridge has a single pending question**: ctx.userQuestions allows one provider per context; a new question while ask() is blocked reports "a question is already waiting for an answer". The frontend shows only one question_pending; each question needs a selection or non-empty custom text before submitting.
28. **Attachment byte validation**: attachment/save uses saveImage (which internally validates media type/bytes/pixel limits); anything that is not png/jpeg/webp/gif or exceeds a limit errors → the caller falls back to a text placeholder.
29. **Event loop blocking caveat**: the question bridge's ask() await suspends the agent loop until answer/cancel/timeout (10 minutes, configurable via PI_WEB_DSH_QUESTION_TIMEOUT_MS) — if the frontend never answers, that session stalls; after the timeout the tool errors and the model continues.
30. **restart race (late exit from the old proc)**: after kill, the old process's exit event can arrive after the new initialize → the exit handler must do a `this.proc !== spawned` identity check (doStart in dsh-client.ts), otherwise the old exit's failPending wrongly rejects the new initialize (reporting "runtime killed (interrupt)") and a wrong intentional verdict wrongly triggers an automatic watchdog restart.
31. **Hardcoded settings echo leftovers**: early dsh pushSettings hardcoded disabledPlugins/thinkingWrap/terminalBash and friends as literals — easy to miss after a batch edit gets rolled back; after touching settings echo, grep to confirm no literals are left.
32. **Slash interception must flushSnapshot**: after intercepting a slash command in prompt you must flushSnapshot (same as pi does after exec), otherwise snapshot-delta style tests/the frontend never see the post-command delta.
33. **Telling watchdog apart from kill**: onExit's intentional flag is decided by `this.closed` (kill()/close() set it true); on an unexpected crash closed=false → the watchdog restarts with rate limiting (2 times within 60s).
34. **pi plugin params are standard JSON Schema while DSH tools need per-property mapping**: `required` is an array of objects in pi (`["x"]`) but `required:true` on each property in DSH — passing it straight through makes the DSH compiler treat `type` as a property name; it must go through `piParamsToDshSpec`.
35. **ctx.tools is brand new after a respawn**: after a model switch/watchdog restart every bridged tool is gone, so `syncPluginTools` must be re-run from the `runtime.onStarted` callback (syncing once at attach is not enough).
36. **Tool results must match the output schema**: bridged tools declare `output:{schema:{type:'string'}, render}` and the server normalizes the result into a string (`normalizeToolResult`); a non-string return is rejected by `snapshotToolValue`/schema validation with ToolOutputError.
37. **tools/invoke is DEBUG-only**: verifying the full zero-key round trip (trampoline→notification→call-result restoration) requires the runtime to run with `PI_WEB_DSH_DEBUG=1`, otherwise the RPC errors; it is unusable in production.

---

## 7. Related file list (required reading for a new conversation)

| File                                                     | Purpose                                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `E:/pi-web-ui/server/dsh/dsh-agent-service.ts`           | Engine body (DshClientSession protocol alignment + goal=DSH native event-driven + DshAgentService)                      |
| `E:/pi-web-ui/server/dsh/dsh-client.ts`                  | DshRuntime (launcher spawn + JSON-RPC + goal RPC + kill/restart)                                                        |
| `E:/pi-web-ui/server/dsh/dsh-serialize.ts`               | Event → UiMessage + DshStreamAccumulator                                                                                |
| `E:/pi-web-ui/server/dsh/dsh-sessions.ts`                | JSONL read-only (list/replay/fork material)                                                                             |
| `E:/pi-web-ui/server/dsh/dsh-usage.ts`                   | Bottom-bar statistics pure mapping (DSH usage → four buckets / context usage / log takes the last usage record)         |
| `E:/pi-web-ui/tests/dsh-stats-test.mjs`                  | Bottom-bar statistics regression: fake runtime fed with live frames/persisted events, zero key / zero child processes   |
| `E:/pi-web-ui/server/dsh/runtime/launcher.mjs`           | Runtime launcher (boot composition; jsonrpc wrapper target; user patch layer)                                           |
| `E:/pi-web-ui/server/dsh/runtime/goal-rpc.mjs`           | ⭐ jsonrpc wrapper plugin: goal/set                                                                                     | get | clear | resume | edit + attachment/save | read + question/answer + question provider bridge |
| `E:/pi-web-ui/server/dsh/runtime/runtime-root.mjs`       | Runtime tree resolution (flat + nested layouts)                                                                         |
| `E:/pi-web-ui/server/dsh/runtime/override.patch.yml`     | Composition override layer (permission preset and friends)                                                              |
| `E:/pi-web-ui/dev/dsh-probes/probe-native-goal.mjs`      | DSH native goal probe (goal/set→round-driver→complete→clear)                                                            |
| `E:/pi-web-ui/dev/dsh-probes/probe-vision.mjs`           | Vision bridge probe (attachment/save+read+vision model image reading)                                                   |
| `E:/pi-web-ui/dev/dsh-probes/probe-tools.mjs`            | Tool bridge probe (tools/sync+list registration/listing/schema conversion + tools/invoke round trip)                    |
| `E:/pi-web-ui/dev/dsh-probes/probe-skills.mjs`           | Skill enable/disable probe (filterSkillCatalogMessage unit tests + register/list/get/set-disabled round trip)           |
| `E:/pi-web-ui/tests/dsh-smoke-test.mjs`                  | dsh engine zero-key protocol smoke test (already part of run-smoke ALL)                                                 |
| `E:/pi-web-ui/tests/dsh-goal-test.mjs`                   | dsh goal real-key gated test (set_goal→round-driver→complete→clear)                                                     |
| `E:/pi-web-ui/tests/dsh-question-test.mjs`               | dsh question bridge real-key gated test (question_pending→answer→model continues)                                       |
| `E:/pi-web-ui/tests/dsh-vision-test.mjs`                 | dsh vision bridge real-key gated test (imageData→attachment/save→vision model reads the image)                          |
| `E:/pi-web-ui/tests/dsh-tools-test.mjs`                  | dsh tool bridge real-key gated test (model calls the bridged plugin tool test_echo → server executes → result returned) |
| `E:/pi-web-ui/tests/dsh-mcp-test.mjs`                    | dsh MCP tool bridge real-key gated test (mcp.json → McpBridge discovers mcp_echo → model calls → MCP_ECHO returned)     |
| `E:/pi-web-ui/tests/dsh-ui-test.mjs`                     | dsh browser UI E2E (zero-key Playwright: engine badge/goal bar/DSH patches block/skill notes, 5/5)                      |
| `E:/pi-web-ui/web/src/components/QuestionDialog.tsx`     | Model question dialog (single/multi choice/custom text + `Markdown(rawHtml)` rich rendering + option `preview` box)     |
| `E:/pi-web-ui/dev/dsh-probes/probe-patch-seam.mjs`       | User patch layer probe (verifies session root redirection)                                                              |
| `E:/pi-web-ui/server/index.ts`                           | Engine dispatch (ENGINE/EngineService/DispatchSession) + dispatch table + dsh_patches branch                            |
| `E:/pi-web-ui/server/protocol.ts`                        | The wire protocol's single source of truth (ready.engine + dsh_patches messages)                                        |
| `E:/pi-web-ui/scripts/copy-dsh-runtime.mjs`              | build:dsh-runtime (copies .mjs/.yml into dist)                                                                          |
| `E:/pi-web-ui/server/agent-service.ts`                   | pi engine (protocol alignment reference; where QuiesceRejectedError is defined)                                         |
| `E:/pi-web-ui/server/files-service.ts`                   | File/SCM service (scmQuery with a git-dir watcher, reused by dsh)                                                       |
| `E:/ds-web-ui/server/dsh-client.js` / `agent-service.js` | Port source (JSONL decoding/event adaptation reference)                                                                 |

---

## 8. Follow-up optimization roadmap (user's backlog, by priority)

> Status as of 2026-09-01 (round two): v1 feature-complete + all P0 done + all P1 done + part of P2 done,
> smoke 22/32 + 2 environment skips (conv-cwd/plugin-*/slash-commands turned green). The items below are ordered by "impact × cost".

### 8.1 P0 — Stability / robustness (✅ all done)

| #   | Item                                                    | Status and implementation                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Automatic runtime crash restart watchdog**            | ✅ `DshRuntime.onExit` takes an intentional parameter (kill/close on purpose vs unexpected crash); `handleRuntimeExit` restarts with rate limiting (at most 2 times within 60s, beyond that it escalates to an error notice); before restarting it resets the streaming state of every conv; a late exit event from the old process no longer harms the new initialize (the `this.proc !== spawned` identity check in dsh-client) |
| 2   | **setModel / abort race**                               | ✅ setModel checks for an active run first → emits a warning notice (「有对话正在运行，切换模型将中止当前所有运行」/a conversation is running, switching models aborts every current run)                                                                                                                                                                                                                                         |
| 3   | **convs memory reclamation**                            | ✅ a 5min timer + newChat trigger `reclaimIdleConversations`: non-active/non-streaming/no terminal, unlisted idle >30min, listed idle >24h are reclaimed (the JSONL stays on disk and can be replayed); setCwd also reclaims the old project's unlisted conversations when switching projects                                                                                                                                     |
| 4   | **PI_WEB_DSH_DEBUG gate**                               | ✅ dsh-client honors `PI_WEB_DSH_DEBUG=1`: RPC frames (-> / <-), exit/kill/restart lifecycle events go to stderr                                                                                                                                                                                                                                                                                                                  |
| 5   | **start failure retries**                               | ✅ `startWithRetry`: exponential backoff 1s/3s/9s; the error notice is only emitted after the final failure (shared by create and the watchdog)                                                                                                                                                                                                                                                                                   |
| 6   | **Question bridge timeout config + frontend countdown** | ✅ `PI_WEB_DSH_QUESTION_TIMEOUT_MS` (default 10min); question_pending carries a deadline; QuestionDialog shows a countdown + auto-cancels at zero (questionTimeout/questionTimeoutExpired i18n)                                                                                                                                                                                                                                   |

### 8.2 P1 — UX alignment (✅ all done)

| #   | Item                                              | Status and implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | **Image paste vision validation**                 | ✅ ChatInput `currentModelNoVision()`: when the current model has `vision === false` in the models list, paste/drag/drop/upload of images is rejected with a hint (modelNoVision i18n)                                                                                                                                                                                                                                                                                                                                  |
| 8   | **Settings panel empty lists**                    | ✅ under DSH the skills/extensions empty lists show explanation text (dshSkillsNote/dshExtensionsNote); the vision tab is hidden; presets/disabledPlugins/terminalBash and friends echo real stored values (persisted in ClientStateStore, surviving reconnects)                                                                                                                                                                                                                                                        |
| 9   | **reviewPrompt / visionBridge ineffective items** | ✅ the vision tab is hidden under DSH (real images go straight to the vision model); the review block shows a DSH semantics note (dshReviewPromptNote); reviewPrompt is still stored and injected via DSH_PERSONA                                                                                                                                                                                                                                                                                                       |
| 10  | **GoalBar out-of-rounds detection**               | ✅ applyGoalChange + `<goal_round>` events: round >= maxGoalRounds while still active → status 「已达轮数上限（N/M），目标未完成」(round limit reached, goal incomplete)                                                                                                                                                                                                                                                                                                                                                |
| 11  | **locked / reviewModel semantics**                | ✅ in setGoal, locked=false → maxGoalRounds forced to 1 (single-round approximation); locked=true keeps the user's rounds; GoalBar hides the reviewModel dropdown under DSH (dshNoReviewModel note)                                                                                                                                                                                                                                                                                                                     |
| 12  | **conv-cwd smoke alignment**                      | ✅ setCwd: notice text aligned (「已切换到工作目录」/switched to the working directory), listFiles refreshed proactively, pushProjects, old project convs reclaimed; emitConversations lists listed + the current conversation (when it has content, issue #140; blank conversations are not listed); switchConversation across projects switches cwd + restarts the runtime. **conv-cwd-test fully passes** (conv-cross-project depends on the pi mock provider and fails on the pi baseline too, so not a regression) |
| 13  | **Session JSONL retention cleanup**               | ✅ `PI_WEB_DSH_SESSION_RETENTION_DAYS` (default 90): a first cleanup 10s after startup + an idempotent cleanup every 24h (activity is judged by the newest file mtime in the directory — appending to JSONL does not update the directory mtime)                                                                                                                                                                                                                                                                        |
| 14  | **session search enhancement**                    | ✅ searchSessions indexes the nested tool output text of tool-results                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 8.3 P2 — New capabilities

| #   | Item                                                  | Status and implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15  | **Tool bridge (plugin injection point)**              | ✅ Done (§2.8) — RPC `tools/sync` registration (pi JSON Schema → DSH parameter mapping) + `tools/list` validation + `tools/call-result` return; the trampoline execute sends a `tools.call.request` notification → the server runs the plugin implementation → `tools/call-result` restores it. Folded into goal-rpc.mjs (transport already exists); `applyPluginAgentTools` re-syncs + `runtime.onStarted` registers automatically after every start. Proven by real-key E2E (model calls test_echo → plugin echoes `ECHO:…` → model replies)                                                    |
| 16  | **MCP bridge**                                        | ✅ Done (§2.9) — **goes through pi's McpBridge + the #15 tool bridge**: `<dataDir>/mcp.json` → McpBridge starts the stdio MCP server → `adaptMcpTool` adapts remote tools into `PluginAgentTool` → they flow automatically into #15's `tools/sync` bridge via `pluginToolsProvider` (including `mcpBridge.getTools()`) → the model calls → `McpClient.call` forwards → the result is returned. Proven by real-key E2E (fake MCP server `mcp_echo` → `MCP_ECHO:marker`). Trade-off: the DSH local MCP client was not used (it is a separate configuration/lifecycle, marginal benefit)             |
| 17  | **Dynamic model catalog**                             | ✅ goal-rpc.mjs adds `model/list` (ctx.llm.listModels) + dsh-client.listModels + listModels merges the local table (pricing/context/vision flags) with the dynamic catalog; setModel validation includes dynamicModels. ⚠️ this round fixed a hidden bug: goal-rpc's `inject` was missing `"llm"`, so `ctx.llm.listModels` reported `cannot get property "llm" without inject` and the dynamic catalog never actually took effect (the local table happening to hold 3 models masked the error) — `inject` now includes `"llm"`                                                                   |
| 18  | **Skill enable/disable UI**                           | ✅ Done (§2.10) — new skills/list + skills/get + skills/set-disabled RPC (directly against the `ctx.skills` SkillRegistry); `settings_state.skills` is filled with real DSH skills (enabled derived from disabledSkills); the disabled set is pushed to the runtime, where a late `agent/pre-step` hook filters the skill-catalog message by `server.disabledSkills` (self-contained rebuild of `source.entries` + the `<available_skills>` block, no import of dsh-skill). Unit tests for the `filterSkillCatalogMessage` pure function + a proven registration/listing/disable round-trip probe |
| 19  | **Goal migration notice on fork**                     | ✅ forkConversation detects an active goal on the original conv (verdict=pending) → appends to the notice 「原目标已随旧会话存档，如需继续请重新设置目标」(the original goal is archived with the old session; set a new goal to continue)                                                                                                                                                                                                                                                                                                                                                        |
| 20  | **Question bridge concurrent queueing**               | ✅ goal-rpc.mjs askUser queues (depth 3, rejects when full); after an answer `dispatchNextQuestion` sends the next one automatically; only one is ever shown to the browser                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 21  | **Streaming UI enhancement (thinking block folding)** | ✅ reuses ThinkingBlock folding (same as pi); the root cause was dsh pushSettings hardcoding thinkingWrap to true → changed to settings.thinkingWrap defaulting to false (same as pi), so long thinking is collapsed by default                                                                                                                                                                                                                                                                                                                                                                   |

### 8.4 Tests and delivery

| #   | Item                         | Current state                                                                                                                                                                                                                                                                                                                                                                                                                             | Plan |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 22  | **dsh-specific smoke suite** | ✅ Done (§8.6) — `tests/dsh-smoke-test.mjs` zero-key protocol smoke (already part of run-smoke ALL), `tests/dsh-goal-test.mjs` / `dsh-question-test.mjs` / `dsh-vision-test.mjs` real-key gated (SKIP with exit 0 when there is no key). ⚠️ also fixed the hidden P2-17 bug: goal-rpc inject was missing `llm`, so the dynamic model catalog never actually took effect (the local table happening to hold 3 models masked the error)     |
| 23  | **Browser E2E (playwright)** | ✅ zero-key UI E2E (§2.11) — `tests/dsh-ui-test.mjs`: engine badge (DSH)/goal bar/settings panel 「DSH 用户补丁」(DSH user patches) block (scans dsh-patches and shows the files)/skills tab DSH note, 5/5 passing. Browser-level rendering of streaming/image paste/the question dialog is covered by protocol-level dsh tests (goal/question/vision) plus engine-agnostic shared components (StreamMarkdown/QuestionDialog/image-paste) |
| 24  | **Deployment docs**          | ✅ Done (§8.7) — `docs/deployment.md` gains an "Engine selection (pi / DeepSeek Harness)" section (PI_WEB_ENGINE / DSH runtime tree / environment variables at a glance / user patch layer / systemd+launchd env examples); `Dockerfile` installs the global dsh runtime tree; `docker-compose.yml` gains DSH comments. `docs/env-vars.md` already had the DSH variables                                                                  |

### 8.5 Known trade-offs (not planning to change unless the user asks)

- **No character-by-character streaming**: the message_delta channel is implemented; the 60ms snapshot throttle is by design (same as pi).
- **queue = cleared on send**: DSH has no mid-run steering; while isStreaming prompts go to followUp, and the frontend's optimistic message enters the stream immediately.
- **No independent reviewer**: goal completion/blocking is self-assessed by the model (DSH's official design); blocked needs the same condition for 3 consecutive rounds.
- **abort = restart the runtime**: the runs of all sessions stop together (the DSH protocol surface has no per-session close).
- **Model config form / custom providers**: the DSH engine only has the built-in deepseek models; v1 explicitly does not support this.

### 8.6 dsh-specific smoke suite (#22, completed this round)

The former ad-hoc probes (mixed / native-goal / patch-seam / vision) became formal `tests/*-dsh-test.mjs` cases; the zero-key parts joined run-smoke, and the real-key gated parts run separately (printing SKIP and exiting 0 when there is no key):

| File                          | Gate     | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                            | Status                                          |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `tests/dsh-smoke-test.mjs`    | zero key | ready.engine=dsh, initial pushes (conversations/goal_status/settings_state/slash_commands/snapshot), dsh_patches list, list_sessions, list_models (local table + dynamic catalog merged), set_settings echo + reconnect persistence, agent presets (dsh_presets default/switch/change default/invalid rejection), three permission levels (dsh_permission_set/default), slash interception (/model /cwd), terminal echo, scm_status | ✅ all green, **already part of run-smoke ALL** |
| `tests/dsh-goal-test.mjs`     | real key | set_goal → goal_status in progress → round-driver continues rounds automatically → model self-assesses complete → clear_goal empties it                                                                                                                                                                                                                                                                                             | ✅ 3/3, ~3s                                     |
| `tests/dsh-question-test.mjs` | real key | model ask_user_question → question_pending → question_answer → the model receives the answer and continues replying (text_delta)                                                                                                                                                                                                                                                                                                    | ✅ 3/3                                          |
| `tests/dsh-vision-test.mjs`   | real key | set_model vision-exp → imageData attachment → attachment/save → the model reads the image and replies                                                                                                                                                                                                                                                                                                                               | ✅ 1/1                                          |
| `tests/dsh-tools-test.mjs`    | real key | plugin registerAgentTool → model calls the bridged tool test_echo → server executes → ECHO:marker returned to the model and the conversation                                                                                                                                                                                                                                                                                        | ✅ 2/2                                          |
| `tests/dsh-mcp-test.mjs`      | real key | mcp.json → McpBridge discovers mcp_echo → model calls → MCP_ECHO:marker returned to the model and the conversation                                                                                                                                                                                                                                                                                                                  | ✅ 2/2                                          |

**Pitfall log**:

- **A user patch file must not insert a duplicate dsh-session entry** (it collides with the base bundle's `sessions` service registration → boot fails, showing up as initialize reporting `cannot create effect on inactive context`) — the smoke test switched to the harmless persona override verified by probe-patch-seam.
- **A WS wait helper timeout must remove itself from the waiters**: a stale pred left in the queue after a timeout silently consumes subsequent new messages, so the loop never sees the real target state — the connect helpers in dsh-goal/question/vision all remove themselves via `waiters.indexOf(entry)`.
- **DSH text_delta is pushed character by character** (each delta is 1-2 characters): do not test `delta.length > 3`; accumulate and test the concatenation (`repliedText.length >= 4`).
- **The message_delta field is `assistantMessageEvent`** (`{type, contentIndex, delta}`), not `delta`.
- **The vision test must wait 8s after set_model** (model switch = runtime restart + vision boot); 5s is not enough.

### 8.7 Deployment docs (#24, completed this round)

- `docs/deployment.md` gains an "Engine selection (pi / DeepSeek Harness)" section: PI_WEB_ENGINE switching, the DSH runtime tree requirement (`npm i -g @deepseek-ai/dsh@0.1.1-rc.2`), the DSH environment variables table, the user patch layer (dsh-patches), and systemd/launchd service environment variable examples (`Environment=` / `EnvironmentVariables`).
- The `Dockerfile` runtime stage adds `RUN npm i -g @deepseek-ai/dsh@0.1.1-rc.2` (the image ships the dsh runtime tree, resolvable via `npm root -g`).
- `docker-compose.yml` environment gains DSH comments (`PI_WEB_ENGINE` / `PI_WEB_DSH_PATCH_DIR` examples).
- `docs/env-vars.md` already had all DSH variables (lines 19-25), no changes needed.
