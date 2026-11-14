import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FeishuBotBridge } from "../../plugins/feishu/bot-bridge.mjs";
import { createMedia } from "../../plugins/feishu/media.mjs";
import { receiveAttachments } from "../../plugins/feishu/runtime.mjs";

const projectWorkspace = join(tmpdir(), "feishu-project");
const nextWorkspace = join(tmpdir(), "feishu-next");

function setup() {
	const host = {
		cwd: projectWorkspace,
		chat: vi.fn(),
		abortRun: vi.fn().mockResolvedValue({ ok: true }),
		models: { list: vi.fn().mockResolvedValue([{ provider: "p", id: "m" }]) },
	};
	const reply = vi.fn().mockResolvedValue({ success: true });
	const download = vi
		.fn()
		.mockResolvedValue({ data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png" });
	const bridge = new FeishuBotBridge({
		host,
		getConfig: () => ({ allowAllSenders: true, groupResponseMode: "all" }),
		replyMessage: reply,
		sendMessage: vi.fn(),
		reactMessage: vi.fn(),
		downloadResource: download,
	} as any);
	let id = 0;
	const inbound = (text = "hello", chat = "group-a", thread = "", type = "text", content?: any) =>
		bridge.onInboundMessage({
			sender: { sender_id: { open_id: "user" } },
			message: {
				message_id: `message-${++id}`,
				chat_type: "group",
				chat_id: chat,
				thread_id: thread,
				message_type: type,
				content: JSON.stringify(content || { text }),
			},
		});
	return { bridge, host, reply, download, inbound };
}

describe("Feishu runtime contracts", () => {
	it.each(["/new", "/reset", "/model p/m", "/thinking HIGH", "/stop"])(
		"%s stops stale reply chunks after an in-flight send",
		async (command) => {
			const { bridge, host, inbound, reply } = setup();
			host.chat.mockResolvedValueOnce({ conversationId: "old", runId: "old-run" });
			await inbound();
			await bridge.handleRunEvent({
				type: "message",
				runId: "old-run",
				message: { role: "assistant", content: "x".repeat(9000) },
			});
			let finishSend!: (value: any) => void;
			reply.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishSend = resolve;
					}),
			);
			const delivery = bridge.handleRunEvent({ type: "run_end", runId: "old-run" });
			expect(reply).toHaveBeenCalledTimes(1);
			await inbound(command);
			finishSend({ success: true });
			await delivery;
			expect(reply.mock.calls.filter(([, message]) => message.title === "AI 助手回复")).toHaveLength(1);
			expect(bridge.status.messagesReplied).toBe(0);
		},
	);

	it.each(["/new", "/CLEAR", "/reset", "／ＮＥＷ", "／ｃｌｅａｒ", "/ＲＥＳＥＴ"])(
		"%s executes its literal prompt in a fresh context",
		async (command) => {
			const { host, inbound } = setup();
			host.chat.mockResolvedValueOnce({ conversationId: "old", runId: "old-run" });
			await inbound();
			host.chat.mockResolvedValueOnce({ conversationId: "new", runId: "new-run" });
			const prompt = "/stop  @literal\n／ＮＥＷ keep  spaces";
			await inbound(`${command} ${prompt}`);
			expect(host.chat).toHaveBeenCalledTimes(2);
			expect(host.chat.mock.calls[1][0].text).toBe(prompt);
			expect(host.chat.mock.calls[1][0]).not.toHaveProperty("conversationId");
			expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
			expect(host.abortRun).toHaveBeenCalledExactlyOnceWith("old-run");
		},
	);

	it.each([
		"/model p/m",
		"/MODEL DEFAULT",
		"/thinking HIGH",
		"/THINKING DEFAULT",
		`/cwd ${nextWorkspace}`,
		`/ＷＯＲＫＳＰＡＣＥ ${nextWorkspace}`,
		"／ＣＷＤ DEFAULT",
		"/workspace DEFAULT",
	])("%s rotates active and in-flight contexts", async (command) => {
		const { host, inbound, bridge } = setup();
		let finish!: (value: any) => void;
		host.chat.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const old = inbound("old");
		await vi.waitFor(() => expect(host.chat).toHaveBeenCalledTimes(1));
		await inbound(command);
		host.chat.mockResolvedValueOnce({ conversationId: "new", runId: "new-run" });
		await inbound("new");
		finish({ conversationId: "old", runId: "old-run" });
		await old;
		expect(host.abortRun).toHaveBeenCalledWith("old-run");
		expect(host.chat.mock.calls[1][0]).not.toHaveProperty("conversationId");
		expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
		expect([...bridge.userConversations.values()]).toEqual(["new"]);
		if (command === "/thinking HIGH") expect(host.chat.mock.calls[1][0].thinkingLevel).toBe("high");
	});

	it("stop during reset abort waits cancels its pending literal prompt", async () => {
		const { host, inbound } = setup();
		host.chat.mockResolvedValueOnce({ conversationId: "old", runId: "old-run" });
		await inbound();
		let finishAbort!: (value: any) => void;
		host.abortRun.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishAbort = resolve;
				}),
		);
		const resetting = inbound("/reset never execute");
		await vi.waitFor(() => expect(host.abortRun).toHaveBeenCalled());
		await inbound("/stop");
		finishAbort({ ok: true });
		await resetting;
		expect(host.chat).toHaveBeenCalledTimes(1);
	});

	it("DEFAULT restores configured defaults and delayed model validation cannot override reset", async () => {
		const { host, inbound, bridge } = setup();
		bridge.getConfig = () => ({
			allowAllSenders: true,
			groupResponseMode: "all",
			model: "configured/model",
			thinkingLevel: "low",
			workspace: projectWorkspace,
		});
		await inbound("/model p/m");
		await inbound("/thinking HIGH");
		await inbound(`/workspace ${nextWorkspace}`);
		await inbound("/model DEFAULT");
		await inbound("/thinking DEFAULT");
		await inbound("/workspace DEFAULT");
		let finishModels!: (value: any) => void;
		host.models.list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishModels = resolve;
				}),
		);
		const setter = inbound("/model p/m");
		await vi.waitFor(() => expect(host.models.list).toHaveBeenCalledTimes(2));
		host.chat.mockResolvedValueOnce({ conversationId: "fresh", runId: "fresh-run" });
		await inbound("/reset literal");
		finishModels([{ provider: "p", id: "m" }]);
		await setter;
		expect(host.chat.mock.calls[0][0]).toMatchObject({
			text: "literal",
			model: "configured/model",
			thinkingLevel: "low",
			cwd: projectWorkspace,
		});
		expect([...bridge.userConversations.values()]).toEqual(["fresh"]);
		expect([...bridge.pendingRuns.keys()]).toEqual(["fresh-run"]);
		expect([...(bridge as any).preferences.values()]).toEqual([{}]);
	});

	it.each(["/new", "/clear", "/NeW", "/CLEAR"])(
		"%s detaches active runs and preserves account identity through the next dispatch",
		async (command) => {
			const { bridge, host, inbound } = setup();
			host.chat.mockResolvedValueOnce({ conversationId: "old", runId: "old-run" });
			await inbound();
			const first = host.chat.mock.calls[0][0];
			await inbound(command);
			expect(host.abortRun).toHaveBeenCalledWith("old-run");
			await bridge.handleRunEvent({
				type: "message",
				runId: "old-run",
				conversationId: "old-moved",
				message: { role: "assistant", content: "stale" },
			});
			await bridge.handleRunEvent({ type: "run_end", runId: "old-run", conversationId: "old-moved" });
			host.chat.mockResolvedValueOnce({ conversationId: "fresh", runId: "fresh-run" });
			await inbound();
			const fresh = host.chat.mock.calls[1][0];
			expect(fresh).not.toHaveProperty("conversationId");
			expect(fresh.accountId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
			expect(fresh.accountId).not.toBe(first.accountId);
			await bridge.handleRunEvent({ type: "run_end", runId: "fresh-run" });
			host.chat.mockResolvedValueOnce({ conversationId: "fresh", runId: "next-run" });
			await inbound();
			expect(host.chat.mock.calls[2][0]).toMatchObject({ accountId: fresh.accountId, conversationId: "fresh" });
		},
	);

	it.each(["/new", "/clear"])("%s cancels downloads and messages waiting for reactions", async (command) => {
		const { bridge, host, inbound, download } = setup();
		let finishDownload!: (value: any) => void;
		download.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishDownload = resolve;
				}),
		);
		const media = inbound("", "group-a", "", "image", { image_key: "key" });
		await inbound(command);
		finishDownload({ data: Buffer.from("image"), mimeType: "image/png" });
		await media;
		expect(host.chat).not.toHaveBeenCalled();
		let finishReaction!: () => void;
		bridge.reactMessage = vi.fn().mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishReaction = resolve;
				}),
		);
		const waiting = inbound("stale");
		await vi.waitFor(() => expect(bridge.reactMessage).toHaveBeenCalled());
		await inbound(command);
		finishReaction();
		await waiting;
		expect(host.chat).not.toHaveBeenCalled();
	});

	it.each(["/new", "/clear"])(
		"%s releases unresolved dispatch without allowing its late receipt to overwrite the new run",
		async (command) => {
			const { bridge, host, inbound } = setup();
			let finishOld!: (value: any) => void;
			let finishNew!: (value: any) => void;
			host.chat.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishOld = resolve;
					}),
			);
			const old = inbound("old");
			await vi.waitFor(() => expect(host.chat).toHaveBeenCalledTimes(1));
			await inbound(command);
			host.chat.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishNew = resolve;
					}),
			);
			const fresh = inbound("new");
			await vi.waitFor(() => expect(host.chat).toHaveBeenCalledTimes(2));
			finishOld({ conversationId: "old", runId: "old-run" });
			await old;
			expect(host.abortRun).toHaveBeenCalledWith("old-run");
			await inbound("busy");
			expect(host.chat).toHaveBeenCalledTimes(2);
			finishNew({ conversationId: "new", runId: "new-run" });
			await fresh;
			expect([...bridge.userConversations.values()]).toEqual(["new"]);
			expect([...bridge.pendingRuns.keys()]).toEqual(["new-run"]);
			expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
			expect(host.chat.mock.calls[1][0]).not.toHaveProperty("conversationId");
		},
	);

	it("reset keeps other threads active and reports failed aborts without restoring the old binding", async () => {
		const { bridge, host, inbound, reply } = setup();
		host.chat.mockResolvedValueOnce({ conversationId: "old", runId: "old-run" });
		host.chat.mockResolvedValueOnce({ conversationId: "other", runId: "other-run" });
		await inbound("one", "group-a", "one");
		await inbound("two", "group-a", "two");
		host.abortRun.mockResolvedValueOnce({ ok: false });
		await inbound("/clear", "group-a", "one");
		expect(reply.mock.calls.at(-1)?.[1].text).toContain("旧任务停止失败");
		expect(host.abortRun).toHaveBeenCalledExactlyOnceWith("old-run");
		expect([...bridge.pendingRuns.keys()]).toEqual(["other-run"]);
		expect([...bridge.userConversations.values()]).toEqual(["other"]);
		host.chat.mockResolvedValueOnce({ conversationId: "fresh", runId: "fresh-run" });
		await inbound("fresh", "group-a", "one");
		expect(host.chat.mock.calls[2][0]).not.toHaveProperty("conversationId");
	});

	it("new, clear and cwd rotate account epochs rather than reusing host context", async () => {
		const { bridge, host, inbound } = setup();
		let n = 0;
		host.chat.mockImplementation(async () => ({ conversationId: `c${++n}`, runId: `r${n}` }));
		await inbound();
		const accounts = [host.chat.mock.calls.at(-1)?.[0].accountId];
		for (const command of ["/new", "/clear", `/cwd ${nextWorkspace}`]) {
			await bridge.handleRunEvent({ type: "run_end", runId: `r${n}` });
			await inbound(command);
			await inbound();
			accounts.push(host.chat.mock.calls.at(-1)?.[0].accountId);
		}
		expect(new Set(accounts).size).toBe(4);
	});

	it.each(["relative/project", "E:relative", ...(process.platform === "win32" ? [] : ["E:/next"])])(
		"rejects non-absolute cwd %s without changing workspace or conversation identity",
		async (workspace) => {
			const { bridge, host, inbound, reply } = setup();
			host.chat.mockResolvedValueOnce({ conversationId: "c1", runId: "r1" });
			await inbound();
			const accountId = host.chat.mock.calls[0][0].accountId;
			await bridge.handleRunEvent({ type: "run_end", runId: "r1" });
			await inbound(`/cwd ${workspace}`);
			expect(reply.mock.calls.at(-1)?.[1].text).toContain("请提供工作区绝对路径");
			expect(host.chat).toHaveBeenCalledTimes(1);
			host.chat.mockResolvedValueOnce({ conversationId: "c1", runId: "r2" });
			await inbound();
			expect(host.chat.mock.calls[1][0]).toMatchObject({ cwd: projectWorkspace, accountId, conversationId: "c1" });
		},
	);

	it("stop bypasses unresolved download and dispatch, cancelling eventual work", async () => {
		const { bridge, host, inbound, download, reply } = setup();
		let resolveDownload!: (value: any) => void;
		download.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveDownload = resolve;
				}),
		);
		const downloading = inbound("", "a", "", "image", { image_key: "k" });
		await inbound("/stop", "a");
		expect(reply.mock.calls.at(-1)?.[1].text).toContain("取消");
		resolveDownload({ data: Buffer.from("png"), mimeType: "image/png" });
		await downloading;
		expect(host.chat).not.toHaveBeenCalled();
		let resolveChat!: (value: any) => void;
		host.chat.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveChat = resolve;
				}),
		);
		const dispatching = inbound("hello", "a");
		await vi.waitFor(() => expect(host.chat).toHaveBeenCalled());
		await inbound("/stop", "a");
		resolveChat({ conversationId: "c", runId: "r" });
		await dispatching;
		expect(host.abortRun).toHaveBeenCalledWith("r");
		expect(bridge.pendingRuns.size).toBe(0);
	});
	it("buffers early events by stable run id and ignores other runs in the same conversation", async () => {
		const { bridge, host, inbound, reply } = setup();
		host.chat.mockImplementation(async () => {
			await bridge.handleRunEvent({
				type: "message",
				conversationId: "c",
				runId: "other",
				message: { role: "assistant", content: "WRONG" },
			});
			await bridge.handleRunEvent({
				type: "message",
				conversationId: "renamed",
				runId: "r",
				message: { role: "assistant", content: "RIGHT" },
			});
			await bridge.handleRunEvent({ type: "run_end", conversationId: "renamed", runId: "r" });
			return { conversationId: "c", runId: "r" };
		});
		await inbound();
		expect(reply).toHaveBeenCalledTimes(1);
		expect(reply.mock.calls[0][1].text).toBe("RIGHT");
		expect(bridge.pendingRuns.size).toBe(0);
	});

	it("isolates the same sender across groups and threads and replies every chunk in the source thread", async () => {
		const { bridge, host, inbound, reply } = setup();
		let n = 0;
		host.chat.mockImplementation(async () => ({ conversationId: `c${++n}`, runId: `r${n}` }));
		await inbound("a", "a", "t1");
		await inbound("b", "b", "t1");
		await inbound("c", "a", "t2");
		expect(new Set(host.chat.mock.calls.map(([req]) => req.accountId)).size).toBe(3);
		await bridge.handleRunEvent({
			type: "message",
			conversationId: "c1",
			runId: "foreign",
			message: { role: "assistant", content: "WRONG" },
		});
		await bridge.handleRunEvent({
			type: "message",
			conversationId: "moved",
			runId: "r1",
			message: { role: "assistant", content: "x".repeat(8000) },
		});
		await bridge.handleRunEvent({ type: "run_end", conversationId: "moved", runId: "r1" });
		expect(reply.mock.calls.length).toBeGreaterThan(1);
		for (const [, req] of reply.mock.calls) expect(req).toMatchObject({ messageId: "message-1", replyInThread: true });
	});

	it("routes every command locally, validates settings and stops using host abortRun", async () => {
		const { bridge, host, inbound, reply } = setup();
		for (const command of [
			"/help",
			"/status",
			"/model",
			"/model p/m",
			"/thinking high",
			`/cwd ${nextWorkspace}`,
			"/new",
			"/clear",
			"/unknown",
			"/thinking invalid",
		])
			await inbound(command);
		expect(host.chat).not.toHaveBeenCalled();
		expect(reply.mock.calls.at(-2)?.[1].text).toContain("未知命令");
		host.chat.mockResolvedValue({ conversationId: "c", runId: "r" });
		await inbound();
		expect(host.chat.mock.calls[0][0]).toMatchObject({ cwd: nextWorkspace, model: "p/m", thinkingLevel: "high" });
		await inbound("/stop");
		await inbound("/abort");
		expect(host.abortRun).toHaveBeenCalledWith("r");
		await bridge.handleRunEvent({ type: "run_end", runId: "r", stopReason: "aborted" });
		expect(reply.mock.calls.at(-1)?.[1].text).toContain("停止");
	});

	it("passes real image and file/audio/video attachments and reports unknown types and download failure", async () => {
		const { host, inbound, download, reply, bridge } = setup();
		let n = 0;
		host.chat.mockImplementation(async () => ({ conversationId: `c${++n}`, runId: `r${n}` }));
		await inbound("", "a", "", "image", { image_key: "img" });
		expect(host.chat.mock.calls[0][0].attachments[0]).toMatchObject({
			path: "",
			mimeType: "image/png",
			imageData: expect.any(String),
		});
		for (const type of ["file", "audio", "media"]) {
			download.mockResolvedValue({ data: Buffer.from("bytes"), mimeType: "application/octet-stream" });
			await inbound("", type, "", type, { file_key: "file", file_name: "test.bin" });
			expect(host.chat.mock.calls.at(-1)?.[0].attachments[0].fileData).toBe(Buffer.from("bytes").toString("base64"));
		}
		await inbound("", "x", "", "sticker", {});
		expect(reply.mock.calls.at(-1)?.[1].text).toContain("不支持");
		download.mockRejectedValue(new Error("download denied"));
		await inbound("", "x", "", "image", { image_key: "bad" });
		expect(reply.mock.calls.at(-1)?.[1].text).toContain("download denied");
		expect(bridge.status.lastError).toContain("download denied");
	});

	it("rejects missing receipts and gives delivery failure feedback", async () => {
		const { host, inbound, reply, bridge } = setup();
		host.chat.mockResolvedValue({ conversationId: "c" });
		await inbound();
		expect(reply.mock.calls.at(-1)?.[1].text).toContain("runId");
		host.chat.mockResolvedValue({ conversationId: "c", runId: "r" });
		await inbound();
		reply.mockRejectedValueOnce(new Error("card rejected"));
		await bridge.handleRunEvent({ type: "run_end", runId: "r" });
		expect(reply.mock.calls.at(-1)?.[1].text).toContain("回复发送失败");
	});

	it("enforces image count and per-item/aggregate byte limits", async () => {
		const resource = { key: "k", type: "image", name: "x.png" };
		await expect(receiveAttachments(Array(9).fill(resource), vi.fn(), {}, "m")).rejects.toThrow("8");
		await expect(
			receiveAttachments(
				[resource],
				async () => ({ data: Buffer.alloc(10 * 1024 * 1024 + 1), mimeType: "image/png" }),
				{},
				"m",
			),
		).rejects.toThrow("10MiB");
		await expect(
			receiveAttachments(
				Array(3).fill(resource),
				async () => ({ data: Buffer.alloc(8 * 1024 * 1024), mimeType: "image/png" }),
				{},
				"m",
			),
		).rejects.toThrow("20MiB");
	});

	it("shares the 20MiB decoded-byte budget across imageData and fileData", async () => {
		const image = { key: "image", type: "image", name: "x.png" };
		const file = { key: "file", type: "file", name: "x.bin" };
		const tenMiB = Buffer.alloc(10 * 1024 * 1024);
		const download = async () => ({ data: tenMiB, mimeType: "image/png" });
		const attachments = await receiveAttachments([image, file], download, {}, "m");
		expect(attachments).toHaveLength(2);
		expect(Buffer.from(attachments[0].imageData!, "base64").length).toBe(tenMiB.length);
		expect(Buffer.from(attachments[1].fileData!, "base64").length).toBe(tenMiB.length);
		await expect(receiveAttachments([image, file, file], download, {}, "m")).rejects.toThrow("20MiB");
		await expect(
			receiveAttachments(
				[file],
				async () => ({ data: Buffer.alloc(tenMiB.length + 1), mimeType: "application/octet-stream" }),
				{},
				"m",
			),
		).rejects.toThrow("10MiB");
	});

	it("uploads media with actual multipart bytes, validates codec and API failures", async () => {
		const request = vi
			.fn()
			.mockImplementation(
				async (..._args: any[]) =>
					new Response(JSON.stringify({ code: 0, data: { image_key: "img", file_key: "file" } })),
			);
		const fs = {
			stat: vi.fn().mockResolvedValue({ type: "file", size: 8 }),
			read: vi.fn().mockResolvedValue(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
		};
		const media = createMedia({
			host: { fs },
			getToken: async () => "token",
			getBaseUrl: () => "https://open.feishu.cn",
			request,
		});
		for (const [msgType, filePath] of [
			["image", "x.png"],
			["audio", "x.opus"],
			["media", "x.mp4"],
			["file", "x.pdf"],
		]) {
			const payload = await media.upload({}, { msgType, filePath, duration: 1000 });
			expect(payload.msg_type).toBe(msgType);
			expect(request.mock.calls.at(-1)?.[1].body).toBeInstanceOf(FormData);
		}
		await expect(media.upload({}, { msgType: "audio", filePath: "x.mp3", duration: 1000 })).rejects.toThrow("opus");
		request.mockResolvedValue(new Response("denied", { status: 403 }));
		await expect(media.download({}, { messageId: "m", key: "k", type: "image", name: "x.png" })).rejects.toThrow("403");
	});
});
