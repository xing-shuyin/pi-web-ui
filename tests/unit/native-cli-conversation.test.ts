import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, createAgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { spawn } from "node-pty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { normalizePathKey } from "../../server/client-state.js";
import { handleSessionLifecycleMessage, handleTerminalMessage } from "../../server/dispatch-domain-handlers.js";
import { persistNativeCliConfig, readNativeCliConfig } from "../../server/native-cli.js";
import type { NativeCliConfig } from "../../server/protocol.js";
import { fakeClientSession } from "../helpers/fake-session.js";
import * as remoteCli from "../../server/remote-native-cli.js";
import {
	getGlobalRemoteSshService,
	resolveWorkspaceSessionDir,
	setGlobalRemoteSshService,
} from "../../server/remote-ssh-service.js";
import { prepareNativeCliSessionLaunch } from "../../server/native-cli-session.js";
import * as persistence from "../../server/remote-cli-persistence.js";
import { readNativeCliBinding } from "../../server/native-cli-state.js";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("../../server/native-cli-session.js", () => ({ prepareNativeCliSessionLaunch: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	createAgentSessionRuntime: vi.fn(),
}));

const config: NativeCliConfig = { preset: "custom", executable: process.execPath, args: ["--version"] };
let root: string;
let project: string;
let clients: any[];
let ptys: any[];
let runtimes: any[];
let preparations: any[];
let previousService: ReturnType<typeof getGlobalRemoteSshService>;
const createSession = SessionManager.create.bind(SessionManager);

function runtimeFor(manager: SessionManager, cwd: string): any {
	const runtime = {
		cwd,
		dispose: vi.fn(async () => {}),
		session: {
			sessionManager: manager,
			get sessionId() {
				return manager.getSessionId();
			},
			get sessionFile() {
				return manager.getSessionFile();
			},
			agent: { state: { messages: [], tools: [], thinkingLevel: "off" } },
			isStreaming: false,
			bindExtensions: vi.fn(async () => {}),
			subscribe: vi.fn(() => vi.fn()),
			getSessionStats: () => ({ totalMessages: 0 }),
			getAvailableThinkingLevels: () => ["off"],
			prompt: vi.fn(),
		},
	};
	runtimes.push(runtime);
	return runtime;
}

function client(overrides: Record<string, unknown> = {}): any {
	const cs = fakeClientSession({
		cwd: project,
		files: { unwatchGit: vi.fn() },
		agentDir: join(root, "agent"),
		activeId: "normal",
		disposed: false,
		clientId: "cli-conversation-test",
		settingsSvc: { current: {} },
		quiesceBlocked: () => false,
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
		scheduleSnapshot: vi.fn(),
		makeRuntimeFactory: vi.fn(() => ({})),
		makeGoalStatus: () => ({}),
		restorePlan: vi.fn(),
		planManager: { getPlan: () => undefined, unbindConversation: vi.fn() },
		markerSvc: { getActionSuggestions: () => null, clearConversation: vi.fn() },
		applySessionOverrides: vi.fn(),
		applyCwdSideEffects: vi.fn(),
		startWidgetsTimer: vi.fn(),
		startStallTimer: vi.fn(),
		webUi: { refresh: vi.fn() },
		notifyConversationChanged: vi.fn(),
		pushSettings: vi.fn(),
		pushSlashCommands: vi.fn(async () => {}),
		goalSvc: { emitGoalStatus: vi.fn(), notifyConversationRemoved: vi.fn() },
		getLang: () => "en",
		parentExecution: () => undefined,
		localParentId: () => undefined,
		getPendingQuestionForConv: () => undefined,
		emitQuestionQueue: vi.fn(),
		completionPending: () => false,
		pendingQuestionForSnapshot: () => null,
		pendingApprovalForSnapshot: () => null,
		pendingApprovalsForSnapshot: () => [],
		isPiConfigured: () => true,
		isPiCliInstalled: () => true,
		subagentHandoffs: [],
		convSeq: 0,
		...overrides,
	});
	const rt = runtimeFor(SessionManager.inMemory(project), project);
	const conv = cs.makeConversation(rt, "normal", cs.makeTerminalManager("normal", project));
	conv.title = "Normal chat";
	conv.listed = true;
	conv.pinned = true;
	cs.convs.set(conv.id, conv);
	clients.push(cs);
	return cs;
}

function makePty(): any {
	const pty = {
		pid: 0,
		write: vi.fn(),
		resize: vi.fn(),
		kill: vi.fn(),
		onData: vi.fn((callback) => {
			pty.data = callback;
			return { dispose() {} };
		}),
		onExit: vi.fn((callback) => {
			pty.exit = callback;
			return { dispose() {} };
		}),
		data: (_text: string) => {},
		exit: (_event: { exitCode: number }) => {},
	};
	ptys.push(pty);
	return pty;
}

