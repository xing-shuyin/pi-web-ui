import { afterEach, describe, expect, it, vi } from "vitest";
import activate, { DiscordBotBridge } from "../../plugins/discord/index.mjs";

const message = (channel = "a", text = "hello") => ({
	author: { id: "user" },
	channel_id: channel,
	content: text,
});
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
function harness(saved = new Map<string, any>()) {
	let config = { allowAllSenders: true, botToken: "test-token", botEnabled: true };
	const sent: { channel: string; text: string }[] = [];
	const storage = {
		get: vi.fn(async (key: string) => structuredClone(saved.get(key))),
		set: vi.fn(async (key: string, value: any) => {
			saved.set(key, structuredClone(value));
		}),
	};
	let listener: any;
	const host = {
		cwd: "/project",
		storage,
		notify: vi.fn(),
		log: vi.fn(),
		chat: vi.fn(async (req: any) => ({
			ok: true,
			conversationId: "c1",
			clientId: req.accountId,
			sessionId: `session:${req.accountId}`,
			runId: `run:${req.accountId}`,
		})),
		abortRun: vi.fn(async () => ({ ok: true })),
		onRunEvent: vi.fn((fn: any) => {
			listener = fn;
			return () => {
				listener = undefined;
			};
		}),
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, options: any) => {
			const match = String(url).match(/\/channels\/([^/]+)\/messages/);
			if (!match) throw new Error(`Unexpected external request: ${url}`);
			sent.push({ channel: match[1], text: JSON.parse(options.body).content });
			return { ok: true, status: 200, json: async () => ({ id: "sent" }) };
		}),
	);
	const bridge: any = new DiscordBotBridge({ host, getConfig: () => config });
	bridge.connectGateway = vi.fn(async () => {});
	return {
		bridge,
		host,
		sent,
		saved,
		config,
		changeAccount: () => {
			config = { ...config, botToken: "other-token" };
		},
		emit: async (ev: any) => {
			listener(ev);
			await vi.waitFor(() => expect(bridge.status.lastError).toBeNull());
		},
	};
}
async function finish(bridge: any, result: any, text = "answer") {
	await bridge.handleRunEvent({ type: "message", ...result, message: assistant(text) });
	await bridge.handleRunEvent({ type: "run_end", ...result });
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Discord scope sessions and destination routing", () => {
	it("keeps two concurrent c1 scopes independent, reuses the account, and sends final assistant once", async () => {
		const { bridge, host, sent } = harness();
		await Promise.all([bridge.onInboundMessage(message("a")), bridge.onInboundMessage(message("b"))]);
		const [a, b] = await Promise.all(host.chat.mock.results.map((r) => r.value));
		expect(a.conversationId).toBe("c1");
		expect(b.conversationId).toBe("c1");
		expect(a.sessionId).not.toBe(b.sessionId);
		await bridge.handleRunEvent({ type: "message", ...a, message: assistant("tool preamble") });
		await bridge.handleRunEvent({
			type: "message",
			...a,
			message: { role: "assistant", content: [{ type: "text", text: "running" }, { type: "toolCall" }] },
		});
		await finish(bridge, b, "B");
		await finish(bridge, a, "A");
		await bridge.handleRunEvent({ type: "run_end", ...a });
		expect(sent).toEqual([
			{ channel: "b", text: "B" },
			{ channel: "a", text: "A" },
		]);
		const account = host.chat.mock.calls[0][0].accountId;
		await bridge.onInboundMessage(message("a", "follow up"));
		expect(host.chat.mock.calls[2][0]).toMatchObject({ accountId: account, conversationId: "c1" });
	});

	it("only creates web runs at no-rid run_start; refuses unknown rid and anonymous c1", async () => {
		const { bridge, host, sent } = harness();
		await bridge.onInboundMessage(message());
		const a = await host.chat.mock.results[0].value;
		await finish(bridge, a);
		sent.length = 0;
		await finish(bridge, { ...a, runId: "unknown" }, "leak");
		await finish(bridge, { conversationId: "c1" }, "anonymous");
		await finish(bridge, { sessionId: a.sessionId }, "no start");
		expect(sent).toEqual([]);
		const web = { sessionId: a.sessionId, clientId: "web-owner", conversationId: "c9" };
		await bridge.handleRunEvent({ type: "run_start", ...web });
		await bridge.handleRunEvent({ type: "run_start", ...web });
		await finish(bridge, { ...web, runId: "unknown" }, "wrong rid");
		await bridge.handleRunEvent({ type: "message", ...web, message: assistant("preamble") });
		await finish(bridge, web, "web final");
		await bridge.handleRunEvent({ type: "run_end", ...web });
		expect(sent).toEqual([{ channel: "a", text: "web final" }]);
	});

	it("persists thread destination and epoch across reload; reset revokes old session permanently", async () => {
		const first = harness();
		await first.bridge.onInboundMessage(message("thread-id"));
		const a = await first.host.chat.mock.results[0].value;
		await finish(first.bridge, a);
		const account = first.host.chat.mock.calls[0][0].accountId;
		await first.bridge.stop();
		const reloaded = harness(first.saved);
		await reloaded.bridge.restoreRoutes();
		await reloaded.bridge.handleRunEvent({ type: "run_start", sessionId: a.sessionId });
		await finish(reloaded.bridge, { sessionId: a.sessionId }, "restored");
		expect(reloaded.sent).toEqual([{ channel: "thread-id", text: "restored" }]);
		await reloaded.bridge.onInboundMessage(message("thread-id", "next"));
		expect(reloaded.host.chat.mock.calls[0][0].accountId).toBe(account);
		await reloaded.bridge.onInboundMessage(message("thread-id", "/reset"));
		const again = harness(first.saved);
		await again.bridge.restoreRoutes();
		await again.bridge.handleRunEvent({ type: "run_start", sessionId: a.sessionId });
		await finish(again.bridge, { sessionId: a.sessionId }, "stale");
		expect(again.sent).toEqual([]);
		await again.bridge.onInboundMessage(message("thread-id"));
		expect(again.host.chat.mock.calls[0][0].accountId).not.toBe(account);
	});

	it("persists empty routes on startup account mismatch so returning to the old account cannot revive them", async () => {
		const first = harness();
		await first.bridge.onInboundMessage(message());
		const original = await first.host.chat.mock.results[0].value;
		await finish(first.bridge, original);
		expect(first.saved.get("sessionRoutes").routes).toHaveLength(1);
		await first.bridge.stop();

		const other = harness(first.saved);
		other.changeAccount();
		await other.bridge.restoreRoutes();
		expect(other.host.chat).not.toHaveBeenCalled();
		expect(other.saved.get("sessionRoutes")).toEqual({
			account: other.bridge.accountFingerprint(),
			states: [],
			routes: [],
		});

		const again = harness(first.saved);
		await again.bridge.restoreRoutes();
		expect(again.saved.get("sessionRoutes")).toEqual({
			account: again.bridge.accountFingerprint(),
			states: [],
			routes: [],
		});
		await again.bridge.handleRunEvent({ type: "run_start", sessionId: original.sessionId });
		await finish(again.bridge, { sessionId: original.sessionId }, "stale account route");
		expect(again.sent).toEqual([]);
		expect(again.bridge.channelStates?.size || 0).toBe(0);
		expect(again.bridge.sessionRoutes?.size || 0).toBe(0);
	});

	it("does not guess abort target for web runs, and revokes routes on account changes", async () => {
		const h = harness();
		await h.bridge.onInboundMessage(message());
		const a = await h.host.chat.mock.results[0].value;
		await finish(h.bridge, a);
		await h.bridge.handleRunEvent({ type: "run_start", sessionId: a.sessionId });
		await h.bridge.onInboundMessage(message("a", "/stop"));
		expect(h.host.abortRun).not.toHaveBeenCalled();
		expect(h.sent.at(-1)?.text).toContain("no stable runId");
		h.changeAccount();
		await finish(h.bridge, { sessionId: a.sessionId }, "wrong account");
		expect(h.sent.some((s) => s.text === "wrong account")).toBe(false);
		await h.bridge.onInboundMessage(message());
		expect(h.host.chat.mock.calls[1][0].accountId).not.toBe(h.host.chat.mock.calls[0][0].accountId);
	});

	it("claims pre-receipt events exclusively by exact rid even with simultaneous c1 receipts", async () => {
		const h = harness();
		let resolveA: any, resolveB: any;
		h.host.chat
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveA = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveB = resolve;
					}),
			);
		const pa = h.bridge.onInboundMessage(message("a"));
		const pb = h.bridge.onInboundMessage(message("b"));
		await vi.waitFor(() => expect(h.host.chat).toHaveBeenCalledTimes(2));
		await finish(h.bridge, { runId: "a", conversationId: "c1" }, "A");
		await finish(h.bridge, { runId: "b", conversationId: "c1" }, "B");
		resolveB({ ok: true, conversationId: "c1", runId: "b", sessionId: "sb" });
		await pb;
		resolveA({ ok: true, conversationId: "c1", runId: "a", sessionId: "sa" });
		await pa;
		expect(h.sent).toEqual([
			{ channel: "b", text: "B" },
			{ channel: "a", text: "A" },
		]);
	});

	it("supports complete legacy ownership, never persists anonymous IDs, and reports delivery failures", async () => {
		const h = harness();
		h.host.chat.mockResolvedValueOnce({ ok: true, conversationId: "c1", clientId: "owner", runId: "legacy" } as any);
		await h.bridge.onInboundMessage(message());
		await finish(h.bridge, { runId: "legacy" });
		h.sent.length = 0;
		await h.bridge.handleRunEvent({ type: "run_start", conversationId: "c1" });
		await finish(h.bridge, { conversationId: "c1" });
		expect(h.sent).toEqual([]);
		const web = { clientId: "owner", conversationId: "c1" };
		await h.bridge.handleRunEvent({ type: "run_start", ...web });
		vi.mocked(fetch).mockRejectedValueOnce(new Error("delivery offline"));
		await expect(finish(h.bridge, web)).rejects.toThrow("delivery offline");
		expect(h.host.notify).toHaveBeenCalledWith("error", expect.stringContaining("delivery offline"));
		expect(h.saved.get("sessionRoutes").routes).toEqual([]);
	});

	it("does not bind a delayed old-account receipt after token rotation", async () => {
		const h = harness();
		let receipt: any;
		h.host.chat.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					receipt = resolve;
				}),
		);
		const pending = h.bridge.onInboundMessage(message());
		await vi.waitFor(() => expect(h.host.chat).toHaveBeenCalledOnce());
		h.changeAccount();
		receipt({ ok: true, conversationId: "c1", runId: "old-run", sessionId: "old-session" });
		await pending;
		expect(h.host.abortRun).toHaveBeenCalledWith("old-run");
		expect(h.bridge.sessionRoutes?.size || 0).toBe(0);
		await h.bridge.handleRunEvent({ type: "run_start", sessionId: "old-session" });
		await finish(h.bridge, { sessionId: "old-session" }, "stale");
		expect(h.sent).toEqual([]);
	});

	it.each(["owned", "web"])("revokes a delayed %s reply after stop removes run ownership", async (kind) => {
		const h = harness();
		await h.bridge.onInboundMessage(message());
		const owned = await h.host.chat.mock.results[0].value;
		let result = owned;
		if (kind === "web") {
			await finish(h.bridge, owned);
			h.sent.length = 0;
			result = { sessionId: owned.sessionId };
			await h.bridge.handleRunEvent({ type: "run_start", ...result });
		}
		const repliedBefore = h.bridge.status.messagesReplied;
		const reply = h.bridge.reply.bind(h.bridge);
		let canSend!: () => boolean;
		vi.spyOn(h.bridge, "reply").mockImplementation((route, text, guard) => {
			canSend = guard as () => boolean;
			return reply(route, text, guard);
		});
		let release!: () => void;
		const delayed = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchNow = fetch;
		vi.mocked(fetch).mockImplementationOnce(async (...args) => {
			await delayed;
			return fetchNow(...args);
		});
		const pending = finish(h.bridge, result, "x".repeat(4000));
		await vi.waitFor(() => expect(canSend).toBeTypeOf("function"));
		expect(canSend()).toBe(true);
		expect(h.bridge.ownedRuns.size).toBe(0);
		expect(h.bridge.webRuns.size).toBe(0);
		expect(h.bridge.dispatches.size).toBe(0);
		await h.bridge.stop();
		expect(canSend()).toBe(false);
		const staleCanSend = canSend;
		release();
		await pending;
		expect(h.sent).toHaveLength(1);
		expect(h.bridge.status.messagesReplied).toBe(repliedBefore);
		await h.bridge.onInboundMessage(message("b"));
		const next = await h.host.chat.mock.results[1].value;
		await finish(h.bridge, next, "new generation");
		expect(h.sent.at(-1)?.text).toBe("new generation");
		expect(canSend()).toBe(true);
		expect(staleCanSend()).toBe(false);
	});

	it("wires activation to host run events and restores routes without a real gateway", async () => {
		const first = harness();
		await first.bridge.onInboundMessage(message());
		const a = await first.host.chat.mock.results[0].value;
		await finish(first.bridge, a);
		await first.bridge.stop();
		first.saved.set("config", { botToken: "test-token", botEnabled: true });
		const h = harness(first.saved);
		vi.spyOn(DiscordBotBridge.prototype, "connectGateway").mockResolvedValue(undefined);
		const stop = await activate(h.host);
		expect(h.host.onRunEvent).toHaveBeenCalledOnce();
		await h.emit({ type: "run_start", sessionId: a.sessionId });
		await h.emit({ type: "message", sessionId: a.sessionId, message: assistant("wired") });
		await h.emit({ type: "run_end", sessionId: a.sessionId });
		await vi.waitFor(() => expect(h.sent).toEqual([{ channel: "a", text: "wired" }]));
		await stop();
	});
});
