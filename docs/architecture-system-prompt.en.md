**English** · [简体中文](./architecture-system-prompt.md) · [繁體中文](./architecture-system-prompt.zh-TW.md)

# System prompt composition and the compose template

> This document explains how the SDK (`@earendil-works/pi-coding-agent`) assembles the system prompt that is
> finally sent to the model, and how pi-web-ui's "compose template" lets you **freely combine** these sources
> and **individually override** any one of those layers.
> Sources of truth: SDK `dist/core/system-prompt.js` (`buildSystemPrompt`), `dist/core/resource-loader.js`
> (`discoverSystemPromptFile` / `loadProjectContextFiles` / override replay),
> `dist/core/agent-session.js` (`_rebuildSystemPrompt`), `dist/core/extensions/runner.js`
> (`before_agent_start` chained replacement); on the pi-web-ui side `server/prompt-composer.ts` (pure-function
> engine), `server/agent-service.ts` (integration), `web/src/components/SettingsModal.tsx` (settings UI).

## 1. Overview: assembly order of the final prompt

    Final prompt = base prompt(soul) + tool list(tools) + guidelines(guidelines)
                   + Pi documentation pointers(pi_docs) + append section(append) + pi-web-ui guidance
                   (markers) + project context(context) + skills section(skills)
                   + working directory line(cwd)
    Once the main session enables the "compose template", each layer above is a {{token}}: which tokens the
    template contains, in what order, and what text of your own sits between them decides the final prompt;
    a layer without an override uses **automatic content** (tools, context and skills are always regenerated
    by the SDK from the latest data).

## 2. Compose template and source tokens

    Token list (PROMPT_TOKENS in server/prompt-composer.ts; the default order is the natural assembly order):
        {{soul}}        agent persona (contents of SYSTEM.md when present, otherwise the built-in default)
        {{tools}}       Available tools list + the “In addition…” sentence
        {{guidelines}}  Guidelines: file exploration guidance + each tool's promptGuidelines + two fixed lines
        {{pi_docs}}     Pi documentation pointers (pointing at the installed pi package path)
        {{append}}      Append section = APPEND_SYSTEM.md contents; override = custom appended text
        {{markers}}     built-in marker tool guidance (when markers are on)
        {{context}}     <project_context> (result of collecting AGENTS.md / CLAUDE.md)
        {{skills}}      <available_skills> skill list
        {{cwd}}         Current working directory line
    Each layer can be **overridden individually**: when overrides[token] has content, your text replaces the
    automatic content; leave it empty = use the automatic content. An empty template = the default template
    (all tokens in natural order); with no template/override configured, behaviour is exactly the SDK default
    assembly (zero overhead, before_agent_start returns empty).

