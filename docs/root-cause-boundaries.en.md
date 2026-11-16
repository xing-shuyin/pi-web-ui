**English** · [简体中文](./root-cause-boundaries.md) · [繁體中文](./root-cause-boundaries.zh-TW.md)

# Root-cause remediation: operation identity and commit boundaries

This file records behavior constraints that must hold across modules. For the concrete review evidence see `audits/root-cause-review-2026-10-29.md`.

## Worktree cleanup

A failed worktree status read is unknown state and cannot authorize deletion. When `getUncommittedCount()` fails it returns a conservative dirty state plus the error; non-forced deletion and subagent terminal cleanup require the query to succeed explicitly.

Subagent terminal cleanup removes the worktree automatically only when status succeeds and is clean and HEAD equals the baseCommit captured at creation. HEAD is re-checked inside the repository operation lock, then the non-forced Git delete runs; when Git refuses because of concurrent modification, the worktree is kept and the error reported. Branch deletion uses the conditional `update-ref -d <ref> <baseCommit>`, so cleanup cannot delete a branch that was advanced concurrently.

Regression: `tests/unit/root-cause-worktree.test.ts` corrupts the index to simulate a status failure while HEAD stays readable, verifying that unknown state deletes neither uncommitted files nor branches; the existing `subagent-worktree.test.ts` covers the normal cleanup and retention paths.

## Scheduling, persistence, and canvas

Plugin cron's sharded timer keeps the same `dueAt` and computes the next one only after that moment has expired and executed. Ordinary plugin settings and the encrypted `setting:` secret live together in the **state directory** `<dataDir>/plugin-data/<id>/storage.json` (the code directory `plugins/<id>/` is a pure cache that can be re-materialized) and commit in a single atomic replace; the internal `__settingsSecrets` is a reserved key that the plugin storage API can neither read nor modify, and the old `secrets.bin` remains a compatibility read source for unmigrated entries. A failed save neither notifies the settings callback nor returns success.

MCP rename-in-place commits atomically in one step; cross-scope migration first writes a recovery log, commits the target, then cleans up the source. A failed migration keeps at least one record, and repeating the same save request can recover; a target conflict or changed contents on either side refuses recovery. Atomic writes reuse `atomic-file.ts`, new MCP files default to `0600`, and refresh staging files are supported; this is not a power-loss durability promise.

Canvas WS and tool deletion both go through the orchestrator: first invalidate the graph lifecycle generation and cancel execution, then delete files. Asynchronous completion and downstream dispatch validate the graph, node generation, and execution object identity; run-state saves update only existing projects. Repeated starts must not replace a graph object that is already running.

## Sessions, goals, and multiple engines

Goal settings capture the operation generation at the entry point, wait for the old executor to clean up, then re-validate the original generation and object identity; clearing, replacing, and closing all invalidate a waiting old setting. Wizard submit returns an explicit token: commit the plan first, then use that token to preempt and start.

Subagent creation must span the parent tool's cancellation and a stable parent run identity, and re-check before the candidate runtime commits; interrupt/reset in the same session share the in-flight operation, and the commit binds to the original runtime. Approval cancellation uses a stable request object; display ID and holder migration do not change the one-shot settlement identity.

A Universal turn captures the session object and cwd and saves against that ownership when it finishes; falling back to active when the old session cannot be found is forbidden; a workspace switch first cancels the old turn and blocks new turns from entering during the switch. A DSH restart must pass the target cwd explicitly, and a failed start must not publish a new workspace.

Claude and Durable history directories are isolated per engine, and the recorded engine is validated. Legacy transcripts without an engine identifier import display messages only, clear the underlying `driverSessionId`, and keep the original record; a migration marker prevents re-import after the user deletes them.

## HTTP transport

`net-guard.ts`'s production requests use a dedicated undici dispatcher that constrains the connection to the validated IP while preserving the original domain Host, TLS servername, and certificate validation. Every redirect is re-validated and the address pinned, and the previous hop's body is cancelled; cross-origin hops strip credentials. The deadline covers DNS, connection, redirects, and body consumption. Preset fetching and marketplace requests reuse this path, and replacing the global fetch cannot bypass validation.

## Shared constraints

- Async work captures the stable run object and ownership at the entry point; after resuming across an await it must not read the current active/cwd as an ownership fallback for the old task.
- A generation belongs to the operation that started it; recovery must not re-read the latest generation to let an old operation keep committing. Only operations that are still valid may publish state, write run state, or dispatch follow-up tasks.
- Cancel, close, and delete must revoke execution eligibility; deleting a file on disk or hiding UI does not terminate a background lifecycle.
- Persistent side effects happen only after full validation; run state and a success acknowledgement are published only after the persistent commit succeeds. Corrupt, unreadable, and nonexistent are distinct outcomes.
- Storage identity includes the necessary project and engine dimensions; underlying session IDs from different engines cannot restore one another.
- A timer keeps this occurrence's dueAt; sharded waiting does not change this execution's identity; the next occurrence is computed only after execution.
- Network pre-checks must constrain the address the actual connection uses; a standalone DNS pre-check is not DNS rebinding protection.

Implementation and tests should verify failure, cancellation, and interleaved execution against these boundaries, rather than adding duplicate guards on the happy path only.
