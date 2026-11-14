import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import activate, { TelegramBotBridge } from "../../plugins/telegram/index.mjs";
import { uploadMedia, validateWorkspace } from "../../plugins/telegram/channel-behavior.mjs";

let workspace: string;
let fetchMock: any;
const msg = (text = "hello", chat = 1, thread = 0) => ({
	message_id: 10,
	chat: { id: chat, type: chat === 1 ? "private" : "supergroup" },
	from: { id: 9 },
	text,
	message_thread_id: thread,
});
function setup(chat?: any) {
	let index = 0;
	const host = {
		cwd: workspace,
		chat: chat || vi.fn(async () => ({ conversationId: `actual-${++index}`, runId: `run-${index}` })),
		abortRun: vi.fn(async () => ({ ok: true })),
		models: { list: async () => [{ provider: "p", id: "m" }] },
	};
	const bridge = new TelegramBotBridge({
		host,
		getConfig: () => ({ allowAllSenders: true, botToken: "token" }),
		log: vi.fn(),
	});
	bridge.status.botUsername = "mybot";
	return { bridge, host };
}
const sent = (): any[] =>
	fetchMock.mock.calls
		.filter(([url]: any[]) => url.endsWith("/sendMessage"))
		.map(([, init]: any[]) => JSON.parse(init.body));
beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "telegram-behavior-"));
	fetchMock = vi.fn(async (url: string) =>
		url.includes("/file/bot")
			? new Response(Buffer.from("media"))
			: new Response(JSON.stringify({ ok: true, result: { file_path: "media/sample.png" } }), {
					headers: { "content-type": "application/json" },
				}),
	);
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(workspace, { recursive: true, force: true });
});
describe("Telegram channel behavior", () => {
	it("uses receipt IDs, buffers early completion and follows runId across conversation renames", async () => {
		let bridge: any;
		const chat = vi.fn(async (_req: any) => {
			await bridge.handleRunEvent({
				runId: "stable",
				conversationId: "actual",
				type: "message",
				message: { role: "assistant", content: "early answer" },
			});
			await bridge.handleRunEvent({ runId: "stable", conversationId: "renamed", type: "run_end" });
			return { conversationId: "actual", runId: "stable" };
		});
		bridge = setup(chat).bridge;
		await bridge.onInboundMessage(msg());
		expect(sent()[0].text).toBe("early answer");
		expect(bridge.pendingRuns.size).toBe(0);
		await bridge.onInboundMessage(msg("next"));
		expect(chat.mock.calls[1][0].conversationId).toBe("renamed");
	});
	it("isolates account and continuation by chat, thread and user, and replies into the same topic", async () => {
		const { bridge, host } = setup();
		await bridge.onInboundMessage(msg("@mybot one", -1, 4));
		await bridge.onInboundMessage(msg("@mybot two", -1, 5));
		await bridge.onInboundMessage(msg("@mybot three", -2, 4));
		expect(new Set(host.chat.mock.calls.map((c: any) => c[0].accountId)).size).toBe(3);
		for (let i = 1; i <= 3; i++)
			await bridge.handleRunEvent({ runId: `run-${i}`, conversationId: `moved-${i}`, type: "run_end" });
		expect(sent().map((p) => [p.chat_id, p.message_thread_id])).toEqual([
			[-1, 4],
			[-1, 5],
			[-2, 4],
		]);
		await bridge.onInboundMessage(msg("@mybot again", -1, 4));
		expect(host.chat.mock.calls[3][0].conversationId).toBe("moved-1");
	});
	it("handles bot-suffixed commands, unknown commands and commands aimed at another bot without model dispatch", async () => {
		const { bridge, host } = setup();
		for (const command of ["/help@mybot", "/status@mybot", "/bogus@mybot", "/help@otherbot"])
			await bridge.onInboundMessage(msg(command, -1, 3));
		expect(host.chat).not.toHaveBeenCalled();
		expect(sent()).toHaveLength(3);
		expect(sent()[2].text).toContain("Unknown command");
	});
	it("keeps model, thinking and cwd preferences per peer and validates input before changing state", async () => {
		const { bridge, host } = setup();
		for (const command of ["/model p/m", "/thinking high", `/cwd ${workspace}`])
			await bridge.onInboundMessage(msg(command));
		await bridge.onInboundMessage(msg());
		expect(host.chat.mock.calls[0][0]).toMatchObject({ model: "p/m", thinkingLevel: "high", cwd: workspace });
		await bridge.onInboundMessage(msg("@mybot hi", -2, 9));
		expect(host.chat.mock.calls[1][0].model).toBeUndefined();
		for (const command of ["/model fake/model", "/thinking impossible", "/cwd relative", `/cwd ${homedir()}`])
			await bridge.onInboundMessage(msg(command));
		expect(sent().filter((p) => p.text.startsWith("❌"))).toHaveLength(4);
	});
	it("aborts only the current peer, supports aliases and clears continuation while retaining preferences", async () => {
		const { bridge, host } = setup();
		await bridge.onInboundMessage(msg("/thinking low"));
		await bridge.onInboundMessage(msg());
		await bridge.onInboundMessage(msg("@mybot elsewhere", -1, 3));
		await bridge.onInboundMessage(msg("/abort"));
		expect(host.abortRun).toHaveBeenCalledExactlyOnceWith("run-1");
		expect(bridge.pendingRuns.has("run-2")).toBe(true);
		await bridge.onInboundMessage(msg("/clear"));
		await bridge.onInboundMessage(msg("next"));
		expect(host.chat.mock.calls[2][0]).toMatchObject({ thinkingLevel: "low" });
		expect(host.chat.mock.calls[2][0].conversationId).toBeUndefined();
		await bridge.onInboundMessage(msg("/new"));
		await bridge.onInboundMessage(msg("/stop"));
	});
	it("reports rejected dispatch, missing receipt, failed runs and abort failures", async () => {
		const { bridge, host } = setup(
			vi
				.fn()
				.mockRejectedValueOnce(new Error("dispatch denied"))
				.mockResolvedValueOnce({ conversationId: "missing-run" })
				.mockResolvedValue({ conversationId: "real", runId: "real-run" }),
		);
		await bridge.onInboundMessage(msg());
		await bridge.onInboundMessage(msg());
		await bridge.onInboundMessage(msg());
		host.abortRun.mockResolvedValueOnce({ ok: false, error: "abort denied" } as any);
		await bridge.onInboundMessage(msg("/stop"));
		await bridge.handleRunEvent({ runId: "real-run", type: "run_end", error: "stale failure" });
		expect(sent().some((p) => p.text.includes("stale failure"))).toBe(false);
		host.chat.mockResolvedValueOnce({ conversationId: "fresh", runId: "fresh-run" });
		await bridge.onInboundMessage(msg());
		await bridge.handleRunEvent({ runId: "fresh-run", type: "run_end", error: "agent failed" });
		expect(
			sent()
				.map((p) => p.text)
				.join("\n"),
		).toMatch(/dispatch denied[\s\S]*runId[\s\S]*abort denied[\s\S]*agent failed/);
	});
	it.each(["photo", "voice", "audio", "document", "video"])(
		"downloads %s and submits real attachments",
		async (kind) => {
			const { bridge, host } = setup();
			const media = {
				file_id: "file",
				file_name: "sample.png",
				mime_type: kind === "photo" ? "image/png" : "application/octet-stream",
			};
			await bridge.onInboundMessage({ ...msg("caption"), [kind]: kind === "photo" ? [media] : media });
			const request = host.chat.mock.calls[0][0];
			expect(request.attachments).toHaveLength(1);
			expect(request.text).toContain("Use read");
			const attachment = request.attachments[0];
			if (kind === "photo")
				expect(attachment).toMatchObject({
					path: "",
					imageData: Buffer.from("media").toString("base64"),
					mimeType: "image/png",
				});
			else {
				expect(attachment.mode).toBe("reference");
				expect(path.isAbsolute(attachment.path)).toBe(true);
				expect(await readFile(attachment.path, "utf8")).toBe("media");
				await rm(attachment.path);
			}
			if (["voice", "audio", "video"].includes(kind)) expect(request.text).toContain("cannot decode");
		},
	);
	it("rejects oversized images, download failures and unsupported messages with feedback", async () => {
		const { bridge, host } = setup();
		await bridge.onInboundMessage({ ...msg(""), photo: [{ file_id: "x", file_size: 21 * 1024 * 1024 }] });
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: "download denied" })));
		await bridge.onInboundMessage({ ...msg(""), document: { file_id: "x" } });
		await bridge.onInboundMessage({ ...msg(""), sticker: { file_id: "x" } });
		expect(host.chat).not.toHaveBeenCalled();
		expect(
			sent()
				.map((p) => p.text)
				.join("\n"),
		).toMatch(/20 MiB[\s\S]*download denied[\s\S]*Unsupported message/);
	});
	it("uploads local and URL media using multipart for common Telegram types", async () => {
		const file = path.join(workspace, "file.dat");
		await writeFile(file, "local");
		const api = vi.fn(async (..._args: any[]) => ({ ok: true }));
		for (const media_type of ["photo", "document", "voice", "audio", "video", "animation"]) {
			await uploadMedia(api, "token", { chat_id: "1", media: file, media_type }, {});
			const form = api.mock.calls.at(-1)![2] as any;
			expect(form.get(media_type)).toBeInstanceOf(Blob);
		}
		fetchMock.mockResolvedValueOnce(new Response("remote"));
		await uploadMedia(api, "token", { chat_id: "1", media: "https://example.com/video.mp4", media_type: "video" }, {});
		expect((api.mock.calls.at(-1)![2] as any).get("video").name).toBe("video.mp4");
	});
	it("exposes media upload through the telegram tool", async () => {
		const file = path.join(workspace, "image.png");
		await writeFile(file, "image");
		let tool: any;
		const dispose = await activate({
			storage: { get: async () => ({ botToken: "token" }) },
			registerTool: (t: any) => (tool = t),
		});
		await tool.execute({ action: "send", chat_id: "1", media: file, media_type: "photo" });
		expect(fetchMock.mock.calls.at(-1)[0]).toContain("/sendPhoto");
		expect(fetchMock.mock.calls.at(-1)[1].body).toBeInstanceOf(FormData);
		await dispose();
	});
	it("uses a new daemon account epoch after reset and preference changes", async () => {
		const { bridge, host } = setup();
		await bridge.onInboundMessage(msg());
		const first = host.chat.mock.calls[0][0].accountId;
		await bridge.onInboundMessage(msg("/new"));
		await bridge.onInboundMessage(msg());
		expect(host.chat.mock.calls[1][0].accountId).not.toBe(first);
		await bridge.onInboundMessage(msg("/clear"));
		await bridge.onInboundMessage(msg("/model p/m"));
		await bridge.onInboundMessage(msg());
		expect(new Set(host.chat.mock.calls.map((c: any) => c[0].accountId)).size).toBe(3);
	});
	it("stops a pending download immediately and never dispatches it afterward", async () => {
		const { bridge, host } = setup();
		let release: any;
		let started: any;
		const downloading = new Promise<void>((r) => (started = r));
		bridge.downloadMedia = vi.fn(async () => {
			started();
			await new Promise((r) => (release = r));
			return { prompt: "media", attachment: { path: "x", mode: "reference", name: "x" } };
		});
		const pending = bridge.onInboundMessage({ ...msg(""), document: { file_id: "x" } });
		await downloading;
		await bridge.onInboundMessage(msg("/stop"));
		expect(sent().at(-1).text).toContain("Stopped");
		release();
		await pending;
		expect(host.chat).not.toHaveBeenCalled();
	});
	it("preserves early terminal state after excessive assistant and tool events", async () => {
		let bridge: any;
		const chat = vi.fn(async () => {
			for (let i = 0; i < 350; i++) {
				await bridge.handleRunEvent({ runId: "burst", type: "tool_end" });
				await bridge.handleRunEvent({
					runId: "burst",
					type: "message",
					message: { role: "assistant", content: "partial" },
				});
			}
			await bridge.handleRunEvent({ runId: "burst", type: "run_end", aborted: true });
			return { conversationId: "actual", runId: "burst" };
		});
		bridge = setup(chat).bridge;
		await bridge.onInboundMessage(msg());
		expect(bridge.pendingRuns.size).toBe(0);
		expect(
			sent()
				.map((p) => p.text)
				.join(" "),
		).toContain("stopped before completion");
	});
	it("validates directory existence, file paths and roots", async () => {
		await expect(validateWorkspace(workspace)).resolves.toBe(workspace);
		await expect(validateWorkspace(path.parse(workspace).root)).rejects.toThrow();
		await expect(validateWorkspace(path.join(workspace, "missing"))).rejects.toThrow();
	});
});
