import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkMarkdownText } from "../../plugins/qq/markdown-chunks.mjs";
import activate, {
	checkCwdValid,
	extractQqText,
	peerAccountId,
	QqBotBridge,
	stripInternalMarkers,
} from "../../plugins/qq/index.mjs";

describe("QQ 运行归属行为", () => {
	it.each([true, false])(
		"two peers sharing c1 isolate concurrent QQ and web rounds (sessionId=%s)",
		async (withSessionId) => {
			let round = 0;
			const identities = new Map<string, any>();
			const chat = vi.fn(async (req: any) => {
				const identity = identities.get(req.accountId) || {
					conversationId: "c1",
					clientId: `plugin:qq:${req.accountId}`,
					...(withSessionId ? { sessionId: `session:${req.accountId}` } : {}),
				};
				identities.set(req.accountId, identity);
				return { ...identity, runId: `run:${req.accountId}:${round}` };
			});
			const bridge = new QqBotBridge({ host: { chat }, getConfig: () => ({}) });
			const reply = vi.fn(async () => {});
			bridge.replyMessage = reply;
			const peers = ["a", "b"];
			try {
				for (round = 0; round < 2; round++) {
					await Promise.all(
						peers.map((peer) => bridge.driveAuthor(peer, `question:${round}:${peer}`, { userOpenid: peer })),
					);
					expect(bridge.pendingRuns.size).toBe(2);
					expect([...bridge.pendingRuns.keys()].sort()).toEqual(["peer:a:0", "peer:b:0"]);
					const receipts = await Promise.all(chat.mock.results.slice(-2).map((result) => result.value));
					await Promise.all(
						receipts.map((identity, index) =>
							bridge.handleRunEvent({
								...identity,
								type: "message",
								message: { role: "assistant", content: `answer:${round}:${peers[index]}` },
							}),
						),
					);
					await Promise.all(
						receipts.reverse().map((identity) => bridge.handleRunEvent({ ...identity, type: "run_end" })),
					);
					expect(bridge.pendingRuns.size).toBe(0);
					expect(bridge.runIdIndex.size).toBe(0);
				}
				expect(chat.mock.calls.slice(2).map(([req]) => req.conversationId)).toEqual(["c1", "c1"]);
				const routes = [...identities.values()];
				await Promise.all(routes.map((identity) => bridge.handleRunEvent({ ...identity, type: "run_start" })));
				expect(bridge.pendingRuns.size).toBe(2);
				await Promise.all(
					routes.map((identity, index) =>
						bridge.handleRunEvent({
							...identity,
							type: "message",
							message: { role: "assistant", content: `web:${peers[index]}` },
						}),
					),
				);
				await Promise.all(routes.map((identity) => bridge.handleRunEvent({ ...identity, type: "run_end" })));
				expect(reply.mock.calls.map((call: any[]) => [call[0].userOpenid, call[1]]).sort()).toEqual(
					[
						["a", "answer:0:a"],
						["a", "answer:1:a"],
						["a", "web:a"],
						["b", "answer:0:b"],
						["b", "answer:1:b"],
						["b", "web:b"],
					].sort(),
				);
				expect(bridge.getRecentChats()).toHaveLength(2);
				expect(bridge.pendingRuns.size).toBe(0);
			} finally {
				await bridge.stop();
			}
		},
	);

	it("reset revokes a web round without runId without aborting a reused c1", async () => {
		const identity = { conversationId: "c1", clientId: "plugin:qq:reset", sessionId: "reset-session" };
		const abortRun = vi.fn(async () => ({ ok: true }));
		const bridge = new QqBotBridge({
			host: { chat: vi.fn(async () => ({ ...identity, runId: "initial" })), abortRun },
			getConfig: () => ({}),
		});
		const reply = vi.fn(async () => {});
		bridge.replyMessage = reply;
		try {
			await bridge.driveAuthor("u", "hello", { userOpenid: "u" });
			await bridge.handleRunEvent({ ...identity, runId: "initial", type: "run_end" });
			reply.mockClear();
			const web = { ...identity, clientId: "browser" };
			await bridge.handleRunEvent({ ...web, type: "run_start" });
			expect(bridge.pendingRuns.size).toBe(1);
			await bridge.handleRunEvent({ ...web, type: "message", message: { role: "assistant", content: "stale" } });
			expect(await bridge.resetAuthorSession("u", {}, {})).toBe(true);
			expect(abortRun).not.toHaveBeenCalled();
			expect(bridge.peerSessionSeq.get("u")).toBe(1);
			await bridge.handleRunEvent({ ...web, type: "run_end" });
			await bridge.handleRunEvent({ ...web, type: "run_start" });
			expect(bridge.pendingRuns.size).toBe(0);
			expect(reply).not.toHaveBeenCalled();
		} finally {
			await bridge.stop();
		}
	});
	it("sessionId survives browser ownership changes; unknown run IDs and duplicate ends cannot deliver", async () => {
		const storage = { set: vi.fn(async () => {}) };
		const cfg = { appId: "account-a" };
		const bridge = new QqBotBridge({
			host: {
				storage,
				chat: vi.fn(async () => ({ conversationId: "c1", clientId: "plugin:qq:x", sessionId: "s1", runId: "r1" })),
			},
			getConfig: () => cfg,
		});
		bridge.replyMessage = vi.fn(async () => {});
		await bridge.driveAuthor("u", "hello", { groupOpenid: "group-a" });
		await bridge.handleRunEvent({ type: "run_end", conversationId: "c1", runId: "r1" });
		vi.mocked(bridge.replyMessage).mockClear();
		const identity = { conversationId: "renamed", clientId: "browser", sessionId: "s1" };
		await bridge.handleRunEvent({ ...identity, type: "run_start", runId: "unknown" });
		await bridge.handleRunEvent({
			...identity,
			type: "message",
			runId: "unknown",
			message: { role: "assistant", content: "wrong" },
		});
		await bridge.handleRunEvent({ ...identity, type: "run_end", runId: "unknown" });
		expect(bridge.replyMessage).not.toHaveBeenCalled();
		await bridge.handleRunEvent({ ...identity, type: "run_start" });
		await bridge.handleRunEvent({
			...identity,
			type: "message",
			message: { role: "assistant", content: "tool preface" },
		});
		await bridge.handleRunEvent({
			...identity,
			type: "message",
			message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read" }] },
		});
		await bridge.handleRunEvent({
			...identity,
			type: "message",
			message: { role: "assistant", content: "final answer" },
		});
		await bridge.handleRunEvent({ ...identity, type: "run_end" });
		await bridge.handleRunEvent({ ...identity, type: "run_end" });
		expect(bridge.replyMessage).toHaveBeenCalledTimes(1);
		expect(vi.mocked(bridge.replyMessage).mock.calls[0][1]).toBe("final answer");
		await bridge.routeSave;
		expect(storage.set).toHaveBeenCalledWith(
			"sessionRoutes",
			expect.objectContaining({
				routes: expect.arrayContaining([["session:s1", expect.objectContaining({ authorId: "u" })]]),
			}),
		);
		await bridge.resetAuthorSession("u", {}, cfg);
		await bridge.handleRunEvent({ ...identity, type: "run_start" });
		expect(bridge.pendingRuns.size).toBe(0);
		await bridge.stop();
	});

	it("routes fail closed across accounts, group scopes, and ambiguous owners", () => {
		const cfg = { appId: "a", useSandbox: false };
		const bridge = new QqBotBridge({ host: {}, getConfig: () => cfg });
		const a = bridge.sessionPeer("u", { groupOpenid: "a" });
		const b = bridge.sessionPeer("u", { groupOpenid: "b" });
		const route = bridge.bindSessionRoute({ sessionId: "shared" }, a, { groupOpenid: "a" });
		expect(a).not.toBe(b);
		expect(bridge.bindSessionRoute({ sessionId: "shared" }, b, { groupOpenid: "b" })).toBeNull();
		expect(bridge.validSessionRoute(bridge.sessionRoutes.get("session:shared"))).toBe(false);
		cfg.appId = "b";
		expect(bridge.validSessionRoute(route)).toBe(false);
	});
	it("回执前事件按稳定 runId 重放，跨群不串话并用真实 ID 续聊", async () => {
		let bridge: any;
		const chat = vi.fn(async (req: any) => {
			const n = chat.mock.calls.length;
			await bridge.handleRunEvent({
				type: "message",
				conversationId: `real-${n}`,
				runId: `r-${n}`,
				message: { role: "assistant", content: `answer-${n}` },
			});
			await bridge.handleRunEvent({ type: "run_end", conversationId: `real-${n}`, runId: `r-${n}` });
			return { conversationId: `real-${n}`, runId: `r-${n}` };
		});
		bridge = new QqBotBridge({ host: { chat }, getConfig: () => ({}) });
		bridge.replyMessage = vi.fn(async () => {});
		for (const group of ["a", "b", "a"]) {
			await bridge.onInboundMessage(
				{ id: String(chat.mock.calls.length), group_openid: group, author: { id: "same" }, content: "hello" },
				"GROUP_AT_MESSAGE_CREATE",
			);
		}
		expect(chat.mock.calls[0][0].accountId).not.toBe(chat.mock.calls[1][0].accountId);
		expect(chat.mock.calls[2][0].conversationId).toBe("real-1");
		expect(bridge.replyMessage.mock.calls.map(([target, text]: any[]) => [target.groupOpenid, text])).toEqual([
			["a", "answer-1"],
			["b", "answer-2"],
			["a", "answer-3"],
		]);
		expect(bridge.pendingRuns.size).toBe(0);
		expect(bridge.runIdIndex.size).toBe(0);
		await bridge.stop();
	});

	it.each(["/new", "/clear", "/cwd default"])("%s 更换 accountId epoch，不复用宿主旧上下文", async (command) => {
		const chat = vi.fn(async (_req: any) => ({
			conversationId: `real-${chat.mock.calls.length}`,
			runId: `run-${chat.mock.calls.length}`,
		}));
		const bridge = new QqBotBridge({ host: { chat }, getConfig: () => ({}) });
		bridge.replyMessage = vi.fn(async () => {});
		await bridge.driveAuthor("u", "first", { userOpenid: "u" });
		await bridge.handleRunEvent({ type: "run_end", conversationId: "real-1", runId: "run-1" });
		await bridge.handleSlashCommand(command, { authorId: "u", replyTarget: {}, cfg: {} });
		await bridge.driveAuthor("u", "second", { userOpenid: "u" });
		expect(chat.mock.calls[1][0].accountId).not.toBe(chat.mock.calls[0][0].accountId);
		expect(chat.mock.calls[1][0].conversationId).not.toBe("real-1");
		await bridge.stop();
	});

	it.each(
		[false, true].flatMap((bindActive) =>
			[
				"/reset",
				"／ｒｅｓｅｔ",
				"/model default",
				"/model test-model",
				"/4 default",
				"4 test-model",
				"／４ test-model",
				"/thinking default",
				"/thinking high",
				"/5 default",
				"5 high",
				"／５ high",
				"/new",
				"/clear",
				"/2",
				"2",
				"2/new",
				"/2/new",
				"／ｎｅｗ",
				"／ｃｌｅａｒ",
				"／２",
				"２／ｎｅｗ",
				"/new 新提示Ａ",
				"2 新提示Ａ",
				"／２ 新提示Ａ",
				"/cwd default",
				"/workspace reset",
				`/cwd ${process.cwd()}`,
				`/workspace ${process.cwd()}`,
				`／１ ${process.cwd()}`,
			].map((command) => ({ bindActive, command })),
		),
	)("$command creates and keeps a new context (bindActive=$bindActive)", async ({ bindActive, command }) => {
		const contexts = new Map<string, string[]>();
		const chat = vi.fn(async (req: any) => {
			const id = contexts.has(req.conversationId) ? req.conversationId : `canonical-${contexts.size}`;
			contexts.set(id, [...(contexts.get(id) || []), req.text]);
			return { conversationId: id, clientId: "plugin:qq:reset", sessionId: `session-${id}` };
		});
		const cfg = { bindActive, workspace: process.cwd() };
		const bridge = new QqBotBridge({
			host: { chat, getActiveConversation: () => ({ conversationId: "canonical-0" }) },
			getConfig: () => cfg,
		});
		bridge.replyMessage = vi.fn().mockResolvedValue(undefined);
		let msg = 0;
		const inbound = (content: string) =>
			bridge.onInboundMessage(
				{
					id: `reset-${++msg}`,
					author: { id: "u" },
					content,
				},
				"C2C_MESSAGE_CREATE",
			);
		const finish = () =>
			bridge.handleRunEvent({
				type: "run_end",
				conversationId: `canonical-${contexts.size - 1}`,
				clientId: "plugin:qq:reset",
				sessionId: `session-canonical-${contexts.size - 1}`,
			});
		try {
			await inbound("旧上下文");
			await finish();
			const oldKey = [...bridge.conversationBindings.keys()][0];
			expect(oldKey).toMatch(/^peer:.*:0$/);
			expect(bridge.conversationBindings.get(oldKey).replyTarget).toMatchObject({ msgId: "reset-1" });
			bridge.webRunTexts.set(oldKey, "旧网页输出");
			bridge.conversationBindings.set("other", { authorId: "other", replyTarget: {} });
			bridge.userModels.set("u", "old-model");
			bridge.userThinkingLevels.set("u", "low");
			await inbound(command);
			expect(bridge.conversationBindings.has(oldKey)).toBe(false);
			expect(bridge.webRunTexts.has(oldKey)).toBe(false);
			expect(bridge.conversationBindings.has("other")).toBe(true);
			if (command.includes("新提示Ａ")) {
				expect(chat.mock.calls.at(-1)![0].text).toBe("新提示Ａ");
				await finish();
			} else {
				await inbound("新上下文");
				await finish();
			}
			expect(contexts.get("canonical-1")).toEqual([command.includes("新提示Ａ") ? "新提示Ａ" : "新上下文"]);
			expect(chat.mock.calls.at(-1)![0].accountId).not.toBe(chat.mock.calls[0][0].accountId);
			expect(chat.mock.calls.at(-1)![0].cwd).toBe(process.cwd());
			if (/model|\/4|^4|４/.test(command)) {
				expect(chat.mock.calls.at(-1)![0].model).toBe(command.includes("default") ? undefined : "test-model");
			}
			if (/thinking|\/5|^5|５/.test(command)) {
				expect(chat.mock.calls.at(-1)![0].thinkingLevel).toBe(command.includes("default") ? undefined : "high");
			}
			await inbound("继续");
			expect(chat.mock.calls.at(-1)![0].conversationId).toBe("canonical-1");
			expect(contexts.get("canonical-0")).toEqual(["旧上下文"]);
			expect(contexts.get("canonical-1")!.at(-1)).toBe("继续");
		} finally {
			await bridge.stop();
		}
	});

	it.each([
		"/new",
		"/clear",
		"/reset",
		"/cwd default",
		`/workspace ${process.cwd()}`,
		"/model default",
		"/4 test-model",
		"/thinking default",
		"/5 high",
	])("%s preserves workspace and bindings when abort fails", async (command) => {
		const bridge = new QqBotBridge({
			host: { abortRun: vi.fn().mockResolvedValue({ ok: false }) },
			getConfig: () => ({}),
		});
		bridge.replyMessage = vi.fn().mockResolvedValue(undefined);
		bridge.userWorkspaces.set("u", "old-workspace");
		bridge.userActiveConvs.set("u", "old");
		bridge.conversationBindings.set("old", { authorId: "u", replyTarget: {} });
		bridge.pendingRuns.set("old", { authorId: "u", runId: "running" });
		await bridge.handleSlashCommand(command, { authorId: "u", replyTarget: {}, cfg: {} });
		expect(bridge.userWorkspaces.get("u")).toBe("old-workspace");
		expect(bridge.peerSessionSeq.has("u")).toBe(false);
		expect(bridge.userActiveConvs.get("u")).toBe("old");
		expect(bridge.conversationBindings.has("old")).toBe(true);
		expect(bridge.pendingRuns.has("old")).toBe(true);
	});

	it("status reports the peer's actual isolated mode after reset", async () => {
		const cfg = { bindActive: true };
		const bridge = new QqBotBridge({ host: {}, getConfig: () => cfg });
		bridge.replyMessage = vi.fn().mockResolvedValue(undefined);
		const command = (text: string, authorId = "u") =>
			bridge.handleSlashCommand(text, { authorId, replyTarget: {}, cfg });
		await command("/status");
		expect(vi.mocked(bridge.replyMessage).mock.calls.at(-1)![1]).toContain("投递到网页活跃会话");
		await command("/reset");
		await command("/status");
		expect(vi.mocked(bridge.replyMessage).mock.calls.at(-1)![1]).toContain("独立无头会话");
		await command("/status", "other");
		expect(vi.mocked(bridge.replyMessage).mock.calls.at(-1)![1]).toContain("投递到网页活跃会话");
	});

	it.each(["reset", "stop", "abort"].flatMap((action) => [false, true].map((reject) => ({ action, reject }))))(
		"late chat receipt cannot resurrect state after $action (reject=$reject)",
		async ({ action, reject }) => {
			let receipt!: (value: any) => void;
			let failReceipt!: (reason: Error) => void;
			const chat = vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise((resolve, rejectReceipt) => {
							receipt = resolve;
							failReceipt = rejectReceipt;
						}),
				)
				.mockResolvedValue({ conversationId: "new-context", runId: "new-run" });
			const cfg = { bindActive: true };
			const bridge = new QqBotBridge({
				host: {
					chat,
					abortRun: vi.fn().mockResolvedValue({ ok: true }),
					getActiveConversation: () => ({ conversationId: "web-old" }),
				},
				getConfig: () => cfg,
			});
			bridge.replyMessage = vi.fn().mockResolvedValue(undefined);
			try {
				const dispatch = bridge.driveAuthor("u", "old", {});
				await bridge.handleRunEvent({
					type: "message",
					conversationId: "old-canonical",
					runId: "old-run",
					message: { role: "assistant", content: "stale" },
				});
				if (action === "stop") await bridge.stop();
				else
					await bridge.handleSlashCommand(action === "reset" ? "/reset" : "/stop", {
						authorId: "u",
						replyTarget: {},
						cfg,
					});
				if (action === "reset") await bridge.driveAuthor("u", "fresh", {});
				if (reject) failReceipt(new Error("late failure"));
				else receipt({ conversationId: "old-canonical", runId: "old-run" });
				await dispatch;
				expect(bridge.userActiveConvs.get("u")).toBe(action === "reset" ? "new-context" : undefined);
				expect(bridge.conversationBindings.has("old-canonical")).toBe(false);
				expect(bridge.runIdIndex.has("old-run")).toBe(false);
				expect(bridge.inFlightConvs.size).toBe(0);
				expect(bridge.earlyRunEvents.size).toBe(0);
				expect(bridge.pendingRuns.size).toBe(action === "reset" ? 1 : 0);
				expect(vi.mocked(bridge.replyMessage).mock.calls.some((call: any[]) => String(call[1]).includes("stale"))).toBe(
					false,
				);
				if (action === "stop") {
					expect(bridge.conversationBindings.size).toBe(0);
					expect(bridge.status.state).toBe("idle");
				}
			} finally {
				await bridge.stop();
			}
		},
	);

	it.each(
		[false, true].flatMap((webSync) =>
			["/reset", "/4 test-model", "/5 high", "stop", "continue", ...(webSync ? ["rebind"] : [])].map((action) => ({
				webSync,
				action,
			})),
		),
	)(
		"chunk delivery webSync=$webSync stops stale output after $action during first send",
		async ({ webSync, action }) => {
			const cfg = { bindActive: true };
			const bridge = new QqBotBridge({ host: {}, getConfig: () => cfg });
			let release!: () => void;
			let started!: () => void;
			const sending = new Promise<void>((resolve) => {
				started = resolve;
			});
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			const target = { msgId: "old-target" };
			const text = "旧输出段落\n".repeat(1500);
			const reply = vi.fn(async (replyTarget: any) => {
				if (replyTarget === target && reply.mock.calls.filter(([t]) => t === target).length === 1) {
					started();
					await blocked;
				}
			});
			bridge.replyMessage = reply;
			const identity = { conversationId: "old", clientId: "plugin:qq:chunks", sessionId: "chunk-session" };
			const key = webSync ? "session:chunk-session" : "peer:u:0";
			bridge.conversationBindings.set(key, { authorId: "u", replyTarget: target });
			if (webSync) {
				bridge.bindSessionRoute(identity, "u", target);
				await bridge.handleRunEvent({ ...identity, type: "run_start" });
			} else bridge.pendingRuns.set(key, { ...identity, authorId: "u", replyTarget: target });
			await bridge.handleRunEvent({ ...identity, type: "message", message: { role: "assistant", content: text } });
			const delivery = bridge.handleRunEvent({ ...identity, type: "run_end" });
			try {
				await sending;
				if (action === "stop") await bridge.stop();
				else if (action === "rebind") bridge.bindSessionRoute(identity, "u", { msgId: "new-target" });
				else if (action !== "continue")
					await bridge.handleSlashCommand(action, { authorId: "u", replyTarget: {}, cfg });
				release();
				await delivery;
				const sent = reply.mock.calls.filter(([t]) => t === target);
				expect(sent.length).toBe(action === "continue" ? chunkMarkdownText(text.trim(), 3000).length : 1);
				expect(bridge.status.messagesReplied).toBe(action === "continue" ? 1 : 0);
				expect(bridge.status.lastReplyAt === null).toBe(action !== "continue");
			} finally {
				release();
				await delivery;
				await bridge.stop();
			}
		},
	);

	it("/stop 在附件下载前执行", async () => {
		const bridge = new QqBotBridge({ host: {}, getConfig: () => ({}) });
		bridge.replyMessage = vi.fn(async () => {});
		const collect = vi.spyOn(bridge, "collectInboundMedia");
		await bridge.onInboundMessage(
			{ id: "stop-media", author: { id: "u" }, content: "/stop", attachments: [{ url: "https://cdn/slow.png" }] },
			"C2C_MESSAGE_CREATE",
		);
		expect(collect).not.toHaveBeenCalled();
		await bridge.stop();
	});

	it("同用户不同 thread 使用不同会话键", () => {
		const bridge = new QqBotBridge({ host: {}, getConfig: () => ({}) });
		expect(bridge.sessionPeer("u", { channelId: "c", threadId: "a" })).not.toBe(
			bridge.sessionPeer("u", { channelId: "c", threadId: "b" }),
		);
	});

	it("旧宿主回执没有 runId 时中止真实 conversationId", async () => {
		const abortRun = vi.fn(async (_id: string) => ({ ok: true }));
		const bridge = new QqBotBridge({
			host: { chat: vi.fn(async () => ({ conversationId: "legacy-real" })), abortRun },
			getConfig: () => ({}),
		});
		bridge.replyMessage = vi.fn(async () => {});
		await bridge.driveAuthor("u", "work", { userOpenid: "u" });
		await bridge.handleSlashCommand("/abort", { authorId: "u", replyTarget: {}, cfg: {} });
		expect(abortRun).toHaveBeenCalledExactlyOnceWith("legacy-real");
		await bridge.stop();
	});

	it("/abort、/stop、/8 优先中止稳定 runId，失败保留运行并诚实提示", async () => {
		const abortRun = vi.fn().mockResolvedValue({ ok: false, error: "拒绝" });
		const bridge = new QqBotBridge({
			host: { chat: vi.fn(async () => ({ conversationId: "real", runId: "pr-qq-stable" })), abortRun },
			getConfig: () => ({}),
		});
		bridge.replyMessage = vi.fn(async () => {});
		await bridge.driveAuthor("u", "work", { userOpenid: "u" });
		await bridge.handleSlashCommand("/abort", { authorId: "u", replyTarget: {}, cfg: {} });
		expect(abortRun).toHaveBeenCalledWith("pr-qq-stable");
		expect(bridge.pendingRuns.size).toBeGreaterThan(0);
		expect(bridge.replyMessage).toHaveBeenCalledWith({}, expect.stringContaining("中止失败"));
		abortRun.mockResolvedValue({ ok: true });
		await bridge.handleSlashCommand("/stop", { authorId: "u", replyTarget: {}, cfg: {} });
		expect(bridge.pendingRuns.size).toBe(0);
		expect(bridge.runIdIndex.size).toBe(0);
		await bridge.driveAuthor("u", "again", { userOpenid: "u" });
		await bridge.handleSlashCommand("/8", { authorId: "u", replyTarget: {}, cfg: {} });
		expect(abortRun.mock.calls.map(([id]) => id)).toEqual(["pr-qq-stable", "pr-qq-stable", "pr-qq-stable"]);
		await bridge.stop();
	});
});

