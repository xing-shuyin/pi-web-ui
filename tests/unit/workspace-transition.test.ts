import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { parseSessionInfoFast } from "../../server/session-parser.js";

describe("workspace & session streaming transition", () => {
	it("extractTranscriptPreview extracts tail non-system messages and total count before runtime mounts", () => {
		const cs = Object.create(ClientSession.prototype) as any;
		const branchEntries = [
			{
				type: "message",
				message: { role: "system", content: "internal system prompt", timestamp: 1000 },
			},
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "First question" }], timestamp: 1001 },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "First answer" }],
					timestamp: 1002,
					model: "gpt-5",
					provider: "openai",
				},
			},
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "Second question" }], timestamp: 1003 },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Second answer" }],
					timestamp: 1004,
					model: "gpt-5",
					provider: "openai",
				},
			},
		];
		const fakeManager = {
			getBranch: () => branchEntries,
		};

		const preview = cs.extractTranscriptPreview(fakeManager, 2);
		expect(preview.totalMessages).toBe(4);
		expect(preview.previewMessages).toHaveLength(2);
		expect(preview.previewMessages[0].role).toBe("user");
		expect(preview.previewMessages[0].content[0]).toMatchObject({ type: "text", text: "Second question" });
		expect(preview.previewMessages[1].role).toBe("assistant");
		expect(preview.previewMessages[1].content[0]).toMatchObject({ type: "text", text: "Second answer" });
	});

	it("openManagerAndRuntime streams transcript callback before awaiting runtime creation", async () => {
		const cs = Object.create(ClientSession.prototype) as any;
		const order: string[] = [];
		const fakeManager = {
			getEntries: () => [],
			getLeafId: () => null,
			branch: vi.fn(),
			getBranch: () => [],
		};

		const res = await cs.openManagerAndRuntime(
			() => {
				order.push("makeManager");
				return fakeManager;
			},
			async () => {
				order.push("makeRuntime");
				return { session: {} };
			},
			async () => undefined,
			async () => {
				order.push("onTranscriptLoaded");
			},
		);

		expect(order).toEqual(["makeManager", "onTranscriptLoaded", "makeRuntime"]);
		expect(res.repair).toBeNull();
	});

	it("parseSessionInfoFast fast-path skips full JSON.parse on large message lines in list mode while keeping exact count and modified time", async () => {
		const dir = mkdtempSync(join(tmpdir(), "piwui-fast-parse-"));
		const fp = join(dir, "huge.jsonl");
		try {
			const lines = [
				JSON.stringify({ type: "session", id: "sess-huge", cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" }),
				JSON.stringify({
					type: "message",
					message: { role: "user", timestamp: 1700000001000, content: "Initial prompt" },
				}),
				// Large >512-byte assistant/toolResult message line
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						timestamp: 1700000099000,
						content: [{ type: "text", text: "x".repeat(4096) }],
					},
				}),
				JSON.stringify({ type: "session_info", name: "My Fast Session" }),
			];
			writeFileSync(fp, lines.join("\n"));

			const info = await parseSessionInfoFast(fp, 1700000000000, false);
			expect(info).not.toBeNull();
			expect(info!.id).toBe("sess-huge");
			expect(info!.name).toBe("My Fast Session");
			expect(info!.firstMessage).toBe("Initial prompt");
			expect(info!.messageCount).toBe(2);
			expect(info!.modified.getTime()).toBe(1700000099000);
			expect(info!.allMessagesText).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preview state in transition isolates historyStart and conversationId from previous conversation", () => {
		const prevChatState = {
			conversationId: "conv-old",
			sessionId: "sess-old",
			sessionFile: "/path/to/old.jsonl",
			historyStart: 150,
			historyTotal: 300,
			messages: [{ id: "m1", role: "user", content: [] }],
		};
		const transition = {
			kind: "conversation" as const,
			target: "conv-target",
			previewMessages: [
				{ id: "p1", role: "user", content: [{ type: "text", text: "preview 1" }] },
				{ id: "p2", role: "assistant", content: [{ type: "text", text: "preview 2" }] },
			],
		};
		const previewState = {
			...prevChatState,
			conversationId: transition.kind === "conversation" ? transition.target : `preview:${transition.target}`,
			sessionFile: undefined,
			historyStart: 0,
			historyTotal: transition.previewMessages.length,
			messages: transition.previewMessages,
			streamingMessage: null,
			isStreaming: false,
			pendingQuestion: null,
			pendingApproval: null,
		};
		expect(previewState.conversationId).toBe("conv-target");
		expect(previewState.historyStart).toBe(0);
		expect(previewState.historyTotal).toBe(2);
		expect(previewState.sessionFile).toBeUndefined();
		expect(previewState.messages).toHaveLength(2);
	});
});
