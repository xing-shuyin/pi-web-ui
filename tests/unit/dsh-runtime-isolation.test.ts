import { mkdtempSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DshClientSession } from "../../server/dsh/dsh-agent-service.js";
import { DshRuntime } from "../../server/dsh/dsh-client.js";
import { SandboxManager } from "../../server/sandbox-service.js";
import { diffStreamingCues } from "../../web/src/streaming-cues.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

type FakeRuntime = ReturnType<typeof makeFakeRuntime>["runtime"];
type RuntimeEntry = {
	key: string;
	runtime: FakeRuntime;
	cwd: string;
	provider: string;
	modelProvider: string;
	model: string;
	generation: number;
	conversationIds: Set<string>;
	bridgeCancellation: AbortController;
	restartCount: number;
	restartWindowStart: number;
	stopping: boolean;
};

function makeFakeRuntime(cwd: string, model: string, modelProvider: string) {
	const prompts: Array<ReturnType<typeof deferred<string>>> = [];
	const runtime = {
		cwd,
		model,
		modelProvider,
		alive: true,
		start: vi.fn(async () => {
			runtime.alive = true;
		}),
		restart: vi.fn(async () => {
			runtime.alive = true;
		}),
		close: vi.fn(async () => {
			runtime.alive = false;
		}),
		kill: vi.fn(async () => {
			runtime.alive = false;
		}),
		prompt: vi.fn(() => {
			const pending = deferred<string>();
			prompts.push(pending);
			return pending.promise;
		}),
		cancelSession: vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true })),
		releaseSession: vi.fn(async (_sessionId?: string): Promise<{ ok: boolean; reason?: string }> => ({ ok: true })),
		assignPreset: vi.fn(async () => ({ ok: true })),
		getWorkingDirectory: vi.fn(async () => cwd),
		setWorkingDirectory: vi.fn(async (_sessionId: string, path: string) => path),
		getPermission: vi.fn(async () => ({ currentValue: "workspace-write-never", options: [] })),
		setPermission: vi.fn(async () => ({ ok: true, currentValue: "workspace-write-never" })),
		answerQuestion: vi.fn(async () => ({ ok: true })),
		toolsCallResult: vi.fn(async () => ({ ok: true })),
		attachmentRead: vi.fn(async () => ({ mediaType: "image/png", data: "" })),
		attachmentSave: vi.fn(async () => ({ path: "saved" })),
		listSkills: vi.fn(async () => ({ skills: [] })),
		listPresets: vi.fn(async () => ({ presets: [], unavailable: true })),
		getStderrTail: vi.fn(() => ""),
		onStarted: null as null | (() => void),
		onExit: null as null | ((code: number | null, signal: string | null, intentional: boolean) => void),
		prompts,
	};
	return { runtime, prompts };
}

