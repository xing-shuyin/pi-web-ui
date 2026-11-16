**English** · [简体中文](./tool-context-budget.md) · [繁體中文](./tool-context-budget.zh-TW.md)

# Tool context budget

> Every turn the model has to swallow the names + full parameter schemas of **all active tools**. With so many tools this is tens of
> thousands of characters of **fixed overhead** (even when the turn only uses bash). This document records the four levers that squeeze
> it, their trade-offs, and **why lazy loading does not break the provider's prefix cache** (the easiest thing to break in the implementation).
>
> Related code: `server/load-tools-tool.ts` (on-demand loading entry), `server/tool-manager.ts` (gating +
> `lazyLoadingDisabledTools`), `server/prompt-composer.ts` (prompt catalog section),
> `server/tool-prompt-overrides.ts` (per-tool text overrides), and `applyToolGating` / `lazyToolCatalog` /
> `promptToolCatalog` / `loadLazyTools` in `server/agent-service.ts`.

## Request-level read-only result deduplication

`server/request-context.ts` builds this request's view from the SDK `context` event and rewrites neither SDK history, the on-disk transcript, nor UI messages. It deduplicates only successful `read` / `grep` / `find` results whose parameters and plain-text output are completely identical and whose serialized output is at least 4096 characters. The first full text and every tool call/result pairing are kept; later results reference the first call id. Errors, images, text with extra fields and results without a matching call are left as-is.

Each request rebuilds the references from the current context and keeps no cross-request index, so once compaction deletes old evidence the new first full text is retained automatically. User interjections, tool edits, and calls/results of unknown tools (including codemode / plugins) all clear the evidence index; mixed read/write batches establish no index. A query is only compared against the most recent valid full text: a changed body, an error, a small result, an image or a structured result invalidates that query's old evidence, preventing cross-version references when content goes A → B → A. Deduplication only references backwards and never rewrites an earlier deduplicated result because of later messages. Neither SDK history nor the existing soft-cap compaction behavior is rewritten.

### Persistent evidence for large outputs

pi engine only. For persistent sessions with `read` active, the message budget is estimated as 70% of the current model window minus the system prompt, active tool schemas and output reserve (characters / 3, not a provider-exact tokenizer); only when the budget is insufficient does externalization start from older outputs, keeping the two most recent tool results in full. Successful plain-text `read` / `grep` / `find` results of 24000 characters or more are saved to `<session.jsonl>.evidence/<sha256>.txt`, and the request keeps 3000 characters on each side plus the stable identifier `context-evidence:<sha256>`, which `read` can page through. Before entering the SDK `tool_call` and the host permission guard, `read` resolves the identifier into a file path under the current SDK session's evidence directory; no tool schema is added and no existing read implementation is bypassed. Original history stays untouched; errors, images, signed text and structured results are not handled. Ephemeral sessions and SSH workspaces keep the full text (a remote `read` cannot reach a local evidence path on the server).

Evidence files are isolated per session and content-addressed, and an existing file must pass a content check; a temporary file is written first and committed through an exclusive hard link, and only after success is the request content replaced. Bounded chunked reads, file-handle checks and digest verification are used, rejecting symlinks and oversized content; cancellation runs through the queue and the I/O, and a cancelled request never degrades into a normal one. Verification, budget checks and writes for the same session run serially so concurrency cannot push past the quota; different sessions do not block each other. A single file is capped at 1MiB, and the session directory's 64MiB budget is checked before writing; on failure or overage the original text is kept. Evidence never expires automatically; when a session is deleted through the host, the evidence directory is cleaned through the same write queue after the transcript is removed, and late writes fall back to the original text because the transcript no longer exists. A cleanup failure is reported as a delete failure. Evidence is backed up and migrated together with the session transcript; copying only the JSONL does not carry the evidence directory. The uncompressed original tool output is still in the transcript, so a request after branching or migration can rebuild evidence at the new session position; new stable identifiers resolve from the new session position after migrating with the evidence directory; absolute paths already baked into old compaction summaries still require the original evidence directory. The pi host's message branch and edit-and-resend entries verify and copy the parent session's evidence before continuing; the child session holds its own files, so deleting the parent does not affect it. A copy failure is reported as an operation failure; an unpublished branch cleans up the transcript and resources, and edit-and-resend restores the original session after a copy failure. When an external tool copies only the JSONL without the evidence directory, evidence referenced in summaries stays unavailable. Evidence paths still go through the existing `read` permission checks, and no extra HTTP download endpoint is offered. Requests still carry the original history for SDK compaction accounting, so this does not lower the SDK's compaction trigger waterline.

