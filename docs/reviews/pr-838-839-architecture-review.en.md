**English** · [简体中文](./pr-838-839-architecture-review.md) · [繁體中文](./pr-838-839-architecture-review.zh-TW.md)

# PR #838 / #839 technical review and architecture evolution recommendations

Reviewed: [PR #838](https://github.com/xing-shuyin/pi-web-ui/pull/838), merge commit `9df07225e4a30b7979d9ffb2a8a9e071b25e4b55`; [PR #839](https://github.com/xing-shuyin/pi-web-ui/pull/839), merge commit `d5ee3b203659758652d063d2070423cb4638c15a`. Conclusions are anchored to those commits; other changes in the current working tree are not counted as part of either PR.

**Conclusion: #838 is an effective stopgap fix, but the path compatibility layer is not a suitable long-term SDK boundary. #839 opens one limited entry point and does not establish a unified automatic-compaction extension contract. Fix the observable feature gaps first, then converge separately on a runtime-scoped plugin SDK and on a compaction lifecycle owned by the Pi SDK.**

Both PRs expose the same class of problem: information that belongs in an interface — runtime, trigger source — is instead expressed indirectly, by making every entry point browser-compatible in one case and by letting a string carry control signals in the other. Long-term evolution should make that information explicit while keeping the compatibility layer small and clearly scoped.

## 1. Confirmed issues and severity

| Priority | Issue                                                                        | Impact and ownership                                                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | The `set_settings` dispatch whitelist in #839 does not forward the new field | A client sending a valid `autoCompactionInstructions` has it silently dropped; the protocol declaration and the actual behavior disagree. This is an integration gap in that PR.                                          |
| P2       | #839 passes the instructions only on the host idle soft-cap path             | SDK threshold compaction between tool calls and overflow recovery still get no instructions; extensions that rely on a magic marker cannot take over automatic compaction uniformly. This is a capability coverage limit. |
| P2       | The mock path semantics in #838 diverge from native Node                     | Some legitimate paths are rejected or rewritten; this undermines the credibility of the test harness. It does not justify inferring a path traversal vulnerability in the production host.                                |
| P2       | `upgrade-sdk` checks the version of only the first copy                      | With an up-to-date server SDK, a stale client SDK and a complete file set, it can wrongly report up to date, blocking the #838 fix from landing. This is a pre-existing issue.                                            |
| P2       | The client adds epoch/retry parameters to the entry URL only                 | Relative dependency URLs are unchanged, so hot reload can keep using the old SDK, and a failed dependency can keep hitting the module cache. This is a pre-existing module-graph publishing issue.                        |

Beyond that, competing summaries from multiple extensions, error fallback, runtime result validation and commit consistency are SDK contracts that must be filled in before introducing a formal Provider; none of them are problems #839 introduced.

### 1.1 The #839 settings message really does drop the field

[The merged `handleSettingsMessage`](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/server/dispatch-domain-handlers.ts#L701) builds the object passed to `setSettings` by hand. `softCapTokens` and `softCapByModel` sit at lines 758–759, and the new field was not added. On the other side, [the protocol](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/server/protocol.ts#L1839) already accepts it and [the settings service](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/server/settings-service.ts#L1053) implements the write.

Running the real `handleSettingsMessage` in a throwaway snapshot of the merge commit with `{ type: "set_settings", autoCompactionInstructions: "[[auto]]" }`: the function returns `true`, `setSettings` is called, but the argument has no `autoCompactionInstructions`. That explains why the field type, persistence and preset unit tests all pass while the normal Web message entry point still cannot set the value.

The fix needs a dispatch mapping entry plus a matching parameter declaration on the host's `setSettings`. The regression test should run through real message dispatch, the settings service and a refreshed settings snapshot, covering write, clear and normalization. The new reproduction proves only the drop at the dispatch layer; a full persistence round trip has not been exercised.

### 1.2 The #838 path regression

[The new `resolvePath`](https://github.com/xing-shuyin/pi-web-ui/blob/9df07225e4a30b7979d9ffb2a8a9e071b25e4b55/plugin-sdk/index.mjs#L71) replaces backslashes in every input and uses its own absolute-path and path-style detection. Loading the SDK from that commit directly yields the following:

| cwd / input                                 | Expected native Node semantics                                | Actual result from the new mock |
| ------------------------------------------- | ------------------------------------------------------------- | ------------------------------- |
| POSIX `/work/proj` / `a\b`                  | `/work/proj/a\b`, where the backslash is a filename character | `/work/proj/a/b`                |
| Windows `C:\work\proj` / `\work\proj\a.txt` | `C:\work\proj\a.txt`                                          | HTTP 403                        |
| Windows `C:\work\proj` / `C:a.txt`          | `C:\work\proj\a.txt`                                          | `C:\work\proj\C:a.txt`          |
| Windows current process, cwd `.` / `a.txt`  | Absolute path relative to the current process directory       | HTTP 403                        |

The first two columns were compared against `path.posix.resolve` and `path.win32.resolve` respectively. The production host still uses Node path handling, so this is a newly introduced **mock contract regression**. The existing tests for root paths, UNC and `.` / `..` cannot prove full Node compatibility, and continuing to plug these rules in gradually turns into maintaining a path library.

If a cross-platform virtual filesystem is genuinely needed, give it its own explicit path syntax and let consumers opt in; do not let a test double quietly change the semantics of the production API.

## 2. #838: split the publishing boundary by runtime

### 2.1 What the current fix buys and where it stops

Removing the top-level `node:path` does fix the hard failure when the browser links the module graph. Native ESM has to resolve static dependencies first, so a caller that only uses `defineView` still cannot avoid resolving the Node dependencies in the same entry, and a browser runtime with no build step has no tree-shaking to lean on.

But rewriting the path algorithm to keep the server-side test tooling in a unified entry trades semantic cost for entry-point compatibility. `createMockHost` belongs to the test runtime by default and should not become a transitive dependency of the client SDK.

That does not mean the test harness must always run in Node. Browser component tests may need mocks, but they should use an explicit client test entry and capability set. A harness that simulates the entire server host, workspace path and binary-read semantics included, is better suited to a Node test entry.

### 2.2 Proposed publishing structure

```text
plugin-sdk/
  core/
    definitions.mjs          # Pure definitions and validation, no dependency on Node or DOM globals
    shared-types.d.ts        # Data contracts that genuinely span runtimes
  client.mjs                 # defineView / defineRenderer / onUiAction / client utilities
  client.d.mts               # Browser types, no Buffer, fs or Express
  server.mjs                 # definePlugin / server helpers
  server.d.mts               # PluginHost, routes and Node types
  testing.mjs                # createMockHost, using native node:path
  testing.d.mts
  client-utils.mjs           # Existing compatibility entry, gradually becomes an internal module or subpath forwarder
  index.mjs                  # Legacy API compatibility entry with a deadline
  index.d.mts
  package.json
  sdk-manifest.json          # Per-runtime file closure, version and content digest
```

`core` shares only what is stable and actually reused; it must not turn back into a monolith entry that aggregates every capability. `server.mjs` can stay lightweight; layering by runtime does not require every server file to pull in Node.

Packaged consumers use explicit subpaths:

```json
{
	"exports": {
		"./client": { "types": "./client.d.mts", "default": "./client.mjs" },
		"./server": { "types": "./server.d.mts", "default": "./server.mjs" },
		"./testing": { "types": "./testing.d.mts", "default": "./testing.mjs" }
	}
}
```

The `./client` here is the proposed full client entry for the new version. **Today `./client` points only at `client-utils.mjs`; do not switch the scaffold imports to it directly, or `defineView` and other existing capabilities will be missing.** Harden the exports and compatibility tests first, then change the generated template.

Conditional exports are a convenience for bundlers, but they should not carry the primary boundary. The `./sdk/index.mjs` produced by the scaffold is a relative URL, and the browser will not resolve the SDK's `package.json#exports` for it. When a relative path imports a `.mjs` file directly, the declaration file needs a matching `.d.mts`; do not rely on package-level `types` alone.

### 2.3 Targeted copying and backward compatibility

A new scaffold should generate explicit runtime entries:

```js
// client/entry.mjs
import { defineView } from "./sdk/client.mjs";

// Server entry
import { definePlugin } from "./sdk/server.mjs";

// Node tests
import { createMockHost } from "../sdk/testing.mjs";
```

Copy logic treats the publishing manifest as the single source of truth: the client gets only the runtime dependency closure of `client.mjs` plus the client declarations, while the server and dev/test directories get their own manifests. Stop representing SDK publishing as "copy two fixed files to two places".

The compatibility migration can happen in two steps:

1. Add the three entries in a minor release, keeping the old imports and the synchronous `createMockHost` signature fully intact; new templates, documentation and tests switch to the new entries immediately. The browser-reachable legacy `index.mjs` must keep its entire static dependency graph loadable in a browser and must not statically forward to the Node `testing.mjs`. The old pure implementation can therefore stay temporarily as an isolated legacy shim, marked deprecated and fixed for the known regressions.
2. In an explicit major release, remove the test exports from the legacy entry so the Node mock returns to the native path library. If role-specific `sdk/index.mjs` compatibility forwarders are generated, state the legacy API set they support; do not let the same import silently expose different full contracts on the two sides.

Deleting 50 lines of compatibility code is not worth turning a synchronous API into `async` or linking the legacy browser entry back to Node modules; that rebuilds the original failure.

The upgrader should check version and file digests per copy, write to a temporary directory first, verify, then swap. [The current logic that only checks the `dirs[0]` version](https://github.com/xing-shuyin/pi-web-ui/blob/9df07225e4a30b7979d9ffb2a8a9e071b25e4b55/bin/pi-web-ui.mjs#L3619) should be fixed first. Until the compatibility layer lands, a routine upgrade of an old plugin must still pick up the #838 fix.

### 2.4 Test the real artifact and the type boundary

The new browser-safe test has value, but its regex scan is not browser verification: it mainly checks static `node:` imports and can miss imports preceded by a statement on the same line, bare `path` / `fs` modules and runtime dependency problems; a dependency existing in the repo also does not prove the scaffold actually copied it.

Long term, keep only three checks that carry real value:

- Generate a plugin with the real CLI, start an isolated HTTP server from the generated directory, import the client entry in Chrome and perform a minimal mount; capture errors and dependency network requests. Test ports and data directories follow the repo constraints.
- Run declaration type checks against the client, server and test entries separately. The client uses DOM plus the standard ES libs with no automatic Node types; the server uses Node types; add an export-existence check so a function present in JS cannot be missing from the declarations.
- Check the publishing manifest and the client dependency closure, explicitly banning Node builtins and bare package dependencies with no resolution strategy.

The existing declarations still say `Promise<Buffer>` where the mock returns `Uint8Array`, and the client utilities carry declaration coverage debt. Settle the binary return contract as part of the entry split instead of just moving `.mjs` files.

## 3. #839: separate summary focus from extension selection

### 3.1 The settings field itself is not the sin

If the product genuinely lets users set "when auto-summarizing, keep decisions and to-dos first", persisting the extra instructions, passing them to the UI and allowing them in preset sharing are all reasonable features. Bumping the protocol from 43 to 44 per existing convention is not an architecture problem either.

The problem is that one string represents two different things at once:

- A human instruction aimed at the model, such as "keep every unfinished item";
- A control signal aimed at the program, such as "use this extension to generate the summary".

The second use makes runtime behavior depend on extension install state, the exact string value, global settings and preset import all at once. A user edit, whitespace normalization or truncation can change the selection; the same text can show up during a manual compaction; several extensions can claim conflicting conventions. When the extension is not installed or throws, the marker can still be handed to the default model as an ordinary summary instruction. It carries no meaning as a permission or identity credential.

So keep the `instructions` that carry product value and give the Provider ID and the trigger source their own fields and types. If the Provider is decided by extension-local configuration, it does not need to enter the Web protocol; if users are to pick a Provider in the UI, an explicit ID in the protocol and presets is entirely reasonable, but importing a preset must not install extensions or grant extra capabilities implicitly.

### 3.2 There are in fact several compaction sources

| Source                            | Current path                                  | reason seen by the extension | Does the #839 field reach it? |
| --------------------------------- | --------------------------------------------- | ---------------------------- | ----------------------------- |
| User manual `/compact`            | `session.compact(user instructions)`          | `manual`                     | No                            |
| AI `compact_context`              | `session.compact(tool instructions)`          | `manual`                     | No                            |
| Host idle soft cap                | `session.compact(instructions from settings)` | `manual`                     | Yes                           |
| SDK threshold check between turns | `_autoCompact("threshold", …)`                | `threshold`                  | No                            |
| SDK context overflow recovery     | `_autoCompact("overflow", …)`                 | `overflow`                   | No                            |

The host injects the soft cap into the SDK as `reserveTokens = W - C`, so "host idle soft cap" and "in-turn SDK threshold" can be triggered by the same product policy while handing the extension two different sets of information.

[The call site added in #839](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/server/agent-service.ts#L9321) covers one path and does not amount to unified automatic-compaction takeover. The existing `reason: threshold/overflow` already carries type value; the minimal root fix is to give host triggers a correct, explicit source as well and route every path through the same lifecycle.

### 3.3 Fix the public request contract first, add Providers on demand

There is no need to build a second plugin bus in the host in parallel with the Pi SDK right away. With a single summarizer extension today, filling in the SDK's request and event metadata and staying on the existing hook is enough to remove the magic-marker dependency. Upgrade to a registration mechanism once multi-provider selection, configuration and isolation have clear demand.

The following pipeline should be owned by the **Pi coding-agent SDK**:

```text
normalize the request and reserve the operation
  → prepare (pick the cut point, compute tokens, pin the history version)
  → select exactly one provider
  → generate a summary or explicitly choose the default generator
  → validate the result
  → host decoration of retained information
  → final validation and atomic commit
  → update the context projection and emit events
```

The host owns when compaction is requested, product settings, model policy, evidence retention and UI snapshots. The SDK owns the session state, history cut points, cancellation and commit it actually holds. Manual user, tool-call, idle check, in-turn threshold and overflow recovery can then all reuse one implementation.

The types below are proposals, **not an SDK API that exists today**:

```ts
type CompactionCause =
	| { kind: "manual"; initiator: "user" | "agent" | "api" }
	| { kind: "threshold"; policy: "host-soft-cap" | "sdk" }
	| { kind: "overflow" };

interface CompactionRequest {
	requestId: string;
	sessionId: string;
	cause: CompactionCause;
	willRetry: boolean;
	instructions?: string; // expresses summary content preference only
	providerId?: string; // from the effective configuration of the current session
}

type ProviderResult =
	| { decision: "summary"; summary: string; details?: JsonValue; usage?: Usage }
	| { decision: "use-default" }
	| { decision: "cancel"; message?: string };

interface CompactionProvider {
	id: string; // stable ID within the extension namespace
	label: string;
	generate(
		request: Readonly<CompactionRequest>,
		input: Readonly<PreparedCompactionInput>,
		context: CompactionProviderContext, // includes signal, constrained model calls and logging
	): Promise<ProviderResult>;
}

// Proposed Pi ExtensionAPI
pi.registerCompactionProvider(provider);

// New call overload; compact(string | undefined) keeps its original meaning
await session.compact({
	cause: { kind: "threshold", policy: "host-soft-cap" },
	instructions: policy.instructions,
	providerId: policy.providerId,
});
```

The request, Provider selection and any necessary configuration bind to a stable session identity at the start and do not read the active session across an `await`. `PreparedCompactionInput` exposes the normalized content to summarize, the prior summary and retained information; do not expose the host object that can freely mutate the SessionManager by default.

### 3.4 Contracts a Provider must settle

**Single selection.** Each request determines exactly one generating Provider first. Duplicate IDs are rejected at registration; the selection order can be explicit session configuration, host default, SDK default. When the configured Provider does not exist, return an explicit unavailable status — never treat its ID as summary text and never rely on load order. An explicit `use-default` is a deliberate hand-off.

**Errors and cancellation.** `cancel`, timeout, execution exception, missing Provider and invalid result must be distinguishable outcomes. Runtime errors should fail explicitly by default; when automatic fallback is genuinely needed, host policy names the error classes eligible for fallback and records the Provider actually used. Overflow recovery must also preserve the original `willRetry` semantics. After a cancellation, avoid a busy loop that immediately re-triggers the same compaction.

**Truncation ownership.** An ordinary Provider only produces the summary and attached information. `firstKeptEntryId`, `tokensBefore` and branch validity are computed by the SDK. The current legacy hook lets extensions return these fields; keep that as a legacy capability and validate it. Advanced retention strategies can propose a candidate policy through an explicit interface, and the SDK re-prepares and validates it. That allows dedicated memory strategies while preventing an ordinary summarizer from accidentally deciding which history to drop.

**Runtime validation.** TypeScript does not validate external `.mjs` extensions. The SDK should validate the summary type, completeness and sensible size, the JSON shape of details and the repo's 64KB boundary, usage numbers, and the relation between the cut point and the current branch. The default generator's checks for model errors and truncation should also become a uniform completeness requirement for Providers.

**Session consistency.** The operation must be reserved before the first `await`, the cancellation controller is held locally, and finally releases only its own operation; verify session/branch/history revision before commit. Recursive compaction of the same session inside a Provider must be rejected explicitly or handled through an explicit deferral mechanism. A Provider must not wait for the current compaction to finish while being the callback that blocks it from finishing.

**Capabilities and budget.** Provide a cancellation signal, constrained model calls, a timeout and an output budget; Providers that need extra tools or external data declare capabilities explicitly. The extension context can be flexible, but do not hand it the re-entrant `session.compact()` as a generation interface by default.

### 3.5 The current SDK hook is not a Provider registry

The published `@earendil-works/pi-coding-agent@1.1.0` package was inspected closely; the relevant implementation matches the local dependency. Its [`ExtensionRunner.emit`](https://unpkg.com/@earendil-works/pi-coding-agent@1.1.0/dist/core/extensions/runner.js) runs each handler in order:

- A later truthy result replaces the earlier result wholesale; even `{}` can wipe out a previous extension's summary.
- `cancel` ends dispatch early.
- A handler that throws reports an extension error and dispatch continues, potentially landing on the default summary.

That is appropriate as legacy event semantics that must be honored; it cannot support the new contract of "exactly one provider, predictable fallback on failure". A new Provider pipeline must not run the old and new summarizers together and then compare which one returned content. When a new Provider is selected, skip legacy summary generation; when none is configured, keep the legacy semantics; diagnostics should report the actual path. Observation and retention-policy hooks can run separately.

Do not conflate the two plugin systems either: `plugin-sdk`'s `PluginHost` targets Web UI plugins, while `session_before_compact` belongs to the Pi SDK extension `ExtensionAPI`. Adding a method of the same name to the former does not give the latter Provider capability. If Web plugins are ever allowed to register server-side Providers, they must join the same SDK registry through a host adapter carrying a stable session identity, with lifecycle and permissions documented.

## 4. Other architecture blind spots worth fixing at the same time

### 4.1 Evidence retention cannot merely decorate the default generator

[`installCompactionInstructions`](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/server/compaction-instructions.ts#L41) wraps the SDK's private `_runDefaultCompaction` and validates its argument count. It rewrites the default generator's instructions and appends an evidence index.

It does not rewrite the magic marker before `session_before_compact`. On the other side, once an extension returns `{ compaction }`, the SDK skips the default generator, so the evidence-index retention that depends on this wrapper is skipped as well.

If the evidence index is a pi-web-ui recovery capability, move it into the host retained-information stage after every generator and before commit; otherwise a Provider taking over the summary may incidentally take over a system invariant it should not own. The decoration stage should be idempotent and count against the final summary budget.

### 4.2 One `reserveTokens` carries two budgets

The host uses `reserveTokens = W - C` to control the trigger threshold; the SDK's default summary generation also derives the summary output cap from reserveTokens, bounded by the model's maxTokens. Lowering the input soft cap can therefore indirectly raise the summary length allowed. This is not something #839 introduced, but a new Provider should not inherit the coupling.

The public policy should express `triggerTokens`, `keepRecentTokens` and `maxSummaryTokens` separately. A Provider uses the summary budget and must not derive it from the threshold delta. Add an independent summary budget first, then replace the runtime override of `getCompactionSettings` with a public threshold policy.

### 4.3 A single synchronous commit is not a persistence transaction

The SDK's current manual compaction does not reserve a dedicated operation before the first `await abort()`, and extension results supply the cut point and token information directly. Concurrency and re-entrancy need SDK-level guarantees; a host-side streaming check before the call is not enough.

Another pre-existing boundary: SessionManager mutates in-memory entries, indexes and the leaf first and persists afterwards, so a disk write failure can leave memory, disk and the agent projection out of sync. A formal compaction commit should define rollback or recovery on persistence failure and have append return the exact entry ID. Looking up the saved entry with `find` by summary text can also hit an older summary with identical text, and a Provider is more likely to repeatedly produce fixed-format text.

Overflow recovery has one more boundary to pin down: before entering automatic compaction the SDK may already have omitted the failed assistant/tool messages through context edits. Cancelling compaction or a failing Provider therefore does not automatically mean the context is unchanged. The new contract should either state that those edits are recovery actions committed independently, or fold them into the same candidate projection and commit them on success.

Settle these with fault-injection, concurrency and cancellation tests in the SDK; there is no need to replicate a second SessionManager in pi-web-ui.

### 4.4 Hot reload needs the whole module graph versioned

[`pluginEntryUrl`](https://github.com/xing-shuyin/pi-web-ui/blob/d5ee3b203659758652d063d2070423cb4638c15a/web/src/plugin-loader.ts#L243) only rewrites `entry.mjs?e=...&r=...`. The `./sdk/index.mjs` inside the entry resolves without those parameters, so the old dependency stays in the browser module table; disabling HTTP caching cannot clear the current page's ESM module table.

In an isolated native Node ESM reproduction, loading the entry with `?e=1`, changing the dependency contents and then loading the entry with `?e=2` still read the old dependency's value `1` on both loads. This verifies the mechanism of ESM URL identity; it does not claim an end-to-end hot-upgrade test in a real browser.

Publish the whole module graph per build revision as immutable assets, for example `/plugins/<id>/client-assets/<revision>/entry.mjs`, so relative dependencies naturally inherit the revision path. The server must actually store and serve artifacts for each revision; it cannot map every revision onto the mutable current file. A smaller implementation can bundle into content-hashed assets at build time. After an upgrade, have the UI load the new revision and clean up the old instance's registrations and resources.

### 4.5 Duplicated configuration paths; type checking never proves the field arrives

The missing forward is not a field type error but a missing coverage constraint across several hand-written projections. `preset-fields` already has partial metadata; build a field registry on top of it incrementally, declared per purpose: normalize, default value, persistence, Web-writable, UI-readable, preset-shareable, each stated explicitly.

Projections can be generated and compile-time coverage checks added, but **do not automatically add every persisted field to the share or Web write allowlist**. Security allowlists must stay explicit, only driven by checkable metadata. A few contract tests running dispatch→settings→snapshot are worth more than piling on more source-string tests.

## 5. Recommended phased roadmap

| Phase                               | Deliverable                                                                                                                                                                               | Compatibility and completion criteria                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: immediate fixes                  | Complete the `set_settings` field chain; fix the confirmed mock path regressions; make the upgrader check every copy; document that only the idle path carries the new instructions today | Existing plugins keep working; message write, clear and restart recovery are all verifiable; a stale client copy can be upgraded.                                |
| B: SDK runtime boundary             | Add client/server/testing entries and separate declarations; publishing manifest; update the scaffold and examples; keep the legacy entry                                                 | The CLI-generated artifact really loads in Chrome; client types need no Node; legacy import compatibility tests pass.                                            |
| C: minimal compaction contract      | Upstream SDK provides compact requests with a source; unify every automatic path; independent summary budget; expose a host retained-information interface before commit                  | user/agent/host/SDK are distinguishable without a magic marker; manual focus instructions survive; the evidence index still survives under an extension summary. |
| D: Providers on demand              | Session-scoped registration and explicit selection; result validation; error/cancel/fallback contracts; serialization and commit consistency                                              | Duplicate IDs, missing Providers, concurrency, cancellation, re-entrancy, model truncation and persistence failure all have defined outcomes.                    |
| E: converge the compatibility layer | Migrate the legacy hook and marker configuration; remove the private method/settings wrapper; version the plugin module graph; introduce configuration metadata projections incrementally | Minimum SDK capability is declared and degradation is diagnosable; no double summarization; legacy entries and transition code removed in a major release.       |

C can ship before D independently and need not wait for the full Provider system. B and C can also proceed in parallel; they are separate SDK contracts.

During migration, do not guess whether an arbitrary `autoCompactionInstructions` value is a magic marker: preserve its original literal meaning; only old markers declared by a known extension may be migrated exactly, recorded in a config version. The transition period allows exactly one summary generation path, so the old and new mechanisms never call the model at once.

The host should detect new SDK APIs by capability and declare a minimum supported version, not rely on a wide dependency range or the argument count of a private function. Old SDKs can keep a limited, explicit legacy adaptation mode; diagnostics should show its coverage.

Drive this as five follow-up PRs of manageable size: fix message dispatch and copy upgrade first; then split runtime publishing; upstream the request source and unified lifecycle; introduce Providers and consistency guarantees as demand requires; finally remove the adaptation layer and fix module-graph versioning.

## 6. Verification and review boundaries

In an independent throwaway full snapshot of `d5ee3b2`, the following were run with the existing dependencies:

- `plugin-sdk-browser-safe.test.ts`
- `plugin-host-primitives.test.ts`
- `auto-compaction-instructions.test.ts`
- `preset-share.test.ts`

Result: **4 test files, 90 tests, all passing.** The throwaway snapshot was deleted after the run; no source in the current working tree was modified.

A separate snapshot also added and ran a behavioral reproduction test confirming that the real `handleSettingsMessage` accepts the message but does not forward the new field; the SDK from the #838 merge commit was loaded directly and the four path differences in the table were measured; a temporary file was used to measure the ESM entry epoch failing to refresh dependencies.

The relevant source of the pinned SDK `1.1.0` package was verified to match the local dependency. Full-repo tests, real-browser scaffold loading and production compaction end-to-end tests were not run; a green existing unit test suite was not used as a substitute for them, and no proposed new API was treated as existing behavior.

This review adds only this document. Every architecture proposal is a recommendation; no business implementation was changed, no SDK was published and no running configuration was adjusted.
