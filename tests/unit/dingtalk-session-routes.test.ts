import { afterEach, describe, expect, it, vi } from "vitest";
import { DingtalkBotBridge } from "../../plugins/dingtalk/bridge.mjs";

function fixture(legacy = false) {
	let callback: any;
	let config: any = { allowAllSenders: true, appKey: "app", robotCode: "robot" };
	const storage = new Map();
	const deliveries: any[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url, init) => {
			deliveries.push([url, JSON.parse(init.body)]);
			return new Response(JSON.stringify({ errcode: 0 }));
		}),
	);
	let seq = 0;
	const host = {
		storage: {
			get: vi.fn(async (key) => structuredClone(storage.get(key))),
			set: vi.fn(async (key, value) => {
				storage.set(key, structuredClone(value));
			}),
		},
		chat: vi.fn(async (_request: any) => {
			const n = ++seq;
			return {
				conversationId: "c1",
				runId: `r${n}`,
				clientId: `owner${n}`,
				...(!legacy ? { sessionId: `s${n}` } : {}),
			};
		}),
		abortRun: vi.fn(async () => ({ ok: true })),
		onRunEvent: vi.fn((cb) => {
			callback = cb;
			return () => {
				callback = undefined;
			};
		}),
	};
	const create = () => new DingtalkBotBridge({ host, getConfig: () => config });
	const inbound = (bridge: any, room = "a", text = "hello") =>
		bridge.onInboundMessage({
			senderStaffId: "peer",
			conversationId: room,
			threadId: "thread",
			sessionWebhook: `https://reply/${room}`,
			text: { content: text },
		});
	return {
		host,
		create,
		inbound,
		deliveries,
		emit: async (ev: any) => callback(ev),
		changeAccount: (appKey = "other") => {
			config = { ...config, appKey };
		},
	};
}
const message = (identity: Record<string, string | undefined>, text: string) => ({
	...identity,
	type: "message",
	message: { role: "assistant", content: text },
});
afterEach(() => vi.unstubAllGlobals());

describe("DingTalk persistent session event wiring", () => {
	it("clears tool preambles when the last assistant contains only a tool call", async () => {
		const f = fixture();
		const b = f.create();
		await b.start();
		await f.inbound(b);
		await f.emit(message({ runId: "r1" }, "preamble"));
		await f.emit({
			type: "message",
			runId: "r1",
			message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
		});
		await f.emit({ type: "run_end", runId: "r1" });
		expect(f.deliveries.at(-1)[1].markdown.text).toBe("任务已完成（无文本输出）。");
		await b.stop();
	});
	it("persists startup account revocation before any inbound message", async () => {
		const f = fixture();
		let b = f.create();
		await b.start();
		await f.inbound(b);
		await f.emit({ type: "run_end", runId: "r1" });
		await b.stop();
		f.changeAccount();
		b = f.create();
		await b.start();
		await b.stop();
		f.changeAccount("app");
		b = f.create();
		await b.start();
		const before = f.deliveries.length;
		await f.emit({ type: "run_start", sessionId: "s1" });
		await f.emit(message({ sessionId: "s1" }, "revoked account"));
		await f.emit({ type: "run_end", sessionId: "s1" });
		expect(f.deliveries).toHaveLength(before);
		expect(b.sessions.size).toBe(0);
		await b.stop();
	});
	it("isolates two c1 scopes and returns web continuations to their original destinations once", async () => {
		const f = fixture();
		const b = f.create();
		await b.start();
		await f.inbound(b, "a");
		await f.inbound(b, "b");
		await f.emit(message({ runId: "r1" }, "tool preamble"));
		await f.emit(message({ runId: "r1" }, "final a"));
		await f.emit({ type: "run_end", runId: "r1" });
		await f.emit({ type: "run_end", runId: "r1" });
		await f.emit(message({ runId: "r2" }, "final b"));
		await f.emit({ type: "run_end", runId: "r2" });
		expect(f.deliveries.map(([url, body]) => [url, body.markdown.text])).toEqual([
			["https://reply/a", "final a"],
			["https://reply/b", "final b"],
		]);
		const web = { sessionId: "s1", clientId: "browser", conversationId: "c9" };
		await f.emit({ ...web, type: "run_start" });
		await f.emit(message({ ...web, runId: "unknown" }, "wrong"));
		await f.emit({ ...web, type: "run_end", runId: "unknown" });
		await f.emit(message(web, "web final"));
		await Promise.all([f.emit({ ...web, type: "run_end" }), f.emit({ ...web, type: "run_end" })]);
		expect(f.deliveries).toHaveLength(3);
		expect(f.deliveries[2][0]).toBe("https://reply/a");
		expect(f.deliveries[2][1].markdown.text).toBe("web final");
		await b.stop();
	});
	it("persists epochs through reload and revokes reset and changed accounts", async () => {
		const f = fixture();
		let b = f.create();
		await b.start();
		await f.inbound(b);
		await f.emit({ type: "run_end", runId: "r1" });
		const account = f.host.chat.mock.calls[0][0].accountId;
		await b.stop();
		await b.start();
		expect([...b.sessions.values()][0].accountId).toBe(account);
		await b.stop();
		b = f.create();
		await b.start();
		const web = { sessionId: "s1" };
		await f.emit({ ...web, type: "run_start" });
		await f.inbound(b, "a", "/stop");
		expect(f.host.abortRun).not.toHaveBeenCalled();
		await f.emit(message(web, "restored"));
		await f.emit({ ...web, type: "run_end" });
		expect(f.deliveries.at(-1)[1].markdown.text).toBe("restored");
		await f.inbound(b, "a", "/reset");
		await b.stop();
		b = f.create();
		await b.start();
		let before = f.deliveries.length;
		await f.emit({ ...web, type: "run_start" });
		await f.emit(message(web, "stale"));
		await f.emit({ ...web, type: "run_end" });
		expect(f.deliveries).toHaveLength(before);
		await f.inbound(b);
		expect(f.host.chat.mock.calls[1][0].accountId).not.toBe(account);
		await f.emit({ type: "run_end", runId: "r2" });
		f.changeAccount();
		before = f.deliveries.length;
		await f.emit({ type: "run_start", sessionId: "s2" });
		await f.emit(message({ sessionId: "s2" }, "old account"));
		await f.emit({ type: "run_end", sessionId: "s2" });
		expect(f.deliveries).toHaveLength(before);
		await b.stop();
	});
	it("requires exact legacy owner and never claims anonymous c1", async () => {
		const f = fixture(true);
		const b = f.create();
		await b.start();
		await f.inbound(b, "a");
		await f.inbound(b, "b");
		for (const runId of ["r1", "r2"]) await f.emit({ type: "run_end", runId });
		const before = f.deliveries.length;
		for (const identity of [
			{ conversationId: "c1" },
			{ clientId: "unknown", conversationId: "c1" },
			{ sessionId: "unknown", clientId: "owner1", conversationId: "c1" },
		]) {
			await f.emit({ ...identity, type: "run_start" });
			await f.emit(message(identity, "wrong"));
			await f.emit({ ...identity, type: "run_end" });
		}
		expect(f.deliveries).toHaveLength(before);
		const owner = { clientId: "owner2", conversationId: "c1" };
		await f.emit({ ...owner, type: "run_start" });
		await f.emit(message(owner, "legacy"));
		await f.emit({ ...owner, type: "run_end" });
		expect(f.deliveries.at(-1)[0]).toBe("https://reply/b");
		await b.stop();
	});
});