function remoteHost() {
	const service = {
		sftpStat: vi.fn(async () => ({ isDirectory: true })),
		createCommandPty: vi.fn(async () => makePty()),
	} as any;
	setGlobalRemoteSshService(service);
	vi.spyOn(persistence, "probePersistentRemoteNativeCli").mockResolvedValue({ alive: false });
	vi.spyOn(remoteCli, "resolveRemoteNativeCliLaunch").mockResolvedValue({ file: "/remote/bin/claude", args: [] });
	return service;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-cli-conversation-"));
	previousService = getGlobalRemoteSshService();
	vi.stubEnv("PI_WEB_DATA_DIR", join(root, "data"));
	project = join(root, "project");
	mkdirSync(project);
	clients = [];
	ptys = [];
	runtimes = [];
	preparations = [];
	vi.mocked(prepareNativeCliSessionLaunch)
		.mockReset()
		.mockImplementation(async (config, ref, ctx) => {
			const launch = {
				config,
				ref,
				capabilities: { resume: "exact" as const, events: "hooks" as const },
				start: vi.fn(() => vi.fn()),
				flush: vi.fn(async () => {}),
				dispose: vi.fn(async () => {}),
			};
			preparations.push({ config, ref, ctx, launch });
			return launch;
		});
	vi.spyOn(SessionManager, "create").mockImplementation((cwd) => createSession(cwd, join(root, "agent", "sessions")));
	vi.mocked(createAgentSessionRuntime).mockImplementation(async (_factory, options) =>
		runtimeFor(options.sessionManager!, options.cwd!),
	);
	vi.mocked(spawn).mockReset().mockImplementation(makePty);
});

