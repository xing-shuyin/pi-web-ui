import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientStateStore } from "../../server/client-state.js";
import { UniversalAgentService } from "../../server/universal/universal-service.js";
import { UniversalSession } from "../../server/universal/universal-session.js";
import { UniversalSessionStore } from "../../server/universal/session-store.js";
import { MockAgentDriver } from "../../server/universal/drivers/mock-driver.js";
import type { AgentEventSink } from "../../server/universal/driver-base.js";
import { isBuiltinEngineId } from "../../server/engine-catalog.js";
import type { CanvasEngineId, EngineId } from "../../server/protocol.js";

const roots: string[] = [];
const sessions: UniversalSession[] = [];
const temp = () => {
	const root = mkdtempSync(join(tmpdir(), "codex-wiring-"));
	roots.push(root);
	return root;
};
afterEach(async () => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
function setup() {
	const root = temp();
	const driver = new MockAgentDriver(root);
	Object.defineProperty(driver, "id", { value: "codex" });
	const store = new UniversalSessionStore(root, "codex");
	const send = vi.fn();
	const session = new UniversalSession({
		clientId: "codex-test",
		cwd: root,
		dataDir: root,
		agentDir: root,
		store,
		driver,
		send,
	});
	sessions.push(session);
	return { root, driver, store, send, session };
}

describe("Codex engine wiring", () => {
	it("persists the selected engine and isolates model preferences from Claude", () => {
		const root = temp();
		const state = new ClientStateStore(join(root, "client-state.json"));
		state.saveClientEngine("tab", "codex");
		state.saveDefaultEngine("codex");
		state.saveDefaultModel("default", "codex");
		state.saveDefaultModel("sonnet", "claude");
		const restored = new ClientStateStore(join(root, "client-state.json"));
		expect(restored.getClientEngine("tab")).toBe("codex");
		expect(restored.getDefaultEngine()).toBe("codex");
		expect(restored.getDefaultModel("codex")).toBe("default");
		expect(restored.getDefaultModel("claude")).toBe("sonnet");
	});
	it("uses default/medium and Codex model provider before model enumeration", async () => {
		const { session, send, driver } = setup();
		session.flushSnapshot(true);
		const snapshot = send.mock.calls
			.map(([m]) => m)
			.filter((m) => m.type === "snapshot")
			.at(-1);
		expect(snapshot.state.model).toMatchObject({ id: "default", provider: "codex" });
		expect(snapshot.state.thinkingLevel).toBe("medium");
		const list = vi.spyOn(driver, "listModels").mockResolvedValue([{ id: "default", name: "Codex config" }]);
		await session.listModels();
		expect(list).toHaveBeenCalledOnce();
		expect(send.mock.calls.map(([m]) => m).find((m) => m.type === "models").models).toEqual([
			expect.objectContaining({ id: "codex/default", provider: "codex" }),
		]);
	});
	it.each(["error", "stop", "complete"])("binds thread before %s and resumes it on the next turn", async (ending) => {
		const { session, driver, store, root } = setup();
		let sink!: AgentEventSink;
		vi.spyOn(driver, "sendPrompt").mockImplementation(async (_p, _a, s) => {
			sink = s;
		});
		const resume = vi.spyOn(driver, "resumeSession");
		await session.prompt("first");
		sink.onSessionStarted?.("real-thread");
		const id = (session as any).activeConvId;
		expect(store.loadConversation(root, id)?.driverSessionId).toBe("real-thread");
		if (ending === "error") sink.onError("interrupted");
		else if (ending === "stop") await session.abort();
		else sink.onTurnComplete();
		await session.prompt("second");
		expect(resume).toHaveBeenCalledWith("real-thread");
		sink.onTurnComplete();
		expect(new UniversalSessionStore(root, "claude").loadConversation(root, id)).toBeNull();
	});
	it("drops stale thread allocation callbacks after a project switch", async () => {
		const { session, driver, store, root } = setup();
		let sink!: AgentEventSink;
		vi.spyOn(driver, "sendPrompt").mockImplementation(async (_p, _a, s) => {
			sink = s;
		});
		await session.prompt("first");
		const id = (session as any).activeConvId;
		await session.setCwd(temp());
		sink.onSessionStarted?.("stale-thread");
		expect(store.loadConversation(root, id)?.driverSessionId).not.toBe("stale-thread");
	});
	it("constructs Codex sessions through the service factory with a separate store", async () => {
		const root = temp();
		const factory = vi.fn((cwd: string) => {
			const driver = new MockAgentDriver(cwd);
			Object.defineProperty(driver, "id", { value: "codex" });
			return driver;
		});
		const service = new UniversalAgentService({
			cwd: root,
			dataDir: root,
			agentDir: root,
			engine: "codex",
			driverFactory: factory,
		});
		const session = (await service.attach("factory", vi.fn())) as UniversalSession;
		sessions.push(session);
		expect(factory).toHaveBeenCalledWith(root);
		expect((session as any).engine).toBe("codex");
	});
	it("registers Codex in startup/hot switching, protocol and CLI validation", () => {
		const index = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
		expect(index).toContain('EXPLICIT_ENGINE_ARG === "codex"');
		expect(index).toContain('msg.engine === "codex"');
		expect(index).toContain("driverFactory: (cwd) => new CodexDriver(cwd)");
		expect(index).toContain("if (codexServiceInstance) list.push(codexServiceInstance)");
		const protocol = readFileSync(new URL("../../server/protocol.ts", import.meta.url), "utf8");
		const engine: EngineId = "codex";
		const canvasEngine: CanvasEngineId = "codex";
		expect(isBuiltinEngineId(engine)).toBe(true);
		expect(canvasEngine).toBe(engine);
		expect(protocol).toContain('export type EngineId = import("./engine-catalog.js").BuiltinEngineId;');
		expect(protocol.match(/export type CanvasEngineId = [^;]+/)?.[0]).toContain('"codex"');
		const cli = readFileSync(new URL("../../bin/pi-web-ui.mjs", import.meta.url), "utf8");
		expect(cli).toContain("env.PI_WEB_ENGINE = engine");
		expect(cli.match(/\["pi", "dsh", "claude", "codex", "durable"\]\.includes/g)).toHaveLength(2);
	});
});
