import { afterEach, describe, expect, it, vi } from "vitest";
import { WecomBotBridge } from "../../plugins/wecom/index.mjs";

afterEach(() => vi.unstubAllGlobals());
function setup(chat?: any) {
	const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
	vi.stubGlobal("fetch", fetch);
	const host = {
		chat: chat || vi.fn().mockResolvedValue({ conversationId: "real", runId: "run" }),
		abortRun: vi.fn().mockResolvedValue({ ok: true }),
	};
	const bridge = new WecomBotBridge({
		host,
		getConfig: () => ({ allowAllSenders: true, webhookKey: "key" }),
		log: () => {},
	});
	const send = (content: string, extra: any = {}) => bridge.onInboundMessage({ fromUserName: "u", content, ...extra });
	return { host, bridge, fetch, send };
}
describe("WeCom scoped runtime", () => {
	it("does not claim a working inbound connection without callback transport", async () => {
		const { bridge } = setup();
		await bridge.start();
		expect(bridge.getStatus()).toMatchObject({ enabled: true, connected: false, state: "waiting_callback" });
		await bridge.stop();
	});
	it("replays early completion by runId and preserves the actual renamed conversation", async () => {
		const { bridge, host, send, fetch } = setup();
		host.chat.mockImplementation(async () => {
			await bridge.handleRunEvent({
				type: "message",
				conversationId: "moved",
				runId: "run",
				message: { role: "assistant", content: "early answer" },
			});
			await bridge.handleRunEvent({ type: "run_end", conversationId: "moved", runId: "run" });
			return { conversationId: "real", runId: "run" };
		});
		await send("hello");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][1].body).toContain("early answer");
		expect(bridge.pendingRuns.size).toBe(0);
		host.chat.mockResolvedValue({ conversationId: "moved", runId: "next" });
		await send("followup");
		expect(host.chat.mock.calls[1][0].conversationId).toBe("moved");
	});
	it("isolates same user across groups and threads, including deduplication", async () => {
		const { send, host } = setup(
			vi.fn().mockImplementation(async (req: any) => ({ conversationId: req.accountId, runId: req.accountId })),
		);
		for (const extra of [
			{ chatId: "g1", threadId: "t1" },
			{ chatId: "g2", threadId: "t1" },
			{ chatId: "g1", threadId: "t2" },
		])
			await send("hi", { ...extra, msgId: "same" });
		expect(host.chat).toHaveBeenCalledTimes(3);
		expect(new Set(host.chat.mock.calls.map((c: any) => c[0].accountId)).size).toBe(3);
	});
	it("stops the owning run after rename and resets while busy", async () => {
		const { bridge, send, host, fetch } = setup();
		await send("hello");
		await bridge.handleRunEvent({
			type: "message",
			runId: "run",
			conversationId: "renamed",
			message: { role: "assistant", content: "answer" },
		});
		await send("/abort");
		expect(host.abortRun).toHaveBeenCalledWith("run");
		await send("/new");
		expect(fetch.mock.calls.at(-1)![1].body).toContain("全新会话");
		await bridge.handleRunEvent({ type: "run_end", runId: "run", conversationId: "renamed" });
		expect(bridge.pendingRuns.size).toBe(0);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it("applies scoped model/thinking/cwd on next chat; new drops actual conversation", async () => {
		const { send, host, bridge } = setup();
		await send("/model p/m");
		await send("/thinking high");
		await send("/cwd C:/project with spaces");
		await send("hi");
		expect(host.chat.mock.calls[0][0]).toMatchObject({
			model: "p/m",
			thinkingLevel: "high",
			cwd: "C:/project with spaces",
		});
		await bridge.handleRunEvent({ type: "run_end", runId: "run", conversationId: "real" });
		await send("/new");
		await send("next");
		expect(host.chat.mock.calls[1][0]).not.toHaveProperty("conversationId");
		expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
		await bridge.handleRunEvent({ type: "run_end", runId: "run", conversationId: "real" });
		await send("/cwd C:/second");
		await send("third");
		expect(host.chat.mock.calls[2][0].accountId).not.toBe(host.chat.mock.calls[1][0].accountId);
		expect(host.chat.mock.calls[2][0]).toMatchObject({ cwd: "C:/second" });
	});
	it.each(["image", "voice", "video", "file"])(
		"explicitly reports unsupported %s instead of hallucinating media",
		async (type) => {
			const { send, host, fetch } = setup();
			await send("", { msgType: type });
			expect(host.chat).not.toHaveBeenCalled();
			expect(fetch.mock.calls[0][1].body).toContain("无法下载或解码");
			if (type === "voice") expect(fetch.mock.calls[0][1].body).toContain("未配置 ASR");
		},
	);
	it("uses only platform-provided voice recognition", async () => {
		const { send, host } = setup();
		await send("", { msgType: "voice", Recognition: "识别内容" });
		expect(host.chat.mock.calls[0][0].text).toContain("[平台提供的语音识别文本]");
	});
});
