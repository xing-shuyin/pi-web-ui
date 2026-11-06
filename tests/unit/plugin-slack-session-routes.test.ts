import { afterEach, describe, expect, it, vi } from "vitest";
import activate from "../../plugins/slack/index.mjs";

async function harness(saved = new Map<string, any>()) {
	let listener: any;
	let client: any;
	const sent: any[] = [];
	const calls: any[] = [];
	const abortRun = vi.fn(async () => ({ ok: true }));
	const cfg = { botEnabled: true, botToken: "bot", appToken: "app" };
	if (!saved.has("config")) saved.set("config", cfg);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, options: any) => {
			const payload = JSON.parse(options.body || "{}");
			if (url.endsWith("chat.postMessage")) sent.push(payload);
			return { ok: true, json: async () => ({ ok: true, user_id: "BOT", user: "bot", url: "wss://example.invalid" }) };
		}),
	);
	vi.stubGlobal(
		"WebSocket",
		class {
			readyState = 1;
			close() {}
			send() {}
		},
	);
	const host: any = {
		cwd: "E:/workspace",
		storage: {
			get: async (key: string) => structuredClone(saved.get(key)),
			set: async (key: string, value: any) => {
				saved.set(key, structuredClone(value));
			},
		},
		onRunEvent: (fn: any) => {
			listener = fn;
			return () => {};
		},
		onClientMessage: (fn: any) => {
			client = fn;
		},
		registerTool() {},
		log() {},
		notify: vi.fn(),
		abortRun,
		chat: vi.fn(async (request: any) => {
			calls.push(request);
			return {
				ok: true,
				conversationId: "c1",
				clientId: request.accountId,
				sessionId: request.accountId,
				runId: `r${calls.length}`,
			};
		}),
	};
	const stop = await activate(host);
	for (let i = 0; i < 15 && !listener; i++) await Promise.resolve();
	const inbound = async (user: string, text: string, thread = "thread") => {
		await activeBridge.onInboundEvent({
			user,
			channel: `channel-${user}`,
			channel_type: "im",
			text,
			thread_ts: thread,
			ts: "123",
		});
	};
	const activeBridge = capturedBridge;
	return {
		host,
		sent,
		calls,
		saved,
		stop,
		inbound,
		event: (ev: any) => listener(ev),
		client: (msg: any) => client(msg, () => {}),
		abortRun,
	};
}

