import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";
import { UniversalSession } from "../../server/universal/universal-session.js";
import { UniversalSessionStore } from "../../server/universal/session-store.js";
import { MockAgentDriver } from "../../server/universal/drivers/mock-driver.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("engine layout sharing, history transition and model isolation", () => {
	let testDir: string;
	let stateStore: ClientStateStore;
	let universalStore: UniversalSessionStore;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-engine-test-"));
		stateStore = new ClientStateStore(join(testDir, "client-state.json"));
		universalStore = new UniversalSessionStore(testDir);
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {}
	});

	describe("per-engine model isolation in ClientStateStore", () => {
		it("isolates project model memory per engine on the same workspace", () => {
			const clientId = "client-alpha";
			const cwd = join(testDir, "workspace-1");

			stateStore.saveProjectModel(clientId, cwd, "anthropic/claude-3-7-sonnet", "pi");
			stateStore.saveProjectModel(clientId, cwd, "deepseek/deepseek-chat", "dsh");
			stateStore.saveProjectModel(clientId, cwd, "claude-code/claude-3-5-sonnet", "claude");

			expect(stateStore.getProjectModel(clientId, cwd, "pi")).toBe("anthropic/claude-3-7-sonnet");
			expect(stateStore.getProjectModel(clientId, cwd, "dsh")).toBe("deepseek/deepseek-chat");
			expect(stateStore.getProjectModel(clientId, cwd, "claude")).toBe("claude-code/claude-3-5-sonnet");
		});

		it("isolates default model per engine while preserving pi legacy fallback", () => {
			stateStore.saveDefaultModel("anthropic/claude-3-7-sonnet", "pi");
			stateStore.saveDefaultModel("deepseek/deepseek-reasoner", "dsh");
			stateStore.saveDefaultModel("claude-code/claude-3-7-sonnet", "claude");

			expect(stateStore.getDefaultModel("pi")).toBe("anthropic/claude-3-7-sonnet");
			expect(stateStore.getDefaultModel("dsh")).toBe("deepseek/deepseek-reasoner");
			expect(stateStore.getDefaultModel("claude")).toBe("claude-code/claude-3-7-sonnet");

			expect(stateStore.getDefaultModel()).toBe("anthropic/claude-3-7-sonnet");
		});
	});

	describe("claude engine (UniversalSession) UI layout and settings push", () => {
		it("pushes settings_state with saved uiLayout on attachSink", () => {
			const clientId = "client-claude-test";
			const cwd = join(testDir, "workspace-claude");

			stateStore.saveSettings(clientId, {
				uiLayout: {
					hidden: ["host:brand"],
					slots: { "host:engine": "topbar.primary" },
				},
			});

			const messages: ServerMessage[] = [];
			const session = new UniversalSession({
				clientId,
				cwd,
				dataDir: testDir,
				send: (msg) => messages.push(msg),
				store: universalStore,
				stateStore,
				driver: new MockAgentDriver(cwd),
				engine: "claude",
			});

			const sinkMsgs: ServerMessage[] = [];
			session.attachSink((msg) => sinkMsgs.push(msg));

			const settingsMsg = sinkMsgs.find((m) => m.type === "settings_state");
			expect(settingsMsg).toBeDefined();
			if (settingsMsg && settingsMsg.type === "settings_state") {
				expect(settingsMsg.settings.uiLayout?.hidden).toContain("host:brand");
				expect(settingsMsg.settings.uiLayout?.slots?.["host:engine"]).toBe("topbar.primary");
			}

			session.dispose();
		});

		it("switchSession emits done transition_progress and snapshot contains sessionFile", async () => {
			const clientId = "client-claude-switch";
			const cwd = join(testDir, "workspace-claude");

			const messages: ServerMessage[] = [];
			const session = new UniversalSession({
				clientId,
				cwd,
				dataDir: testDir,
				send: (msg) => messages.push(msg),
				store: universalStore,
				stateStore,
				driver: new MockAgentDriver(cwd),
				engine: "claude",
			});

			session.flushSnapshot();
			const snapshot = messages.find((m) => m.type === "snapshot");
			expect(snapshot).toBeDefined();
			if (snapshot && snapshot.type === "snapshot") {
				expect(snapshot.state.sessionFile).toBeDefined();
				expect(snapshot.state.sessionFile).toBe(snapshot.state.sessionId);
			}

			await session.newChat();

			const historyId = (snapshot as any).state.sessionId;
			messages.length = 0;
			await session.switchSession(historyId);

			const transitionDone = messages.find((m) => m.type === "transition_progress" && (m as any).phase === "done");
			expect(transitionDone).toBeDefined();
			expect((transitionDone as any).progress).toBe(100);

			session.dispose();
		});

		it("automatically renames conversation and pushes conversations/sessions on first prompt", async () => {
			const clientId = "client-claude-rename";
			const cwd = join(testDir, "workspace-claude");

			const messages: ServerMessage[] = [];
			const session = new UniversalSession({
				clientId,
				cwd,
				dataDir: testDir,
				send: (msg) => messages.push(msg),
				store: universalStore,
				stateStore,
				driver: new MockAgentDriver(cwd),
				engine: "claude",
			});

			messages.length = 0;
			await session.prompt("你好");

			const convMsg = messages.find((m) => m.type === "conversations");
			expect(convMsg).toBeDefined();
			if (convMsg && convMsg.type === "conversations") {
				const activeConv = convMsg.conversations.find((c) => c.id === convMsg.activeId);
				expect(activeConv).toBeDefined();
				expect(activeConv?.title).toBe("你好");
			}

			const sessMsg = messages.find((m) => m.type === "sessions");
			expect(sessMsg).toBeDefined();
			if (sessMsg && sessMsg.type === "sessions") {
				const current = sessMsg.sessions[0];
				expect(current).toBeDefined();
				expect(current?.name).toBe("你好");
				expect(current?.displayName).toBe("你好");
			}

			session.dispose();
		});
	});
});
