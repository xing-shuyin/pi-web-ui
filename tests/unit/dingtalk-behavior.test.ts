import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DingtalkBotBridge } from "../../plugins/dingtalk/index.mjs";
import { receiveMedia, sendMedia } from "../../plugins/dingtalk/media.mjs";
import { DingTalkStream } from "../../plugins/dingtalk/stream.mjs";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return { ...original, stat: vi.fn(original.stat) };
});

const json = (value: any) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
	"base64",
);
const event = (text = "hello", extra = {}) => ({
	senderStaffId: "staff",
	conversationId: "group1",
	threadId: "thread1",
	sessionWebhook: "https://reply/group1",
	text: { content: text },
	...extra,
});
function fixture(chat?: any) {
	const fetch = vi.fn(async (_url: any, _init?: any) => json({ errcode: 0 }));
	vi.stubGlobal("fetch", fetch);
	const host = {
		cwd: process.cwd(),
		chat: chat || vi.fn(async () => ({ conversationId: "c1", runId: "r1" })),
		abortRun: vi.fn(async () => ({ ok: true })),
	};
	return { bridge: new DingtalkBotBridge({ host, getConfig: () => ({ allowAllSenders: true }) }), host, fetch };
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("DingTalk command and ownership behavior", () => {
	it("DEFAULT setters suppress configured model and thinking preferences", async () => {
		const { bridge, host } = fixture();
		bridge.getConfig = () => ({ allowAllSenders: true, model: "configured/model", thinkingLevel: "high" });
		await bridge.onInboundMessage(event("／ＭＯＤＥＬ DEFAULT"));
		await bridge.onInboundMessage(event("／ＴＨＩＮＫＩＮＧ DEFAULT"));
		await bridge.onInboundMessage(event("/reset /stop  ＡＢＣ\nnext line  "));
		expect(host.chat.mock.calls[0][0].text).toBe("/stop  ＡＢＣ\nnext line  ");
		expect(host.chat.mock.calls[0][0].model).toBeUndefined();
		expect(host.chat.mock.calls[0][0].thinkingLevel).toBeUndefined();
	});
	it.each(["/new", "/clear", "/reset", "／ＮＥＷ", "/ＣｌＥａＲ", "／RESET"])(
		"%s dispatches its prompt literally in a fresh context",
		async (command) => {
			let n = 0;
			const { bridge, host } = fixture(vi.fn(async () => ({ conversationId: `c${++n}`, runId: `r${n}` })));
			await bridge.onInboundMessage(event());
			await bridge.onInboundMessage(event(`${command} /stop  ＡＢＣ\nnext line`));
			expect(host.chat).toHaveBeenCalledTimes(2);
			expect(host.chat.mock.calls[1][0]).toMatchObject({
				text: "/stop  ＡＢＣ\nnext line",
				accountId: expect.stringMatching(/^dt_/),
			});
			expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
			expect(host.chat.mock.calls[1][0].conversationId).toBeUndefined();
			expect(host.abortRun).toHaveBeenCalledTimes(1);
		},
	);
	it.each([
		"/model DEFAULT",
		"／ＭＯＤＥＬ provider/CaseSensitive",
		"/thinking HIGH",
		"／ＴＨＩＮＫＩＮＧ DEFAULT",
		"/cwd DEFAULT",
		"／ＷＯＲＫＳＰＡＣＥ DEFAULT",
	])("%s replaces an in-flight session and keeps its receipt stale", async (command) => {
		let release!: (value: any) => void;
		const chat = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			)
			.mockResolvedValue({ conversationId: "fresh", runId: "fresh-run" });
		const { bridge, host } = fixture(chat);
		const pending = bridge.onInboundMessage(event());
		await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
		await bridge.onInboundMessage(event(command));
		await bridge.onInboundMessage(event("fresh"));
		expect(chat).toHaveBeenCalledTimes(2);
		release({ conversationId: "old", runId: "old-run" });
		await pending;
		expect(host.abortRun).toHaveBeenCalledWith("old-run");
		const req = chat.mock.calls[1][0];
		expect(req.accountId).not.toBe(chat.mock.calls[0][0].accountId);
		expect(req.conversationId).toBeUndefined();
		if (command.includes("HIGH")) expect(req.thinkingLevel).toBe("high");
		if (command.includes("CaseSensitive")) expect(req.model).toBe("provider/CaseSensitive");
		if (command.includes("DEFAULT")) {
			expect(req.model).toBeUndefined();
			expect(req.thinkingLevel).toBeUndefined();
		}
	});
	it.each(["/cwd", "/workspace"])("late %s validation cannot overwrite a reset", async (command) => {
		let release!: (value: any) => void;
		vi.mocked(fsPromises.stat).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}) as any,
		);
		const { bridge, host } = fixture();
		const pending = bridge.onInboundMessage(event(`${command} ${process.cwd()}`));
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		await bridge.onInboundMessage(event("/reset /stop"));
		const freshAccount = host.chat.mock.calls[0][0].accountId;
		release({ isDirectory: () => true });
		await pending;
		await bridge.handleRunEvent({ type: "run_end", runId: "r1" });
		await bridge.onInboundMessage(event("continue"));
		expect(host.chat.mock.calls[1][0]).toMatchObject({ accountId: freshAccount, conversationId: "c1" });
	});
	it.each(["/new", "/clear", `/cwd ${process.cwd()}`])("%s rotates actual host account epoch", async (command) => {
		const { bridge, host } = fixture();
		await bridge.onInboundMessage(event());
		await bridge.handleRunEvent({ type: "run_end", runId: "r1" });
		await bridge.onInboundMessage(event(command));
		await bridge.onInboundMessage(event());
		expect(host.chat.mock.calls[0][0].accountId).not.toBe(host.chat.mock.calls[1][0].accountId);
		expect(host.chat.mock.calls[1][0].conversationId).toBeUndefined();
	});
	it.each(["/new", "/clear", "/reset", " /NEW ", " /CLEAR ", "／ＲＥＳＥＴ"])(
		"%s resets the host account binding and reuses only the new context",
		async (command) => {
			const bindings = new Map<string, string>();
			let n = 0;
			const chat = vi.fn(async (req: any) => {
				expect(req.accountId).toMatch(/^dt_[a-f0-9]{32}$/);
				const conversationId = req.conversationId || bindings.get(req.accountId) || `c${++n}`;
				bindings.set(req.accountId, conversationId);
				return { conversationId, runId: `r${chat.mock.calls.length}` };
			});
			const { bridge } = fixture(chat);
			await bridge.onInboundMessage(event());
			await bridge.handleRunEvent({ type: "run_end", runId: "r1" });
			await bridge.onInboundMessage(event(command));
			await bridge.onInboundMessage(event("fresh"));
			await bridge.handleRunEvent({ type: "run_end", runId: "r2" });
			await bridge.onInboundMessage(event("continue"));
			const [old, fresh, continued] = chat.mock.calls.map(([req]: any) => req);
			expect(fresh.accountId).not.toBe(old.accountId);
			expect(fresh).not.toHaveProperty("conversationId");
			expect(continued).toMatchObject({ accountId: fresh.accountId, conversationId: "c2" });
		},
	);
	it.each(["/new", "/clear", "/reset"])(
		"%s bypasses a delayed receipt without rebinding the new session",
		async (command) => {
			let release!: (value: any) => void;
			const chat = vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							release = resolve;
						}),
				)
				.mockResolvedValue({ conversationId: "fresh", runId: "fresh-run" });
			const { bridge, host, fetch } = fixture(chat);
			const pending = bridge.onInboundMessage(event());
			await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
			await bridge.onInboundMessage(event(command));
			await bridge.onInboundMessage(event("fresh input"));
			expect(chat).toHaveBeenCalledTimes(2);
			release({ conversationId: "old", runId: "old-run" });
			await pending;
			expect(host.abortRun).toHaveBeenCalledWith("old-run");
			await bridge.handleRunEvent({
				type: "message",
				runId: "old-run",
				conversationId: "old",
				message: { role: "assistant", content: "STALE" },
			});
			await bridge.handleRunEvent({ type: "run_end", runId: "old-run", conversationId: "old" });
			await bridge.handleRunEvent({ type: "run_end", runId: "fresh-run" });
			await bridge.onInboundMessage(event("continue"));
			expect(chat.mock.calls[2][0]).toMatchObject({
				accountId: chat.mock.calls[1][0].accountId,
				conversationId: "fresh",
			});
			expect(chat.mock.calls[1][0].accountId).not.toBe(chat.mock.calls[0][0].accountId);
			expect(fetch.mock.calls.some((call: any) => call[1].body.includes("STALE"))).toBe(false);
		},
	);
	it.each(["/new", "/clear"])("%s retires a live run while retaining preferences and other scopes", async (command) => {
		let n = 0;
		const { bridge, host, fetch } = fixture(vi.fn(async () => ({ conversationId: `c${++n}`, runId: `r${n}` })));
		await bridge.onInboundMessage(event("/model test/model"));
		await bridge.onInboundMessage(event("/thinking high"));
		await bridge.onInboundMessage(event(`/cwd ${process.cwd()}`));
		await bridge.onInboundMessage(event());
		await bridge.onInboundMessage(event("other", { threadId: "other" }));
		await bridge.onInboundMessage(event(command));
		expect(host.abortRun).toHaveBeenCalledWith("r1");
		await bridge.handleRunEvent({
			type: "message",
			runId: "r1",
			conversationId: "old",
			message: { role: "assistant", content: "STALE" },
		});
		await bridge.handleRunEvent({ type: "run_end", runId: "r1", conversationId: "old" });
		await bridge.onInboundMessage(event("fresh"));
		expect(host.chat.mock.calls[2][0]).toMatchObject({
			model: "test/model",
			thinkingLevel: "high",
			cwd: process.cwd(),
		});
		expect(host.chat.mock.calls[2][0].conversationId).toBeUndefined();
		await bridge.handleRunEvent({ type: "run_end", runId: "r2" });
		await bridge.onInboundMessage(event("other again", { threadId: "other" }));
		expect(host.chat.mock.calls[3][0]).toMatchObject({
			accountId: host.chat.mock.calls[1][0].accountId,
			conversationId: "c2",
		});
		expect(fetch.mock.calls.some((call: any) => call[1].body.includes("STALE"))).toBe(false);
	});
	it("keeps the new epoch usable and reports failure when the old run cannot be aborted", async () => {
		const { bridge, host, fetch } = fixture();
		await bridge.onInboundMessage(event());
		host.abortRun.mockResolvedValueOnce({ ok: false, error: "denied" } as any);
		await bridge.onInboundMessage(event("/clear"));
		expect(fetch.mock.calls.some((call: any) => call[1].body.includes("旧任务未能确认停止"))).toBe(true);
		await bridge.onInboundMessage(event("fresh"));
		expect(host.chat).toHaveBeenCalledTimes(2);
		expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
		expect(host.chat.mock.calls[1][0].conversationId).toBeUndefined();
	});
	it("stop bypasses unresolved chat dispatch and aborts receipt immediately on arrival", async () => {
		let release!: (value: any) => void;
		const { bridge, host, fetch } = fixture(
			vi.fn(
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			),
		);
		const pending = bridge.onInboundMessage(event());
		await vi.waitFor(() => expect(host.chat).toHaveBeenCalled());
		await bridge.onInboundMessage(event("/stop"));
		expect(fetch.mock.calls.at(-1)?.[1]).toMatchObject({ body: expect.stringContaining("已收到停止请求") });
		release({ conversationId: "actual", runId: "r1" });
		await pending;
		expect(host.abortRun).toHaveBeenCalledWith("r1");
		expect(bridge.pendingRuns.size).toBe(0);
	});
	it("stop bypasses media download and prevents later model dispatch", async () => {
		const { bridge, host } = fixture();
		bridge.getConfig = () => config;
		let release!: (value: any) => void;
		const mock = vi.fn(async (url: any) => {
			if (String(url).includes("accessToken")) return json({ accessToken: "token" });
			if (String(url).includes("messageFiles/download"))
				return new Promise<Response>((resolve) => {
					release = resolve;
				});
			if (String(url) === "https://download/file") return new Response(new Uint8Array(png));
			return json({ errcode: 0 });
		});
		vi.stubGlobal("fetch", mock);
		const pending = bridge.onInboundMessage(event("", { msgtype: "picture", content: { downloadCode: "x" } }));
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		await bridge.onInboundMessage(event("/abort"));
		release(json({ downloadUrl: "https://download/file" }));
		await pending;
		expect(host.chat).not.toHaveBeenCalled();
	});
	it.each(["/new", "/clear", "/reset", "/model test/new", "/thinking HIGH", "/workspace DEFAULT"])(
		"%s bypasses old media preparation and discards its eventual dispatch",
		async (command) => {
			const { bridge, host } = fixture();
			bridge.getConfig = () => config;
			let release!: (value: any) => void;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: any) => {
					if (String(url).includes("accessToken")) return json({ accessToken: "token" });
					if (String(url).includes("messageFiles/download"))
						return new Promise<Response>((resolve) => {
							release = resolve;
						});
					if (String(url) === "https://download/file") return new Response(new Uint8Array(png));
					return json({ errcode: 0 });
				}),
			);
			const pending = bridge.onInboundMessage(event("", { msgtype: "picture", content: { downloadCode: "x" } }));
			await vi.waitFor(() => expect(release).toBeTypeOf("function"));
			await bridge.onInboundMessage(event(command));
			await bridge.onInboundMessage(event("fresh"));
			expect(host.chat).toHaveBeenCalledTimes(1);
			release(json({ downloadUrl: "https://download/file" }));
			await pending;
			expect(host.chat).toHaveBeenCalledTimes(1);
			expect(host.chat.mock.calls[0][0]).toMatchObject({ text: "fresh", accountId: expect.stringMatching(/^dt_/) });
		},
	);
	it("all informational and unknown commands stay out of the model", async () => {
		const { bridge, host, fetch } = fixture();
		for (const command of ["/help", "/status", "/model", "/thinking", "/cwd", "/stop", "/abort", "/unknown"])
			await bridge.onInboundMessage(event(command));
		expect(host.chat).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledTimes(8);
		expect(fetch.mock.calls.at(-1)?.[1]).toMatchObject({ body: expect.stringContaining("未知命令") });
	});
	it("model, thinking and cwd preferences reach real chat; clear/new rotate account and context", async () => {
		const { bridge, host } = fixture();
		await bridge.onInboundMessage(event("/model test/model"));
		await bridge.onInboundMessage(event("/thinking high"));
		await bridge.onInboundMessage(event(`/cwd ${process.cwd()}`));
		await bridge.onInboundMessage(event());
		expect(host.chat).toHaveBeenLastCalledWith(
			expect.objectContaining({ model: "test/model", thinkingLevel: "high", cwd: process.cwd() }),
		);
		const account = host.chat.mock.calls[0][0].accountId;
		await bridge.handleRunEvent({ type: "run_end", runId: "r1" });
		await bridge.onInboundMessage(event("/clear"));
		await bridge.onInboundMessage(event());
		expect(host.chat.mock.calls[1][0].accountId).not.toBe(account);
		expect(host.chat.mock.calls[1][0].conversationId).toBeUndefined();
	});
	it("invalid model/thinking/path fail visibly without sending commands to chat", async () => {
		const { bridge, host, fetch } = fixture();
		for (const command of ["/model nope", "/thinking impossible", "/cwd relative"])
			await bridge.onInboundMessage(event(command));
		expect(host.chat).not.toHaveBeenCalled();
		expect(fetch.mock.calls.every((call: any) => JSON.parse(call[1].body).text.content.includes("处理失败"))).toBe(
			true,
		);
	});
	it("stop uses actual receipt ID after takeover and reports abort failure", async () => {
		const { bridge, host, fetch } = fixture();
		await bridge.onInboundMessage(event());
		await bridge.handleRunEvent({
			type: "message",
			runId: "r1",
			conversationId: "moved",
			message: { role: "assistant", content: "partial" },
		});
		host.abortRun.mockResolvedValueOnce({ ok: false, error: "denied" } as any);
		await bridge.onInboundMessage(event("/abort"));
		expect(host.abortRun).toHaveBeenCalledWith("r1");
		expect(fetch.mock.calls.at(-1)?.[1]).toMatchObject({ body: expect.stringContaining("denied") });
		await bridge.onInboundMessage(event("/stop"));
		expect(bridge.pendingRuns.size).toBe(0);
	});
	it("buffers messages AND run_end before chat receipt, even if conversation ID changes", async () => {
		let bridge: any;
		const chat = vi.fn(async () => {
			await bridge.handleRunEvent({
				type: "message",
				conversationId: "other",
				runId: "early",
				message: { role: "assistant", content: "early answer" },
			});
			await bridge.handleRunEvent({ type: "run_end", conversationId: "moved", runId: "early" });
			return { conversationId: "actual", runId: "early" };
		});
		const f = fixture(chat);
		bridge = f.bridge;
		await bridge.onInboundMessage(event());
		expect(f.fetch).toHaveBeenCalledWith(
			"https://reply/group1",
			expect.objectContaining({ body: expect.stringContaining("early answer") }),
		);
		expect(bridge.pendingRuns.size).toBe(0);
	});
	it("isolates same user across groups and threads and routes by runId despite identical conversation IDs", async () => {
		let n = 0;
		const { bridge, host, fetch } = fixture(vi.fn(async () => ({ conversationId: "c1", runId: `r${++n}` })));
		await bridge.onInboundMessage(event());
		await bridge.onInboundMessage(event("hello", { conversationId: "group2", sessionWebhook: "https://reply/group2" }));
		await bridge.onInboundMessage(event("hello", { threadId: "thread2", sessionWebhook: "https://reply/thread2" }));
		expect(new Set(host.chat.mock.calls.map((call: any) => call[0].accountId)).size).toBe(3);
		await bridge.handleRunEvent({
			type: "message",
			conversationId: "c1",
			runId: "foreign",
			message: { role: "assistant", content: "LEAK" },
		});
		await bridge.handleRunEvent({ type: "run_end", conversationId: "c1", runId: "foreign" });
		for (let i = 1; i <= 3; i++) {
			await bridge.handleRunEvent({
				type: "message",
				conversationId: "moved",
				runId: `r${i}`,
				message: { role: "assistant", content: `answer${i}` },
			});
			await bridge.handleRunEvent({ type: "run_end", conversationId: "moved", runId: `r${i}` });
		}
		expect(fetch.mock.calls.map((call: any) => call[0])).toEqual([
			"https://reply/group1",
			"https://reply/group2",
			"https://reply/thread2",
		]);
		expect(fetch.mock.calls.map((call: any) => call[1].body).join()).not.toContain("LEAK");
	});
	it("missing receipt, dispatch errors and platform delivery errors are visible", async () => {
		const { bridge, fetch } = fixture(vi.fn(async () => ({ conversationId: "actual" })));
		await bridge.onInboundMessage(event());
		expect(fetch.mock.calls.at(-1)?.[1]).toMatchObject({ body: expect.stringContaining("runId") });
		fetch.mockImplementation(async () => json({ errcode: 400, errmsg: "expired webhook" }));
		await bridge.onInboundMessage(event("/help"));
		expect(bridge.getStatus().lastError).toContain("expired webhook");
	});
	it("rejects missing sender and missing reply route before dispatch", async () => {
		const { bridge, host } = fixture();
		await bridge.onInboundMessage(event("hello", { senderStaffId: "" }));
		await bridge.onInboundMessage(event("hello", { sessionWebhook: "" }));
		expect(host.chat).not.toHaveBeenCalled();
	});
});

