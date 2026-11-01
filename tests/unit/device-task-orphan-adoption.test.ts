import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentService } from "../../server/agent-service-daemon.js";
import { ClientSession } from "../../server/agent-service.js";
import { ClientStateStore } from "../../server/client-state.js";
import { fakeClientSession } from "../helpers/fake-session.js";
import {
	isDeviceTaskClientId,
	isOrphanAdoptionExcludedClientId,
	isPseudoClientId,
} from "../../server/client-id-utils.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function session(id: string) {
	// 原型真方法（sharedPendingMessages 之类）+ 源码推导的实例字段，只覆写行为钩子。
	return fakeClientSession({
		clientId: id,
		cwd: resolve("."),
		workspaceRoots: [],
		sinkCount: () => 0,
		sharedPendingMessages: () => [],
		activeConversations: () => 0,
		hasAdoptableContent: () => true,
		latestActivity: () => 10,
		attachSink: vi.fn(),
		noteAdopted: vi.fn(),
		resumeInterrupted: vi.fn().mockResolvedValue(undefined),
	}) as unknown as ClientSession;
}
function serviceWith(oldId: string) {
	const root = mkdtempSync(join(tmpdir(), "bot-adoption-"));
	roots.push(root);
	const service = new AgentService(resolve("."), new ClientStateStore(join(root, "state.json")));
	const old = session(oldId);
	(service as any).clients.set(oldId, old);
	return { service, old };
}

describe("private Bot orphan adoption boundary", () => {
	it("classifies Bot adoption separately without changing existing pseudo semantics", () => {
		expect(isDeviceTaskClientId("device-task-new")).toBe(true);
		expect(isOrphanAdoptionExcludedClientId("device-task-new")).toBe(true);
		expect(isPseudoClientId("device-task-new")).toBe(false);
		for (const id of ["plugin:example", "scheduler:task", "canvas:run", "canvas-run"]) {
			expect(isPseudoClientId(id)).toBe(true);
			expect(isOrphanAdoptionExcludedClientId(id)).toBe(true);
		}
		expect(isOrphanAdoptionExcludedClientId("browser-client")).toBe(false);
	});

	it.each(["device-task-old", "browser-old"])("new Bot never adopts disconnected %s", async (oldId) => {
		const { service, old } = serviceWith(oldId);
		const fresh = session("device-task-new");
		const create = vi.spyOn(ClientSession, "create").mockResolvedValue(fresh);
		const attached = await service.attach("device-task-new", vi.fn());
		expect(attached).toBe(fresh);
		expect(create).toHaveBeenCalledWith("device-task-new", resolve("."), expect.any(ClientStateStore), { blank: true });
		expect(service.get(oldId)).toBe(old);
		expect(service.get("device-task-new")).toBe(fresh);
		expect(old.attachSink).not.toHaveBeenCalled();
		expect(old.noteAdopted).not.toHaveBeenCalled();
	});

	it("ordinary browser never adopts a disconnected Bot", async () => {
		const { service, old } = serviceWith("device-task-old");
		const fresh = session("browser-new");
		vi.spyOn(ClientSession, "create").mockResolvedValue(fresh);
		const attached = await service.attach("browser-new", vi.fn());
		expect(attached).toBe(fresh);
		expect(service.get("device-task-old")).toBe(old);
		expect(old.noteAdopted).not.toHaveBeenCalled();
	});

	it("ordinary browser still adopts its disconnected browser session", async () => {
		const { service, old } = serviceWith("browser-old");
		const create = vi.spyOn(ClientSession, "create");
		const attached = await service.attach("browser-new", vi.fn());
		expect(attached).toBe(old);
		expect(create).not.toHaveBeenCalled();
		expect(service.get("browser-old")).toBeUndefined();
		expect(service.get("browser-new")).toBe(old);
		expect(old.noteAdopted).toHaveBeenCalledOnce();
	});
});