describe("QQ 纯函数与辅助方法测试", () => {
	it("stripInternalMarkers 剥离内部标记与清理空行", () => {
		const raw = "这是回答[[plan:123]]中间内容[[conv:xyz]]结尾。\n\n\n新行";
		expect(stripInternalMarkers(raw)).toBe("这是回答中间内容结尾。\n\n新行");
	});

	it("peerAccountId 生成稳定的 qq_ 前缀脱敏 ID", () => {
		const id1 = peerAccountId("OPENID_123456");
		const id2 = peerAccountId("OPENID_123456");
		expect(id1).toBe(id2);
		expect(id1.startsWith("qq_")).toBe(true);
		expect(peerAccountId("")).toBe("qq_default");
	});

	it("extractQqText 剥离机器人 <@!botId> 与 <@botId> 标签", () => {
		const text1 = "<@!10203040> 帮我写一个快速排序算法";
		expect(extractQqText(text1, "10203040")).toBe("帮我写一个快速排序算法");

		const text2 = "<@10203040> 帮我写一个函数";
		expect(extractQqText(text2, "10203040")).toBe("帮我写一个函数");
	});
});

describe("QqBotBridge 双工逻辑测试", () => {
	it("白名单模式：不在白名单内的用户会被拒绝，不触发 host.chat", async () => {
		const chatSpy = vi.fn();
		const bridge = new QqBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
				allowedUsers: ["ALLOWED_USER_1"],
			}),
		});

		await bridge.onInboundMessage(
			{
				id: "msg_qq_1",
				channel_id: "c_123",
				author: { id: "STRANGER_USER", bot: false },
				content: "你好",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(chatSpy).not.toHaveBeenCalled();
	});

	it("斜杠命令 /help 应当直接回复帮助说明，不触发 host.chat", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: "m_reply_1" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge = new QqBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
			}),
		});

		await bridge.onInboundMessage(
			{
				id: "msg_qq_2",
				channel_id: "c_123",
				author: { id: "ALLOWED_USER_1", bot: false },
				content: "/help",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/c_123/messages"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("QQ 机器人帮助"),
			}),
		);

		vi.unstubAllGlobals();
	});

	it("正常入站消息派发到 host.chat，并在 run_end 时回复 Markdown", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ access_token: "mock_qq_token", id: "m_reply_2" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi
			.fn()
			.mockResolvedValue({ conversationId: "conv_qq_1", clientId: "plugin:qq:markdown", sessionId: "qq-markdown" });

		const bridge = new QqBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
			}),
		});

		await bridge.start();

		await bridge.onInboundMessage(
			{
				id: "msg_qq_3",
				channel_id: "c_123",
				author: { id: "ALLOWED_USER_1", bot: false },
				content: "帮我写一个函数",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "帮我写一个函数",
				accountId: expect.stringMatching(/^qq_/),
			}),
		);

		const convId = "conv_qq_1";
		const identity = { clientId: "plugin:qq:markdown", sessionId: "qq-markdown" };

		runHandler!({
			...identity,
			conversationId: convId,
			type: "message",
			message: {
				role: "assistant",
				content: "```typescript\nfunction test() {}\n```[[plan:qq]]",
			},
		});

		await runHandler!({ ...identity, conversationId: convId, type: "run_end" });

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/c_123/messages"),
			expect.objectContaining({
				body: expect.stringContaining("function test()"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("长回复按 3000 字分块后，replyMessage 调用时的 msg_seq 严格从 1 递增", async () => {
		const replySpy = vi.fn().mockResolvedValue({});
		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi
			.fn()
			.mockResolvedValue({ conversationId: "conv_qq_long", clientId: "plugin:qq:long", sessionId: "qq-long" });

		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ access_token: "mock_qq_token" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const bridge = new QqBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
			}),
		});

		bridge.replyMessage = replySpy;
		await bridge.start();

		await bridge.onInboundMessage(
			{
				id: "msg_qq_4",
				channel_id: "c_123",
				author: { id: "ALLOWED_USER_1", bot: false },
				content: "请生成长文本",
			},
			"AT_MESSAGE_CREATE",
		);

		const convId = "conv_qq_long";
		const identity = { clientId: "plugin:qq:long", sessionId: "qq-long" };

		const longReply = "A".repeat(3500);
		runHandler!({
			...identity,
			conversationId: convId,
			type: "message",
			message: {
				role: "assistant",
				content: longReply,
			},
		});

		await runHandler!({ ...identity, conversationId: convId, type: "run_end" });

		expect(replySpy).toHaveBeenCalledTimes(2);
		expect(replySpy.mock.calls[0][2]).toBe(1);
		expect(replySpy.mock.calls[1][2]).toBe(2);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("ensureAccessToken：未到期直接复用，到期惰性刷新", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ access_token: "token_v2", expires_in: 7200 }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const bridge = new QqBotBridge({
			host: { chat: vi.fn() },
			getConfig: () => ({ appId: "102030", clientSecret: "mock_secret" }),
		});

		bridge.accessToken = "token_v1";
		bridge.tokenExpiresAt = Date.now() + 7200 * 1000;

		const t1 = await bridge.ensureAccessToken();
		expect(t1).toBe("token_v1");
		expect(fetchMock).not.toHaveBeenCalled();

		bridge.tokenExpiresAt = Date.now() + 60 * 1000;

		const t2 = await bridge.ensureAccessToken();
		expect(t2).toBe("token_v2");
		expect(bridge.accessToken).toBe("token_v2");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("onClientMessage 请求-响应配对：回显 __rid 并正确分发 get_state 与 test_config", async () => {
		let clientHandler: ((msg: any, reply: (payload: any) => void) => Promise<void>) | null = null;
		const mockStorage = new Map<string, any>();
		const mockHost = {
			storage: {
				get: async (k: string) => mockStorage.get(k),
				set: async (k: string, v: any) => mockStorage.set(k, v),
			},
			secrets: {
				getAll: async () => ({}),
			},
			onClientMessage: (fn: any) => {
				clientHandler = fn;
			},
			registerTool: vi.fn(),
		};

		await activate(mockHost as any);
		expect(clientHandler).toBeDefined();

		let replyData: any = null;
		await clientHandler!({ type: "get_state", __rid: "qq-req-1" }, (res: any) => {
			replyData = res;
		});

		expect(replyData).toBeDefined();
		expect(replyData.__rid).toBe("qq-req-1");
		expect(replyData.type).toBe("state");

		let testReply: any = null;
		await clientHandler!(
			{
				type: "test_config",
				__rid: "qq-req-2",
				config: { appId: "1905849155", clientSecret: "" },
			},
			(res: any) => {
				testReply = res;
			},
		);

		expect(testReply).toBeDefined();
		expect(testReply.__rid).toBe("qq-req-2");
		expect(testReply.success).toBe(false);
		expect(testReply.message).toContain("未填入 AppID 或 ClientSecret");
	});

	it("工作台发媒体：本地文件自动上传（file_data）后以 msg_type=7 发出", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qq-send-"));
		try {
			writeFileSync(join(dir, "pic.png"), Buffer.from("PNGDATA"));
			const calls: any[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: any, init?: any) => {
					const u = String(url);
					const body = init?.body ? JSON.parse(String(init.body)) : null;
					calls.push({ url: u, body });
					if (u.includes("getAppAccessToken")) {
						return { ok: true, json: async () => ({ access_token: "tk", expires_in: 7200 }) } as Response;
					}
					if (u.endsWith("/files")) return { ok: true, json: async () => ({ file_info: "FI_LOCAL" }) } as Response;
					if (u.endsWith("/messages")) return { ok: true, json: async () => ({ id: "m_media" }) } as Response;
					return { ok: true, json: async () => ({}) } as Response;
				}),
			);

			let clientHandler: ((msg: any, reply: (payload: any) => void) => Promise<void>) | null = null;
			const mockHost = {
				storage: {
					get: async () => ({ appId: "102030", clientSecret: "sec", workspace: dir }),
					set: async () => {},
				},
				secrets: { getAll: async () => ({}) },
				onClientMessage: (fn: any) => {
					clientHandler = fn;
				},
				registerTool: vi.fn(),
			};
			await activate(mockHost as any);

			let replyData: any = null;
			await clientHandler!(
				{ type: "send_message", media: "pic.png", openid: "openid-u1", openidType: "user", text: "看图" },
				(res: any) => {
					replyData = res;
				},
			);

			expect(replyData?.success).toBe(true);
			const upload = calls.find((c) => c.url.endsWith("/files"));
			expect(upload.url).toContain("/v2/users/openid-u1/files");
			expect(upload.body.file_type).toBe(1);
			expect(upload.body.file_data).toBe(Buffer.from("PNGDATA").toString("base64"));
			const msg = calls.find((c) => c.url.endsWith("/messages"));
			expect(msg.body).toMatchObject({ msg_type: 7, media: { file_info: "FI_LOCAL" }, content: "看图" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
			vi.unstubAllGlobals();
		}
	});

	it("工作台发媒体：子频道只接受公网 URL（本地文件明确报错）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qq-send-ch-"));
		try {
			writeFileSync(join(dir, "pic.png"), Buffer.from("PNGDATA"));
			let clientHandler: ((msg: any, reply: (payload: any) => void) => Promise<void>) | null = null;
			const mockHost = {
				storage: {
					get: async () => ({ appId: "102030", clientSecret: "sec", workspace: dir, defaultChannelId: "ch1" }),
					set: async () => {},
				},
				secrets: { getAll: async () => ({}) },
				onClientMessage: (fn: any) => {
					clientHandler = fn;
				},
				registerTool: vi.fn(),
			};
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response),
			);
			await activate(mockHost as any);

			let replyData: any = null;
			await clientHandler!({ type: "send_message", media: "pic.png", channelId: "ch1" }, (res: any) => {
				replyData = res;
			});
			expect(replyData?.success).toBe(false);
			expect(String(replyData?.message)).toContain("公网 http(s)");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			vi.unstubAllGlobals();
		}
	});

	it("get_state 回传 inboundMedia 开关（默认开启）", async () => {
		let clientHandler: ((msg: any, reply: (payload: any) => void) => Promise<void>) | null = null;
		const mockHost = {
			storage: { get: async () => ({ appId: "1" }), set: async () => {} },
			secrets: { getAll: async () => ({}) },
			onClientMessage: (fn: any) => {
				clientHandler = fn;
			},
			registerTool: vi.fn(),
		};
		await activate(mockHost as any);
		let replyData: any = null;
		await clientHandler!({ type: "get_state" }, (res: any) => {
			replyData = res;
		});
		expect(replyData.config.inboundMedia).toBe(true);
	});

	it("checkCwdValid 能够正确拦截非法或不存在的路径", () => {
		expect(checkCwdValid("").ok).toBe(false);
		expect(checkCwdValid("Z:/non_existent_path_xyz_123").ok).toBe(false);
		expect(checkCwdValid(process.cwd()).ok).toBe(true);
	});

	it("QQ 斜杠命令支持 /4 model 与 /5 thinking 切换，并自增代次透传给 host.chat", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: "m_reply_cmd" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_qq_m" });
		const bridge = new QqBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({ appId: "102030", clientSecret: "mock_secret" }),
		});

		await bridge.onInboundMessage(
			{
				id: "msg_cmd_1",
				channel_id: "c_123",
				author: { id: "USER_A", bot: false },
				content: "/4 deepseek/deepseek-chat",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(bridge.userModels.get(bridge.sessionPeer("USER_A", { channelId: "c_123" }))).toBe("deepseek/deepseek-chat");

		await bridge.onInboundMessage(
			{
				id: "msg_cmd_2",
				channel_id: "c_123",
				author: { id: "USER_A", bot: false },
				content: "/5 high",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(bridge.userThinkingLevels.get(bridge.sessionPeer("USER_A", { channelId: "c_123" }))).toBe("high");

		await bridge.onInboundMessage(
			{
				id: "msg_cmd_3",
				channel_id: "c_123",
				author: { id: "USER_A", bot: false },
				content: "写一个二分查找",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "deepseek/deepseek-chat",
				thinkingLevel: "high",
				text: expect.stringContaining("写一个二分查找"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("双向同步：电脑网页端在 QQ 关联会话中的回复，能自动同步推送回 QQ 目标", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: "m_reply_sync" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const identity = { conversationId: "conv_qq_sync", clientId: "plugin:qq:sync", sessionId: "qq-sync" };
		const chatSpy = vi.fn().mockResolvedValue(identity);

		const bridge = new QqBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
				bindActive: true,
			}),
		});

		await bridge.start();

		await bridge.onInboundMessage(
			{
				id: "msg_in_1",
				channel_id: "c_sync_1",
				author: { id: "USER_SYNC", bot: false },
				content: "同步测试提问",
			},
			"AT_MESSAGE_CREATE",
		);

		await runHandler!({ ...identity, type: "run_end" });

		const chats = bridge.getRecentChats();
		expect(chats.length).toBeGreaterThan(0);
		expect(chats[0].lastUserText).toBe("同步测试提问");

		const webIdentity = { ...identity, clientId: "browser:sync" };
		await runHandler!({ ...webIdentity, type: "run_start" });
		await runHandler!({
			...webIdentity,
			type: "message",
			message: {
				role: "assistant",
				content: "这是电脑网页端生成的回答内容",
			},
		});

		await runHandler!({ ...webIdentity, type: "run_end" });

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/c_sync_1/messages"),
			expect.objectContaining({
				body: expect.stringContaining("这是电脑网页端生成的回答内容"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("发送单斜杠 / 应当直接回复快捷指令菜单，不触发 host.chat", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: "m_reply_menu" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge = new QqBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({ appId: "102030", clientSecret: "mock_secret" }),
		});

		await bridge.onInboundMessage(
			{
				id: "msg_slash_only",
				channel_id: "c_123",
				author: { id: "USER_SLASH", bot: false },
				content: "/",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/c_123/messages"),
			expect.objectContaining({
				body: expect.stringContaining("QQ 机器人帮助与快捷指令菜单"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("安全隔离守卫：电脑网页端自身发起的其他日常对话，绝不会被错误收录到 QQ 最近互动中", async () => {
		const chatSpy = vi.fn();
		let runHandler: ((ev: any) => void) | null = null;
		const bridge = new QqBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({ appId: "102030", clientSecret: "mock_secret" }),
		});

		await bridge.start();

		runHandler!({
			conversationId: "conv_unrelated_web_chat_1",
			type: "message",
			message: {
				role: "assistant",
				content: "这是用户在网页端自己写代码的对话内容，与 QQ 无关",
			},
		});

		await runHandler!({
			conversationId: "conv_unrelated_web_chat_1",
			type: "run_end",
		});

		const chats = bridge.getRecentChats();
		expect(chats.find((c) => c.conversationId === "conv_unrelated_web_chat_1")).toBeUndefined();
		expect(chats.length).toBe(0);

		await bridge.stop();
	});

	it("提问进入后若宿主分配了真实会话 ID（与初始临时 ID 不同），recentChats 应当迁移且仅有 1 条记录", async () => {
		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "c5" });
		const bridge = new QqBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
				broadcast: vi.fn(),
			},
			getConfig: () => ({ appId: "102030", clientSecret: "mock_secret" }),
		});

		await bridge.start();

		await bridge.onInboundMessage(
			{
				id: "msg_in_single",
				channel_id: "c_news",
				author: { id: "E009F0BF1B068C38C46CF14EA50FCCA3", bot: false },
				content: "今日新闻",
			},
			"AT_MESSAGE_CREATE",
		);

		const chats = bridge.getRecentChats();
		expect(chats.length).toBe(1);
		expect(chats[0].conversationId).toBe("c5");
		expect(chats[0].lastUserText).toBe("今日新闻");
		expect([...bridge.userActiveConvs.values()]).toContain("c5");

		await runHandler!({
			conversationId: "c5",
			type: "run_end",
		});

		const tempId = `qq_${"E009F0BF1B068C38C46CF14EA50FCCA3".slice(-8)}_0`;
		expect(bridge.pendingRuns.has(tempId)).toBe(false);
		expect(bridge.pendingRuns.has("c5")).toBe(false);

		const chatsAfter = bridge.getRecentChats();
		expect(chatsAfter.length).toBe(1);
		expect(chatsAfter[0].conversationId).toBe("c5");

		await bridge.stop();
	});

	it("频道通知广播：AI 提问待确认 (ask_user_question) 自动格式化并推送到指定频道，支持防重复", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ access_token: "mock_qq_token", id: "m_broadcast_1" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const bridge = new QqBotBridge({
			host: {
				broadcast: vi.fn(),
			},
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
				defaultChannelId: "channel_broad_123",
				notifyOnQuestion: true,
			}),
		});

		bridge.accessToken = "mock_token";
		bridge.tokenExpiresAt = Date.now() + 3600 * 1000;
		bridge.running = true;

		const args = JSON.stringify({
			questions: [
				{
					id: "confirm_deploy",
					header: "部署确认",
					question: "是否确认将代码推送到生产环境？",
					options: [{ label: "确认继续", recommended: true }, { label: "取消操作" }],
				},
			],
		});

		await bridge.handleRunEvent({
			conversationId: "web_conv_888",
			type: "tool_start",
			toolName: "ask_user_question",
			toolCallId: "call_ask_1",
			argsText: args,
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/channel_broad_123/messages"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("部署确认"),
			}),
		);

		fetchMock.mockClear();
		await bridge.handleRunEvent({
			conversationId: "web_conv_888",
			type: "tool_start",
			toolName: "ask_user_question",
			toolCallId: "call_ask_1",
			argsText: args,
		});
		expect(fetchMock).not.toHaveBeenCalled();

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("频道通知广播：普通网页会话在 run_end 时根据 notifyOnRunEnd 推送完成摘要", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ access_token: "mock_qq_token", id: "m_broadcast_2" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const bridge = new QqBotBridge({
			host: {
				broadcast: vi.fn(),
			},
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
				broadcastChannelId: "channel_custom_999",
				notifyOnRunEnd: true,
			}),
		});

		bridge.accessToken = "mock_token";
		bridge.tokenExpiresAt = Date.now() + 3600 * 1000;
		bridge.running = true;

		await bridge.handleRunEvent({
			conversationId: "web_conv_999",
			type: "run_start",
			task: "修复登录接口 500 异常",
			at: Date.now() - 5000,
		});

		await bridge.handleRunEvent({
			conversationId: "web_conv_999",
			type: "message",
			message: {
				role: "assistant",
				content: "已查明空指针原因并已修复，全部 12 项单元测试通过。",
			},
		});

		await bridge.handleRunEvent({
			conversationId: "web_conv_999",
			type: "run_end",
			stopReason: "stop",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/channel_custom_999/messages"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("已查明空指针原因并已修复"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});
});

describe("QQ：对话被过户（改名 + 换客户端）后仍按 runId 回包", () => {
	it("conversationId 改名、clientId 变成浏览器后，run_end 仍回复到原频道", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ access_token: "mock_qq_token", id: "m_reply_9" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "c1", clientId: "plugin:qq:x", runId: "pr-qq-9" });

		const bridge = new QqBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({ appId: "102030", clientSecret: "mock_secret" }),
		});

		await bridge.start();
		await bridge.onInboundMessage(
			{
				id: "msg_qq_takeover",
				channel_id: "c_123",
				author: { id: "ALLOWED_USER_1", bot: false },
				content: "查一下磁盘占用",
			},
			"AT_MESSAGE_CREATE",
		);

		runHandler!({
			conversationId: "c7",
			clientId: "client_browser_tab1",
			runId: "pr-qq-9",
			type: "message",
			message: { role: "assistant", content: "磁盘还剩 42GB。" },
		});
		await runHandler!({
			conversationId: "c7",
			clientId: "client_browser_tab1",
			runId: "pr-qq-9",
			type: "run_end",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/c_123/messages"),
			expect.objectContaining({ body: expect.stringContaining("磁盘还剩 42GB") }),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});
});
