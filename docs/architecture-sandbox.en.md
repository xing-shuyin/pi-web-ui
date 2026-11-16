**English** · [简体中文](./architecture-sandbox.md) · [繁體中文](./architecture-sandbox.zh-TW.md)

# Sandbox workspace

A sandbox is a server-managed copy of a project. File tools can only reach managed directories; without an OS-level isolation backend, side effects must not be executed through the host shell, interpreters, arbitrary code or unknown tools. The sandbox must not be advertised as a container that allows arbitrary program execution. Every execution engine must have equivalent refusal capability before execution, and an engine that lacks it refuses to start a task in the sandbox.

## Identity and admission

Sandbox identity is bound to the execution session and inherited by subagents. Switching cwd, spawning an executor and resuming a session cannot lift the boundary; a sandboxed parent executor must not break out by spawning against an external cwd or worktree. Execution is refused when the registry record is invalid, the managed directory identity is unknown, or a lifecycle operation is in progress; it must never degrade into a plain workspace.

File-path checks cover both lexical and real paths and reject symlinks, junctions, hard links and special files. Host tools are allowed by explicit capability, and unknown capabilities are denied by default; promising arbitrary-code isolation by extending shell regexes is not acceptable. Plugins, MCP, interpreters, terminal input and tool-orchestration entry points are part of the execution boundary too. SDK search tools may inherit host command configuration, so `grep/find` are likewise refused until a dedicated safe implementation exists.

The sandbox runtime loads no disk extensions, SDK built-in extensions, plugins or MCP tools; before final SDK execution the check also verifies the original references of the tool definition and execute, so a same-name replacement cannot gain trust. The current final tool allowlist also does not let a model inside the sandbox dispatch subagents; the host subagent entry still verifies parent identity and cwd so no other path bypasses it. The in-sandbox management tool may only list its own metadata and convert itself to permanent retention; import, source-project diff, export, reset, write-back and destroy are initiated by the control plane outside the sandbox. Preview and management performed by the user in the UI are not limited by this model tool.

## Baseline and write-back

Import saves an independent baseline. A diff means the sandbox's modifications relative to that baseline; write-back compares baseline, current source project and current sandbox three ways, committing only sandbox changes and keeping files and modifications the source project produced on its own. When both sides modified the same target it refuses and reports the conflict.

Write-back is bound to a preview version: if any participating content changes after the user previewed, a new preview is required. Execution re-validates the real target path and refuses to write along a target symlink, junction or other unsafe target. Writes are staged first on the same filesystem as the source project with a restore mapping kept; before rolling back a failure it verifies the target still holds this write's content, and a concurrent source-side modification preserves the current content and a backup and reports the restore path. Directory deletion runs in reverse depth order, and a failure must not return success. A sandbox without a trusted baseline can be viewed and exported, but direct write-back is refused.

## Lifecycle and persistence

Sessions within the same data-dir share the repository, and registry changes commit serially and persist atomically. A persistence failure must be reported to the caller and must not publish a successful runtime state first.

Reset, write-back and destroy first freeze new execution, coordinate every runtime, subagent and related terminal holding that sandbox, and wait for in-flight operations to exit before touching files. A failure leaves a recognizable and protected state for retry. Sandbox identity must not be revoked before destroy completes; the stop scope is determined per sandbox and does not affect other projects or the user's terminals.

Reset prepares a complete new copy before committing, avoiding a mix of old and new files from deleting while copying. Destroy first renames the content to a recoverable staging location and then commits the registry deletion; a failed commit restores the directory, and a failed cleanup reports the restore path. A file lock or cleanup failure must not be reported as success after a mere warning. Copying verifies per file that content and permissions match the source snapshot, and scanning is capped at 15,000 entries, 64 MB per file and 512 MB of cumulative file bytes to avoid unbounded use.

## Verification focus

Regression must cover: independent additions and modifications on the source side, conflicts from both sides, deletions and type changes, stale previews, target symlinks/junctions, concurrent creation, persistence failures, invalid registry identity, reset and destroy while running, parent-child permission inheritance, terminal and unknown-tool bypasses, and engines without isolation support refusing to start.

The core implementation lives in `server/sandbox-service.ts`, `server/sandbox-tool.ts` and each engine's session entry. The protocol lives in `server/protocol.ts`, and the frontend entry is `web/src/components/SandboxModal.tsx`.