describe("DSH runtime isolation", () => {
	let dir: string;
	let sessions: any[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dsh-runtime-isolation-"));
		sessions = [];
	});

	afterEach(async () => {
		for (const session of sessions) await session.dispose();
		await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	function addEntry(session: any, cwd: string, model = "deepseek-v4-flash", modelProvider = "deepseek") {
		const key = session.runtimeKeyFor(cwd, modelProvider, model);
		const existing = session.runtimeEntries.get(key) as RuntimeEntry | undefined;
		if (existing) return { entry: existing, prompts: existing.runtime.prompts };
		const { runtime, prompts } = makeFakeRuntime(cwd, model, modelProvider);
		const entry: RuntimeEntry = {
			key,
			runtime,
			cwd,
			provider: "deepseek-official",
			modelProvider,
			model,
			generation: 0,
			conversationIds: new Set(),
			bridgeCancellation: new AbortController(),
			restartCount: 0,
			restartWindowStart: 0,
			stopping: false,
		};
		session.runtimeEntries.set(key, entry);
		return { entry, prompts };
	}

	function makeSession(cwd: string) {
		const projectModels = new Map<string, string>();
		const session: any = Object.assign(Object.create(DshClientSession.prototype), {
			clientId: "dsh-isolation-test",
			cwd,
			model: "deepseek-v4-flash",
			modelProvider: "deepseek",
			modelDisplayName: "DeepSeek V4 Flash",
			modelVision: false,
			dynamicModels: new Set<string>(),
			customModelsMap: new Map(),
			convs: new Map(),
			activeId: "",
			runtimeEntries: new Map<string, RuntimeEntry>(),
			fallbackRuntimeEntry: null,
			pendingQuestion: null,
			pendingQuestionEntry: null,
			pendingQuestionQueue: [],
			pendingPageCalls: new Map(),
			conversationBridgeCancellations: new Map<string, AbortController>(),
			workspaceGeneration: 0,
			switchingWorkspace: false,
			disposed: false,
			snapshotTimer: null,
			sessionsTimer: null,
			reclaimTimer: null,
			retentionTimer: null,
			retentionOnce: null,
			sessionRoot: join(dir, "sessions"),
			dataDir: dir,
			agentDir: join(dir, "agent"),
			sandboxes: new SandboxManager(join(dir, "sandboxes")),
			settings: {
				defaultPermissionPreset: "workspace-write-never",
				disabledSkills: [],
				openRecentSessionOnProjectSwitch: false,
				questionnaireEnabled: true,
				retainFinishedConversations: true,
			},
			skillsCache: [],
			agentPresets: [],
			agentPresetsAvailable: false,
			agentPresetDefault: "standard",
			permissionOptions: [],
			goalPrefs: { reviewModel: null, maxRounds: 2, locked: false },
			stateStore: {
				get: () => ({ locale: "zh" }),
				getProjectModel: (_clientId: string, project: string) => projectModels.get(project),
				getDefaultModel: () => undefined,
				saveProjectModel: (_clientId: string, project: string, model: string) => projectModels.set(project, model),
				getWorkspaceRoots: () => [],
				remember: vi.fn(),
				isSessionPinned: () => false,
			},
			userTerminals: { killAll: vi.fn() },
			bg: { stop: vi.fn() },
			modelAdmin: { dispose: vi.fn() },
			emit: vi.fn(),
			emitConversations: vi.fn(),
			emitGoalStatus: vi.fn(),
			flushSnapshot: vi.fn(),
			scheduleSessionsRefresh: vi.fn(),
			getLang: () => "zh",
			resolvePreset: (preset?: string) => preset ?? "standard",
			pushSessions: vi.fn(async () => {}),
			pushProjects: vi.fn(async () => {}),
			pushSessionsForCwd: vi.fn(async () => {}),
			pushTerminals: vi.fn(),
			pushSettings: vi.fn(),
			pushAgentPresets: vi.fn(),
			pushPermission: vi.fn(),
			listFiles: vi.fn(async () => {}),
			refreshActivePermission: vi.fn(async () => {}),
		});
		session.makeRuntime = (targetCwd: string, model: string, modelProvider: string) =>
			addEntry(session, targetCwd, model, modelProvider).entry;
		sessions.push(session);
		return session;
	}

	function addConversation(session: any, cwd: string, sessionId: string, entry: RuntimeEntry) {
		const conv = session.addConversation(sessionId, cwd, false, "standard");
		conv.model = entry.model;
		conv.modelProvider = entry.modelProvider;
		session.bindConversationRuntime(conv, entry);
		conv.listed = true;
		return conv;
	}

	it("uses DSH's per-session working-directory RPC", async () => {
		const runtime: any = Object.assign(Object.create(DshRuntime.prototype), {
			start: vi.fn(async () => {}),
			_request: vi.fn(async () => ({ cwd: "/workspace/project-b" })),
		});
		await expect(runtime.setWorkingDirectory("session-b", "/workspace/project-b")).resolves.toBe(
			"/workspace/project-b",
		);
		expect(runtime._request).toHaveBeenCalledWith("session/working-directory/set", {
			sessionId: "session-b",
			path: "/workspace/project-b",
		});
	});

	it("uses the wrapper's per-session cancel RPC", async () => {
		const runtime: any = Object.assign(Object.create(DshRuntime.prototype), {
			start: vi.fn(async () => {}),
			_request: vi.fn(async () => ({ ok: true })),
		});
		await expect(runtime.cancelSession("session-a")).resolves.toEqual({ ok: true });
		expect(runtime._request).toHaveBeenCalledWith("session/cancel", { sessionId: "session-a", keepInbox: true });
	});

	it("shares one model runtime across projects while keeping each session workspace and prompt alive", async () => {
		const projectA = join(dir, "project-a");
		const projectB = join(dir, "project-b");
		mkdirSync(projectA);
		mkdirSync(projectB);
		const session = makeSession(projectA);
		const first = addEntry(session, projectA);
		session.runtime = first.entry.runtime;
		const convA = addConversation(session, projectA, "session-a", first.entry);
		session.activateConversation(convA);
		convA.isStreaming = true;
		const promptA = session.promptConv(convA, "project A task");
		await vi.waitFor(() => expect(first.entry.runtime.prompt).toHaveBeenCalledOnce());
		expect(first.entry.runtime.setWorkingDirectory).toHaveBeenCalledWith(convA.sessionId, projectA);

		await session.setCwd(projectB);
		const convB = session.conv;
		expect(convB.cwd).toBe(projectB);
		expect(first.entry.runtime.restart).not.toHaveBeenCalled();
		expect(first.entry.runtime.close).not.toHaveBeenCalled();
		expect(convA.isStreaming).toBe(true);
		expect(session.activeConversations()).toBe(1);

		convB.isStreaming = true;
		const secondEntry = session.runtimeForConversation(convB);
		expect(secondEntry).toBe(first.entry);
		expect(secondEntry.runtime.setWorkingDirectory).toHaveBeenCalledWith(convB.sessionId, projectB);
		const promptB = session.promptConv(convB, "project B task");
		await vi.waitFor(() => expect(secondEntry.runtime.prompt).toHaveBeenCalledTimes(2));
		secondEntry.runtime.prompts[1]!.resolve("b-done");
		await promptB;
		expect(convA.isStreaming).toBe(true);
		expect(first.entry.runtime.restart).not.toHaveBeenCalled();

		await session.setCwd(projectA);
		expect(session.conv.id).toBe(convA.id);
		expect([...session.convs.values()].filter((conv: any) => conv.sessionId === convA.sessionId)).toHaveLength(1);
		await session.setCwd(projectB);
		expect(session.conv.id).toBe(convB.id);

		first.prompts[0]!.resolve("a-done");
		await promptA;
	});

	it("moves only the idle active conversation to a new model runtime", async () => {
		const session = makeSession(dir);
		const first = addEntry(session, dir);
		session.runtime = first.entry.runtime;
		const background = addConversation(session, dir, "background", first.entry);
		background.isStreaming = true;
		const active = addConversation(session, dir, "active", first.entry);
		session.activateConversation(active);
		expect(session.runtimeForConversation(active)).toBe(first.entry);

		await session.setModel("deepseek-v4-pro");
		const activeEntry = session.runtimeForConversation(active);
		expect(activeEntry).not.toBe(first.entry);
		expect(activeEntry.runtime.model).toBe("deepseek-v4-pro");
		expect(session.runtimeForConversation(background)).toBe(first.entry);
		expect(background.isStreaming).toBe(true);
		expect(first.entry.runtime.restart).not.toHaveBeenCalled();

		active.isStreaming = true;
		await session.setModel("deepseek-v4-flash-vision-exp");
		expect(session.runtimeForConversation(active)).toBe(activeEntry);
		expect(activeEntry.runtime.restart).not.toHaveBeenCalled();
	});

	it("rolls back the conversation and releases the new runtime when model startup fails", async () => {
		const session = makeSession(dir);
		const first = addEntry(session, dir);
		session.runtime = first.entry.runtime;
		const active = addConversation(session, dir, "active", first.entry);
		session.activateConversation(active);
		let created!: RuntimeEntry;
		session.makeRuntime = (cwd: string, model: string, modelProvider: string) => {
			created = addEntry(session, cwd, model, modelProvider).entry;
			return created;
		};
		session.startWithRetry = vi.fn(async (entry: RuntimeEntry) => {
			if (entry === created) throw new Error("start failed");
			await entry.runtime.start();
		});

		await session.setModel("deepseek-v4-pro");
		expect(session.runtimeForConversation(active)).toBe(first.entry);
		expect(active.model).toBe("deepseek-v4-flash");
		expect(session.model).toBe("deepseek-v4-flash");
		expect(created.runtime.close).toHaveBeenCalledOnce();
		expect(first.entry.runtime.restart).not.toHaveBeenCalled();
	});

	it("does not move the active runtime pointer when an async model switch fails after navigation", async () => {
		const projectA = join(dir, "project-a");
		const projectB = join(dir, "project-b");
		mkdirSync(projectA);
		mkdirSync(projectB);
		const session = makeSession(projectA);
		const first = addEntry(session, projectA);
		const second = addEntry(session, projectB, "deepseek-v4-pro");
		session.runtime = first.entry.runtime;
		const convA = addConversation(session, projectA, "a", first.entry);
		const convB = addConversation(session, projectB, "b", second.entry);
		session.activateConversation(convA);
		const starting = deferred<void>();
		let created!: RuntimeEntry;
		session.makeRuntime = (cwd: string, model: string, modelProvider: string) => {
			created = addEntry(session, cwd, model, modelProvider).entry;
			return created;
		};
		session.startWithRetry = vi.fn(async (entry: RuntimeEntry) => {
			if (entry === created) await starting.promise;
			else await entry.runtime.start();
		});

		const switching = session.setModel("deepseek-v4-flash-vision-exp");
		await vi.waitFor(() => expect(created).toBeDefined());
		session.activateConversation(convB);
		starting.reject(new Error("start failed"));
		await switching;
		expect(session.conv.id).toBe(convB.id);
		expect(session.runtime).toBe(second.entry.runtime);
		expect(session.runtimeForConversation(convA)).toBe(first.entry);
	});

	it("abortForPlugins cancels the target session, not the active session", async () => {
		const projectA = join(dir, "project-a");
		const projectB = join(dir, "project-b");
		mkdirSync(projectA);
		mkdirSync(projectB);
		const session = makeSession(projectA);
		const first = addEntry(session, projectA);
		const second = addEntry(session, projectB, "deepseek-v4-pro");
		session.runtime = second.entry.runtime;
		const target = addConversation(session, projectA, "target", first.entry);
		const active = addConversation(session, projectB, "active", second.entry);
		target.isStreaming = true;
		active.isStreaming = true;
		first.entry.runtime.cancelSession.mockImplementation(async () => {
			target.isStreaming = false;
			return { ok: true };
		});
		session.activateConversation(active);

		await session.abortForPlugins(target.id);
		expect(first.entry.runtime.cancelSession).toHaveBeenCalledWith(target.sessionId, true);
		expect(first.entry.runtime.restart).not.toHaveBeenCalled();
		expect(second.entry.runtime.cancelSession).not.toHaveBeenCalled();
		expect(target.isStreaming).toBe(false);
		expect(target.terminal).toBe("canceled");
		expect(active.isStreaming).toBe(true);
	});

	it("cancels only the target session in a shared model runtime and keeps its inbox", async () => {
		const projectA = join(dir, "project-a");
		const projectB = join(dir, "project-b");
		mkdirSync(projectA);
		mkdirSync(projectB);
		const session = makeSession(projectA);
		const shared = addEntry(session, projectA);
		session.runtime = shared.entry.runtime;
		const convA = addConversation(session, projectA, "a", shared.entry);
		const convB = addConversation(session, projectB, "b", shared.entry);
		convA.isStreaming = true;
		convB.isStreaming = true;
		convA.queue.followUp.push("queued follow-up");
		shared.entry.runtime.cancelSession.mockImplementation(async () => {
			convA.isStreaming = false;
			return { ok: true };
		});
		session.activateConversation(convB);

		await session.abortForPlugins(convA.id);
		expect(shared.entry.runtime.cancelSession).toHaveBeenCalledWith(convA.sessionId, true);
		expect(shared.entry.runtime.restart).not.toHaveBeenCalled();
		expect(convA.isStreaming).toBe(false);
		expect(convB.isStreaming).toBe(true);
		expect(convA.terminal).toBe("canceled");
		expect(convA.queue.followUp).toEqual(["queued follow-up"]);
	});

	it("does not mark a session stopped when its queued inbox immediately starts another turn", async () => {
		const session = makeSession(dir);
		const first = addEntry(session, dir);
		session.runtime = first.entry.runtime;
		const conv = addConversation(session, dir, "queued", first.entry);
		conv.isStreaming = true;
		conv.queue.followUp.push("next turn");
		first.entry.runtime.cancelSession.mockImplementation(async () => {
			conv.terminal = undefined;
			conv.isStreaming = true;
			return { ok: true };
		});

		await session.abort(conv.id);
		expect(conv.isStreaming).toBe(true);
		expect(conv.terminal).toBeUndefined();
		expect(conv.queue.followUp).toEqual(["next turn"]);
		expect(first.entry.runtime.restart).not.toHaveBeenCalled();
	});

	it("keeps the session running when the cancel RPC fails", async () => {
		const session = makeSession(dir);
		const first = addEntry(session, dir);
		session.runtime = first.entry.runtime;
		const conv = addConversation(session, dir, "cancel-failed", first.entry);
		conv.isStreaming = true;
		first.entry.runtime.cancelSession.mockResolvedValue({ ok: false, reason: "unknown_session" });

		await session.abort(conv.id);
		expect(conv.isStreaming).toBe(true);
		expect(conv.terminal).toBeUndefined();
		expect(first.entry.runtime.restart).not.toHaveBeenCalled();
	});

	it("serializes simultaneous questions and routes each answer to its source runtime", async () => {
		const projectA = join(dir, "project-a");
		const projectB = join(dir, "project-b");
		mkdirSync(projectA);
		mkdirSync(projectB);
		const session = makeSession(projectA);
		const first = addEntry(session, projectA);
		const second = addEntry(session, projectB, "deepseek-v4-pro");
		const convA = addConversation(session, projectA, "a", first.entry);
		const convB = addConversation(session, projectB, "b", second.entry);

		session.enqueuePendingQuestion(first.entry, { id: "q-a", questions: [], conversationId: convA.id });
		session.enqueuePendingQuestion(second.entry, { id: "q-b", questions: [], conversationId: convB.id });
		expect(session.pendingQuestion?.id).toBe("q-a");
		expect(session.pendingQuestionQueue).toHaveLength(1);

		await session.answerQuestion("q-a", [], true);
		expect(first.entry.runtime.answerQuestion).toHaveBeenCalledWith("q-a", [], true);
		expect(session.pendingQuestion?.id).toBe("q-b");
		expect(second.entry.runtime.answerQuestion).not.toHaveBeenCalled();

		await session.answerQuestion("q-b", [], true);
		expect(second.entry.runtime.answerQuestion).toHaveBeenCalledWith("q-b", [], true);
		expect(session.pendingQuestion).toBeNull();
	});

	it("keeps an ordinary model error terminal instead of projecting a successful completion", () => {
		const session = makeSession(dir);
		const first = addEntry(session, dir);
		session.runtime = first.entry.runtime;
		const conv = addConversation(session, dir, "failed-turn", first.entry);
		session.activateConversation(conv);
		conv.isStreaming = true;
		session.handleSessionEvent(
			{
				sessionId: conv.sessionId,
				event: {
					type: "turn/end",
					seq: 1,
					time: Date.now(),
					data: { reason: { kind: "error", error: { message: "provider failed" } } },
				},
			},
			first.entry,
		);
		session.handleSessionStatus({ sessionId: conv.sessionId, status: "idle" }, first.entry);
		expect(conv.terminal).toBe("error");
		expect(conv.terminalError).toBe("provider failed");
		expect(
			diffStreamingCues(new Map([[conv.id, true]]), conv.id, false, [
				{ id: conv.id, isStreaming: false, error: conv.terminalError },
			]).finishedConvs,
		).toEqual([]);
	});

	it("runtime failure settles only its own bucket and does not emit a completion cue", async () => {
		const projectA = join(dir, "project-a");
		const projectB = join(dir, "project-b");
		mkdirSync(projectA);
		mkdirSync(projectB);
		const session = makeSession(projectA);
		const first = addEntry(session, projectA);
		const second = addEntry(session, projectB, "deepseek-v4-pro");
		session.runtime = second.entry.runtime;
		const failed = addConversation(session, projectA, "failed", first.entry);
		const active = addConversation(session, projectB, "active", second.entry);
		failed.isStreaming = true;
		active.isStreaming = true;
		session.activateConversation(active);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		session.handleRuntimeExit(first.entry, 1, null);
		expect(failed.isStreaming).toBe(false);
		expect(failed.terminal).toBe("error");
		expect(active.isStreaming).toBe(true);
		expect(first.entry.runtime.start).toHaveBeenCalled();
		expect(second.entry.runtime.start).not.toHaveBeenCalled();
		const cues = diffStreamingCues(
			new Map([
				[failed.id, true],
				[active.id, true],
			]),
			active.id,
			true,
			[
				{ id: failed.id, isStreaming: false, error: failed.terminalError },
				{ id: active.id, isStreaming: true },
			],
		);
		expect(cues.finishedConvs).toEqual([]);
		consoleError.mockRestore();
	});

	it("dispose closes every runtime exactly once", async () => {
		const projectA = join(dir, "project-a");
		const projectB = join(dir, "project-b");
		mkdirSync(projectA);
		mkdirSync(projectB);
		const session = makeSession(projectA);
		const first = addEntry(session, projectA);
		const second = addEntry(session, projectB, "deepseek-v4-pro");
		session.runtime = second.entry.runtime;
		addConversation(session, projectA, "a", first.entry);
		addConversation(session, projectB, "b", second.entry);

		await session.dispose();
		expect(first.entry.runtime.close).toHaveBeenCalledOnce();
		expect(second.entry.runtime.close).toHaveBeenCalledOnce();
	});

	it("newChat activates and flushes snapshot without waiting for setWorkingDirectory", async () => {
		const projectA = join(dir, "project-a");
		mkdirSync(projectA);
		const session = makeSession(projectA);
		const { entry } = addEntry(session, projectA);
		session.runtime = entry.runtime;
		const existing = addConversation(session, projectA, "existing", entry);
		existing.messages.push({ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
		session.activateConversation(existing);

		const pendingCwd = deferred<string>();
		entry.runtime.setWorkingDirectory.mockImplementation(() => pendingCwd.promise);
		const flushSpy = vi.spyOn(session, "flushSnapshot");
		let readyId: string | undefined;
		const ok = await session.newChat(undefined, undefined, (id: string) => {
			readyId = id;
		});

		expect(ok).toBe(true);
		expect(readyId).toBeTruthy();
		expect(readyId).not.toBe(existing.id);
		expect(session.activeId).toBe(readyId);
		expect(flushSpy).toHaveBeenCalled();

		pendingCwd.resolve(projectA);
		await Promise.resolve();
	});

	it("releases the previous runtime session handle before binding the new model runtime", async () => {
		const projectA = join(dir, "project-a");
		mkdirSync(projectA);
		const session = makeSession(projectA);
		const { entry: prevEntry } = addEntry(session, projectA, "deepseek-v4-flash");
		session.runtime = prevEntry.runtime;
		const conv = addConversation(session, projectA, "conv-1", prevEntry);
		session.activateConversation(conv);

		const events: string[] = [];
		prevEntry.runtime.releaseSession.mockImplementation(async (sid?: string) => {
			events.push(`release:${sid}`);
			return { ok: true };
		});
		const nextEntry = addEntry(session, projectA, "deepseek-v4-pro").entry;
		nextEntry.runtime.setWorkingDirectory.mockImplementation(async (sid: string, path: string) => {
			events.push(`setCwd:${sid}`);
			return path;
		});

		await session.setModel("deepseek/deepseek-v4-pro");
		expect(events).toEqual([`release:${conv.sessionId}`, `setCwd:${conv.sessionId}`]);
	});

	it("prompt still sends when startWithRetry increments entry.generation", async () => {
		const projectA = join(dir, "project-a");
		mkdirSync(projectA);
		const session = makeSession(projectA);
		const { entry } = addEntry(session, projectA);
		session.runtime = entry.runtime;
		const conv = addConversation(session, projectA, "conv-1", entry);
		session.activateConversation(conv);

		entry.runtime.start.mockImplementationOnce(async () => {
			entry.runtime.alive = true;
			entry.generation += 1;
		});
		entry.runtime.prompt.mockResolvedValueOnce("msg-1");

		await session.promptConv(conv, "hello");
		expect(entry.runtime.prompt).toHaveBeenCalledTimes(1);
	});
});