let capturedBridge: any;
import { SlackBotBridge } from "../../plugins/slack/index.mjs";
const originalConnect = SlackBotBridge.prototype.connectSocketMode;
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function setup(saved?: Map<string, any>) {
	vi.spyOn(SlackBotBridge.prototype, "connectSocketMode").mockImplementation(async function (this: any) {
		capturedBridge = this;
		await originalConnect.call(this);
	});
	return harness(saved);
}
const message = (text: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

describe("Slack session route wiring", () => {
	it.each([false, true])("invalidates a delayed final reply after stop (web=%s)", async (web) => {
		const h = await setup();
		await h.inbound("A", "hello");
		const bridge = capturedBridge;
		const identity = web ? { sessionId: h.calls[0].accountId } : { runId: "r1" };
		if (web) {
			await h.event({ type: "run_end", runId: "r1" });
			await h.event({ type: "run_start", ...identity });
		}
		await h.event({ ...message("delayed final"), ...identity });
		let release!: () => void;
		let guard!: () => boolean;
		vi.spyOn(bridge, "reply").mockImplementation(async (_route: any, _text: any, isCurrent: any) => {
			guard = isCurrent;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		const ending = h.event({ type: "run_end", ...identity });
		await vi.waitFor(() => expect(guard).toBeTypeOf("function"));
		expect(guard()).toBe(true);
		expect(bridge.ownedRuns.size).toBe(0);
		expect(bridge.webRuns?.size || 0).toBe(0);
		await h.stop();
		expect(guard()).toBe(false);
		release();
		await ending;
	});

	it("stops remaining chunks after a send already in flight", async () => {
		const h = await setup();
		await h.inbound("A", "hello");
		await h.event({ ...message("long output ".repeat(1000)), runId: "r1" });
		let release!: () => void;
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { ok: true, json: async () => ({ ok: true }) } as Response;
		});
		const before = fetchMock.mock.calls.length;
		const ending = h.event({ type: "run_end", runId: "r1" });
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		await h.stop();
		release();
		await ending;
		expect(fetchMock.mock.calls.length - before).toBe(1);
	});

	it("discards a receipt after stop and preserves routes and epochs for reload", async () => {
		const h = await setup();
		await h.inbound("A", "bound");
		await h.event({ type: "run_end", runId: "r1" });
		const saved = structuredClone(h.saved.get("sessionRoutes"));
		const bridge = capturedBridge;
		let receipt!: (value: any) => void;
		h.host.chat.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					receipt = resolve;
				}),
		);
		const pending = h.inbound("A", "pending");
		await vi.waitFor(() => expect(receipt).toBeTypeOf("function"));
		const state = [...bridge.channelStates.values()][0] as any;
		expect(state.busy).toBe(true);
		await h.stop();
		expect(state.busy).toBe(false);
		expect(bridge.dispatches.size).toBe(0);
		receipt({ ok: true, conversationId: "late", sessionId: "stale", runId: "stale-run" });
		await pending;
		expect(bridge.ownedRuns.size).toBe(0);
		expect(state.conversationId).toBe("c1");
		expect(h.saved.get("sessionRoutes")).toEqual(saved);
		const next = await harness(h.saved);
		await next.event({ type: "run_start", sessionId: "stale" });
		await next.event({ type: "run_end", sessionId: "stale" });
		expect(next.sent).toHaveLength(0);
		await next.event({ type: "run_start", sessionId: h.calls[0].accountId });
		await next.event({ ...message("restored"), sessionId: h.calls[0].accountId });
		await next.event({ type: "run_end", sessionId: h.calls[0].accountId });
		expect(next.sent.map((x) => x.text)).toEqual(["restored"]);
		await next.stop();
	});

	it("persists startup account revocation even without a new chat", async () => {
		const h = await setup();
		await h.inbound("A", "bound");
		await h.stop();
		const originalConfig = structuredClone(h.saved.get("config"));
		const originalAccount = h.saved.get("sessionRoutes").account;
		h.saved.set("config", { ...originalConfig, botToken: "other" });
		const other = await harness(h.saved);
		expect(other.calls).toHaveLength(0);
		expect(other.saved.get("sessionRoutes")).toMatchObject({ states: [], routes: [] });
		expect(other.saved.get("sessionRoutes").account).not.toBe(originalAccount);
		await other.stop();
		h.saved.set("config", originalConfig);
		const restored = await harness(h.saved);
		await restored.event({ type: "run_start", sessionId: h.calls[0].accountId });
		await restored.event({ type: "run_end", sessionId: h.calls[0].accountId });
		expect(restored.sent).toHaveLength(0);
		expect(restored.saved.get("sessionRoutes").routes).toEqual([]);
		await restored.stop();
	});
	it("requires complete legacy ownership and refuses a late receipt after account replacement", async () => {
		const h = await setup();
		h.host.chat.mockResolvedValueOnce({
			ok: true,
			conversationId: "c1",
			clientId: "legacy-owner",
			runId: "legacy-run",
		});
		await h.inbound("A", "legacy");
		await h.event({ type: "run_end", runId: "legacy-run" });
		h.sent.length = 0;
		await h.event({ type: "run_start", conversationId: "c1" });
		await h.event({ type: "run_end", conversationId: "c1" });
		expect(h.sent).toHaveLength(0);
		const legacy = { clientId: "legacy-owner", conversationId: "c1" };
		await h.event({ type: "run_start", ...legacy });
		await h.event({ ...message("legacy web"), ...legacy });
		await h.event({ type: "run_end", ...legacy });
		expect(h.sent[0].text).toBe("legacy web");
		let receipt: any;
		h.host.chat.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					receipt = resolve;
				}),
		);
		const pending = h.inbound("A", "pending");
		for (let i = 0; i < 10 && !receipt; i++) await Promise.resolve();
		await h.client({ type: "save_config", config: { botToken: "replacement" } });
		receipt({ ok: true, conversationId: "c1", sessionId: "stale", runId: "stale-run" });
		await pending;
		h.sent.length = 0;
		await h.event({ type: "run_start", sessionId: "stale" });
		await h.event({ type: "run_end", sessionId: "stale" });
		expect(h.sent).toHaveLength(0);
		expect(h.saved.get("sessionRoutes").routes).toEqual([]);
		await h.stop();
	});
	it("keeps concurrent scopes with canonical c1 separate and continues each same scope", async () => {
		const h = await setup();
		await Promise.all([h.inbound("A", "one"), h.inbound("B", "two")]);
		expect(h.calls[0].conversationId).not.toBe(h.calls[1].conversationId);
		await h.event({ ...message("A final"), runId: "r1" });
		await h.event({ ...message("B final"), runId: "r2" });
		await h.event({ type: "run_end", runId: "r2" });
		await h.event({ type: "run_end", runId: "r1" });
		expect(h.sent.map((x) => [x.channel, x.text])).toEqual([
			["channel-B", "B final"],
			["channel-A", "A final"],
		]);
		await h.inbound("A", "again");
		expect(h.calls[2].accountId).toBe(h.calls[0].accountId);
		expect(h.calls[2].conversationId).toBe("c1");
		await h.stop();
	});

	it("routes web runs only after run_start, ignores unknown IDs and duplicate ends, keeps the final candidate", async () => {
		const h = await setup();
		await h.inbound("A", "hello");
		await h.event({ type: "run_end", runId: "r1" });
		h.sent.length = 0;
		const sessionId = h.calls[0].accountId;
		await h.event({ type: "run_start", sessionId, runId: "unknown" });
		await h.event({ ...message("wrong"), sessionId, runId: "unknown" });
		await h.event({ type: "run_end", sessionId, runId: "unknown" });
		await h.event({ type: "run_start", conversationId: "c1" });
		await h.event({ type: "run_end", conversationId: "c1" });
		expect(h.sent).toHaveLength(0);
		await h.event({ type: "run_start", sessionId });
		await h.inbound("A", "/stop");
		expect(h.abortRun).not.toHaveBeenCalled();
		h.sent.length = 0;
		await h.event({ ...message("preamble"), sessionId });
		await h.event({ ...message("final"), sessionId });
		await h.event({ type: "run_end", sessionId });
		await h.event({ type: "run_end", sessionId });
		expect(h.sent.map((x) => x.text)).toEqual(["final"]);
		expect(h.sent[0].thread_ts).toBe("thread");
		await h.stop();
	});

	it("restores routes on reload, persists resets and revokes account changes", async () => {
		const h = await setup();
		await h.inbound("A", "hello");
		await h.event({ type: "run_end", runId: "r1" });
		const sessionId = h.calls[0].accountId;
		await h.stop();
		const next = await harness(h.saved);
		await next.event({ type: "run_start", sessionId });
		await next.event({ ...message("web after reload"), sessionId });
		await next.event({ type: "run_end", sessionId });
		expect(next.sent[0].text).toBe("web after reload");
		await next.inbound("A", "/reset");
		await next.stop();
		const reset = await harness(next.saved);
		await reset.event({ type: "run_start", sessionId });
		await reset.event({ type: "run_end", sessionId });
		expect(reset.sent).toHaveLength(0);
		await reset.inbound("A", "new epoch");
		expect(reset.calls[0].accountId).not.toBe(sessionId);
		await reset.event({ type: "run_end", runId: "r1" });
		const current = reset.calls[0].accountId;
		await reset.client({ type: "save_config", config: { botToken: "other" } });
		reset.sent.length = 0;
		await reset.event({ type: "run_start", sessionId: current });
		await reset.event({ type: "run_end", sessionId: current });
		expect(reset.sent).toHaveLength(0);
		await reset.stop();
	});
});
