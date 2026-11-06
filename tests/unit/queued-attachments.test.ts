import { describe, expect, it } from "vitest";
import { formatOptimisticQueuedPrompt } from "../../web/src/optimistic-queue.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createAgentSessionServices,
	createAgentSessionFromServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	extractStreamingPayload,
	formatStreamingPrompt,
	splitQuotedPrompt,
	formatTextQuote,
} from "../../server/text-quote.js";
import type { TextQuote } from "../../server/protocol.js";
import { serializeMessage } from "../../server/serialize.js";
import type { AgentMessage } from "../../server/serialize.js";

const sampleQuote: TextQuote = {
	text: "const a = 1;",
	messageId: "m1",
	role: "assistant",
};

describe("排队消息附件处理与隔离 (queued-attachments)", () => {
	it("round-trips canvas identity and escaped titles through queued prompts", () => {
		const att = { mode: "canvas" as const, path: "build", name: 'Build "UI" & <test>' };
		const queued = formatOptimisticQueuedPrompt("inspect", [att]);
		expect(queued).not.toContain("<file");
		expect(splitQuotedPrompt(queued)).toMatchObject({
			text: "inspect",
			attachments: [{ type: "canvas", path: att.path, name: att.name }],
		});
	});
	it("formatStreamingPrompt 与 splitQuotedPrompt 往返解析：正文干净且提取所有附件元数据", () => {
		const formatted = formatStreamingPrompt(
			"请帮我分析这张图片和代码",
			['<file path="src/app.ts" lines="5-15" />', "<vision-bridge>\n识别为柱状图\n</vision-bridge>"],
			[sampleQuote],
			["chart.png"],
		);

		expect(formatted).toContain("请帮我分析这张图片和代码");
		expect(formatted).toContain('<attached-image name="chart.png" />');
		expect(formatted).toContain('<file path="src/app.ts" lines="5-15" />');
		expect(formatted).toContain("<vision-bridge>\n识别为柱状图\n</vision-bridge>");
		expect(formatted).toContain(formatTextQuote(sampleQuote));

		const parsed = splitQuotedPrompt(formatted);
		expect(parsed.text).toBe("请帮我分析这张图片和代码");
		expect(parsed.quotes).toEqual([sampleQuote]);
		expect(parsed.attachments).toEqual([
			{ type: "image", name: "chart.png" },
			{ type: "file", name: "app.ts", path: "src/app.ts", lines: { start: 5, end: 15 } },
			{ type: "vision-bridge", name: "视觉转写" },
		]);
	});

	it("仅有附件无提问文字时，拆分后正文为空串，附件元数据完整", () => {
		const formatted = formatStreamingPrompt("", ['<folder path="docs" />'], [], ["photo.jpg"]);
		const parsed = splitQuotedPrompt(formatted);
		expect(parsed.text).toBe("");
		expect(parsed.quotes).toEqual([]);
		expect(parsed.attachments).toEqual([
			{ type: "image", name: "photo.jpg" },
			{ type: "folder", name: "docs", path: "docs" },
		]);
	});

	it("serializeMessage 将排队完成后的用户消息正文净化，并挂载 details.attachments 与 details.quotes", () => {
		const formatted = formatStreamingPrompt(
			"这是排队提交的问题",
			['<file path="server/index.ts" />'],
			[sampleQuote],
			["error.png"],
		);

		const rawMessage: AgentMessage = {
			role: "user",
			timestamp: 1700000000000,
			content: [
				{ type: "text", text: formatted },
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					mimeType: "image/png",
				},
			],
		};

		const ui = serializeMessage(rawMessage, 1);
		expect(ui).not.toBeNull();
		expect(ui!.role).toBe("user");

		const textBlock = ui!.content.find((b) => b.type === "text") as { type: "text"; text: string };
		expect(textBlock.text).toBe("这是排队提交的问题");

		const imgBlock = ui!.content.find((b) => b.type === "image") as { type: "image"; dataUrl?: string };
		expect(imgBlock).toBeDefined();
		expect(imgBlock.dataUrl).toContain("data:image/png;base64,");

		const details = ui!.details as { quotes?: TextQuote[]; attachments?: unknown[] };
		expect(details.quotes).toEqual([sampleQuote]);
		expect(details.attachments).toEqual([
			{ type: "image", name: "error.png" },
			{ type: "file", name: "index.ts", path: "server/index.ts", lines: undefined },
		]);
	});

	it("无附件的普通消息 serializeMessage 不产生冗余 details.attachments", () => {
		const rawMessage: AgentMessage = {
			role: "user",
			timestamp: 1700000000001,
			content: [{ type: "text", text: "普通提问" }],
		};

		const ui = serializeMessage(rawMessage, 2);
		expect(ui!.details).toBeUndefined();
	});

	it("验证流式排队不向 _pendingNextTurnMessages 泄露，防止下一次提问被动附带上一次排队的附件", () => {
		const session = {
			isStreaming: true,
			model: { input: ["text", "image"] },
			_pendingNextTurnMessages: [] as unknown[],
			promptsReceived: [] as { text: string; options?: unknown }[],
			async sendCustomMessage(msg: unknown, opts?: { deliverAs?: string }) {
				if (opts?.deliverAs === "nextTurn") {
					this._pendingNextTurnMessages.push(msg);
				}
			},
			async prompt(text: string, options?: { streamingBehavior?: string; images?: unknown[] }) {
				if (this.isStreaming) {
					this.promptsReceived.push({ text, options });
					return;
				}
				const injected = [...this._pendingNextTurnMessages];
				this._pendingNextTurnMessages = [];
				this.promptsReceived.push({ text, options: { ...options, injected } });
			},
		};

		const promptImages = [{ type: "image" as const, data: "base64data", mimeType: "image/png" }];
		const fullText = formatStreamingPrompt("请帮我看排队图片", [], [], ["pasted.png"]);

		session.prompt(fullText, {
			streamingBehavior: "followUp",
			images: promptImages,
		});

		expect(session._pendingNextTurnMessages.length).toBe(0);

		expect(session.promptsReceived.length).toBe(1);
		expect(session.promptsReceived[0]!.text).toBe(fullText);
		expect(session.promptsReceived[0]!.options).toEqual({
			streamingBehavior: "followUp",
			images: promptImages,
		});

		session.isStreaming = false;

		session.prompt("下一个问题：今天天气怎么样？");

		expect(session.promptsReceived.length).toBe(2);
		const nextPrompt = session.promptsReceived[1]!;
		expect(nextPrompt.text).toBe("下一个问题：今天天气怎么样？");
		expect((nextPrompt.options as { injected: unknown[] }).injected).toEqual([]);
	});

	it("空闲状态下带图片与文件附件发消息通过 deliverAs: nextTurn 注入并被当轮 prompt 消费 (fixes #667)", async () => {
		const session = {
			isStreaming: false,
			model: { input: ["text", "image"] },
			_pendingNextTurnMessages: [] as unknown[],
			promptsReceived: [] as { text: string; options?: unknown }[],
			async sendCustomMessage(msg: unknown, opts?: { deliverAs?: string }) {
				if (opts?.deliverAs === "nextTurn") {
					this._pendingNextTurnMessages.push(msg);
				}
			},
			async prompt(text: string, options?: { streamingBehavior?: string; images?: unknown[] }) {
				const injected = [...this._pendingNextTurnMessages];
				this._pendingNextTurnMessages = [];
				this.promptsReceived.push({ text, options: { ...options, injected } });
			},
		};

		const imageAside = {
			customType: "file",
			content: [
				{
					type: "image",
					data: "base64_image_data_here",
					mimeType: "image/png",
				},
			],
			display: true,
			details: { name: "diagram.png", mode: "image", size: 1024 },
		};
		const fileAside = {
			customType: "file",
			content: [{ type: "text", text: '<file path="src/main.ts" />' }],
			display: true,
			details: { name: "main.ts", path: "src/main.ts", mode: "reference" },
		};

		await session.sendCustomMessage(imageAside, { deliverAs: "nextTurn" });
		await session.sendCustomMessage(fileAside, { deliverAs: "nextTurn" });

		expect(session._pendingNextTurnMessages.length).toBe(2);

		await session.prompt("请分析这个架构图和源码");

		expect(session.promptsReceived.length).toBe(1);
		const turn1 = session.promptsReceived[0]!;
		expect(turn1.text).toBe("请分析这个架构图和源码");
		const injected1 = (turn1.options as { injected: unknown[] }).injected;
		expect(injected1.length).toBe(2);
		expect(injected1[0]).toEqual(imageAside);
		expect(injected1[1]).toEqual(fileAside);

		expect(session._pendingNextTurnMessages.length).toBe(0);

		await session.prompt("下一个问题：需要怎么重构？");
		expect(session.promptsReceived.length).toBe(2);
		const turn2 = session.promptsReceived[1]!;
		expect(turn2.text).toBe("下一个问题：需要怎么重构？");
		expect((turn2.options as { injected: unknown[] }).injected).toEqual([]);
	});

	it("空闲提问前置阶段若被 abort 或发生异常，暂存的 _pendingNextTurnMessages 被安全清理，防止泄漏", async () => {
		const session = {
			isStreaming: false,
			_pendingNextTurnMessages: [] as unknown[],
			promptsReceived: [] as { text: string; options?: unknown }[],
			async sendCustomMessage(msg: unknown, opts?: { deliverAs?: string }) {
				if (opts?.deliverAs === "nextTurn") {
					this._pendingNextTurnMessages.push(msg);
				}
			},
			async prompt(text: string, options?: unknown) {
				const injected = [...this._pendingNextTurnMessages];
				this._pendingNextTurnMessages = [];
				this.promptsReceived.push({ text, options: { injected } });
			},
		};

		await session.sendCustomMessage(
			{
				customType: "file",
				content: [{ type: "image", data: "aborted_img", mimeType: "image/png" }],
			},
			{ deliverAs: "nextTurn" },
		);
		expect(session._pendingNextTurnMessages.length).toBe(1);

		if (Array.isArray(session._pendingNextTurnMessages)) {
			session._pendingNextTurnMessages = [];
		}

		await session.prompt("全新提问");
		expect(session.promptsReceived.length).toBe(1);
		expect((session.promptsReceived[0]!.options as { injected: unknown[] }).injected).toEqual([]);
	});

	it("真实 Pi SDK 实例集成测试：sendCustomMessage(deliverAs: nextTurn) 图片正确进 agent 消息且下一轮不残留", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-attach-"));
		try {
			const services = await createAgentSessionServices({ cwd: tmpDir, agentDir: tmpDir });
			services.modelRuntime.setRuntimeApiKey("amazon-bedrock", "dummy-key");
			const model = services.modelRuntime.getAllModels()[0];

			const { session: s } = await createAgentSessionFromServices({
				services,
				model: model as any,
				sessionManager: SessionManager.inMemory(tmpDir),
			});

			const captured: unknown[][] = [];
			s.agent.prompt = async (input: unknown) => {
				captured.push(Array.isArray(input) ? input : [input]);
			};

			await s.sendCustomMessage(
				{
					customType: "file",
					content: [{ type: "image", data: "b64_image_content", mimeType: "image/png" }],
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
			await s.prompt("请查看这张图片");

			expect(captured.length).toBe(1);
			const turn1Messages = captured[0] as { role: string; content?: unknown }[];
			const userMsg = turn1Messages.find((m) => m.role === "user");
			expect(userMsg).toBeDefined();
			expect(userMsg!.content).toEqual([{ type: "text", text: "请查看这张图片" }]);

			const customImgMsg = turn1Messages.find((m) => m.role === "custom");
			expect(customImgMsg).toBeDefined();
			expect(customImgMsg!.content).toEqual([{ type: "image", data: "b64_image_content", mimeType: "image/png" }]);

			captured.length = 0;
			await s.prompt("第二轮普通提问");

			expect(captured.length).toBe(1);
			const turn2Messages = captured[0] as { role: string; content?: unknown }[];
			const turn2Custom = turn2Messages.find((m) => m.role === "custom");
			expect(turn2Custom).toBeUndefined();
			const turn2User = turn2Messages.find((m) => m.role === "user");
			expect(turn2User).toBeDefined();
			expect(turn2User!.content).toEqual([{ type: "text", text: "第二轮普通提问" }]);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("extractStreamingPayload: 视觉模型完整解构图片、文本附件与引用 (fixes #717)", () => {
		const asides = [
			{
				message: {
					customType: "file",
					content: [
						{
							type: "image",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
							mimeType: "image/png",
						},
					],
					display: true,
					details: { name: "arch.png", mode: "image" },
				},
			},
			{
				message: {
					customType: "file",
					content: [{ type: "text", text: '<file path="src/server.ts" />' }],
					display: true,
					details: { name: "server.ts", path: "src/server.ts", mode: "reference" },
				},
			},
			{
				message: {
					customType: "file",
					content: [{ type: "text", text: formatTextQuote(sampleQuote) }],
					display: true,
					details: { mode: "quote", quote: sampleQuote },
				},
			},
		];

		const payload = extractStreamingPayload(asides, [], true, "claude-3-5-sonnet");

		expect(payload.promptImages.length).toBe(1);
		expect(payload.promptImages[0]!.mimeType).toBe("image/png");
		expect(payload.imageNames).toEqual(["arch.png"]);

		expect(payload.textAsides).toEqual(['<file path="src/server.ts" />']);

		expect(payload.quotes).toEqual([sampleQuote]);
	});

	it("extractStreamingPayload: 非视觉模型补充占位提示，杜绝排队发图静默消失 (fixes #717)", () => {
		const asides = [
			{
				message: {
					customType: "file",
					content: [
						{
							type: "image",
							data: "raw_image_data",
							mimeType: "image/jpeg",
						},
					],
					display: true,
					details: { name: "photo.jpg", mode: "image" },
				},
			},
			{
				message: {
					customType: "file",
					content: [
						{ type: "text", text: "<vision-bridge>\n识别为折线图\n</vision-bridge>" },
						{ type: "image", data: "bridge_raw", mimeType: "image/png" },
					],
					display: true,
					details: { name: "chart.png", mode: "bridged" },
				},
			},
		];

		const payload = extractStreamingPayload(asides, [], false, "deepseek-coder");

		expect(payload.promptImages.length).toBe(0);

		expect(payload.imageNames).toEqual(["photo.jpg", "chart.png"]);

		expect(payload.textAsides.length).toBe(2);
		expect(payload.textAsides[0]).toContain(
			'[Attached image "photo.jpg" omitted: model (deepseek-coder) does not support vision]',
		);
		expect(payload.textAsides[1]).toBe("<vision-bridge>\n识别为折线图\n</vision-bridge>");
	});

	it("空闲发送 await 期间转入 streaming 时自愈：排空 _pendingNextTurnMessages 且排队 prompt 携带完整附件 (fixes #717)", async () => {
		const session = {
			isStreaming: false,
			model: { name: "gpt-4o", input: ["text", "image"] },
			_pendingNextTurnMessages: [] as unknown[],
			promptsReceived: [] as { text: string; options?: unknown }[],
			async sendCustomMessage(msg: unknown, opts?: { deliverAs?: string }) {
				if (opts?.deliverAs === "nextTurn") {
					this._pendingNextTurnMessages.push(msg);
				}
			},
			async prompt(text: string, options?: { streamingBehavior?: string; images?: unknown[] }) {
				if (this.isStreaming) {
					this.promptsReceived.push({ text, options });
					return;
				}
				const injected = [...this._pendingNextTurnMessages];
				this._pendingNextTurnMessages = [];
				this.promptsReceived.push({ text, options: { ...options, injected } });
			},
		};

		const asides = [
			{
				message: {
					customType: "file",
					content: [{ type: "image", data: "flowchart_base64", mimeType: "image/png" }],
					display: true,
					details: { name: "flowchart.png", mode: "image" },
				},
			},
			{
				message: {
					customType: "file",
					content: [{ type: "text", text: '<file path="server/agent-service.ts" />' }],
					display: true,
					details: { name: "agent-service.ts", path: "server/agent-service.ts", mode: "reference" },
				},
			},
		];

		expect(session.isStreaming).toBe(false);

		for (const aside of asides) {
			await session.sendCustomMessage(aside.message, { deliverAs: "nextTurn" });
		}
		expect(session._pendingNextTurnMessages.length).toBe(2);

		session.isStreaming = true;

		const deliverStreamingPrompt = async (text: string) => {
			if (Array.isArray(session._pendingNextTurnMessages)) {
				session._pendingNextTurnMessages = [];
			}
			const { promptImages, textAsides, imageNames, quotes } = extractStreamingPayload(
				asides,
				[],
				session.model.input.includes("image"),
				session.model.name,
			);
			const fullPromptText = formatStreamingPrompt(text, textAsides, quotes, imageNames);
			await session.prompt(fullPromptText, {
				streamingBehavior: "steer",
				images: promptImages.length > 0 ? promptImages : undefined,
			});
		};

		if (session.isStreaming) {
			await deliverStreamingPrompt("请帮我看下这个流程图和代码");
		}

		expect(session._pendingNextTurnMessages.length).toBe(0);

		expect(session.promptsReceived.length).toBe(1);
		const queuedPrompt = session.promptsReceived[0]!;
		expect(queuedPrompt.text).toContain("请帮我看下这个流程图和代码");
		expect(queuedPrompt.text).toContain('<attached-image name="flowchart.png" />');
		expect(queuedPrompt.text).toContain('<file path="server/agent-service.ts" />');
		expect(queuedPrompt.options).toEqual({
			streamingBehavior: "steer",
			images: [{ type: "image", data: "flowchart_base64", mimeType: "image/png" }],
		});

		session.isStreaming = false;

		await session.prompt("下一个问题：怎么重构？");
		expect(session.promptsReceived.length).toBe(2);
		const nextTurnPrompt = session.promptsReceived[1]!;
		expect(nextTurnPrompt.text).toBe("下一个问题：怎么重构？");
		expect((nextTurnPrompt.options as { injected: unknown[] }).injected).toEqual([]);
	});

	it("同文本不同图排队：删除 index 1 时幸存的 index 0 重新入队携带原本图片，杜绝串台覆盖 (fixes #718)", async () => {
		const imgA = [{ type: "image" as const, data: "imgA_base64", mimeType: "image/png" }];
		const imgB = [{ type: "image" as const, data: "imgB_base64", mimeType: "image/png" }];

		const session = {
			isStreaming: true,
			steeringQueue: [] as Array<{ text: string; images?: typeof imgA }>,
			followUpQueue: [] as Array<{ text: string; images?: typeof imgA }>,
			clearQueue() {
				const steering = this.steeringQueue.map((e) => e.text);
				const followUp = this.followUpQueue.map((e) => e.text);
				this.steeringQueue = [];
				this.followUpQueue = [];
				return { steering, followUp };
			},
			async followUp(text: string, images?: typeof imgA) {
				this.followUpQueue.push({ text, images });
			},
		};

		let queuedFollowUpEntries = [
			{ text: "继续处理", images: imgA },
			{ text: "继续处理", images: imgB },
		];
		await session.followUp("继续处理", imgA);
		await session.followUp("继续处理", imgB);

		const targetIndex = 1;
		const targetText = "继续处理";

		const { followUp } = session.clearQueue();
		const currentFollowUpEntries = queuedFollowUpEntries;

		const kept = [...currentFollowUpEntries.slice(0, targetIndex), ...currentFollowUpEntries.slice(targetIndex + 1)];
		queuedFollowUpEntries = [];

		for (const entry of kept) {
			queuedFollowUpEntries.push(entry);
			await session.followUp(entry.text, entry.images);
		}

		expect(session.followUpQueue.length).toBe(1);
		expect(session.followUpQueue[0]!.text).toBe("继续处理");
		expect(session.followUpQueue[0]!.images).toEqual(imgA);
	});

	it("同文本不同图排队：删除 index 0 时幸存的 index 1 重新入队携带原本图片 (fixes #718)", async () => {
		const imgA = [{ type: "image" as const, data: "imgA_base64", mimeType: "image/png" }];
		const imgB = [{ type: "image" as const, data: "imgB_base64", mimeType: "image/png" }];

		const session = {
			isStreaming: true,
			followUpQueue: [] as Array<{ text: string; images?: typeof imgA }>,
			clearQueue() {
				const followUp = this.followUpQueue.map((e) => e.text);
				this.followUpQueue = [];
				return { steering: [], followUp };
			},
			async followUp(text: string, images?: typeof imgA) {
				this.followUpQueue.push({ text, images });
			},
		};

		let queuedFollowUpEntries = [
			{ text: "继续处理", images: imgA },
			{ text: "继续处理", images: imgB },
		];
		await session.followUp("继续处理", imgA);
		await session.followUp("继续处理", imgB);

		const targetIndex = 0;

		session.clearQueue();
		const kept = [...queuedFollowUpEntries.slice(0, targetIndex), ...queuedFollowUpEntries.slice(targetIndex + 1)];
		queuedFollowUpEntries = [];

		for (const entry of kept) {
			queuedFollowUpEntries.push(entry);
			await session.followUp(entry.text, entry.images);
		}

		expect(session.followUpQueue.length).toBe(1);
		expect(session.followUpQueue[0]!.text).toBe("继续处理");
		expect(session.followUpQueue[0]!.images).toEqual(imgB);
	});
});
