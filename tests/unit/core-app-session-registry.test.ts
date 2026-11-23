import { beforeEach, describe, expect, it, vi } from "vitest";

const openTurnSession = vi.fn();

vi.mock("../../packages/keel/src/adapters/sdk/index.js", () => ({
	openTurnSession: (...args: unknown[]) => openTurnSession(...args),
}));

const { SessionRegistry, SessionUnavailableError } = await import("../../packages/keel/src/app/session-registry.js");
const { Conversation } = await import("../../packages/keel/src/kernel/conversation/index.js");

function makeConv(overrides: Partial<{ id: string; sessionFile: string }> = {}) {
	return new Conversation({
		id: overrides.id ?? "c1",
		clientId: "client-1",
		cwd: "/work",
		kind: "user",
		createdAt: 1,
		sessionFile: overrides.sessionFile,
	});
}

function fakeOpened(overrides: { sessionFile?: string } = {}) {
	const dispose = vi.fn();
	return { dispose, value: { session: { dispose }, sessionId: "s1", sessionFile: overrides.sessionFile, dispose } };
}

describe("app · SessionRegistry", () => {
	beforeEach(() => {
		openTurnSession.mockReset();
	});

	it("首次 ensure 打开会话，之后复用同一份", async () => {
		const opened = fakeOpened({ sessionFile: "/tmp/s1.jsonl" });
		openTurnSession.mockResolvedValue(opened.value);
		const registry = new SessionRegistry({ agentDir: "/agent" });
		const conv = makeConv();

		const first = await registry.ensure(conv);
		const second = await registry.ensure(conv);

		expect(openTurnSession).toHaveBeenCalledTimes(1);
		expect(openTurnSession).toHaveBeenCalledWith({ cwd: "/work", agentDir: "/agent", sessionFile: undefined });
		expect(first).toBe(second);
		expect(registry.has("c1")).toBe(true);
		expect(registry.openCount()).toBe(1);
		expect(conv.meta.sessionFile).toBe("/tmp/s1.jsonl");
	});

	it("退役中的对话不开会话（fail-closed 先于开会话）", async () => {
		const registry = new SessionRegistry({ agentDir: "/agent" });
		const conv = makeConv();
		conv.retire();
		await expect(registry.ensure(conv)).rejects.toBeInstanceOf(SessionUnavailableError);
		expect(openTurnSession).not.toHaveBeenCalled();
	});

	it("开会话失败时不留半成品，可重试", async () => {
		const registry = new SessionRegistry({ agentDir: "/agent" });
		const conv = makeConv();
		openTurnSession.mockRejectedValueOnce(new Error("boom"));
		await expect(registry.ensure(conv)).rejects.toThrow("boom");
		expect(registry.has("c1")).toBe(false);

		const opened = fakeOpened();
		openTurnSession.mockResolvedValueOnce(opened.value);
		await expect(registry.ensure(conv)).resolves.toBe(opened.value);
	});

	it("close 释放 SDK 会话并回调，重复 close 不再 dispose", async () => {
		const opened = fakeOpened();
		openTurnSession.mockResolvedValue(opened.value);
		const onClosed = vi.fn();
		const registry = new SessionRegistry({ agentDir: "/agent", onClosed });
		await registry.ensure(makeConv());

		registry.close("c1");
		registry.close("c1");

		expect(opened.dispose).toHaveBeenCalledTimes(1);
		expect(onClosed).toHaveBeenCalledTimes(1);
		expect(registry.has("c1")).toBe(false);
	});

	it("closeAll 只释放一次", async () => {
		const a = fakeOpened();
		const b = fakeOpened();
		openTurnSession.mockResolvedValueOnce(a.value).mockResolvedValueOnce(b.value);
		const registry = new SessionRegistry({ agentDir: "/agent" });
		await registry.ensure(makeConv({ id: "a" }));
		await registry.ensure(makeConv({ id: "b" }));

		registry.closeAll();
		registry.closeAll();

		expect(a.dispose).toHaveBeenCalledTimes(1);
		expect(b.dispose).toHaveBeenCalledTimes(1);
		expect(registry.openCount()).toBe(0);
	});

	it("续开已有转录时把 sessionFile 透传给适配器", async () => {
		openTurnSession.mockResolvedValue(fakeOpened().value);
		const registry = new SessionRegistry({ agentDir: "/agent" });
		await registry.ensure(makeConv({ sessionFile: "/tmp/existing.jsonl" }));
		expect(openTurnSession).toHaveBeenCalledWith({
			cwd: "/work",
			agentDir: "/agent",
			sessionFile: "/tmp/existing.jsonl",
		});
	});

	it("onOpened 收到对话与句柄", async () => {
		const opened = fakeOpened();
		openTurnSession.mockResolvedValue(opened.value);
		const onOpened = vi.fn();
		const registry = new SessionRegistry({ agentDir: "/agent", onOpened });
		const conv = makeConv();
		await registry.ensure(conv);
		expect(onOpened).toHaveBeenCalledWith(conv, opened.value);
	});
});

describe("app · SessionRegistry 工具装载透传", () => {
	beforeEach(() => {
		openTurnSession.mockReset();
	});

	it("tools / customTools 由注入的装载钩子决定，注册表不加默认值", async () => {
		openTurnSession.mockResolvedValue(fakeOpened().value);
		const tool = { name: "ask_user_question" };
		const registry = new SessionRegistry({
			agentDir: "/agent",
			toolsFor: () => ["read", "bash"],
			customToolsFor: () => [tool],
		});
		await registry.ensure(makeConv());
		expect(openTurnSession).toHaveBeenCalledWith(
			expect.objectContaining({ tools: ["read", "bash"], customTools: [tool] }),
		);
	});

	it("钩子没给就不传，交给 SDK 默认", async () => {
		openTurnSession.mockResolvedValue(fakeOpened().value);
		const registry = new SessionRegistry({ agentDir: "/agent" });
		await registry.ensure(makeConv());
		const arg = openTurnSession.mock.calls[0][0] as Record<string, unknown>;
		expect(arg.tools).toBeUndefined();
		expect(arg.customTools).toBeUndefined();
	});
});
