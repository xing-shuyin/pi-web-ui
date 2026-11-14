import { afterEach, describe, expect, it, vi } from "vitest";
import { WecomBotBridge } from "../../plugins/wecom/index.mjs";

afterEach(() => vi.unstubAllGlobals());
function setup() {
	const disk = new Map();
	const secrets = new Map();
	let config = { allowAllSenders: true, corpId: "corp", webhookKey: "default" };
	let handler: any;
	let sequence = 0;
	const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
	vi.stubGlobal("fetch", fetch);
	const host = {
		storage: {
			get: async (key: string) => disk.get(key),
			set: async (key: string, value: any) => {
				disk.set(key, structuredClone(value));
			},
		},
		secrets: {
			get: async (key: string) => secrets.get(key),
			set: async (key: string, value: string) => {
				secrets.set(key, value);
			},
		},
		onRunEvent: (fn: any) => {
			handler = fn;
			return () => {
				handler = null;
			};
		},
		chat: vi.fn(async (_req: any) => ({
			conversationId: "c1",
			clientId: `owner-${++sequence}`,
			sessionId: `s${sequence}`,
			runId: `r${sequence}`,
		})),
		abortRun: vi.fn().mockResolvedValue({ ok: true }),
	};
	const create = () => new WecomBotBridge({ host, getConfig: () => config, log: () => {} });
	const send = (bridge: any, content: string, room = "a") =>
		bridge.onInboundMessage({
			fromUserName: "peer",
			chatId: room,
			channelId: "channel",
			threadId: "thread",
			webhookKey: `key-${room}`,
			content,
		});
	const emit = (event: any) => handler(event);
	const answer = async (identity: any, text = "final") => {
		await emit({ ...identity, type: "message", message: { role: "assistant", content: text } });
		await emit({ ...identity, type: "run_end" });
	};
	return {
		host,
		create,
		send,
		emit,
		answer,
		fetch,
		disk,
		changeAccount: () => {
			config = { ...config, corpId: "other" };
		},
	};
}

describe("WeCom persistent scope event wiring", () => {
	it("isolates two c1 receipts and web continuations; ignores unknown runs and duplicate ends", async () => {
		const { create, send, emit, answer, fetch } = setup();
		const bridge = create();
		await bridge.start();
		await send(bridge, "first");
		await send(bridge, "second", "b");
		await answer({ runId: "r2", sessionId: "s2", conversationId: "c1" }, "second answer");
		await answer({ runId: "r1", sessionId: "s1", conversationId: "c1" }, "first answer");
		expect(fetch.mock.calls.map((call) => call[0])).toEqual([
			expect.stringContaining("key-b"),
			expect.stringContaining("key-a"),
		]);
		fetch.mockClear();
		await emit({ type: "run_start", sessionId: "s1", clientId: "web", conversationId: "c1" });
		await emit({ type: "run_start", sessionId: "s1", clientId: "web", conversationId: "c1" });
		await answer({ runId: "unknown", sessionId: "s1" }, "forged");
		await emit({
			type: "message",
			sessionId: "s1",
			message: { role: "assistant", content: "tool preface", stopReason: "toolUse" },
		});
		await emit({ type: "message", sessionId: "s1", message: { role: "assistant", content: "earlier candidate" } });
		await answer({ sessionId: "s1", clientId: "web", conversationId: "c1" }, "web final");
		await emit({ type: "run_end", sessionId: "s1" });
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][0]).toContain("key-a");
		expect(fetch.mock.calls[0][1].body).toContain("web final");
		expect(fetch.mock.calls[0][1].body).not.toMatch(/forged|preface|earlier/);
		await bridge.stop();
	});
	it("restores session and original destination, persists reset epoch, and refuses unsafe web abort", async () => {
		const { create, send, emit, answer, fetch, host, disk } = setup();
		let bridge = create();
		await bridge.start();
		await send(bridge, "first");
		const original = host.chat.mock.calls[0][0] as any;
		await answer({ runId: "r1", sessionId: "s1" });
		await bridge.stop();
		expect(JSON.stringify(disk.get("sessionRoutes"))).not.toContain("key-a");
		bridge = create();
		await bridge.start();
		fetch.mockClear();
		await emit({ type: "run_start", sessionId: "s1", conversationId: "c1", clientId: "web" });
		await send(bridge, "/stop");
		expect(host.abortRun).not.toHaveBeenCalled();
		expect(fetch.mock.calls[0][1].body).toContain("精确 runId");
		await answer({ sessionId: "s1" }, "after reload");
		expect(fetch.mock.calls[1][0]).toContain("key-a");
		await send(bridge, "/reset");
		await bridge.stop();
		bridge = create();
		await bridge.start();
		fetch.mockClear();
		await emit({ type: "run_start", sessionId: "s1" });
		await answer({ sessionId: "s1" }, "revived");
		expect(fetch).not.toHaveBeenCalled();
		await send(bridge, "fresh");
		expect((host.chat.mock.calls[1][0] as any).accountId).not.toBe(original.accountId);
		await bridge.stop();
	});
	it("requires full legacy owner identity and never claims anonymous c1", async () => {
		const { create, host, send, emit, answer, fetch } = setup();
		host.chat.mockResolvedValueOnce({ conversationId: "c1", clientId: "legacy" } as any);
		const bridge = create();
		await bridge.start();
		await send(bridge, "first");
		await answer({ conversationId: "c1" }, "anonymous");
		expect(fetch).not.toHaveBeenCalled();
		await answer({ conversationId: "c1", clientId: "legacy" });
		await emit({ type: "run_start", conversationId: "c1", clientId: "other" });
		await answer({ conversationId: "c1", clientId: "other" });
		expect(fetch).toHaveBeenCalledTimes(1);
		await emit({ type: "run_start", conversationId: "c1", clientId: "legacy" });
		await answer({ conversationId: "c1", clientId: "legacy" });
		expect(fetch).toHaveBeenCalledTimes(2);
		await bridge.stop();
	});
	it("revokes old account routes even after switching back and reports platform errors", async () => {
		const { create, send, emit, answer, fetch, changeAccount } = setup();
		const bridge = create();
		await bridge.start();
		await send(bridge, "first");
		await answer({ runId: "r1", sessionId: "s1" });
		changeAccount();
		fetch.mockClear();
		await emit({ type: "run_start", sessionId: "s1" });
		await answer({ sessionId: "s1" });
		expect(fetch).not.toHaveBeenCalled();
		await send(bridge, "new account");
		fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ errcode: 45009, errmsg: "rate limited" }) });
		await answer({ runId: "r2", sessionId: "s2" });
		expect(bridge.getStatus().lastError).toContain("rate limited");
		expect(bridge.getStatus().messagesReplied).toBe(1);
		await bridge.stop();
	});
});
