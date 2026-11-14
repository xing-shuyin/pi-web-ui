import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordBotBridge } from "../../plugins/discord/index.mjs";
import { SlackBotBridge } from "../../plugins/slack/index.mjs";
import { downloadMedia as discordDownload, sendMedia as discordSend } from "../../plugins/discord/channel-behavior.mjs";
import { downloadMedia as slackDownload, sendMedia as slackSend } from "../../plugins/slack/channel-behavior.mjs";

afterEach(() => vi.unstubAllGlobals());

for (const platform of ["discord", "slack"] as const) {
	function setup() {
		const host = {
			cwd: process.cwd(),
			chat: vi.fn(async (_req: any) => ({ conversationId: "real", runId: "stable" })),
			abortRun: vi.fn(async () => ({ ok: true })),
			fs: {
				statPath: vi.fn(async () => ({ type: "dir" })),
				mkdirPath: vi.fn(),
				writePath: vi.fn(),
				readPath: vi.fn(async () => Buffer.from("image bytes")),
			},
			notify: vi.fn(),
		};
		const Bridge = platform === "discord" ? DiscordBotBridge : SlackBotBridge;
		const bridge: any = new Bridge({ host, getConfig: () => ({ allowAllSenders: true, botToken: "secret" }) });
		bridge.botUser = platform === "discord" ? { id: "bot" } : { user_id: "bot" };
		const reply = vi.fn<(route: any, text: string) => Promise<void>>().mockResolvedValue(undefined);
		bridge.reply = reply;
		const send = (text: string, channel = "one", thread = "t1", files: any[] = []) =>
			platform === "discord"
				? bridge.onInboundMessage({ author: { id: "user" }, channel_id: channel, content: text, attachments: files })
				: bridge.onInboundEvent({
						user: "user",
						channel,
						channel_type: "im",
						thread_ts: thread,
						ts: "ts",
						text,
						files,
					});
		return { host, bridge, reply, send };
	}
	describe(`${platform} channel behavior`, () => {
		it("consumes all commands and unknown slash commands without model dispatch", async () => {
			const { send, host, reply } = setup();
			for (const text of [
				"/help",
				"/new",
				"/clear",
				"/status",
				"/stop",
				"/abort",
				"/model provider/model",
				"/thinking high",
				"/cwd",
				"/thinking invalid",
				"/unknown",
			])
				await send(text);
			expect(host.chat).not.toHaveBeenCalled();
			expect(host.abortRun).not.toHaveBeenCalled();
			expect(reply.mock.calls.at(-1)?.[1]).toContain("Unknown command");
			await send("hello");
			expect(host.chat.mock.calls[0][0]).toMatchObject({ model: "provider/model", thinkingLevel: "high" });
		});
		it("replays early message and run_end by runId despite all conversation IDs differing", async () => {
			const { bridge, host, send, reply } = setup();
			host.chat.mockImplementationOnce(async () => {
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "before-takeover",
					runId: "stable",
					message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
				});
				await bridge.handleRunEvent({ type: "run_end", conversationId: "after-takeover", runId: "stable" });
				return { conversationId: "real", runId: "stable" };
			});
			await send("hello");
			expect(reply).toHaveBeenCalledTimes(1);
			expect(reply.mock.calls[0][1]).toBe("answer");
			await send("again");
			expect(host.chat.mock.calls[1][0].conversationId).toBe("real");
		});
		it("stops by receipt stable runId after conversation ownership moves", async () => {
			const { host, bridge, send, reply } = setup();
			host.chat.mockResolvedValueOnce({ conversationId: "receipt-conversation", runId: "pr-owned-run" });
			await send("hello");
			await bridge.handleRunEvent({
				type: "message",
				conversationId: "moved-conversation",
				runId: "pr-owned-run",
				message: { role: "assistant", content: "partial" },
			});
			await send("/stop");
			expect(host.abortRun).toHaveBeenLastCalledWith("pr-owned-run");
			await send("/abort");
			expect(host.abortRun).toHaveBeenLastCalledWith("pr-owned-run");
			await bridge.handleRunEvent({
				type: "run_end",
				conversationId: "moved-conversation",
				runId: "pr-owned-run",
				stopReason: "aborted",
			});
			await send("/stop");
			expect(host.abortRun).toHaveBeenCalledTimes(2);
			expect(reply.mock.calls.at(-1)?.[1]).toContain("Stop failed");
		});
		it("changes daemon account epoch on reset, cwd and model switches", async () => {
			const { host, bridge, send } = setup();
			host.chat.mockImplementation(async () => ({
				conversationId: `real-${host.chat.mock.calls.length}`,
				runId: `run-${host.chat.mock.calls.length}`,
			}));
			await send("hello");
			for (const command of ["/new", "/clear", `/cwd ${process.cwd()}`, "/model provider/new"]) {
				await bridge.handleRunEvent({ type: "run_end", runId: `run-${host.chat.mock.calls.length}` });
				await send(command);
				await send("hello again");
			}
			const accounts = host.chat.mock.calls.map(([req]) => req.accountId);
			expect(new Set(accounts).size).toBe(5);
		});
		it("stops a pending attachment download immediately and never dispatches after cancellation", async () => {
			const { host, send, reply } = setup();
			let entered!: () => void;
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			vi.stubGlobal(
				"fetch",
				vi.fn(
					(_url, init) =>
						new Promise((_resolve, reject) => {
							init.signal.addEventListener("abort", () => reject(new Error("download aborted")), { once: true });
							entered();
						}),
				),
			);
			const task = send("", "one", "t1", [
				{
					url:
						platform === "discord"
							? "https://cdn.discordapp.com/attachments/file"
							: "https://files.slack.com/files-pri/file",
				},
			]);
			await started;
			await send("/stop");
			await task;
			expect(host.chat).not.toHaveBeenCalled();
			expect(reply.mock.calls.some((call) => call[1].includes("Download cancelled"))).toBe(true);
		});
		it("retains the last early assistant candidate and terminal failure beyond 512 events", async () => {
			const { bridge, host, send, reply } = setup();
			host.chat.mockImplementationOnce(async () => {
				for (let i = 0; i < 600; i++)
					await bridge.handleRunEvent({
						type: "message",
						runId: "stable",
						message: { role: "assistant", content: `${i}:${"x".repeat(1000)}` },
					});
				await bridge.handleRunEvent({ type: "run_end", runId: "stable", stopReason: "error" });
				return { conversationId: "real", runId: "stable" };
			});
			await send("hello");
			expect(reply).toHaveBeenCalledTimes(1);
			expect(reply.mock.calls[0][1]).toBe(`599:${"x".repeat(1000)}\n\nRun failed. Check host logs.`);
			expect(reply.mock.calls[0][1]).not.toContain("Output truncated");
			await send("again");
			expect(host.chat).toHaveBeenCalledTimes(2);
		});
		it("truncates a single oversized early assistant candidate and preserves terminal failure", async () => {
			const { bridge, host, send, reply } = setup();
			host.chat.mockImplementationOnce(async () => {
				await bridge.handleRunEvent({
					type: "message",
					runId: "stable",
					message: { role: "assistant", content: "x".repeat(300 * 1024) },
				});
				await bridge.handleRunEvent({ type: "run_end", runId: "stable", stopReason: "error" });
				return { conversationId: "real", runId: "stable" };
			});
			await send("hello");
			expect(reply).toHaveBeenCalledTimes(1);
			expect(reply.mock.calls[0][1]).toBe(
				`${"x".repeat(256 * 1024)}\n\nOutput truncated; inspect host conversation for full result.\n\nRun failed. Check host logs.`,
			);
		});
		it("never claims an unknown runId by matching the owned conversation", async () => {
			const { bridge, send, reply, host } = setup();
			await send("hello");
			for (const event of [
				{ type: "message", message: { role: "assistant", content: "foreign answer" } },
				{ type: "run_end" },
			])
				await bridge.handleRunEvent({ ...event, conversationId: "real", runId: "foreign" });
			expect(reply).not.toHaveBeenCalled();
			await send("/stop");
			expect(host.abortRun).toHaveBeenCalledExactlyOnceWith("stable");
		});
		it("routes a web run by exact session identity but refuses to guess an abort target", async () => {
			const { bridge, send, reply, host } = setup();
			host.chat.mockResolvedValueOnce({ conversationId: "real", runId: "stable", sessionId: "session-owned" } as any);
			await send("hello");
			await bridge.handleRunEvent({ type: "run_end", runId: "stable" });
			reply.mockClear();
			await bridge.handleRunEvent({ type: "run_start", conversationId: "real", sessionId: "session-owned" });
			await send("/stop");
			expect(host.abortRun).not.toHaveBeenCalled();
			expect(reply.mock.calls.at(-1)?.[1]).toContain("Stop failed");
			await bridge.handleRunEvent({
				type: "message",
				conversationId: "real",
				sessionId: "session-owned",
				message: { role: "assistant", content: "web answer" },
			});
			await bridge.handleRunEvent({ type: "run_end", conversationId: "real", sessionId: "session-owned" });
			expect(reply.mock.calls.at(-1)?.[1]).toBe("web answer");
		});
		it("isolates same-user channels and threads, routes moved runs to original destination", async () => {
			const { bridge, host, send, reply } = setup();
			host.chat.mockImplementation(async () => ({
				conversationId: `actual-${host.chat.mock.calls.length}`,
				runId: `run-${host.chat.mock.calls.length}`,
			}));
			await send("hello", "one", "t1");
			await send("hello", platform === "slack" ? "one" : "two", "t2");
			const requests = host.chat.mock.calls.map(([req]) => req);
			expect(requests[0].accountId).not.toBe(requests[1].accountId);
			expect(requests[0].conversationId).not.toBe(requests[1].conversationId);
			await bridge.handleRunEvent({
				type: "message",
				conversationId: "moved",
				runId: "run-1",
				message: { role: "assistant", content: "first" },
			});
			await bridge.handleRunEvent({ type: "run_end", conversationId: "moved", runId: "run-1" });
			expect(reply.mock.calls[0][0]).toMatchObject({
				channelId: "one",
				...(platform === "slack" ? { threadTs: "t1" } : {}),
			});
			expect(reply.mock.calls[0][1]).toBe("first");
		});
		it("reports rejected dispatch and download failures without pretending success", async () => {
			const { host, send, reply } = setup();
			host.chat.mockRejectedValueOnce(new Error("model unavailable"));
			await send("hello");
			expect(reply.mock.calls.at(-1)?.[1]).toContain("model unavailable");
			await send("", "one", "t1", [{ url: "https://evil.example/file" }]);
			expect(reply.mock.calls.at(-1)?.[1]).toContain("Untrusted attachment");
			expect(host.chat).toHaveBeenCalledTimes(1);
		});
		it("downloads attachment-only messages and sends a local read path with explicit decoding limits", async () => {
			const { host, send, reply } = setup();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response("media bytes")),
			);
			const url =
				platform === "discord"
					? "https://cdn.discordapp.com/attachments/file"
					: "https://files.slack.com/files-pri/file";
			await send("", "one", "t1", [
				{ url, name: "voice.ogg", filename: "voice.ogg", mimetype: "audio/ogg", content_type: "audio/ogg" },
			]);
			expect(host.fs.writePath).toHaveBeenCalledTimes(1);
			expect(host.chat.mock.calls[0][0].text).toContain("Use read with this path");
			expect(host.chat.mock.calls[0][0].attachments[0]).toMatchObject({ mode: "reference", name: "voice.ogg" });
			expect(reply.mock.calls[0][1]).toContain("not automatically decoded");
		});
		it("passes downloaded images as imageData attachments and enforces image count", async () => {
			const { host, send, bridge, reply } = setup();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response("image bytes")),
			);
			const file = {
				url:
					platform === "discord"
						? "https://cdn.discordapp.com/attachments/image"
						: "https://files.slack.com/files-pri/image",
				name: "x.png",
				content_type: "image/png",
				mimetype: "image/png",
			};
			await send("", "one", "t1", [file]);
			expect(host.chat.mock.calls[0][0].attachments[0]).toMatchObject({
				imageData: Buffer.from("image bytes").toString("base64"),
				mimeType: "image/png",
				name: "x.png",
			});
			await bridge.handleRunEvent({ type: "run_end", runId: "stable" });
			await send("", "one", "t1", Array(9).fill(file));
			expect(host.chat).toHaveBeenCalledTimes(1);
			expect(reply.mock.calls.at(-1)?.[1]).toContain("Image limit");
		});
	});
}