afterEach(async () => {
	await Promise.allSettled([...(ClientSession as any).sessionInfosInFlight.values()]);
	for (const cs of clients) for (const conv of cs.convs.values()) conv.terminals.killAll();
	setGlobalRemoteSshService(previousService as any);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("native CLI conversations", () => {
	it("persists the native session ID and consumes reliable events once across history reopening", async () => {
		const cs = client();
		cs.onNotificationEvent = vi.fn();
		expect(await cs.newCliChat({ preset: "claude", executable: process.execPath })).toBe(true);
		const cli = cs.conv;
		const sessionId = "12345678-1234-4123-8123-123456789abc";
		const report = preparations[0].ctx.onEvent;
		report({ type: "session", nativeId: sessionId, eventId: "session-start-1:session", cursor: "session-start-1" });
		expect(cli.nativeCliBinding.lastEventId).toBe("session-start-1");
		report({ type: "working", eventId: "working-1" });
		expect(cli.nativeCli.status.phase).toBe("working");
		report({ type: "done", eventId: "turn-complete-1" });
		report({ type: "done", eventId: "turn-complete-1" });
		expect(cs.onNotificationEvent).toHaveBeenCalledTimes(1);
		expect(cs.onNotificationEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "done", sessionId: cli.session.sessionId, conversationId: cli.id }),
		);
		report({ type: "done", eventId: "cancelled-turn", aborted: true });
		expect(cs.onNotificationEvent).toHaveBeenCalledTimes(1);
		report({ type: "error", code: "event_observer", message: "observer unavailable", eventId: "observer-generated" });
		expect(cli.nativeCliBinding.lastEventId).toBe("cancelled-turn");
		const restoredManager = SessionManager.open(cli.session.sessionFile);
		const binding = readNativeCliBinding(restoredManager, cli.nativeCli.config, project)!;
		expect(binding.nativeId).toBe(sessionId);
		const restored = cs.makeConversation(
			runtimeFor(restoredManager, project),
			"native-history",
			cs.makeTerminalManager("native-history", project),
		);
		cs.convs.set(restored.id, restored);
		await cs.bindSession(restored);
		expect(preparations.at(-1).ref).toMatchObject({ key: binding.key, nativeId: sessionId });
		expect(preparations.at(-1).ctx.lastEventId).toBe("cancelled-turn");
		preparations.at(-1).ctx.onEvent({ type: "done", eventId: "turn-complete-1" });
		expect(cs.onNotificationEvent).toHaveBeenCalledTimes(1);
	});

	it("keeps a persistent process on detach and reuses its binding when reconnecting", async () => {
		remoteHost();
		const stops: any[] = [];
		vi.spyOn(persistence, "openPersistentRemoteNativeCli").mockImplementation(async () => {
			const terminate = vi.fn(async () => {});
			stops.push(terminate);
			return {
				pty: makePty(),
				created: stops.length === 1,
				sessionName: "fixture",
				terminate,
				probe: vi.fn(async () => ({ alive: true })),
			};
		});
		const cs = client();
		expect(await cs.newCliChat({ preset: "claude", keepAlive: true }, "ssh://tester@example.test:22/project")).toBe(
			true,
		);
		const cli = cs.conv;
		const key = cli.nativeCliBinding.key;
		await cs.controlNativeCli(cli.id, cli.nativeCli.terminalId, "detach");
		cli.nativeCli.config.model = { provider: "removed-provider", id: "removed-model" };
		cs.sharedModelRuntime = { getModel: vi.fn(() => undefined) };
		vi.mocked(remoteCli.resolveRemoteNativeCliLaunch).mockRejectedValue(new Error("Old CLI executable was removed"));
		expect(cli.nativeCli.status.phase).toBe("disconnected");
		expect(stops[0]).not.toHaveBeenCalled();
		vi.mocked(persistence.probePersistentRemoteNativeCli).mockResolvedValue({ alive: true });
		vi.spyOn(persistence, "attachPersistentRemoteNativeCli").mockImplementation(async () => {
			const terminate = vi.fn(async () => {});
			stops.push(terminate);
			return {
				pty: makePty(),
				created: false,
				sessionName: "fixture",
				terminate,
				probe: vi.fn(async () => ({ alive: true })),
			};
		});
		await cs.controlNativeCli(cli.id, cli.nativeCli.terminalId, "reconnect");
		expect(preparations.at(-1).ctx.observeOnly).toBe(true);
		expect(preparations.at(-1).ref.key).toBe(key);
		expect(cli.nativeCli.status.phase).toBe("running");
		expect(cs.sharedModelRuntime.getModel).not.toHaveBeenCalled();
		expect(remoteCli.resolveRemoteNativeCliLaunch).toHaveBeenCalledTimes(1);
		expect(stops[0]).not.toHaveBeenCalled();
		expect(ptys[1].write).not.toHaveBeenCalled();
		await cs.controlNativeCli(cli.id, cli.nativeCli.terminalId, "stop");
		expect(stops[1]).toHaveBeenCalledOnce();
		expect(cli.nativeCli.status.phase).toBe("exited");
	});

	it("preserves an existing persistent process when service disposal overlaps a reconnect", async () => {
		remoteHost();
		const terminate = vi.fn(async () => {});
		vi.spyOn(persistence, "openPersistentRemoteNativeCli").mockResolvedValue({
			pty: makePty(),
			created: true,
			sessionName: "fixture",
			terminate,
			probe: vi.fn(async () => ({ alive: true })),
		});
		const cs = client({
			mcpOAuthUi: { dispose: vi.fn() },
			modelAdmin: { dispose: vi.fn() },
			bg: { stop: vi.fn() },
			files: { unwatchDir: vi.fn(), unwatchGit: vi.fn() },
			webUi: { refresh: vi.fn(), dispose: vi.fn() },
			settingsSvc: { current: {}, dispose: vi.fn() },
			cancelPendingQuestions: vi.fn(),
			cancelPendingPageCalls: vi.fn(),
			cancelPendingApprovals: vi.fn(),
			clearConversationToolStates: vi.fn(),
		});
		expect(await cs.newCliChat({ preset: "claude", keepAlive: true }, "ssh://tester@example.test:22/project")).toBe(
			true,
		);
		const cli = cs.conv;
		const reconnecting = cs.startNativeCliTerminal(cli);
		expect(cs.pendingCliManagers.has(cli.terminals)).toBe(true);
		await cs.dispose();
		await reconnecting;
		expect(terminate).not.toHaveBeenCalled();
	});

	it("keeps ownership when a persistent remote stop cannot be confirmed", async () => {
		remoteHost();
		const terminate = vi.fn().mockRejectedValue(new Error("SSH offline"));
		vi.spyOn(persistence, "openPersistentRemoteNativeCli").mockResolvedValue({
			pty: makePty(),
			created: true,
			sessionName: "fixture",
			terminate,
			probe: vi.fn(async () => ({ alive: true })),
		});
		const cs = client();
		expect(await cs.newCliChat({ preset: "claude", keepAlive: true }, "ssh://tester@example.test:22/project")).toBe(
			true,
		);
		const cli = cs.conv;
		await cs.dismissConversation(cli.id);
		expect(cs.convs.get(cli.id)).toBe(cli);
		expect(existsSync(cli.session.sessionFile)).toBe(true);
		terminate.mockResolvedValue(undefined);
		await cs.controlNativeCli(cli.id, cli.nativeCli.terminalId, "stop");
	});

	it("waits for SSH startup before replacing the active chat and keeps SSH cwd in history", async () => {
		const uri = "ssh://tester@example.test:22/remote-project";
		const service = remoteHost();
		let finish!: (value: any) => void;
		service.createCommandPty.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const cs = client();
		const creating = cs.newCliChat({ preset: "claude" }, uri);
		await vi.waitFor(() => expect(service.createCommandPty).toHaveBeenCalledOnce());
		expect(cs.activeId).toBe("normal");
		expect(cs.convs.size).toBe(1);
		finish(makePty());
		const created = await creating;
		expect(created, JSON.stringify(cs.emit.mock.calls)).toBe(true);
		expect(cs.conv.cwd).toBe(uri);
		expect(readNativeCliConfig(cs.conv.session.sessionManager)).toEqual({ preset: "claude" });
		expect(service.sftpStat).toHaveBeenCalledWith(uri, "/remote-project");
		expect(spawn).not.toHaveBeenCalled();
		const manager = SessionManager.open(cs.conv.session.sessionFile);
		const restored = cs.makeConversation(
			runtimeFor(manager, cs.conv.runtime.cwd),
			"ssh-history",
			cs.makeTerminalManager("ssh-history", uri),
		);
		cs.convs.set(restored.id, restored);
		expect(restored.cwd).toBe(uri);
		await cs.bindSession(restored);
		expect(service.createCommandPty).toHaveBeenCalledTimes(2);
		await cs.bindSession(restored);
		expect(service.createCommandPty).toHaveBeenCalledTimes(2);
	});

	it("does not activate a late SSH command after the startup deadline", async () => {
		vi.useFakeTimers();
		try {
			const service = remoteHost();
			let finish!: (value: any) => void;
			service.createCommandPty.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			const cs = client();
			const creating = cs.newCliChat({ preset: "claude" }, "ssh://tester@example.test:22/project");
			await vi.waitFor(() => expect(service.createCommandPty).toHaveBeenCalledOnce());
			const signal = service.createCommandPty.mock.calls[0][4].signal;
			await vi.advanceTimersByTimeAsync(90_000);
			expect(signal.aborted).toBe(true);
			const late = makePty();
			finish(late);
			expect(await creating).toBe(false);
			expect(cs.activeId).toBe("normal");
			expect(late.kill).toHaveBeenCalledOnce();
			expect(cs.creatingConversations.size).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rolls back a failed SSH command and leaves the current local chat active", async () => {
		const service = remoteHost();
		service.createCommandPty.mockRejectedValue(new Error("SSH channel closed"));
		const cs = client();
		expect(await cs.newCliChat({ preset: "claude" }, "ssh://tester@example.test:22/project")).toBe(false);
		expect(cs.activeId).toBe("normal");
		expect(cs.convs.size).toBe(1);
		expect(runtimes[1].dispose).toHaveBeenCalledOnce();
		expect(cs.creatingConversations.size).toBe(0);
		expect(cs.pendingCliManagers.size).toBe(0);
		expect(spawn).not.toHaveBeenCalled();
	});

	it.each(["claude", "codex"] as const)("passes the host model connection to a new %s CLI", async (preset) => {
		const cs = client();
		const model = {
			provider: "selected-provider",
			id: "selected-model",
			api: preset === "claude" ? "anthropic-messages" : "openai-responses",
			baseUrl: "https://configured.test/api",
		};
		cs.convs.get("normal").session.model = model;
		cs.settingsSvc.current = { nativeCliInheritModel: { [preset]: true } };
		cs.sharedModelRuntime = {
			getModel: vi.fn(() => model),
			isUsingOAuth: () => false,
			getAuth: vi.fn(async () => ({ auth: { apiKey: "host-connection-test-key" } })),
			getCompatibilityRequestConfig: () => ({}),
		};
		expect(await cs.newCliChat({ preset, executable: process.execPath })).toBe(true);
		expect(cs.sharedModelRuntime.getModel).toHaveBeenCalledWith(model.provider, model.id);
		const [, argv, options] = vi.mocked(spawn).mock.calls[0];
		expect(argv).toEqual(expect.arrayContaining(["--model", model.id]));
		expect(JSON.stringify(argv)).not.toContain("host-connection-test-key");
		expect(options.env).toMatchObject(
			preset === "claude"
				? { ANTHROPIC_BASE_URL: model.baseUrl, ANTHROPIC_AUTH_TOKEN: "host-connection-test-key" }
				: { PI_WEB_CLI_API_KEY: "host-connection-test-key" },
		);
		expect(JSON.stringify(readNativeCliConfig(cs.conv.session.sessionManager))).not.toContain(
			"host-connection-test-key",
		);
	});

	it("captures the selected model before creating a runtime and retains it for restart and history", async () => {
		const cs = client();
		const selected = { provider: "selected-provider", id: "selected-model" };
		cs.convs.get("normal").session.model = selected;
		cs.settingsSvc.current = { nativeCliInheritModel: { pi: true } };
		vi.mocked(createAgentSessionRuntime).mockImplementationOnce(async (_factory, options) => {
			cs.convs.get("normal").session.model = { provider: "later-provider", id: "later-model" };
			return runtimeFor(options.sessionManager!, options.cwd!);
		});
		expect(await cs.newCliChat({ preset: "pi", executable: process.execPath })).toBe(true);
		const cli = cs.conv;
		expect(cli.nativeCli.config.model).toEqual(selected);
		expect(readNativeCliConfig(cli.session.sessionManager)?.model).toEqual(selected);
		const argv = ["--provider", selected.provider, "--model", selected.id];
		expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(argv);
		cs.settingsSvc.current.nativeCliInheritModel.pi = false;
		ptys[0].exit({ exitCode: 0 });
		handleTerminalMessage(
			{
				type: "terminal_create",
				ownerKind: "conversation",
				conversationId: cli.id,
				terminalId: cli.nativeCli.terminalId,
				cwd: project,
				cols: 80,
				rows: 24,
			},
			cs,
		);
		await vi.waitFor(() => expect(vi.mocked(spawn).mock.calls[1]?.[1]).toEqual(argv));
	});

	it.each([false, true])("keeps CLI defaults when inheritance is %s but no model can be captured", async (enabled) => {
		const cs = client();
		cs.settingsSvc.current = { nativeCliInheritModel: { codex: enabled } };
		if (!enabled) cs.convs.get("normal").session.model = { provider: "openai", id: "selected-model" };
		expect(await cs.newCliChat({ preset: "codex", executable: process.execPath, args: ["--verbose"] })).toBe(true);
		expect(cs.conv.nativeCli.config.model).toBeUndefined();
		expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(["--verbose"]);
	});

	it.each(["local", "ssh"])("switches the active project after creating a CLI in another %s project", async (kind) => {
		const targetCwd = kind === "ssh" ? "ssh://dev@fixture:22/work/other" : join(root, "other-project");
		if (kind === "ssh") remoteHost();
		else mkdirSync(targetCwd);
		const roots = [targetCwd];
		const cs = client({
			applyCwdSideEffects: (ClientSession.prototype as any).applyCwdSideEffects,
			stateStore: { getWorkspaceRoots: vi.fn(() => roots), remember: vi.fn() },
			onCwdChanged: vi.fn(),
			invalidateProjectsCache: vi.fn(),
			refreshSessionsOnSwitch: vi.fn(),
			listFiles: vi.fn(async () => {}),
			listCommands: vi.fn(async () => {}),
			pushSessionsForCwd: vi.fn(async () => {}),
			pushProjects: vi.fn(async () => {}),
		});
		const snapshotCwds: string[] = [];
		cs.flushSnapshot.mockImplementation(() => snapshotCwds.push(cs.buildLightState(1, false).cwd));

		expect(await cs.newCliChat(config, targetCwd)).toBe(true);
		expect(cs.cwd).toBe(targetCwd);
		expect(cs.conv.cwd).toBe(targetCwd);
		expect(cs.roots).toBe(roots);
		expect(cs.files.unwatchGit).toHaveBeenCalledOnce();
		expect(cs.onCwdChanged).toHaveBeenCalledWith(targetCwd, roots);
		expect(cs.stateStore.remember).toHaveBeenCalledWith(cs.clientId, targetCwd);
		expect(cs.refreshSessionsOnSwitch).toHaveBeenCalledOnce();
		expect(cs.pushProjects).toHaveBeenCalledOnce();
		expect(cs.listFiles).toHaveBeenCalledWith(undefined);
		expect(cs.listCommands).toHaveBeenCalledOnce();
		expect(snapshotCwds).toEqual([targetCwd]);
		expect(cs.convs.get("normal").cwd).toBe(project);
	});

	it("creates distinct rows, keeps processes/output when switching, and replays only the active CLI", async () => {
		const cs = client();
		const ready = vi.fn();
		expect(await cs.newCliChat(config, project, ready)).toBe(true);
		const first = cs.conv;
		ptys[0].data("first output\r\n");
		expect(await cs.newCliChat(config, project, ready)).toBe(true);
		const second = cs.conv;
		ptys[1].data("second output\r\n");
		expect(cs.cwd).toBe(project);
		expect(cs.files.unwatchGit).not.toHaveBeenCalled();
		expect(cs.applyCwdSideEffects).not.toHaveBeenCalled();
		expect(first.id).not.toBe(second.id);
		expect(ready.mock.calls.map(([id]) => id)).toEqual([first.id, second.id]);
		expect(cs.convs.size).toBe(3);
		const rows = cs.emit.mock.calls.map(([msg]: any[]) => msg).findLast((msg: any) => msg.type === "conversations");
		expect(rows.conversations.filter((item: any) => item.nativeCli)).toHaveLength(2);
		// 原生 CLI 对话自己占左栏一行（终端要留在活动行），引擎必须明说
		expect(rows.conversations.filter((item: any) => item.nativeCli).every((item: any) => item.rowKind === "open")).toBe(
			true,
		);
		expect(rows.conversations.find((item: any) => item.id === first.id)?.modified).toBeGreaterThan(0);
		await cs.switchConversation("normal");
		await cs.switchConversation(first.id);
		expect(ptys).toHaveLength(2);
		expect(ptys.every((pty) => pty.kill.mock.calls.length === 0)).toBe(true);
		expect(first.terminals.replay()[0].data).toContain("first output");
		expect(second.terminals.replay()[0].data).toContain("second output");
		expect(cs.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "terminal_output",
				conversationId: first.id,
				terminalId: first.nativeCli.terminalId,
				reset: true,
				data: expect.stringContaining("first output"),
			}),
		);
		const state = cs.buildLightState(1, false, first);
		expect(state.nativeCli).toEqual(first.nativeCli);
		expect(cs.buildLightState(2, false, cs.convs.get("normal")).nativeCli).toBeUndefined();
	});

	it("publishes custom-only CLI history immediately and preserves type when no live conversation remains", async () => {
		const cs = client();
		expect(await cs.newCliChat(config)).toBe(true);
		const cli = cs.conv;
		await vi.waitFor(() =>
			expect(cs.emit).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "sessions",
					cwd: project,
					sessions: expect.arrayContaining([
						expect.objectContaining({
							path: cli.session.sessionFile,
							nativeCli: config,
							messageCount: 0,
							firstMessage: "",
							displayName: cli.title,
						}),
					]),
				}),
			),
		);
		expect(cli.session.sessionManager.getEntries().some((entry: any) => entry.type === "message")).toBe(false);
		cs.activeId = "normal";
		cli.terminals.killAll();
		cs.convs.delete(cli.id);
		cs.emit.mockClear();
		await cs.pushSessionsForCwd(project);
		expect(cs.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "sessions",
				cwd: project,
				sessions: expect.arrayContaining([expect.objectContaining({ nativeCli: config, messageCount: 0 })]),
			}),
		);
	});

	it("rebuilds history after an in-flight pre-creation scan has published its stale empty cache", async () => {
		const cs = client();
		const host = ClientSession as any;
		const cwdKey = normalizePathKey(project);
		const flightKey = `${cwdKey}\0list:old`;
		let finish!: (infos: any[]) => void;
		const pending = new Promise<any[]>((resolve) => {
			finish = resolve;
		});
		host.sessionInfosInFlight.set(flightKey, pending);
		expect(await cs.newCliChat(config)).toBe(true);
		const cli = cs.conv;
		expect(cs.emit.mock.calls.some(([message]: any[]) => message.type === "sessions")).toBe(false);
		host.sessionInfosCache.set(cwdKey, { infos: [], at: Date.now(), complete: true });
		host.sessionInfosInFlight.delete(flightKey);
		finish([]);
		await vi.waitFor(() =>
			expect(cs.emit).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "sessions",
					cwd: project,
					sessions: expect.arrayContaining([
						expect.objectContaining({ path: cli.session.sessionFile, nativeCli: config, messageCount: 0 }),
					]),
				}),
			),
		);
	});

	it("retains exited CLIs, excludes them from blank reuse and LRU, and rejects ordinary prompts", async () => {
		const cs = client();
		await cs.newCliChat(config);
		const cli = cs.conv;
		ptys[0].data("before exit");
		ptys[0].exit({ exitCode: 7 });
		expect(cs.displaceActive()).toBeNull();
		cli.viewOnly = true;
		cs.activeId = "normal";
		expect(cs.isEvictableViewedConversation(cli)).toBe(false);
		cs.activeId = cli.id;
		expect(cs.isBlankConversation(cli)).toBe(false);
		await cs.prompt("do not send this to an SDK model");
		expect(cli.session.prompt).not.toHaveBeenCalled();
		expect(cs.emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "notice", level: "error", textEn: expect.stringContaining("terminal") }),
		);
		cs.convs.delete("normal");
		vi.stubEnv("PI_WEB_MAX_OPEN_CONVERSATIONS", "1");
		const ready = vi.fn();
		expect(await cs.newChat(undefined, false, ready)).toBe(false);
		expect(ready).not.toHaveBeenCalled();
		expect(cli.terminals.replay()[0].data).toContain("before exit");
	});

	it("exposes the explicitly referenced CLI's readable output to reference materialization", async () => {
		const cs = client();
		await cs.newCliChat(config);
		const first = cs.conv;
		ptys[0].data("\u001b[32mfirst CLI content\u001b[0m\r\n");
		await cs.newCliChat(config);
		ptys[1].data("second CLI content");
		const snapshot = await cs.readQuickAskConversation(
			{ kind: "conversation", conversationId: first.id },
			new AbortController().signal,
		);
		expect(snapshot.messages[0].content).toContain("first CLI content");
		expect(snapshot.messages[0].content).not.toContain("second CLI content");
		expect(snapshot.messages[0].content).not.toContain("\u001b[");
		ptys[0].exit({ exitCode: 0 });
		expect(
			(
				await cs.readQuickAskConversation(
					{ kind: "conversation", conversationId: first.id },
					new AbortController().signal,
				)
			).messages[0].content,
		).toContain("first CLI content");
	});

	it("rolls back failed spawn without changing the active project or chat, and permits another creation", async () => {
		const cs = client();
		const targetCwd = join(root, "failed-project");
		mkdirSync(targetCwd);
		vi.mocked(spawn).mockImplementationOnce(() => {
			throw new Error("fixture spawn failure");
		});
		const ready = vi.fn();
		expect(await cs.newCliChat(config, targetCwd, ready)).toBe(false);
		expect(cs.activeId).toBe("normal");
		expect(cs.cwd).toBe(project);
		expect(cs.applyCwdSideEffects).not.toHaveBeenCalled();
		expect(cs.files.unwatchGit).not.toHaveBeenCalled();
		expect(cs.convs.size).toBe(1);
		expect(ready).not.toHaveBeenCalled();
		expect(runtimes[1].dispose).toHaveBeenCalledOnce();
		expect(cs.creatingConversations.size).toBe(0);
		expect(await cs.newCliChat(config)).toBe(true);
	});

	it("persists zero-message type metadata and restores history as CLI with a fresh terminal identity", async () => {
		const cs = client();
		await cs.newCliChat(config);
		const original = cs.conv;
		const path = original.session.sessionFile;
		expect(existsSync(path)).toBe(true);
		const restoredManager = SessionManager.open(path);
		expect(readNativeCliConfig(restoredManager)).toEqual(config);
		expect(restoredManager.getEntries().some((entry) => entry.type === "message")).toBe(false);
		const restored = cs.makeConversation(
			runtimeFor(restoredManager, project),
			"history-cli",
			cs.makeTerminalManager("history-cli", project),
		);
		cs.convs.set(restored.id, restored);
		await cs.bindSession(restored);
		expect(restored.nativeCli.config).toEqual(config);
		expect(restored.nativeCli.terminalId).not.toBe(original.nativeCli.terminalId);
		expect(ptys).toHaveLength(2);
		await cs.bindSession(restored);
		expect(ptys).toHaveLength(2);
	});

	it.each([
		{ active: true, exited: false },
		{ active: false, exited: false },
		{ active: true, exited: true },
		{ active: false, exited: true },
	])("deletes CLI history and releases its runtime (active=$active, exited=$exited)", async ({ active, exited }) => {
		const cs = client();
		await cs.newCliChat(config);
		const cli = cs.conv;
		const file = cli.session.sessionFile;
		const runtime = runtimes.at(-1);
		if (!active) await cs.switchConversation("normal");
		if (exited) ptys[0].exit({ exitCode: 0 });

		await cs.deleteSession(file);

		expect(cs.convs.has(cli.id)).toBe(false);
		expect(existsSync(file)).toBe(false);
		expect(cs.activeId).toBe("normal");
		expect(runtime.dispose).toHaveBeenCalledOnce();
		expect(runtimes[0].dispose).not.toHaveBeenCalled();
		expect(cli.terminals.countLive()).toBe(0);
		const lists = cs.emit.mock.calls.map(([message]: any[]) => message).filter((m: any) => m.type === "conversations");
		expect(lists.at(-1)).toEqual(
			expect.objectContaining({
				activeId: "normal",
				conversations: expect.not.arrayContaining([expect.objectContaining({ id: cli.id })]),
			}),
		);
		if (!exited) await vi.waitFor(() => expect(ptys[0].kill).toHaveBeenCalledOnce());
	});

	it.each([false, true])(
		"refreshes the deleted CLI's project while viewing another project (closed=%s)",
		async (closed) => {
			const cs = client();
			await cs.newCliChat(config);
			const cli = cs.conv;
			const file = cli.session.sessionFile;
			await cs.pushSessionsForCwd(project);
			if (closed) await cs.dismissConversation(cli.id);
			else await cs.switchConversation("normal");
			const otherProject = join(root, "other-project");
			mkdirSync(otherProject);
			cs.cwd = otherProject;
			cs.emit.mockClear();

			await cs.deleteSession(file);

			expect(existsSync(file)).toBe(false);
			expect(cs.cwd).toBe(otherProject);
			expect(cs.emit).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "sessions",
					cwd: project,
					sessions: expect.not.arrayContaining([expect.objectContaining({ path: file })]),
				}),
			);
		},
	);

	it("refreshes the logical SSH project when deleting closed CLI history", async () => {
		const cs = client();
		const uri = "ssh://u@fixture.test:22/remote-project";
		const manager = SessionManager.create(resolveWorkspaceSessionDir(cs.stateStore?.dataDir, uri));
		persistNativeCliConfig(manager, config, "Remote CLI");
		const file = manager.getSessionFile()!;
		await cs.pushSessionsForCwd(uri);
		cs.emit.mockClear();

		await cs.deleteSession(file);

		expect(existsSync(file)).toBe(false);
		expect(cs.cwd).toBe(project);
		expect(cs.emit).toHaveBeenCalledWith({ type: "sessions", cwd: uri, sessions: [] });
	});

	it("opens a fresh chat when deleting the only CLI conversation", async () => {
		const cs = client();
		await cs.newCliChat(config);
		const cli = cs.conv;
		const file = cli.session.sessionFile;
		cs.convs.delete("normal");

		await cs.deleteSession(file);

		expect(existsSync(file)).toBe(false);
		expect(cs.convs.has(cli.id)).toBe(false);
		expect(cs.conv.nativeCli).toBeUndefined();
		expect(cs.convs.size).toBe(1);
		await vi.waitFor(() => expect(ptys[0].kill).toHaveBeenCalledOnce());
	});

	it.each([true, false])(
		"preserves CLI history and processes when a user terminal blocks deletion (active=%s)",
		async (active) => {
			const cs = client();
			await cs.newCliChat(config);
			const cli = cs.conv;
			const file = cli.session.sessionFile;
			cli.terminals.create("user-shell", project, 80, 24);
			cli.terminals.input("user-shell", "running command\r");
			if (!active) await cs.switchConversation("normal");

			await cs.deleteSession(file);

			expect(cs.convs.has(cli.id)).toBe(true);
			expect(existsSync(file)).toBe(true);
			expect(ptys[0].kill).not.toHaveBeenCalled();
			expect(ptys[1].kill).not.toHaveBeenCalled();
			expect(cs.emit).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "notice",
					level: "warning",
					textEn: expect.stringContaining("still has open terminals"),
				}),
			);
		},
	);

	it.each([true, false])(
		"one dismiss message closes a running CLI with no SDK messages and preserves history (active=%s)",
		async (active) => {
			const cs = client();
			await cs.newCliChat(config);
			const cli = cs.conv;
			const file = cli.session.sessionFile;
			expect(cli.session.sessionManager.getEntries().some((entry: any) => entry.type === "message")).toBe(false);
			expect(cli.terminals.list()[0].running).toBe(true);
			if (!active) await cs.switchConversation("normal");
			cs.emit.mockClear();

			expect(handleSessionLifecycleMessage({ type: "dismiss_conversation", id: cli.id }, cs)).toBe(true);

			await vi.waitFor(() => expect(cs.convs.has(cli.id)).toBe(false));
			expect(cs.activeId).toBe("normal");
			await vi.waitFor(() => expect(ptys[0].kill).toHaveBeenCalledOnce());
			expect(cli.runtime.dispose).toHaveBeenCalledOnce();
			expect(cli.terminals.list()).toEqual([]);
			expect(cs.emit).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "conversations",
					activeId: "normal",
					conversations: expect.not.arrayContaining([expect.objectContaining({ id: cli.id })]),
				}),
			);
			ptys[0].exit({ exitCode: 0 });
			expect(cs.convs.has(cli.id)).toBe(false);
			expect(existsSync(file)).toBe(true);
			expect(readNativeCliConfig(SessionManager.open(file))).toEqual(config);
			cs.emit.mockClear();
			await cs.pushSessionsForCwd(project);
			expect(cs.emit).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "sessions",
					sessions: expect.arrayContaining([
						expect.objectContaining({ path: file, nativeCli: config, messageCount: 0 }),
					]),
				}),
			);

			await cs.deleteSession(file);
			expect(existsSync(file)).toBe(false);
			expect(spawn).toHaveBeenCalledOnce();
		},
	);

	it("routes restart/input to the owning background conversation and keeps old output on restart failure", async () => {
		const cs = client();
		await cs.newCliChat(config);
		const first = cs.conv;
		ptys[0].data("retained after failure");
		ptys[0].exit({ exitCode: 0 });
		await cs.newCliChat(config);
		const second = cs.conv;
		const message = {
			type: "terminal_create" as const,
			ownerKind: "conversation" as const,
			conversationId: first.id,
			terminalId: first.nativeCli.terminalId,
			cwd: "ignored",
			cols: 80,
			rows: 24,
			nativeCli: { preset: "custom" as const, executable: "ignored" },
		};
		vi.mocked(spawn).mockImplementationOnce(() => {
			throw new Error("retry failure");
		});
		handleTerminalMessage(message, cs);
		await vi.waitFor(() =>
			expect(cs.emit).toHaveBeenCalledWith(
				expect.objectContaining({ type: "notice", textEn: expect.stringContaining("retry failure") }),
			),
		);
		expect(first.terminals.replay()[0].data).toContain("retained after failure");
		handleTerminalMessage(message, cs);
		await vi.waitFor(() =>
			expect(first.terminals.getNativeCliTerminal(first.nativeCli.terminalId)?.nativeCli).toEqual(config),
		);
		handleTerminalMessage(
			{
				type: "terminal_input",
				terminalId: first.nativeCli.terminalId,
				conversationId: first.id,
				ownerKind: "conversation",
				data: "abc",
			},
			cs,
		);
		expect(ptys[2].write).toHaveBeenCalledWith("abc");
		expect(ptys[1].write).not.toHaveBeenCalledWith("abc");
		expect(cs.activeId).toBe(second.id);
		expect(cs.findTerminalManager(first.nativeCli.terminalId, second.id, "conversation")).toBeUndefined();
	});

	it("keeps asynchronous reference reads bound to the captured CLI across a conversation switch", async () => {
		const cs = client();
		await cs.newCliChat(config);
		const first = cs.conv;
		let release!: (attachments: any[]) => void;
		const materializeAttachments = vi.fn(
			() =>
				new Promise<any[]>((resolve) => {
					release = resolve;
				}),
		);
		const send = vi.fn();
		handleTerminalMessage(
			{
				type: "terminal_cli_paste",
				requestId: "delayed",
				terminalId: first.nativeCli.terminalId,
				conversationId: first.id,
				ownerKind: "conversation",
				data: "inspect",
				attachments: [],
			},
			cs,
			{ clientId: "cli-conversation-test", settings: {}, send, materializeAttachments },
		);
		await cs.newCliChat(config);
		const active = cs.conv;
		release([
			{ path: "", mode: "quote", quote: { text: "actual reference contents", role: "user", messageId: "reference" } },
		]);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "terminal_cli_paste_result", ok: true })),
		);
		expect(ptys[0].write).toHaveBeenCalledWith(expect.stringContaining("actual reference contents"));
		expect(ptys[1].write).not.toHaveBeenCalled();
		expect(cs.activeId).toBe(active.id);
	});

	it("rejects a delayed paste after the same terminal ID was restarted", async () => {
		const cs = client();
		await cs.newCliChat(config);
		const cli = cs.conv;
		let release!: (attachments: any[]) => void;
		const materializeAttachments = () =>
			new Promise<any[]>((resolve) => {
				release = resolve;
			});
		const send = vi.fn();
		handleTerminalMessage(
			{
				type: "terminal_cli_paste",
				requestId: "stale",
				terminalId: cli.nativeCli.terminalId,
				conversationId: cli.id,
				ownerKind: "conversation",
				data: "stale prompt",
			},
			cs,
			{ clientId: "cli-conversation-test", settings: {}, send, materializeAttachments },
		);
		ptys[0].exit({ exitCode: 0 });
		handleTerminalMessage(
			{
				type: "terminal_create",
				terminalId: cli.nativeCli.terminalId,
				conversationId: cli.id,
				ownerKind: "conversation",
				cwd: project,
				cols: 80,
				rows: 24,
			},
			cs,
		);
		release([]);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "terminal_cli_paste_result",
					ok: false,
					error: expect.stringContaining("restarted"),
				}),
			),
		);
		expect(ptys[1].write).not.toHaveBeenCalled();
	});

	it("rolls back a host binding failure after spawn and removes the incomplete history file", async () => {
		const cs = client();
		vi.mocked(createAgentSessionRuntime).mockImplementationOnce(async (_factory, options) => {
			const rt = runtimeFor(options.sessionManager!, options.cwd!);
			rt.session.bindExtensions.mockRejectedValueOnce(new Error("fixture bind failure"));
			return rt;
		});
		expect(await cs.newCliChat(config)).toBe(false);
		expect(cs.activeId).toBe("normal");
		expect(cs.convs.size).toBe(1);
		await vi.waitFor(() => expect(ptys[0].kill).toHaveBeenCalled());
		expect(runtimes[1].dispose).toHaveBeenCalled();
		expect(existsSync(runtimes[1].session.sessionFile)).toBe(false);
	});

	it("ACKs the exact new conversation and negatively ACKs unsupported engines or creation failure", async () => {
		const cs = client();
		const send = vi.fn();
		handleSessionLifecycleMessage({ type: "new_cli_chat", config, requestId: "create-cli" }, cs, send);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith({
				type: "new_chat_result",
				requestId: "create-cli",
				ok: true,
				conversationId: cs.activeId,
			}),
		);
		const unsupported = { newChat: vi.fn() } as any;
		handleSessionLifecycleMessage({ type: "new_cli_chat", config, requestId: "unsupported" }, unsupported, send);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith({ type: "new_chat_result", requestId: "unsupported", ok: false }),
		);
		handleSessionLifecycleMessage(
			{ type: "new_cli_chat", config: { preset: "custom" }, requestId: "bad-cli" },
			cs,
			send,
		);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith({ type: "new_chat_result", requestId: "bad-cli", ok: false }),
		);
	});

	it("persists later metadata without dropping the CLI marker, and rejects corrupt type markers", () => {
		const manager = SessionManager.create(project);
		persistNativeCliConfig(manager, config, "CLI history");
		manager.appendSessionInfo("Renamed CLI");
		expect(SessionManager.open(manager.getSessionFile()!).getSessionName()).toBe("Renamed CLI");
		expect(readNativeCliConfig(SessionManager.open(manager.getSessionFile()!))).toEqual(config);
		manager.appendCustomEntry("webui/native-cli", { version: 99, config });
		expect(() => readNativeCliConfig(manager)).toThrow("Unsupported");
	});
});
