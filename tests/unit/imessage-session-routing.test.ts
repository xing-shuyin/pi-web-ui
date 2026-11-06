import { describe, expect, it, vi } from "vitest";
import { IMessageBotBridge } from "../../plugins/imessage/bridge.mjs";

async function setup(saved = new Map<string, any>(), config: any = {}) {
	let listener: any;
	let sequence = 0;
	const host = {
		storage: {
			get: vi.fn(async (key: string) => structuredClone(saved.get(key))),
			set: vi.fn(async (key: string, value: any) => {
				saved.set(key, structuredClone(value));
			}),
		},
		chat: vi.fn(async (_request: any) => ({
			conversationId: "c1",
			clientId: `scope-${++sequence}`,
			sessionId: `session-${sequence}`,
			runId: `run-${sequence}`,
		})),
		onRunEvent: vi.fn((fn: any) => {
			listener = fn;
			return () => {};
		}),
		abortRun: vi.fn(async () => ({ ok: true })),
	};
	const bridge: any = new IMessageBotBridge({
		host,
		getConfig: () => config,
		platform: "darwin",
		execFileImpl: vi.fn(async () => ({ stdout: "[]" })),
	});
	bridge.reply = vi.fn(async (_target: any, _text: string) => {});
	await bridge.restoreRoutes();
	await bridge.start();
	if (bridge.pollTimer) clearInterval(bridge.pollTimer);
	const event = async (type: string, identity: any, text?: string) =>
		listener({ type, ...identity, ...(text === undefined ? {} : { message: { role: "assistant", content: text } }) });
	const inbound = async (room: string, text = "hello") =>
		bridge.onInboundMessage({ sender: "user@example.com", chatId: room, text });
	return { host, bridge, event, inbound, saved, config };
}

