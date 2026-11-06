import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, stat: vi.fn(actual.stat) };
});
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMessageBotBridge, sendMacOSIMessage } from "../../plugins/imessage/index.mjs";

function setup(chat?: any) {
	const exec = vi.fn().mockResolvedValue({ stdout: "[]" });
	const host = {
		chat: chat || vi.fn().mockResolvedValue({ conversationId: "real", runId: "run" }),
		abortRun: vi.fn().mockResolvedValue({ ok: true }),
		cwd: process.cwd(),
	};
	const bridge = new IMessageBotBridge({ host, getConfig: () => ({}), execFileImpl: exec });
	return { bridge, exec, host };
}
const msg = (text: string, chatId = "room", extra: any = {}) => ({ sender: "a@example.com", chatId, text, ...extra });

describe("iMessage command, routing and media behavior", () => {
	it("buffers early completion and uses runId after takeover", async () => {
		const { bridge, exec, host } = setup();
		host.chat = vi.fn(async () => {
			await bridge.handleRunEvent({
				type: "message",
				conversationId: "real",
				runId: "r",
				message: { role: "assistant", content: "answer" },
			});
			await bridge.handleRunEvent({ type: "run_end", conversationId: "moved", runId: "r" });
			return { conversationId: "real", runId: "r" };
		});
		await bridge.onInboundMessage(msg("hello"));
		expect(exec).toHaveBeenCalledTimes(1);
		expect(exec.mock.calls[0][1][1]).toContain("answer");
		expect(exec.mock.calls[0][1][1]).toContain('chat id "room"');
		expect(bridge.getStatus().messagesReplied).toBe(1);
		await bridge.onInboundMessage(msg("next"));
		expect(host.chat.mock.calls[1][0].conversationId).toBe("moved");
	});
	it("isolates the same sender across rooms and threads and ignores foreign runs", async () => {
		const { bridge, exec, host } = setup();
		let i = 0;
		host.chat = vi.fn(async () => ({ conversationId: `c${++i}`, runId: `r${i}` }));
		await bridge.onInboundMessage(msg("one", "roomA"));
		await bridge.onInboundMessage(msg("two", "roomB"));
		await bridge.onInboundMessage(msg("three", "roomA", { threadId: "thread" }));
		expect(new Set(host.chat.mock.calls.map((c: any) => c[0].accountId)).size).toBe(3);
		await bridge.handleRunEvent({ type: "run_end", conversationId: "c1", runId: "foreign" });
		expect(exec).not.toHaveBeenCalled();
		await bridge.handleRunEvent({
			type: "message",
			conversationId: "new-owner",
			runId: "r2",
			message: { role: "assistant", content: "B only" },
		});
		await bridge.handleRunEvent({ type: "run_end", conversationId: "new-owner", runId: "r2" });
		expect(exec.mock.calls[0][1][1]).toContain('chat id "roomB"');
	});
	it("unknown slash commands and invalid settings never reach the model", async () => {
		const { bridge, exec, host } = setup();
		for (const text of ["/bogus", "/thinking wrong", "/model missing-provider", "/cwd /no/such/path"]) {
			await bridge.onInboundMessage(msg(text));
		}
		expect(host.chat).not.toHaveBeenCalled();
		expect(exec).toHaveBeenCalledTimes(4);
		await bridge.onInboundMessage(msg("/model provider/model"));
		await bridge.onInboundMessage(msg("/thinking high"));
		await bridge.onInboundMessage(msg("hello"));
		expect(host.chat).toHaveBeenCalledWith(expect.objectContaining({ model: "provider/model", thinkingLevel: "high" }));
		await bridge.onInboundMessage(msg("/abort"));
		expect(host.abortRun).toHaveBeenCalledWith("run");
	});
	it("sends actual imageData and local file references, reports unsupported attachments", async () => {
		const dir = await mkdtemp(join(tmpdir(), "imessage-media-"));
		try {
			const path = join(dir, "x.png");
			await writeFile(path, Buffer.from("image"));
			const { bridge, host } = setup();
			await bridge.onInboundMessage(msg("", "room", { attachments: [{ path, mimeType: "image/png" }] }));
			expect(host.chat.mock.calls[0][0].attachments).toEqual([
				{ path: "", imageData: Buffer.from("image").toString("base64"), mimeType: "image/png", name: "x.png" },
			]);
			const other = setup();
			await other.bridge.onInboundMessage(msg("", "room", { attachments: [{ path, mimeType: "audio/mp4" }] }));
			expect(other.host.chat.mock.calls[0][0].attachments[0]).toMatchObject({ path, mode: "reference" });
			const unknown = setup();
			await unknown.bridge.onInboundMessage(msg("", "room", { attachments: [{ path, mimeType: "unknown" }] }));
			expect(unknown.host.chat).not.toHaveBeenCalled();
			expect(unknown.exec.mock.calls[0][1][1]).toContain("不支持");
			const send = vi.fn().mockResolvedValue({});
			await sendMacOSIMessage({ chatId: "group" }, "", { execFileImpl: send, file: path });
			expect(send.mock.calls[0][1][1]).toContain("POSIX file");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("reports dispatch errors and delivery failures", async () => {
		const { bridge, exec } = setup(vi.fn().mockRejectedValue(new Error("denied")));
		await bridge.onInboundMessage(msg("hello"));
		expect(exec.mock.calls[0][1][1]).toContain("denied");
		exec.mockRejectedValueOnce(new Error("automation denied"));
		await expect(bridge.onInboundMessage(msg("/help"))).rejects.toThrow("automation denied");
		expect(bridge.getStatus().lastError).toContain("automation denied");
	});
	const resets = ["/new", "/clear", "/reset", `/cwd ${process.cwd()}`, `/workspace ${process.cwd()}`];
	it.each(resets)("%s starts fresh history and retains the new binding on follow-up", async (command) => {
		const accounts = new Map<string, string>();
		let sequence = 0;
		const { bridge, host } = setup(
			vi.fn(async (request: any) => {
				expect(request.accountId).toMatch(/^im_/);
				if (!accounts.has(request.accountId)) accounts.set(request.accountId, `conversation-${accounts.size}`);
				return {
					conversationId: request.conversationId || accounts.get(request.accountId),
					runId: `run-${++sequence}`,
				};
			}),
		);
		const finish = async () => {
			const receipt = await host.chat.mock.results.at(-1)!.value;
			await bridge.handleRunEvent({ type: "run_end", ...receipt });
		};
		await bridge.onInboundMessage(msg("first"));
		await finish();
		await bridge.onInboundMessage(msg(command.replace(/^\/\w+/, (name) => name.toUpperCase())));
		await bridge.onInboundMessage(msg("second"));
		const first = host.chat.mock.calls[0][0],
			second = host.chat.mock.calls[1][0];
		expect(second.accountId).not.toBe(first.accountId);
		expect(second.conversationId).toBeUndefined();
		if (/^\/(cwd|workspace)/.test(command)) expect(second.cwd).toBe(process.cwd());
		await finish();
		await bridge.onInboundMessage(msg("follow-up"));
		expect(host.chat.mock.calls[2][0]).toMatchObject({ accountId: second.accountId, conversationId: "conversation-1" });
	});
	it.each(resets)("%s bypasses pending dispatch and invalidates queued work and late events", async (command) => {
		let resolveChat!: (receipt: any) => void;
		const { bridge, host, exec } = setup(
			vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							resolveChat = resolve;
						}),
				)
				.mockResolvedValue({ conversationId: "fresh", runId: "fresh-run" }),
		);
		const pending = bridge.onInboundMessage(msg("old"));
		await vi.waitFor(() => expect(host.chat).toHaveBeenCalledTimes(1));
		const queued = bridge.onInboundMessage(msg("old queued"));
		await bridge.onInboundMessage(msg(command));
		await bridge.onInboundMessage(msg("fresh"));
		expect(host.chat).toHaveBeenCalledTimes(2);
		expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
		expect(host.chat.mock.calls[1][0].conversationId).toBeUndefined();
		resolveChat({ conversationId: "old", runId: "old-run" });
		await Promise.all([pending, queued]);
		expect(host.abortRun).toHaveBeenCalledWith("old-run");
		const replies = exec.mock.calls.length;
		await bridge.handleRunEvent({
			type: "message",
			runId: "old-run",
			conversationId: "old",
			message: { role: "assistant", content: "stale" },
		});
		await bridge.handleRunEvent({ type: "run_end", runId: "old-run", conversationId: "old" });
		expect(exec).toHaveBeenCalledTimes(replies);
		await bridge.handleRunEvent({ type: "run_end", runId: "fresh-run", conversationId: "fresh" });
		await bridge.onInboundMessage(msg("follow-up"));
		expect(host.chat).toHaveBeenCalledTimes(3);
		expect(host.chat.mock.calls[2][0].conversationId).toBe("fresh");
	});
	it.each(resets.slice(3))("%s explicitly refuses to change directory during a running task", async (command) => {
		const { bridge, host, exec } = setup();
		await bridge.onInboundMessage(msg("first"));
		await bridge.onInboundMessage(msg(command));
		expect(exec.mock.calls.at(-1)![1][1]).toContain("请先 /stop");
		await bridge.handleRunEvent({ type: "run_end", runId: "run", conversationId: "real" });
		await bridge.onInboundMessage(msg("follow-up"));
		expect(host.chat.mock.calls[1][0]).toMatchObject({
			accountId: host.chat.mock.calls[0][0].accountId,
			conversationId: "real",
		});
	});
	it.each(["/new", "/clear", "/reset", "/NEW", "/CLEAR", "/RESET", "／ｒｅｓｅｔ"])(
		"%s resets a running task before abort completes and ignores late events",
		async (command) => {
			const { bridge, host, exec } = setup(
				vi
					.fn()
					.mockResolvedValueOnce({ conversationId: "old", runId: "old-run" })
					.mockResolvedValue({ conversationId: "fresh", runId: "fresh-run" }),
			);
			let finishAbort!: (result: any) => void;
			host.abortRun.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishAbort = resolve;
					}),
			);
			await bridge.onInboundMessage(msg("old"));
			const resetting = bridge.onInboundMessage(msg(command));
			expect(host.abortRun).toHaveBeenCalledWith("old-run");
			expect(bridge.pendingRuns.size).toBe(0);
			await bridge.handleRunEvent({ type: "run_end", runId: "old-run", conversationId: "old-moved" });
			await bridge.onInboundMessage(msg("fresh"));
			expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
			expect(host.chat.mock.calls[1][0].conversationId).toBeUndefined();
			finishAbort({ ok: true });
			await resetting;
			const replies = exec.mock.calls.length;
			await bridge.handleRunEvent({
				type: "message",
				runId: "old-run",
				conversationId: "old-moved",
				message: { role: "assistant", content: "stale" },
			});
			await bridge.handleRunEvent({ type: "run_end", runId: "old-run", conversationId: "old-moved" });
			expect(exec).toHaveBeenCalledTimes(replies);
			await bridge.handleRunEvent({ type: "run_end", runId: "fresh-run", conversationId: "fresh" });
			await bridge.onInboundMessage(msg("follow-up"));
			expect(host.chat.mock.calls[2][0]).toMatchObject({
				accountId: host.chat.mock.calls[1][0].accountId,
				conversationId: "fresh",
			});
		},
	);
	it.each(["rejected", "thrown", "unsupported"])(
		"reports %s abort failure while keeping the new session detached",
		async (failure) => {
			const { bridge, host, exec } = setup();
			if (failure === "thrown") host.abortRun.mockRejectedValueOnce(new Error("abort denied"));
			else
				host.abortRun.mockResolvedValueOnce(
					failure === "unsupported" ? undefined : { ok: false, error: "abort denied" },
				);
			await bridge.onInboundMessage(msg("old"));
			await bridge.onInboundMessage(msg("/clear"));
			expect(exec.mock.calls.at(-1)![1][1]).toContain("旧任务停止失败");
			expect(bridge.pendingRuns.size).toBe(0);
			await bridge.handleRunEvent({ type: "run_end", runId: "run", conversationId: "old-moved" });
			await bridge.onInboundMessage(msg("fresh"));
			expect(host.chat.mock.calls[1][0].conversationId).toBeUndefined();
			expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
		},
	);
	it.each(resets)("%s invalidates attachment preparation without affecting another room", async (command) => {
		const dir = await mkdtemp(join(tmpdir(), "imessage-reset-"));
		try {
			const path = join(dir, "audio.mp4");
			await writeFile(path, Buffer.from("audio"));
			let sequence = 0;
			const { bridge, host, exec } = setup(
				vi.fn(async () => ({ conversationId: `c-${++sequence}`, runId: `r-${sequence}` })),
			);
			let release!: (result: any) => void;
			exec.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			);
			const pending = bridge.onInboundMessage(
				msg("old attachment", "room", { attachments: [{ path, mimeType: "audio/mp4" }] }),
			);
			await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
			await bridge.onInboundMessage(msg("other room", "other"));
			await bridge.onInboundMessage(msg(command));
			await bridge.onInboundMessage(msg("fresh"));
			release({ stdout: "[]" });
			await pending;
			expect(host.chat.mock.calls.map((call: any) => call[0].text)).toEqual(["other room", "fresh"]);
			expect(bridge.pendingRuns.size).toBe(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it.each(["/new", "/clear", "/reset", "/NEW", "／ＣＬＥＡＲ", "/ｒｅｓｅｔ"])(
		"%s executes its prompt literally in the new account",
		async (command) => {
			const { bridge, host } = setup(
				vi
					.fn()
					.mockResolvedValueOnce({ conversationId: "old", runId: "old-run" })
					.mockResolvedValue({ conversationId: "fresh", runId: "fresh-run" }),
			);
			await bridge.onInboundMessage(msg("old"));
			const prompt = "/stop  preserve\n  spacing Ａ  ";
			await bridge.onInboundMessage(msg(`${command} ${prompt}`));
			expect(host.abortRun).toHaveBeenCalledTimes(1);
			expect(host.chat).toHaveBeenCalledTimes(2);
			expect(host.chat.mock.calls[1][0].text).toBe(prompt);
			expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
			expect(host.chat.mock.calls[1][0].conversationId).toBeUndefined();
		},
	);
	it.each([
		"/MODEL Provider/CaseSensitive",
		"／ｍｏｄｅｌ DEFAULT",
		"/THINKING HIGH",
		"／ＴＨＩＮＫＩＮＧ ＤＥＦＡＵＬＴ",
	])("%s resets running context and applies normalized settings", async (command) => {
		const { bridge, host } = setup(
			vi
				.fn()
				.mockResolvedValueOnce({ conversationId: "old", runId: "old-run" })
				.mockResolvedValue({ conversationId: "fresh", runId: "fresh-run" }),
		);
		await bridge.onInboundMessage(msg("/model previous/model"));
		await bridge.onInboundMessage(msg("/thinking low"));
		await bridge.onInboundMessage(msg("old"));
		await bridge.onInboundMessage(msg(command));
		await bridge.handleRunEvent({ type: "run_end", runId: "old-run", conversationId: "old-moved" });
		await bridge.onInboundMessage(msg("fresh"));
		const request = host.chat.mock.calls[1][0];
		expect(request.accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
		expect(request.conversationId).toBeUndefined();
		expect(host.abortRun).toHaveBeenCalledWith("old-run");
		if (command.includes("CaseSensitive")) expect(request.model).toBe("Provider/CaseSensitive");
		else if (command.includes("HIGH")) expect(request.thinkingLevel).toBe("high");
		else if (command.includes("ｍｏｄｅｌ")) expect(request.model).toBeUndefined();
		else expect(request.thinkingLevel).toBeUndefined();
	});
	it.each(["／ＣＷＤ", "/ｗｏｒｋｓｐａｃｅ"])(
		"%s supports default and leaves getters in the same context",
		async (command) => {
			const dir = await mkdtemp(join(tmpdir(), "imessage-workspace-"));
			try {
				const { bridge, host } = setup();
				await bridge.onInboundMessage(msg(`${command} ${dir}`));
				await bridge.onInboundMessage(msg("first"));
				expect(host.chat.mock.calls[0][0].cwd).toBe(dir);
				await bridge.handleRunEvent({ type: "run_end", runId: "run", conversationId: "real" });
				await bridge.onInboundMessage(msg(`${command} DEFAULT`));
				await bridge.onInboundMessage(msg("second"));
				expect(host.chat.mock.calls[1][0].cwd).toBe(process.cwd());
				expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
				await bridge.handleRunEvent({ type: "run_end", runId: "run", conversationId: "real" });
				for (const getter of [command, "/model", "/thinking"]) await bridge.onInboundMessage(msg(getter));
				await bridge.onInboundMessage(msg("third"));
				expect(host.chat.mock.calls[2][0]).toMatchObject({
					accountId: host.chat.mock.calls[1][0].accountId,
					conversationId: "real",
				});
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	);
	it.each(["/model Provider/Exact", "/thinking HIGH"])(
		"%s invalidates an unresolved dispatch and its queued messages",
		async (command) => {
			let finishChat!: (receipt: any) => void;
			const { bridge, host } = setup(
				vi
					.fn()
					.mockImplementationOnce(
						() =>
							new Promise((resolve) => {
								finishChat = resolve;
							}),
					)
					.mockResolvedValue({ conversationId: "fresh", runId: "fresh-run" }),
			);
			const old = bridge.onInboundMessage(msg("old"));
			await vi.waitFor(() => expect(host.chat).toHaveBeenCalledTimes(1));
			const queued = bridge.onInboundMessage(msg("stale queued"));
			await bridge.onInboundMessage(msg(command));
			await bridge.onInboundMessage(msg("fresh"));
			finishChat({ conversationId: "old", runId: "old-run" });
			await Promise.all([old, queued]);
			expect(host.abortRun).toHaveBeenCalledWith("old-run");
			expect(host.chat.mock.calls.map((call: any) => call[0].text)).toEqual(["old", "fresh"]);
			expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
			expect(host.chat.mock.calls[1][0].conversationId).toBeUndefined();
		},
	);
	it("late directory validation cannot override a newer reset", async () => {
		const { bridge, host } = setup();
		let finishStat!: (value: any) => void;
		vi.mocked(stat).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishStat = resolve;
				}),
		);
		const pending = bridge.onInboundMessage(msg("/workspace /late-directory"));
		await bridge.onInboundMessage(msg("/reset /stop"));
		finishStat({ isDirectory: () => true });
		await pending;
		expect(host.chat).toHaveBeenCalledTimes(1);
		expect(host.chat.mock.calls[0][0]).toMatchObject({ text: "/stop", cwd: process.cwd() });
		await bridge.handleRunEvent({ type: "run_end", runId: "run", conversationId: "real" });
		await bridge.onInboundMessage(msg("follow-up"));
		expect(host.chat.mock.calls[1][0]).toMatchObject({
			cwd: process.cwd(),
			accountId: host.chat.mock.calls[0][0].accountId,
			conversationId: "real",
		});
	});
	it.each(["/new", "/clear", "/reset", "/model provider/new", "/thinking HIGH"])(
		"%s stops remaining old reply chunks after a blocked send",
		async (command) => {
			const { bridge, host, exec } = setup();
			await bridge.onInboundMessage(msg("old"));
			await bridge.handleRunEvent({
				type: "message",
				runId: "run",
				conversationId: "real",
				message: { role: "assistant", content: "old output ".repeat(1000) },
			});
			let release!: (result: any) => void;
			exec.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			);
			const sending = bridge.handleRunEvent({ type: "run_end", runId: "run", conversationId: "real" });
			expect(exec).toHaveBeenCalledTimes(1);
			await bridge.onInboundMessage(msg(command));
			const replies = exec.mock.calls.length;
			release({ stdout: "[]" });
			await sending;
			expect(exec).toHaveBeenCalledTimes(replies);
			expect(bridge.getStatus().messagesReplied).toBe(0);
			await bridge.onInboundMessage(msg("fresh"));
			expect(host.chat.mock.calls[1][0].conversationId).toBeUndefined();
			expect(host.chat.mock.calls[1][0].accountId).not.toBe(host.chat.mock.calls[0][0].accountId);
		},
	);
	it("stop bypasses an unresolved chat receipt and aborts it when it arrives", async () => {
		let resolveChat: any;
		const { bridge, host, exec } = setup(
			vi.fn(
				() =>
					new Promise((resolve) => {
						resolveChat = resolve;
					}),
			),
		);
		const pending = bridge.onInboundMessage(msg("hello"));
		await vi.waitFor(() => expect(host.chat).toHaveBeenCalled());
		await bridge.onInboundMessage(msg("/stop"));
		expect(exec).toHaveBeenCalled();
		resolveChat({ conversationId: "late", runId: "late-run" });
		await pending;
		expect(host.abortRun).toHaveBeenCalledWith("late-run");
		expect(bridge.pendingRuns.size).toBe(0);
	});
	it("polls Messages database read-only and routes group messages", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({ stdout: '[{"id":10}]' })
			.mockResolvedValueOnce({ stdout: '[{"id":11,"sender":"a","chatId":"group","text":"/help","is_from_me":0}]' })
			.mockResolvedValue({ stdout: "[]" });
		const bridge = new IMessageBotBridge({ host: {}, getConfig: () => ({}), execFileImpl: exec, platform: "darwin" });
		await bridge.start();
		await bridge.poll();
		await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(3));
		await bridge.stop();
		expect(exec.mock.calls[0][1]).toContain("-readonly");
		expect(exec.mock.calls[2][1][1]).toContain('chat id "group"');
	});
});
