import { afterEach, describe, expect, it, vi } from "vitest";
import { QqBotBridge } from "../../plugins/qq/index.mjs";
import { speechReplyText } from "../../plugins/qq/voice.mjs";

function fixture(mode = "voice") {
	const config = {
		appId: "app",
		clientSecret: "secret",
		replyMode: mode,
		voiceEngine: "doubao-tts",
		voiceSpeaker: "taozi",
		voiceRate: 1.2,
	};
	const bridge = new QqBotBridge({ host: {}, getConfig: () => config, log: vi.fn() });
	bridge.renderVoice = vi.fn(async () => ({ buffer: Buffer.from("silk"), fileName: "reply.silk", kind: "voice" }));
	bridge.replyMessage = vi.fn(async () => {});
	const fetcher = vi.fn(async (url: any) => ({
		ok: true,
		json: async () =>
			String(url).includes("getAppAccessToken")
				? { access_token: "token", expires_in: 7200 }
				: String(url).endsWith("/files")
					? { file_info: "uploaded-voice" }
					: { id: "sent" },
	}));
	vi.stubGlobal("fetch", fetcher);
	return { bridge, config, fetcher };
}

afterEach(() => vi.unstubAllGlobals());

describe("QQ automatic voice replies", () => {
	it.each([
		{ userOpenid: "user", msgId: "incoming" },
		{ groupOpenid: "group", msgId: "incoming" },
	])("uploads and sends a voice reply to the original target %j", async (target) => {
		const { bridge, fetcher } = fixture();
		expect(await bridge.deliverReply(target, "你好", () => true)).toBe(true);
		expect(bridge.renderVoice).toHaveBeenCalledWith(
			"你好",
			expect.objectContaining({ voiceEngine: "doubao-tts", voiceSpeaker: "taozi", voiceRate: 1.2 }),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		const upload = JSON.parse((fetcher.mock.calls[1] as any)[1].body);
		expect(upload).toMatchObject({ file_type: 3, srv_send_msg: false, file_name: "reply.silk" });
		const send = JSON.parse((fetcher.mock.calls[2] as any)[1].body);
		expect(send).toMatchObject({ msg_type: 7, msg_id: "incoming", msg_seq: 1, media: { file_info: "uploaded-voice" } });
		expect(bridge.replyMessage).not.toHaveBeenCalled();
	});
	it("supports voice plus full text and preserves text for long replies", async () => {
		const { bridge, config } = fixture("both");
		const target = { userOpenid: "u" };
		await bridge.deliverReply(target, "**你好**", () => true);
		expect(bridge.replyMessage).toHaveBeenCalledWith(target, "**你好**", 2);
		config.replyMode = "voice";
		const long = "完整回答。".repeat(100);
		await bridge.deliverReply(target, long, () => true);
		expect(bridge.replyMessage).toHaveBeenLastCalledWith(target, long, 4);
		expect(vi.mocked(bridge.renderVoice).mock.calls.at(-1)![0]).toContain("更多内容请查看文字回复");
	});
	it.each(["text", "voice"])("keeps guild replies as text (mode=%s)", async (mode) => {
		const { bridge } = fixture(mode);
		const target = { channelId: "channel" };
		await bridge.deliverReply(target, "hello", () => true);
		expect(bridge.renderVoice).not.toHaveBeenCalled();
		expect(bridge.replyMessage).toHaveBeenCalledWith(target, "hello", 1);
	});
	it("falls back to text after synthesis or QQ upload failure", async () => {
		const { bridge, fetcher } = fixture();
		vi.mocked(bridge.renderVoice).mockRejectedValueOnce(new Error("no credentials"));
		const target = { userOpenid: "u" };
		await bridge.deliverReply(target, "first", () => true);
		expect(bridge.replyMessage).toHaveBeenCalledWith(target, "first", 1);
		fetcher.mockRejectedValueOnce(new Error("QQ upload unavailable"));
		await bridge.deliverReply(target, "second", () => true);
		expect(bridge.replyMessage).toHaveBeenLastCalledWith(target, "second", 3);
		expect(bridge.status.lastVoiceError).toContain("QQ upload unavailable");
	});
	it("drops synthesized audio after a session reset", async () => {
		const { bridge, fetcher } = fixture();
		let resolve!: (value: any) => void;
		vi.mocked(bridge.renderVoice).mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const guard = bridge.createDeliveryGuard("peer");
		const delivery = bridge.deliverReply({ userOpenid: "u" }, "stale", guard);
		bridge.peerSessionSeq.set("peer", 1);
		resolve({ buffer: Buffer.from("silk"), kind: "voice" });
		expect(await delivery).toBe(false);
		expect(fetcher).not.toHaveBeenCalled();
		expect(bridge.replyMessage).not.toHaveBeenCalled();
	});
	it("does not send uploaded audio after the bridge stops", async () => {
		const { bridge, fetcher } = fixture();
		let finishUpload!: (value: any) => void;
		fetcher.mockImplementationOnce(async () => ({
			ok: true,
			json: async () => ({ access_token: "token", expires_in: 3600 }),
		}));
		fetcher.mockImplementationOnce(
			() =>
				new Promise((done) => {
					finishUpload = done;
				}),
		);
		const pending = bridge.deliverReply({ userOpenid: "u" }, "late", bridge.createDeliveryGuard("u"));
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
		await bridge.stop();
		finishUpload({ ok: true, json: async () => ({ file_info: "late" }) });
		expect(await pending).toBe(false);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(bridge.replyMessage).not.toHaveBeenCalled();
	});
	it("uses the voice delivery path for completed AI runs", async () => {
		const { bridge } = fixture();
		bridge.host = {
			chat: vi.fn(async () => ({ conversationId: "c", clientId: "plugin:qq:u", sessionId: "s", runId: "r" })),
		};
		await bridge.driveAuthor("u", "question", { userOpenid: "u", msgId: "incoming" });
		await bridge.handleRunEvent({
			type: "message",
			conversationId: "c",
			sessionId: "s",
			runId: "r",
			message: { role: "assistant", content: "回答内容" },
		});
		await bridge.handleRunEvent({ type: "run_end", conversationId: "c", sessionId: "s", runId: "r" });
		expect(bridge.renderVoice).toHaveBeenCalledWith("回答内容", expect.anything(), expect.anything());
		expect(bridge.status.messagesReplied).toBe(1);
		await bridge.stop();
	});
	it("removes code and markdown from spoken text without losing the original reply", () => {
		expect(speechReplyText("# 标题\n**你好** [网页](https://example.org)\n```js\nsecret()\n```")).toEqual({
			text: "标题 你好 网页",
			truncated: false,
		});
	});
});