### Compaction task state and the evidence index

`server/compaction-instructions.ts` appends one shared set of retention requirements to the SDK's default compaction pipeline: goal, user constraints, verified facts and their evidence, actual changes, verification results, open questions and next steps. It keeps the SDK's own summary format, separates assumptions from facts and self-reported summaries from primary evidence, and starts no extra model request. It covers manual, soft-cap and default automatic compaction; custom summaries supplied directly by an extension remain the extension's responsibility.

After the summary is generated and before it is persisted, an evidence index is attached deterministically, listing at most 32 stable references; the full list is available via `read({path:"context-evidence:index"})`. The index holds file names only and injects no body text, so compaction does not leave the model unable to see the references in the request projection and forgetting the evidence.

The SDK exposes no public interface for automatic compaction instructions or for resolving aliases before the permission check, so private-interface adapters `installCompactionInstructions` and `installEvidenceToolHooks` are used: they validate structure and arity and install idempotently; when the SDK is incompatible the default behavior is kept. These adapters must be regression-verified on every SDK upgrade.

Custom instructions for soft-cap automatic compaction can be passed through the `autoCompactionInstructions` setting (empty = not passed, keeping the SDK default summary): an extension can use this to let a `session_before_compact` hook take over summary generation for automatic compaction without touching host source. It only affects automatic compaction; manual `/compact` and the AI's `compact_context` still pass their own instructions. The evidence directory still has to migrate with the transcript, and old absolute paths are not rewritten automatically.

Verification: `tests/unit/request-context.test.ts`, `context-evidence.test.ts`, `compaction-instructions.test.ts`, `evidence-tool-hooks.test.ts`, `context-integration.test.ts`.

## 1. How big the overhead is

