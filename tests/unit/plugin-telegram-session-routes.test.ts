import { expect, it, vi } from "vitest";
import { TelegramBotBridge } from "../../plugins/telegram/index.mjs";

function setup(saved = new Map(), config = { botToken: "bot" }) {
	let seq = 0;
	const host = {
		cwd: process.cwd(),
		storage: {
			get: vi.fn(async (key: string) => structuredClone(saved.get(key))),
			set: vi.fn(async (key: string, value: any) => {
				saved.set(key, structuredClone(value));
			}),
		},
		chat: vi.fn(async (req: any) => ({ conversationId: "c1", sessionId: `s${req.accountId}`, runId: `r${++seq}` })),
		abortRun: vi.fn(async () => ({ ok: true })),
	};
	const bridge: any = new TelegramBotBridge({ host, getConfig: () => config, log: vi.fn() });
	bridge.send = vi.fn(async () => {});
	return { host, bridge, saved, config };
}
const msg = (id: number, text = "hello") => ({
	chat: { id, type: "private" },
	from: { id },
	message_thread_id: id + 10,
	text,
});
const event = (type: string, sessionId: string, rest = {}) => ({
	type,
	sessionId,
	clientId: "web",
	conversationId: "c1",
	...rest,
});
async function finish(bridge: any, sessionId: string, runId?: string) {
	await bridge.handleRunEvent(event("message", sessionId, { runId, message: { role: "assistant", content: "final" } }));
	await bridge.handleRunEvent(event("run_end", sessionId, { runId }));
}
it("isolates concurrent c1 receipts, forwards web runs once, rejects unknown IDs and clears the last candidate", async () => {
	const { bridge, host } = setup();
	// 两个账号并发进入同一个 conversationId（c1）。`host.chat` 的**调用顺序**取决于哪条
	// inbound 先跑完内部 await（storage.get / workspace 校验…），所以不能拿
	// `mock.results` 的下标当账号号——满载时会偶发拿到 [2,1] 而假红。
	// 这里按「这条 run 是给哪个 chat 回的」取（run.msg.chat.id），与调度顺序无关。
	await Promise.all([bridge.onInboundMessage(msg(1)), bridge.onInboundMessage(msg(2))]);
	const runForChat = (chatId: number) => {
		for (const [runId, run] of bridge.pendingRuns) {
			if (run.msg?.chat?.id === chatId) return { ...run, runId } as any;
		}
		return undefined;
	};
	const one = runForChat(1);
	const two = runForChat(2);
	expect({ one: !!one, two: !!two }).toEqual({ one: true, two: true });
	expect(bridge.pendingRuns.size).toBe(2);
	expect(host.chat).toHaveBeenCalledTimes(2);
	await finish(bridge, one!.sessionId, one!.runId);
	await finish(bridge, two!.sessionId, two!.runId);
	// 各自回到各自的 chat：两次 finish 的先后决定调用顺序，这里只锁「谁都回了、没串号」。
	expect(bridge.send.mock.calls.map(([m]: any[]) => m.chat.id).sort()).toEqual([1, 2]);
	bridge.send.mockClear();
	await bridge.handleRunEvent(event("run_start", one!.sessionId));
	await bridge.handleRunEvent(
		event("message", one!.sessionId, { message: { role: "assistant", content: "tool preamble" } }),
	);
	await bridge.handleRunEvent(event("run_end", one!.sessionId, { runId: "unknown" }));
	expect(bridge.send).not.toHaveBeenCalled();
	await bridge.handleRunEvent(event("message", one!.sessionId, { message: { role: "assistant", content: "final" } }));
	await bridge.handleRunEvent(
		event("message", one!.sessionId, {
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "tool preamble" },
					{ type: "toolCall", name: "read" },
				],
			},
		}),
	);
	await bridge.handleRunEvent(event("run_end", one!.sessionId));
	await finish(bridge, one!.sessionId);
	expect(bridge.send).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ chat: { id: 1 }, message_thread_id: 11 }),
		"final",
	);
	await bridge.handleRunEvent({ type: "run_start", conversationId: "c1" });
	expect(bridge.pendingRuns.size).toBe(0);
});

it("restores routes and conversation choices on reload, persists reset epochs and revokes account changes", async () => {
	const { bridge, saved, host, config } = setup();
	await bridge.onInboundMessage(msg(1));
	const receipt = await host.chat.mock.results[0].value;
	await finish(bridge, receipt.sessionId, receipt.runId);
	await bridge.stop();
	const reloaded = setup(saved, config);
	await reloaded.bridge.handleRunEvent(event("run_start", receipt.sessionId));
	await finish(reloaded.bridge, receipt.sessionId);
	expect(reloaded.bridge.send).toHaveBeenCalledTimes(1);
	await reloaded.bridge.onInboundMessage(msg(1, "/new"));
	await reloaded.bridge.sessionRouting.saving;
	const reset = setup(saved, config);
	await reset.bridge.handleRunEvent(event("run_start", receipt.sessionId));
	await finish(reset.bridge, receipt.sessionId);
	expect(reset.bridge.send).not.toHaveBeenCalled();
	await reset.bridge.onInboundMessage(msg(1));
	expect(reset.host.chat.mock.calls[0][0].conversationId).toBeUndefined();
	const fresh = await reset.host.chat.mock.results[0].value;
	await finish(reset.bridge, fresh.sessionId, fresh.runId);
	reset.bridge.send.mockClear();
	config.botToken = "different";
	await reset.bridge.handleRunEvent(event("run_start", fresh.sessionId));
	await finish(reset.bridge, fresh.sessionId);
	expect(reset.bridge.send).not.toHaveBeenCalled();
});
it("durably revokes old account routes even when the replacement account never chats", async () => {
	const initial = setup();
	await initial.bridge.onInboundMessage(msg(1));
	const receipt = await initial.host.chat.mock.results[0].value;
	await finish(initial.bridge, receipt.sessionId, receipt.runId);
	await initial.bridge.sessionRouting.saving;
	const changed = setup(initial.saved, { botToken: "other" });
	await changed.bridge.routesReady();
	const restored = setup(initial.saved);
	await restored.bridge.handleRunEvent(event("run_start", receipt.sessionId));
	await finish(restored.bridge, receipt.sessionId);
	expect(restored.bridge.send).not.toHaveBeenCalled();
});

it("detaches web delivery on stop without guessing a canonical abort target", async () => {
	const { bridge, host } = setup();
	await bridge.onInboundMessage(msg(1));
	const receipt = await host.chat.mock.results[0].value;
	await finish(bridge, receipt.sessionId, receipt.runId);
	await bridge.handleRunEvent(event("run_start", receipt.sessionId));
	await bridge.onInboundMessage(msg(1, "/stop"));
	expect(host.abortRun).not.toHaveBeenCalled();
	expect(bridge.send).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining("cannot precisely abort"));
});