for (const [platform, download, send] of [
	["discord", discordDownload, discordSend],
	["slack", slackDownload, slackSend],
] as const) {
	it(`${platform} uploads real bytes and rejects oversized media`, async () => {
		const host = {
			fs: { statPath: vi.fn(async () => ({ type: "file", size: 3 })), readPath: vi.fn(async () => Buffer.from("abc")) },
		};
		const api = vi.fn(async (_token: any, method: any, _payload: any) =>
			method === "files.getUploadURLExternal"
				? { upload_url: "https://files.slack.com/upload/test", file_id: "file-id" }
				: { ok: true },
		);
		const fetch = vi.fn(async (_url: any, _init: any) => new Response(JSON.stringify({ id: "sent" }), { status: 200 }));
		vi.stubGlobal("fetch", fetch);
		await send(
			host,
			platform,
			api,
			{ botToken: "secret" },
			{ channelId: "target", threadTs: "thread" },
			{ file: "image.png", text: "caption" },
		);
		if (platform === "discord") expect(fetch.mock.calls[0][1].body).toBeInstanceOf(FormData);
		else {
			expect(fetch.mock.calls[0][1].body).toEqual(Buffer.from("abc"));
			expect(api.mock.calls.at(-1)?.[2]).toMatchObject({
				channel_id: "target",
				thread_ts: "thread",
				files: [{ id: "file-id", title: "image.png" }],
			});
		}
		host.fs.statPath.mockResolvedValueOnce({ type: "file", size: 21 * 1024 * 1024 });
		await expect(send(host, platform, api, {}, {}, { file: "large.mp4" })).rejects.toThrow("20 MiB");
		await expect(
			download(host, platform, "secret", process.cwd(), { url: "https://evil.example/file" }),
		).rejects.toThrow("Untrusted");
	});
}