function mediaFetch(bytes = png) {
	return vi.fn(async (url: any) => {
		const value = String(url);
		if (value.includes("accessToken")) return json({ accessToken: "token" });
		if (value.includes("messageFiles/download")) return json({ downloadUrl: "https://download/file" });
		if (value === "https://download/file") return new Response(new Uint8Array(bytes));
		return json({ errcode: 0 });
	});
}
const config = { allowAllSenders: true, appKey: "key", appSecret: "secret", robotCode: "robot" };
describe("DingTalk real media transport", () => {
	it("sends image bytes via actual host.chat attachments instead of URL text", async () => {
		const { bridge, host } = fixture();
		bridge.getConfig = () => config;
		vi.stubGlobal("fetch", mediaFetch());
		await bridge.onInboundMessage(event("", { msgtype: "picture", content: { downloadCode: "code" } }));
		expect(host.chat).toHaveBeenCalledWith(
			expect.objectContaining({
				attachments: [{ path: "", name: "picture-0.png", mimeType: "image/png", imageData: png.toString("base64") }],
			}),
		);
		expect(host.chat.mock.calls[0][0].text).not.toContain("https://download");
	});
	it.each(["audio", "voice", "file", "video"])(
		"%s arrives as real fileData and unsupported decoding is explained",
		async (kind) => {
			const { bridge, host, fetch } = fixture();
			bridge.getConfig = () => config;
			const mock = mediaFetch(Buffer.from("raw media"));
			vi.stubGlobal("fetch", mock);
			await bridge.onInboundMessage(
				event("", { msgtype: kind, content: { downloadCode: "code", fileName: "media.bin" } }),
			);
			expect(host.chat).toHaveBeenCalledWith(
				expect.objectContaining({
					attachments: [
						{
							path: "",
							name: "media.bin",
							mimeType: "application/octet-stream",
							fileData: Buffer.from("raw media").toString("base64"),
						},
					],
				}),
			);
			if (kind !== "file")
				expect(mock.mock.calls.some((call: any) => call[1]?.body?.includes("不提供自动语音转写或视频解码"))).toBe(true);
		},
	);
	it("rejects unsupported types, malformed payload and invalid image bytes", async () => {
		const { bridge, host } = fixture();
		bridge.getConfig = () => config;
		const mock = mediaFetch(Buffer.from("not image"));
		vi.stubGlobal("fetch", mock);
		for (const msg of [
			{ msgtype: "location" },
			{ msgtype: "file", content: "bad-json" },
			{ msgtype: "picture", content: { downloadCode: "x" } },
		])
			await bridge.onInboundMessage(event("", msg));
		expect(host.chat).not.toHaveBeenCalled();
		expect(mock.mock.calls.some((call: any) => call[1]?.body?.includes("图片无法解码"))).toBe(true);
	});
	it.each(["file", "audio", "video"])("rejects a 15MiB inbound %s without model dispatch", async (kind) => {
		const { bridge, host } = fixture();
		bridge.getConfig = () => config;
		const mock = mediaFetch(Buffer.alloc(15 * 1024 * 1024));
		vi.stubGlobal("fetch", mock);
		await bridge.onInboundMessage(
			event("", { msgtype: kind, content: { downloadCode: "large", fileName: "large.bin" } }),
		);
		expect(host.chat).not.toHaveBeenCalled();
		expect(mock.mock.calls.some((call: any) => call[1]?.body?.includes("入站单个媒体超过 10MiB"))).toBe(true);
	});
	it("enforces eight images, 10MiB per image, and 20MiB total", async () => {
		vi.stubGlobal("fetch", mediaFetch());
		await expect(
			receiveMedia(
				{ msgtype: "richText", content: { richText: Array.from({ length: 9 }, () => ({ pictureDownloadCode: "x" })) } },
				config,
			),
		).rejects.toThrow("8 张");
		const huge = Buffer.alloc(10 * 1024 * 1024 + 1);
		png.copy(huge);
		vi.stubGlobal("fetch", mediaFetch(huge));
		await expect(receiveMedia({ msgtype: "picture", content: { downloadCode: "x" } }, config)).rejects.toThrow("10MiB");
		const large = Buffer.alloc(8 * 1024 * 1024);
		png.copy(large);
		vi.stubGlobal("fetch", mediaFetch(large));
		await expect(
			receiveMedia(
				{ msgtype: "richText", content: { richText: Array.from({ length: 3 }, () => ({ pictureDownloadCode: "x" })) } },
				config,
			),
		).rejects.toThrow("累计");
	});
	it.each(["image", "audio", "file", "video"])(
		"uploads and sends native %s with correct recipient and template",
		async (kind) => {
			const dir = await mkdtemp(join(tmpdir(), "dt-media-"));
			try {
				const path = join(dir, { image: "x.png", audio: "x.amr", file: "x.txt", video: "x.mp4" }[kind]!);
				const coverPath = join(dir, "cover.png");
				await writeFile(path, kind === "image" ? png : "bytes");
				await writeFile(coverPath, png);
				const mock = vi.fn(async (url: any) =>
					String(url).includes("accessToken")
						? json({ accessToken: "token" })
						: String(url).includes("media/upload")
							? json({ errcode: 0, media_id: "media-id" })
							: json({ processQueryKey: "query" }),
				);
				vi.stubGlobal("fetch", mock);
				await sendMedia(config, { mediaType: kind, path, coverPath, duration: 2, openConversationId: "target-group" });
				expect(mock.mock.calls.at(-1)?.[0]).toContain("groupMessages/send");
				const body = JSON.parse((mock.mock.calls.at(-1) as any)[1].body);
				expect(body.openConversationId).toBe("target-group");
				expect(body.msgKey).toBe(
					{ image: "sampleImageMsg", audio: "sampleAudio", file: "sampleFile", video: "sampleVideo" }[kind],
				);
				expect(body.msgParam).toContain("media-id");
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("DingTalk Stream ingress", () => {
	it("ACKs gateway callback and invokes real inbound handler; ping receives pong", async () => {
		const onMessage = vi.fn();
		const send = vi.fn();
		const stream = new DingTalkStream({ config: () => config, onMessage, onState: vi.fn(), log: vi.fn() });
		await stream.receive(
			{ send },
			JSON.stringify({
				type: "CALLBACK",
				headers: { topic: "/v1.0/im/bot/messages/get", messageId: "id" },
				data: JSON.stringify(event()),
			}),
		);
		expect(onMessage).toHaveBeenCalledWith(event());
		expect(JSON.parse(send.mock.calls[0][0]).code).toBe(200);
		await stream.receive(
			{ send },
			JSON.stringify({ type: "SYSTEM", headers: { topic: "ping", messageId: "ping" }, data: "ping" }),
		);
		expect(JSON.parse(send.mock.calls[1][0]).data).toBe("ping");
		stream.close();
	});
});
