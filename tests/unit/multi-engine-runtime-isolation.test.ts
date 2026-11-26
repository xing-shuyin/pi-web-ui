import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { normalizePathKey } from "../../server/client-state.js";
import { UniversalSessionStore } from "../../server/universal/session-store.js";
import { UniversalSession } from "../../server/universal/universal-session.js";
import { MockAgentDriver } from "../../server/universal/drivers/mock-driver.js";
import { DshRuntime } from "../../server/dsh/dsh-client.js";
import { DshClientSession } from "../../server/dsh/dsh-agent-service.js";
import { SandboxManager } from "../../server/sandbox-service.js";
import type { AgentEventSink } from "../../server/universal/driver-base.js";

const roots: string[] = [];
const sessions: UniversalSession[] = [];
const temp = () => {
	const path = mkdtempSync(join(tmpdir(), "engine-isolation-"));
	roots.push(path);
	return path;
};
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};
afterEach(async () => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe("engine history isolation", () => {
	it("separates equal IDs and imports ambiguous history as messages only once per engine", async () => {
		const root = temp();
		const hash = createHash("sha256").update(normalizePathKey(root)).digest("hex").slice(0, 16);
		const dir = join(root, "universal-sessions", hash);
		mkdirSync(dir, { recursive: true });
		const legacy = join(dir, "old.json");
		writeFileSync(
			legacy,
			JSON.stringify({
				id: "old",
				title: "legacy",
				createdAt: 1,
				updatedAt: 1,
				messages: [{ id: "u", role: "user", content: [{ type: "text", text: "hello" }] }],
				driverSessionId: "foreign-session",
			}),
		);
		const claude = new UniversalSessionStore(root, "claude");
		const durable = new UniversalSessionStore(root, "durable");
		expect(claude.listConversations(root)[0].driverSessionId).toBeUndefined();
		expect(durable.listConversations(root)[0].driverSessionId).toBeUndefined();
		claude.renameConversation(root, "old", "claude only");
		expect(durable.loadConversation(root, "old")?.title).toBe("legacy");
		await claude.deleteConversation(root, "old");
		expect(new UniversalSessionStore(root, "claude").listConversations(root)).toEqual([]);
		expect(existsSync(legacy)).toBe(true);
		expect(durable.loadConversation(root, "old")?.messages).toHaveLength(1);
	});
});

function universal() {
	const root = temp();
	const driver = new MockAgentDriver(root);
	const store = new UniversalSessionStore(root);
	const session = new UniversalSession({
		clientId: "test",
		cwd: root,
		dataDir: root,
		agentDir: root,
		send: vi.fn(),
		store,
		driver,
	});
	sessions.push(session);
	return { root, driver, store, session };
}

describe("Universal stable turn ownership", () => {
	it("ignores stale callbacks and completion after switching projects", async () => {
		const { root, driver, store, session } = universal();
		let sink!: AgentEventSink;
		vi.spyOn(driver, "sendPrompt").mockImplementation(async (_p, _a, s) => {
			sink = s;
		});
		await session.prompt("first");
		const oldId = (session as any).activeConvId;
		sink.onTextDelta("old response");
		const next = temp();
		await session.setCwd(next);
		const before = JSON.stringify(store.listConversations(next));
		sink.onTextDelta("late");
		sink.onTurnComplete({ usage: { inputTokens: 50 } } as any);
		sink.onError("late error");
		expect(JSON.stringify(store.listConversations(next))).toBe(before);
		await vi.waitFor(() => {
			expect(store.loadConversation(root, oldId)?.messages.at(-1)?.content).toEqual([
				{ type: "text", text: "old response" },
			]);
		});
	});
	it("does not send an old prompt when createSession resumes after a project switch", async () => {
		const { driver, session } = universal();
		const pending = deferred<string>();
		vi.spyOn(driver, "createSession").mockReturnValue(pending.promise);
		const send = vi.spyOn(driver, "sendPrompt");
		const running = session.prompt("old");
		await vi.waitFor(() => expect(driver.createSession).toHaveBeenCalled());
		await session.setCwd(temp());
		pending.resolve("old-session");
		await running;
		expect(send).not.toHaveBeenCalled();
	});
	it("completes once and ignores late errors while a new turn runs", async () => {
		const { driver, session } = universal();
		const sinks: AgentEventSink[] = [];
		vi.spyOn(driver, "sendPrompt").mockImplementation(async (_p, _a, s) => {
			sinks.push(s);
		});
		await session.prompt("one");
		sinks[0].onTextDelta("answer");
		sinks[0].onTurnComplete();
		await session.prompt("two");
		sinks[0].onError("stale");
		sinks[0].onTurnComplete();
		expect((session as any).isStreaming).toBe(true);
		sinks[1].onTextDelta("second");
		sinks[1].onTurnComplete();
		expect((session as any).activeConv.messages.filter((m: any) => m.role === "assistant")).toHaveLength(2);
	});
});

describe("Universal abort admission", () => {
	it("shares an abort and blocks new prompts until the driver settles", async () => {
		const { driver, session } = universal();
		const pending = deferred<void>();
		const stop = vi.spyOn(driver, "abort").mockReturnValue(pending.promise);
		const send = vi.spyOn(driver, "sendPrompt").mockResolvedValue(undefined);
		await session.prompt("first");
		const a = session.abort();
		const b = session.abort();
		await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
		await session.prompt("blocked");
		expect(send).toHaveBeenCalledOnce();
		pending.resolve(undefined);
		await Promise.all([a, b]);
		await session.prompt("allowed");
		expect(send).toHaveBeenCalledTimes(2);
	});
});

describe("DSH workspace transaction", () => {
	it("restart initializes with the new cwd even when initially idle", async () => {
		const root = temp();
		const runtime = new DshRuntime({ cwd: root } as any);
		const start = vi.spyOn(runtime, "start").mockResolvedValue(undefined);
		await runtime.restart(undefined, undefined, join(root, "next"));
		expect(runtime.cwd).toBe(resolve(root, "next"));
		expect(start).toHaveBeenCalledOnce();
	});
	it("blocks prompts during restart and never publishes a failed target", async () => {
		const root = temp();
		const next = temp();
		const pending = deferred<void>();
		const runtime = {
			restart: vi.fn(() => pending.promise),
			kill: vi.fn().mockResolvedValue(undefined),
			cwd: root,
			model: "old",
			modelProvider: "provider",
		};
		const session: any = Object.assign(Object.create(DshClientSession.prototype), {
			cwd: root,
			model: "old",
			modelProvider: "provider",
			runtime,
			clientId: "test",
			workspaceGeneration: 0,
			sandboxes: new SandboxManager(root),
			stateStore: {
				getProjectModel: () => undefined,
				getDefaultModel: () => undefined,
				remember: vi.fn(),
				getWorkspaceRoots: () => [],
			},
			emit: vi.fn(),
		});
		const switching = session.setCwd(next);
		await vi.waitFor(() => expect(runtime.restart).toHaveBeenCalled());
		expect(session.cwd).toBe(root);
		await session.prompt("blocked");
		expect(session.stateStore.remember).not.toHaveBeenCalled();
		runtime.kill.mockResolvedValue(undefined);
		pending.resolve(undefined);
		await switching;
		expect(session.cwd).toBe(next);
	});
	it("initialization failure retains the old workspace and resets runtime cwd", async () => {
		const root = temp();
		const next = temp();
		const runtime = {
			restart: vi.fn().mockRejectedValue(new Error("initialize failed")),
			kill: vi.fn().mockResolvedValue(undefined),
			cwd: next,
			model: "new",
			modelProvider: "provider",
		};
		const remember = vi.fn();
		const emit = vi.fn();
		const session: any = Object.assign(Object.create(DshClientSession.prototype), {
			cwd: root,
			model: "old",
			modelProvider: "provider",
			runtime,
			clientId: "test",
			workspaceGeneration: 0,
			sandboxes: new SandboxManager(root),
			stateStore: { getProjectModel: () => undefined, getDefaultModel: () => undefined, remember },
			emit,
		});
		await session.setCwd(next);
		expect(session.cwd).toBe(root);
		expect(runtime.cwd).toBe(root);
		expect(remember).not.toHaveBeenCalled();
		expect(emit.mock.calls.some(([m]) => m.type === "transition_progress" && m.phase === "done")).toBe(false);
		expect(session.switchingWorkspace).toBe(false);
	});
});