Taking 30 catalog/core tools as an example (the settings page's "View tool schema" shows the live numbers):

| Component                                                           | Approx.             |
| ------------------------------------------------------------------- | ------------------- |
| Tool text (description + snippet + guidelines)                      | 11.3k characters    |
| Parameter schema (JSON, with parameter descriptions/enums/defaults) | 18.6k characters    |
| **Total dispatched tool schema**                                    | **~33k characters** |

The parameter schema is a structured **contract** (enums, defaults, ranges, per-action semantics); delete it and the model passes wrong parameters, so squeezing the wording has a very low floor (measured: after full convergence only ~11% more is available).

## 2. Four levers

### 2.1 Tighten the wording (done)

See "three-way separation of duties for tool prompts" in `AGENTS.md`. description = what it does + side effects; snippet = trigger
condition (≤80c); guidelines = when to use / order / prohibitions. Each thing is said once; the guard test
`tests/unit/tool-prompt-hygiene.test.ts` enforces it mechanically.

### 2.2 Per-tool text is editable (done)

Settings → Tools → "Edit text": `description` / `promptSnippet` / `promptGuidelines` can all be overridden;
empty = factory default. Stored in `ClientSettings.toolPromptOverrides`; patches land on the SDK's merged
`_toolRegistry` (core built-ins / this project's tools / plugins / MCP all covered). See
`server/tool-prompt-overrides.ts`.

### 2.3 Lazy loading (this mechanism, **off by default**, can be enabled; allowlist-based)

On: `load_tools` is resident; only tools in the **on-demand list** (`ClientSettings.toolOnDemandTools`, see §2.6) are lazy —
in the `{{tools}}` section of the system prompt they have only **a name + a one-line summary** (the catalog), and their parameter schemas stay out of context. When the model needs one it first calls `load_tools(["patch","lsp"])`, that batch becomes active, and only then are the schemas dispatched.
Tools outside the list (including the core `bash` / `read` / `edit` / `write`) stay resident under the switch/preset; an empty list means nothing is lazy
(in that case `load_tools` is not mounted and the whole `{{tools}}` section is omitted, see §3).

- Switch: Settings → Tools → "Load tools on demand" (`ClientSettings.toolLazyLoading`, **off by factory default**, i.e. the master switch for `load_tools`).
  Why off by default: if the model forgets to load it first eats one `Tool <name> not found` (the SDK only knows the declared set), so out-of-the-box
  usability wins; instances that need to save context turn it on themselves, and the deployment-level default can be set with the environment variable `PI_WEB_TOOL_LAZY_LOADING=1`
  / `true` / `on` / `yes` (a default value only; a user's saved setting wins).
  Off = everything active per the switch/preset (matching the pi CLI, the list has no effect). **Only affects new sessions and later gating replays** —
  it never empties the tools of a conversation that is already running.
- Gating: lazy loading **introduces no second gating path**. An unloaded on-demand tool = temporarily added to the disabled list
  (`lazyLoadingDisabledTools(all, loaded, core, onDemand)`, where `only` is the list), still going through the `applyAgentToolsGating` chain. Loading only takes the
  name out of that list.
- `load_tools` is a **resident scaffolding tool**, it does not enter `AGENT_TOOL_CATALOG` (it cannot be turned off on its own, only the master switch controls its existence),
  and `forceActive` in `applyAgentToolsGating` keeps it in the active set even under non-standard presets
  (the `ask` preset has no tools at all, so it is not forced in).
- The loaded set is stored per **session object** (`WeakMap`): a takeover moves the session itself, so the set moves with it;
  when a session is restored from a transcript it is seeded with the active set at that time (only names in the list are remembered, whatever was loaded last time stays loaded).
- Loading **rejects**: unknown names / not in the list (resident tools are called directly) / turned off by the user / not allowed by the current preset / blocked by the plan-mode gate / already loaded
  — the reason goes back in the tool result so the model can correct itself.
- **The model forgets to load and calls a catalog tool directly** (JIT auto-activation): the SDK dispatches
  `tool_execution_start` before resolving the tool, then answers `Tool <name> not found` because the tool is not in the active set; on
  that event the server adds the tool to the loaded set **and immediately replays gating**, so it is genuinely active from the next turn on — the model
  retries unchanged and succeeds, with no detour of loading some other tool first (issue #652).
- "Already loaded" is judged by the **active set**, not just the loaded set: a half-done state that is marked but not activated gets treated as a
  reload and corrected, instead of answering "already loaded" and blocking the model (same #652).
- The DSH engine has no pi tool registry surface, so this does not apply (the settings row is hidden, the protocol field is a constant `false` placeholder).

### 2.4 Single-sourcing shared sub-schemas (for large tools)

A question object used to be copied separately into `ask_user_question` / `communicate` / `conversation`
(the `preview` / `recommended` / `dependsOn` / `optionsMap` rich-interaction fields), so what went to the model was three copies of the same
structure, and a field change meant three edits. Now it is unified in `server/question-params.ts`:

- `richQuestionsSchema()`: the full field set for rich dialogs (the source of truth for dialog-only capabilities such as `preview` / `dependsOn` / `optionsMap`);
- `askQuestionsSchema()`: the derived view `ask_user_question` dispatches to the model — dialog-only fields and decoration keywords are stripped, so the model only sees
  "what is asked, which options are offered"; the field definitions still exist in exactly one place, the rich variant;
- **Cross-conversation tools no longer declare question/answer structures**: `communicate`'s `request`/`reply` and `conversation`'s
  `consult`/`answer` take plain-text `message` only; structured questioning stays in `ask_user_question`.
  At the state-machine entry points (`questionsFromMessage()` / `answersFromMessage()` in `server/conversation-communication.ts`)
  the server folds the text into the internal structure: questions are wrapped as `[{ id: "q1", question: message }]`, and
  answers are expanded against the pending questions into `{ id, selected: [], custom: message }`. The old structured
  `questions`/`answers` are still accepted (TypeBox does not write `additionalProperties: false`), validated unchanged by
  `checkQuestions`/`checkAnswers` and then forwarded — **no capability lost, only the paid dispatch of the structure**.

In the same pass the wording redundancy of that batch of large tools was tightened (measured; character counts include description/snippet/guidelines, with the parameter schema itself in parentheses):

| Tool           | Before             | After              | Method                                                                                                                                                                                             |
| -------------- | ------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation` | 4785 (schema 4505) | 1998 (schema 1718) | structured question/answer structure retired, per-parameter text zeroed, `enum` replaces `anyOf`, boundary validation moved into the handler, one-line signature on `action` covers all parameters |
| `communicate`  | 2217 (schema 1418) | 1266 (schema 467)  | same: `questions`/`answers` retired, `enum` replaces `anyOf`, `minLength`/`min/max` moved into the handler                                                                                         |

The rule: the parameter schema is a contract, so field types and `enum` cannot be deleted; what can be deleted is **a second copy of the same
structure or sentence**, per-field descriptions (replaced by a compact one-line signature in the `action` field), mechanical boundaries
(`minLength`/`minItems`/`minimum`/`maximum`, all moved into the handler with `Math.min`/`Math.max` as a backstop),
and "when to use" inside descriptions (that is the snippet's job). The other route is not paying at all: hand these two
tools to lazy loading (§2.3), at the cost of one extra `load_tools` step for the model.

The same standard now covers every resident tool (`read` / `bash` / `edit` / `write` / `ask_user_question` /
`browser_page` / `claim_files` / `present_files` / `skill` / `grep` / `find`): the exported schema keeps only
field names and types, candidate values go in `enum` (`browser_page.op`'s signature states in one line which parameters each op needs), and
per-field descriptions remain only for the five that genuinely do not explain themselves (`read.offset`, `bash.timeout`/`persist`, `edit.soft`,
`present_files.items[].focus`, `skill.name`). `write` / `grep` / `find` are still implemented by the SDK; only their
text and schema are swapped by `server/tool-prompts.ts` (`withSlimPrompt()`), and the consistency of field names with the SDK definitions is watched by
`tests/unit/tool-schema-slim.test.ts`. Next, the same ruler is pushed onto the remaining 15 host/SDK tools and the `sftp`
plugin (§2.5). `codemode`'s description is computed by the SDK per turn from the loadout (it contains the `tools.<name>` declarations);
the host does not override it, and its budget is controlled by `codemodeInlineBudget`.

### 2.5 Low-frequency/large tools get the same slimming (second batch, measured −37%)

The same standard had previously landed only on the 11 resident tools; the remaining 15 host/SDK tools + the `sftp` plugin had no guard, so they grew back:
`action` using `Type.Union([Type.Literal…])` expanded into `anyOf` const arrays, `Type.Record()` expanded into
`patternProperties`, `minimum`/`maximum`/`minLength` all present, and per-field descriptions restating the action semantics.

They are now converged with the same ruler (measured character counts: description + snippet + guidelines + the parameter schema itself):

| Tool              | Before | After | Method                                                                                                                  |
| ----------------- | ------ | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| `canvas`          | 2946   | 2516  | the `anyOf/const` of 24 `action` entries → `enum`; `Type.Record()`'s `patternProperties` → `type:object`                |
| `mcp_manage`      | 2777   | 1436  | 3 `anyOf` → `enum`, `env`/`headers` `patternProperties` retired, 14 field descriptions → 1 signature line               |
| `sandbox`         | 2245   | 1020  | 2 `anyOf` → `enum`, 8 field descriptions zeroed                                                                         |
| `delegate_task`   | 2139   | 1554  | descriptions of the 7 required fields moved into `promptGuidelines` (field contract unchanged, only where it is stated) |
| `terminal`        | 2131   | 1274  | `anyOf` → `enum`, `minimum`/`maximum`/`minLength` moved into `create`'s `Math.min/max` backstop                         |
| `schedule`        | 1685   | 881   | per-field descriptions zeroed, only one line left for `schedule`'s cron/delay                                           |
| `worktree`        | 1525   | 963   | 2 `anyOf` → `enum`/`type:["boolean","string"]`, 7 descriptions zeroed                                                   |
| `lsp`             | 1526   | 803   | 8 field descriptions → 1 action signature line, `minimum/maximum` zeroed (handler already does `Math.min/max`)          |
| `patch`           | 1295   | 1114  | `minimum/maximum` + 2 descriptions zeroed (the description is the Hashline grammar itself, kept)                        |
| `plan_update`     | 1121   | 771   | 6 field descriptions zeroed                                                                                             |
| `compact_context` | 1065   | 694   | `minimum/maximum` zeroed (`calculateEffectiveKeepRecentTokens` already clamps), only one `focus` line left              |
| `eval`            | 882    | 492   | `minimum/maximum` zeroed (handler already clamps), only two lines left for `timeout`/`reset`                            |
| `powershell`      | 590    | 252   | same as `write`/`grep`/`find`: SDK implementation + `withSlimPrompt()` swaps text and schema                            |
| `ls`              | 422    | 180   | same as above                                                                                                           |
| `sftp` (plugin)   | 4851   | 2807  | 24 field descriptions → 1 action signature line + key hints for the 6 credential fields; `manifest.json` 0.4.8 → 0.4.9  |

Total **27.9k → 16.9k characters (−39%)**; the 9 that were factory-default resident at the time (`ls` / `patch` / `delegate_task` /
`sandbox` / `worktree` / `plan_update` / `compact_context` / `schedule` / `canvas`) went **14.5k → 9.7k
(−33%, roughly 1.3k tokens saved per turn)**.

> Later product decision (see the catalog in `server/tool-manager.ts`): `ls` / `patch` / `delegate_task` / `sandbox` /
> `worktree` / `canvas` all became `defaultOn: false`. Only `plan_update` / `compact_context` / `schedule` remain
> factory-default resident, so the "factory-default resident" framing in the table above narrows accordingly; the
> schema slimming on `ls` / `patch` and friends is still there and a user who turns them on explicitly benefits from it as before.

**What this batch deliberately did not do** (every cost was measured; the conclusion was negative return):

- **Do not delete tools.** `powershell` / `eval` / `lsp` / `terminal` / `mcp_manage` / `tool_search` are
  `defaultOn: false` at the factory, so under the default accounting they were already 0 characters — deleting them loses capability without saving
  budget; `ls` / `patch` / `delegate_task` are `defaultOn: true` product surface (catalog in `tool-manager.ts` + settings row + i18n + guard unit test),
  so deleting them removes features, not overhead. `patch`'s 926-character description is the Hashline grammar contract itself (`[path#TAG]`/`PUT`/`CUT`);
  delete it and the model cannot write patches. `delegate_task`'s 7 required fields are the validation contract against
  vague delegation; making them optional would bring back `validateDelegation()`'s failure modes — so only where it is stated moved, requiredness did not.
- **Do not merge `sandbox` + `worktree`.** Both "change cwd", but one is a CoW workspace and the other git-branch isolation;
  merging saves only ~1.2k characters (~330 tokens), at the cost of collapsing two sets of services/approvals/settings rows/permission gates into one
  mixed 15-action enum, and it violates "one capability, one tool name".
- **Do not flip defaults to make them lazy** (the conclusion at the time). Lazy loading is already provided by the global switch in §2.3; making
  headline features like `canvas` / `sandbox` / `schedule` load-on-demand by default is a product decision, not a by-product of budget
  optimization. The later product decision was to **turn `ls` / `patch` / `delegate_task` / `sandbox` / `worktree` / `canvas`
  off by default** (catalog `defaultOn: false` + the same list in the factory `disabledAgentTools`), and the reason is no longer budget but a narrower
  default tool surface; `plan_update` / `compact_context` / `schedule` stay on by default.

Guard: `tests/unit/tool-schema-slim.test.ts` now covers all 21 tools above (including `patternProperties`);
any single decoration constraint or any field description outside the allowlist turns it red.

### 2.6 The on-demand list: one registry for the lazy range (built-ins + plugins merged automatically)

Lazy loading in §2.3 is **allowlist-based** (only what is on the list is lazy, and the model pulls it back with `load_tools`). Anything off the list is resident;
an empty list means nothing is lazy.

`toolOnDemandTools` (Settings → Tools → "On-demand tool list"; the protocol field has the same name as the preset field) is that lazy list:

- **Listed = lazy.** With the switch on: not active, parameter schema out of context, the model must first call `load_tools` to pull it (resident for the rest of this conversation once loaded), and it is also auto-activated by JIT;
  with the switch off the list has no effect (everything resident per the switch/preset). `isNeverLazyTool()` (the core four + `load_tools`) is never lazy, and front end and back end share the same semantics.
- **One registry, nothing hardcoded.** `TOOL_NAME_PATTERN` + `foldLegacyToolName()` + `isValidToolName()` are the only naming rule (see `server/tool-manager.ts`):
  built-ins are accepted directly, plugins / MCP / future tools by the regex, orphan entries (plugin uninstalled / another device) are kept so nothing is lost; legacy aliases are folded
  automatically. The front-end inventory is `web/src/tool-inventory.ts` (`buildOnDemandOptions`): built-in catalog + live plugin inventory + orphan fallback;
  every tool-management UI derives from that inventory instead of hand-writing `[...AGENT, ...CORE]`.
- **Single source of truth for the partition.** `partitionLazyTools({all, allowed, onDemand, loaded})` computes `{resident, pending, loadedLazy}` in one pass,
  and gating/catalog/loading/JIT/prompt baseline share the same partition; `disabledToolSet()` converges the plan/delegation/subagent gates so `loadLazyTools` no longer hand-writes a second copy.
- **No more hard disabling.** `effectiveDisabledAgentTools()` no longer folds the list in; resident/disabled is decided only by `disabledAgentTools` (built-ins) + `disabledPluginTools` (plugins, filtered at the registry layer) + presets and mode gates. **There is no second gating path** —
  `applyAgentToolsGating` / `allowedToolNames` / the prompt catalog all read the same allowed set, and lazy only adds a temporary disable (`lazyLoadingDisabledTools(..., onDemand)`).
- Relation to §2.3: the switch is the master gate for `load_tools` (the tool only exists when it is on); the list decides the lazy range (plugins included). The DSH engine does not apply (no pi tool registry surface, the settings row is hidden).
- Guard: the "on-demand list + architectural single source" cases in `tests/unit/tool-manager.test.ts` pin the naming rule/aliases/partition/orphan retention; `tests/lazy-tools-test.mjs` turns the switch on, then writes the list, then creates the session.

## 3. Hard constraint: do not break the prefix cache

Provider prompt caches (Anthropic `cache_control`, OpenAI/DeepSeek automatic prefix caching) hit by **prefix**: as long as that
segment is completely identical to the cached one it hits, even if new content is appended after it. So we only allow **append-only**
change, never "change one character in the middle".

Lazy loading walks straight into this trap: the obvious implementation moves "loaded" tools from the catalog section to the "active tools" section — the catalog section
changes, so the system prompt changes, and the whole cache is wasted. **This implementation deliberately avoids it**:

1. **The system prompt is independent of the loaded set.** Under lazy loading `{{tools}}` lists only the **on-demand list**
   (`promptToolCatalog()`: registry order, **no filtering by loaded**) and **never lists resident tools** — their schemas are already dispatched in full,
   so listing them again only burns tokens; the section opens with one constant **English-only** one-liner (`On-demand tools (schema not attached — call load_tools with the names first):`, not bilingual, consistent with the tool-prompt policy).
   With an empty list this whole section is omitted (nothing to load, and `load_tools` is not mounted either).
   It is byte-for-byte identical before and after loading (it only changes with settings/presets, not with loading).
2. **Guidelines come from resident tools only.** Under lazy loading the Guidelines section of the system prompt holds only the points of resident tools (allowed set − list, including the core tools +
   `load_tools`); the points of loaded tools enter the conversation **with `load_tools`'s acknowledgement text** (appended, not a
   prefix change).
3. **The tools array only grows.** Loading produces only `toolsAdded` deltas (the SDK's `getToolStateChanges`);
   `toolsRemoved`/redefinition never appears; providers that support mid-conversation tool changes (Anthropic
   `defer_loading`, OpenAI `additional_tools` / `tool_search`) stream the new tools **anchored to the initial declaration**
   (`anchorsAdditions` in `resolveTranscriptTools`), and every other provider gets the current list as-is, which is still "old prefix + new tail".
4. **Stable order.** Both the catalog and the baseline list are generated in registry order, so repeated renders under the same settings are identical.

Regression: `tests/lazy-tools-test.mjs` (zero tokens, mock LLM) asserts outright that "the system text **is byte-identical** before and after
loading" and "the second call's tools have the first call's as a **prefix**", and covers
the JIT path "model calls an unloaded tool directly → the tool auto-activates → retrying unchanged succeeds" (#652).

⚠️ Operations that break the cache (all inside our control surface): editing `toolPromptOverrides` (the tool definition changes →
redefinition), turning a tool off (`toolsRemoved` → that conversation can only take the non-anchored path afterwards). These are
user-initiated, one-off costs that are acceptable; but **do not** change them in automated paths.

## 4. What this buys and what it costs

(All figures assume this switch is **on**; it is off by factory default, so what follows is "the price you pay when you want to save context")

- Benefit: resident schema depends on the list size — when the list takes in all the heavyweight tools, 33k → **~7k** (core tools + load_tools + resident tools outside the list). Tools on the list that never get used never enter context;
  the system prompt itself also drops from ~8.6k to ~6.7k (guidelines hold only resident tools). With an empty list the switch is equivalent to off (nothing lazy, no `load_tools`, no on-demand section), so check some tools before turning the switch on.
- Cost: the model takes one extra step, "load first, then use". The catalog (name + one-line summary) stays resident, so discoverability is not lost; a failed load
  states the reason. Weak models may forget to load — which is why this switch **ships off by default** (see §2.3).
  Also note the catalog **does not repeat resident tools** (especially the core four); their schemas are already in `tools`.