## 3. Where each source's automatic content comes from (the buildSystemPrompt view)

    Base prompt base (resource-loader.discoverSystemPromptFile, in priority order):
        1. project level: <cwd>/.pi/SYSTEM.md (when trusted)
        2. global level: <agentDir>/SYSTEM.md
        3. neither → undefined → the SDK default branch assembles the built-in template (persona + tools +
           guidelines + pi_docs)
    In compose mode systemPromptOverride always returns base (= SYSTEM.md verbatim, undefined when absent)
    → with the compose template active, before_agent_start replaces the prompt wholesale ({{soul}} uses the same base);
    with the compose template inactive, the SDK default branch keeps .pi/SYSTEM.md on that basis (same semantics as the
    TUI; the old implementation always returned undefined, so in a session with "all defaults + a SYSTEM.md" this file
    was silently dropped).

    base ownership (issue #812, hard rule):
        override is a **callback**; the base it pushes to the host must live under the **loader / session**
        (`server/prompt-base-store.ts`, key = the resourceLoader object), and must **never** be stored as the
        "most recently observed value" field on a ClientSession (= one browser client).
        Historical incident: `lastBaseSystemPrompt` was updated only while base was non-empty, so on switching to
        a project without SYSTEM.md nobody cleared the old value → the previous project's system prompt leaked into
        this project's settings preview and new conversations, and it was only reset by accident when visiting a
        project with an "empty SYSTEM.md".
        Rules:
        - record: **overwrite unconditionally** on every reload (write empty when base is missing), so a project
          without the file always has an empty record;
        - read: `readPromptBase(target session's session.resourceLoader)` — preview whichever conversation is being
          computed (recall the same class of cross-accounting as "compute a background session from the active session");
        - takeover: what moves is the session itself, and the record follows; after the session is destroyed the WeakMap
          reclaims it automatically;
        - blank semantics aligned with the SDK: empty string / undefined = no file (use the built-in default), a
          whitespace-only file = an empty prompt (`{{soul}}` keeps the original text, with no trim fallback).
        Guard tests: tests/unit/prompt-base-{store,scope,isolation}.test.ts.
    Project context (loadProjectContextFiles): candidates AGENTS.override.md > AGENTS.md >
        AGENTS.MD > CLAUDE.md > CLAUDE.MD; one from the global agentDir + cwd walking upward level by level,
        wrapped as <project_context><project_instructions path="…">…</project_instructions></project_context>.
    Skills section: visible skills (disableModelInvocation=false) as output by formatSkillsForPrompt;
        omitted when the read tool is unavailable. pi-web-ui skillsOverride filters by the disabled set.
    Working directory line: `Current working directory: <cwd with forward slashes>`.
    Pi package paths (README.md / docs / examples): resolved once from the install location
        (require.resolve("@earendil-works/pi-coding-agent/package.json")).

## 4. Engine (server/prompt-composer.ts, pure functions, reusable in the browser)

    resolveSectionTexts(inputs) → automatic content per token
    renderPromptTemplate(template, texts, overrides) → {{token}} substitution
        - overrides win: overrides[token] non-blank → use it; otherwise texts[token]
        - unknown tokens keep their original text (the UI can hint at a typo)
        - tokens whose automatic content is empty (e.g. {{append}} without APPEND_SYSTEM.md) expand to the empty string
    DEFAULT_PROMPT_TEMPLATE / PROMPT_TOKENS feed the settings UI (token insertion, restore defaults).
    Unit tests: tests/unit/prompt-composer.test.ts.

## 5. Runtime integration (server/agent-service.ts)

    Each session runtime registers a hidden inline extension <inline:pi-webui-persona>:
        before_agent_start (before every agent run) —
            - main session: if a template or any override is configured, render the compose template with this run's
              systemPromptOptions (selectedTools / toolSnippets / promptGuidelines / contextFiles /
              skills are all current) and replace this run's systemPrompt body;
            - subagent template replace: in the default branch, swap the soul section for the template prompt
              (automatic sections are kept); template append still goes through the loader append section.
        Chain preservation (shared by both branches) — we are the last handler on the before_agent_start chain
        (resource-loader orders inline extensions after all file/package extensions), and returning systemPrompt means
        forceSystemPrompt wholesale replacement, which would throw away what other extensions wrote as well. So split first:
            splitAgentStartPrompt(event) → { pre, core, post }
                forceSystemPrompt unset = nobody touched it, core is the current prompt, pre/post empty
                (zero overhead, byte-identical output to today);
                set = an earlier extension replaced it, temporarily clear that and read event.systemPrompt to get the SDK
                original baseline, splitExtensionWrap(baseline, current) lifts the head/tail additions into pre/post.
            Rendering/section swapping happens only on core, then pre + result + post are put back.
        Priority: user templates/overrides always win the prompt body; extensions only keep their own head/tail additions.
        When the baseline is not embedded verbatim in the current text (an extension inserted in the middle or replaced
        the whole thing) it cannot be lifted safely, so it falls back to today's behaviour (pre/post empty) and never
        doubles the whole prompt. With everything at defaults (uncustomized) the main session still returns undefined and
        extension changes take effect as they are.
        The pure function splitExtensionWrap lives in prompt-composer.ts, unit tests in
        tests/unit/prompt-composer.test.ts; the settings panel preview does not run extensions, so preview and a real run
        differ by these extension additions.
    Settings changes take effect on the next run without a reload (settingsSvc is read per run);
    session.reload() only syncs the loader side (default branch/skill filtering etc.).
    Settings panel preview (settings_state.effectiveSystemPrompt): uses the current session's resources
        through the same render function — consistent with a real run (read-only inspection).

## 6. Settings and migration

    Fields (client-state.json / protocol UiSettingsState):
        promptTemplate: string           compose template text (empty = default template)
        promptOverrides: Record<string,string>   per-source overrides
    Old save migration (getSettings): when customSystemPrompt is non-empty —
        append → the text becomes the {{append}} override (a standalone append block)
        replace → the text becomes the {{soul}} override
    The legacy fields promptMode/customSystemPrompt stay in the data structure (the DSH subsystem shares the same
    client-state storage as old presets, see dsh-agent-service.ts); the main session UI no longer uses them.
    Presets (SettingsPreset) additionally capture promptTemplate/promptOverrides; when an old preset
    lacks a field the current value is kept.

## 7. Settings UI (SettingsModal → the 「系统提示词」(System Prompt) page)

    Prompt template library (presets that capture only the prompt field group):
        A save_preset message carries groups:["prompt"] → snapshotPreset is narrowed by narrowPresetToGroups to only
        prompt group fields (promptMode/customSystemPrompt/promptTemplate/promptOverrides/promptDisabled/
        reviewPrompt/reviewDisabledSkills); on push, settingsPresetToUi tags them with scope:"prompt" via
        isPromptOnlyPreset. The panel filters by scope: the template library lists only scope==="prompt", the presets
        page/preset counts list only scope!=='"prompt"'. Switching a template = apply_preset (writes back only the prompt
        group fields); delete/share/import all reuse the preset channel (preset_export / preset_import /
        PresetShareModal), and an imported prompt-only JSON lands in the template library automatically. "In use" check:
        effectiveTemplate + the normalized override map + the promptDisabled set equal the server snapshot.
    Prompt sources (single list: switch + Chinese name + one-liner + ↑↓; click a name to expand and edit in place):
        Each row = switch (whether it enters the prompt) + Chinese name/one-line description + a 「已改|自动」
        (modified|auto) label + ≈tokens + ↑↓.
        Clicking the name expands: writable sources get an edit area (sub-heading promptSec_<token>_edit, hint
        _hint, empty = automatic content) + a collapsible 「查看默认内容」(view default content) comparison (one click
        fills it in); read-only sources only show the system-generated content and 「恢复默认」(restore default).
        The expanded area spans the whole row (no left/right padding, only the input's own padding) —
        .prompt-src-list / .prompt-src-body.
        Template-string semantics are unchanged: the switches drive promptDisabled (same semantics as the old
        "enable" checkbox);
        custom template: the template string is the single source of truth (collectTemplateTokens takes the order),
        switches = add/remove tokens, ↑↓ = swap neighbours; serialized with join("\n\n"), and zeroed back to "" when it
        exactly equals the default string (the zero-overhead default branch).
        First reorder under the default order → materialized into a custom template (default-disabled sections do not
        enter the template, promptDisabled is untouched).
        When an old template contains free text/unknown tokens, show a warning: switch/order edits keep only the enabled
        source sections.
        setTemplateValue uses the same submission discipline as the old editor (send only when it differs from
        serverSettings, keep the draft until the acknowledgement).
    Global "restore default template and clear all overrides" button (still sends an empty string per token; an empty-object patch deletes nothing)
    "View the current full prompt" read-only preview = the composed render result
    Message keys: promptTok_<token> (name) / promptTok_<token>_desc (one-liner)
        + promptSec_<token>_edit (edit-box sub-heading) / promptSec_<token>_hint (empty hint)
        + promptSecEdited / promptSecShowDefault + promptAssembly* / promptTemplate*
        (zh/en in sync; the other 12 language packs fall back to English by default, the Traditional Chinese pack
        writes its own Traditional text)

    Saving and acknowledgement (source of truth web/src/settings-sync.ts, regression tests
    tests/settings-prompt-save-test.mjs + tests/unit/settings-sync.test.ts) — read the four rules before touching this:
    1. Every change enters the pending overlay first (server snapshot ⊕ unconfirmed patch), and is removed only when
       the server settings_state acknowledgement matches the patch value. The UI therefore never rolls back to an old
       value because of a single unconfirmed (or already failed) save.
    2. promptOverrides / toolPromptOverrides are map-semantics fields (server side: "override child keys, empty string
       deletes"). The local overlay layers with the same semantics and never treats a partial patch as a whole value —
       otherwise the panel would treat untouched tokens as deleted, and writing the rebuilt result back to the server
       would really lose configuration.
    3. Draft rebuild only refreshes tokens not claimed locally (reconcileOverrideDraft): tokens being edited (focus)
       and changed-but-unacknowledged (dirty) are always kept; dirty is released only after the server acknowledgement matches.
    4. The top capsule shows the real acknowledgement state: saving / saved / failed (timed out or channel dropped). failed
       is clickable to retry; never use a timer to pretend "saved".

    The override boxes have two persistence paths: auto-submit 800ms after typing (not relying on blur) + immediate submit
    on blur; closing the panel / switching sections / unmounting runs flushAllDrafts once more (the comparison baseline is
    always the server's real value, not settings layered with pending).
    "Restore default template and clear all overrides" must send an empty string for each existing token: an empty-object
    patch means "delete no child keys" on the server, so sending {} clears nothing (historical bug, already guarded by a unit test).

## 8. Relation to subagent templates

    Subagent templates keep their own append/replace semantics (role presets): allowlist filtering of skills/extensions;
    replace swaps the subagent default branch's soul section for the template prompt when there is no SYSTEM.md; append is
    appended to that subagent's append section. Template conversations do not take the main session compose template (the
    role is defined by the template). The main session compose template does not affect template-derived subagents.
    Two other template dimensions are unrelated to the prompt and are applied at dispatch time (spawnSubagentConversation):
    model (provider/id) and thinkingLevel (off…max, see THINKING_LEVELS in server/subagent-templates.ts).
    Priority: explicit model argument > template model > settings panel subagent default model > follow the dispatching
    session's current model; thinkingLevel has no explicit argument, so an empty template value = follow the dispatching
    session's current level (session.thinkingLevel). Both are applied after the model switch, and setThinkingLevel converges
    to the model's capabilities (reasoning:false → off, xhigh/max need thinkingLevelMap); persist is not passed and only that
    subagent session is affected.
    Built-in templates live in DEFAULT_TEMPLATES in server/subagent-templates.ts (including the oh-my-pi specialist
    series: oracle/librarian/explore/metis/momus/multimodal-looker/sisyphus-junior); for users who already have files,
    missing built-in templates are filled in once (the sidecar subagent-templates.seeded.json records the seeded names, so a
    deleted one never comes back).
    Traditional Chinese view: resolveServerLang folds zh-TW/zh-HK/zh-Hant into "zh", so Traditional Chinese users get
    Simplified. localizeTemplate, keyed on the **original locale** (isTraditionalLocale), swaps in the Taiwan wording from
    subagent-templates-hant.ts (shared by the three Traditional Chinese UIs), while the built-in template's
    description/systemPrompt still equals the factory Simplified Chinese copy; used for settings snapshots, the templates
    tool and subagent system prompts; it is only a view, never written back to the store, and user-edited fields are left
    alone. canonicalizeTemplate, on upsert, restores text that is "exactly factory Traditional Chinese" back to Simplified,
    so one click on a switch in a Traditional Chinese UI does not rewrite the global store into Traditional Chinese. When
    the factory Simplified Chinese copy changes, subagent-templates-hant.ts must be updated in sync (guard test: subagent-templates.test.ts).

## 9. Structured delegation and full-text skill injection (a native port of the oh-my-pi essence)

    Settings (client-state.json / protocol UiSettingsState):
        delegate_task: structured delegation tool (server/delegate-task.ts), six mandatory sections + server validation
        skillsFullText: string[]        skills injected in full text (default empty = directory mode)
    Effect points (server/agent-service.ts):
        before_agent_start main session branch — the prompt the SDK assembled (or the compose template render result)
        delegate six-section assembly + validation rejections (see validateDelegation in server/delegate-task.ts).
        composeInputs — when the skillsFullText list is non-empty, fillSkillContents() best-effort reads the SKILL.md
            body of the listed skills (per-file skillsMaxFileBytes, total skillsFullTextMaxBytes caps, defaults 8KB / 32KB,
            counted in UTF-8 bytes, GBK fallback via decodeText), and
            fills PromptComposerInputs.skills[].content; {{skills}} expands listed skills in full-text format.
            The skill tool reads bodies under the same per-file cap (skill-tool.ts reads it live from the host),
            both settings at 0 = explicitly unlimited (issue #819).
    The list is read live per run by before_agent_start: changes take effect on the next turn, without
    session.reload() (settings-service needsReload does not include them); the settings preview
    (sessionPromptSnapshot) uses the same logic. The DSH engine only passes the stored value through (effective after switching back to pi).
    Presets capture the list (old presets lacking the field keep the current value).

## Source code map

    - pi-web-ui: server/prompt-composer.ts (tokens/engine/default template),
      server/agent-service.ts (override + inline extension + render preview),
      server/settings-service.ts / client-state.ts (settings persistence and migration),
      server/protocol.ts (UiSettingsState fields), web/src/components/SettingsModal.tsx
    - SDK: dist/core/system-prompt.js (buildSystemPrompt default assembly),
      dist/core/resource-loader.js (SYSTEM.md / context collection / override replay),
      dist/core/extensions/runner.js (before_agent_start chained replacement)