describe("iMessage persistent session routes through the host bridge", () => {
	it("isolates concurrent c1 scopes, exact unknown IDs, replacement text and web continuation", async () => {
		const { bridge, event, inbound } = await setup();
		await Promise.all([inbound("A"), inbound("B")]);
		for (const n of [1, 2]) {
			const identity = { runId: `run-${n}`, sessionId: `session-${n}`, conversationId: "c1" };
			await event("message", { ...identity, runId: "unknown" }, "foreign");
			await event("message", identity, "draft");
			await event("message", identity, `final-${n}`);
			await event("run_end", identity);
			await event("run_end", identity);
		}
		expect(bridge.reply.mock.calls).toEqual([
			[{ chatId: "A" }, "final-1"],
			[{ chatId: "B" }, "final-2"],
		]);
		const web = { sessionId: "session-1", clientId: "new-owner", conversationId: "c1" };
		await event("run_start", web);
		await event("run_start", web);
		await event("message", web, "web draft");
		await event("run_start", web);
		await event("message", { ...web, runId: "unknown-web" }, "foreign");
		await event("run_end", { ...web, runId: "unknown-web" });
		await event("message", web, "web final");
		await event("run_end", web);
		await event("run_end", web);
		expect(bridge.reply).toHaveBeenLastCalledWith({ chatId: "A" }, "web final");
		expect(bridge.reply).toHaveBeenCalledTimes(3);
		await bridge.stop();
	});

	it("restores stable routes and reset epochs without reviving old sessions", async () => {
		const first = await setup();
		await first.inbound("A");
		await first.event("run_end", { runId: "run-1" });
		await first.bridge.stop();
		const second = await setup(first.saved);
		const web = { sessionId: "session-1", conversationId: "c1" };
		await second.event("run_start", web);
		await second.event("message", web, "restored");
		await second.event("run_end", web);
		expect(second.bridge.reply).toHaveBeenCalledWith({ chatId: "A" }, "restored");
		await second.inbound("A", "/reset");
		const epochs = [...second.bridge.sessionEpochs];
		await second.bridge.stop();
		const third = await setup(first.saved);
		expect([...third.bridge.sessionEpochs]).toEqual(epochs);
		await third.event("run_start", web);
		await third.event("run_end", web);
		expect(third.bridge.reply).not.toHaveBeenCalled();
		await third.inbound("A");
		expect(third.host.chat.mock.calls[0][0].accountId).not.toBe(first.host.chat.mock.calls[0][0].accountId);
		await third.bridge.stop();
	});

	it("account changes revoke history and queues even after reverting or reloading", async () => {
		const first = await setup();
		await first.inbound("A");
		await first.event("run_end", { runId: "run-1" });
		const originalAccount = first.host.chat.mock.calls[0][0].accountId;
		first.config.accountId = "other";
		await first.bridge.invalidateAccount();
		expect(first.bridge.userConversations.size).toBe(0);
		expect(first.bridge.queues.size).toBe(0);
		await first.inbound("A");
		expect(first.host.chat.mock.calls[1][0].conversationId).toBeUndefined();
		expect(first.host.chat.mock.calls[1][0].accountId).not.toBe(originalAccount);
		first.config.accountId = "";
		await first.bridge.invalidateAccount();
		await first.inbound("A");
		expect(first.host.chat.mock.calls[2][0].conversationId).toBeUndefined();
		expect(first.host.chat.mock.calls[2][0].accountId).not.toBe(originalAccount);
		await first.bridge.stop();
		const restored = await setup(first.saved, { accountId: "offline-change" });
		await restored.inbound("A");
		expect(restored.host.chat.mock.calls[0][0].conversationId).toBeUndefined();
		expect(restored.host.chat.mock.calls[0][0].accountId).not.toBe(first.host.chat.mock.calls[2][0].accountId);
		await restored.bridge.stop();
	});

	it("stops chunk delivery when the account changes while sending", async () => {
		const { bridge, event, inbound, config } = await setup();
		await inbound("A");
		bridge.reply.mockImplementationOnce(async () => {
			config.accountId = "changed";
		});
		await event("message", { runId: "run-1" }, "a".repeat(7000));
		await event("run_end", { runId: "run-1" });
		expect(bridge.reply).toHaveBeenCalledTimes(1);
		expect(bridge.getStatus().messagesReplied).toBe(0);
		await bridge.stop();
	});

	it("uses full legacy client identity and never anonymous conversation IDs", async () => {
		const { bridge, host, inbound, event, saved } = await setup();
		let n = 0;
		host.chat.mockImplementation(
			async () => ({ conversationId: "c1", clientId: `legacy-${++n}`, runId: undefined, sessionId: undefined }) as any,
		);
		await Promise.all([inbound("A"), inbound("B")]);
		await event("run_end", { conversationId: "c1" });
		expect(bridge.reply).not.toHaveBeenCalled();
		await event("message", { clientId: "legacy-2", conversationId: "c1" }, "B");
		await event("run_end", { clientId: "legacy-2", conversationId: "c1" });
		expect(bridge.reply).toHaveBeenCalledWith({ chatId: "B" }, "B");
		await event("run_end", { clientId: "legacy-1", conversationId: "c1" });
		expect(saved.get("sessionRoutes").routes).toEqual([]);
		await bridge.stop();
	});

	it("refuses guessed web abort, keeps stop routes, and invalidates account changes", async () => {
		const { bridge, host, event, inbound, config, saved } = await setup();
		await inbound("A");
		await event("run_end", { runId: "run-1" });
		const web = { sessionId: "session-1", conversationId: "c1" };
		await event("run_start", web);
		await inbound("A", "/stop");
		expect(host.abortRun).not.toHaveBeenCalled();
		expect(bridge.reply.mock.calls.at(-1)[1]).toContain("网页端");
		await event("run_end", web);
		await event("run_start", web);
		await event("message", web, "after stop");
		await event("run_end", web);
		expect(bridge.reply).toHaveBeenLastCalledWith({ chatId: "A" }, "after stop");
		config.accountId = "changed";
		bridge.reply.mockClear();
		await event("run_start", web);
		await event("run_end", web);
		expect(bridge.reply).not.toHaveBeenCalled();
		await bridge.stop();
		const restored = await setup(saved, config);
		expect(restored.bridge.sessionRoutes.size).toBe(0);
		await restored.bridge.stop();
	});
});
