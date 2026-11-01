import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceCollabService } from "../../server/device-center/collab-service.js";
import {
	makeDeviceCollabTool,
	projectTaskState,
	setDeviceCollabService,
	validateDeviceCollabInput,
	type DeviceCollabExecutionContext,
	type DeviceCollabInput,
} from "../../server/device-center/collab-tool.js";
import {
	buildDeterministicTaskSummary,
	queryTaskReportChunk,
	type ConversationTaskState,
} from "../../server/device-center/task-state.js";
import { selectTaskContext } from "../../server/device-center/task-context-budget.js";
import { groupTaskContext } from "../../server/device-center/group-context.js";
import { createTaskReportStore } from "../../server/device-center/task-report.js";
import type { Bot, Room, RoomMessage } from "../../server/device-center/store.js";

const dirs: string[] = [];
afterEach(async () => {
	setDeviceCollabService(undefined);
	for (const d of dirs.splice(0)) {
		await rm(d, { recursive: true, force: true });
	}
});

const context = { cwd: resolve("task-evidence-workspace"), sessionId: "test-session" };
const mockState: ConversationTaskState = {
	revision: 5,
	objective: "Initial user requirement",
	currentTaskId: "task-100",
	phase: "running",
	blocker: { attentionId: "att-1", taskId: "task-100", question: "Need human confirmation" },
	decisions: [
		{
			attentionId: "att-0",
			messageId: "msg-0",
			taskId: "task-99",
			question: "Deploy to staging?",
			answer: "Yes, deploy with read-only database replica",
			questionTruncated: false,
			answerTruncated: false,
		},
	],
	artifacts: [{ deliveryId: "del-1", taskId: "task-99" }],
	reported: {
		taskId: "task-100",
		botId: "worker-bot",
		updatedAt: 12345678,
		provenance: "bot_reported",
		constraints: ["Do not delete production tables"],
		progress: "Completed database migration script",
		blockers: ["Waiting for firewall approval"],
		nextSteps: ["Run integration checks"],
	},
};

const binding: DeviceCollabExecutionContext = {
	roomId: "room-1",
	botId: "coordinator-bot",
	taskId: "task-100",
	conversationId: "conv-1",
	taskState: mockState,
};

function fixture(bound: DeviceCollabExecutionContext | undefined = binding) {
	const request = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
		const urlStr = String(url);
		if (urlStr.includes("/evidence")) {
			return new Response(
				JSON.stringify({
					conversationId: "conv-1",
					taskId: "task-100",
					evidence: queryTaskReportChunk(
						"task-100",
						"Detailed execution report\n" + "Log line 1\n".repeat(50) + "Conclusion: checks passed",
						0,
						256,
						{
							attemptId: "att-100",
							revision: 5,
							source: "full_report",
							complete: true,
							reportRef: "ref-100",
						},
					),
					summary: buildDeterministicTaskSummary(mockState),
				}),
			);
		}
		return new Response(
			JSON.stringify({
				taskState: mockState,
				events: [
					{ id: "ev-1", sequence: 1, type: "user_message", sourceId: "user", createdAt: 1, text: "Start" },
					{ id: "ev-2", sequence: 2, type: "execution_started", sourceId: "task-100", createdAt: 2 },
				],
				summary: buildDeterministicTaskSummary(mockState, {
					userConstraints: ["Must maintain zero-downtime, continuous replication, and automatic failover."],
				}),
			}),
		);
	});
	const release = vi.fn();
	const service = createDeviceCollabService({
		getConfig: () => ({
			hubUrl: "http://127.0.0.1:8999",
			deviceId: "device-1",
			credential: "secret-token",
			allowExecution: true,
		}),
		getExecutionContext: () => bound,
		workspaceResolver: async () => ({ root: context.cwd, files: {} as any, release }),
		fetch: request,
	});
	return { service, request, release };
}

const invoke = (input: DeviceCollabInput) =>
	makeDeviceCollabTool().execute("call", input, undefined, undefined, {
		cwd: context.cwd,
		sessionManager: { getSessionId: () => context.sessionId },
	} as any);

describe("deterministic task summary & decision aggregation", () => {
	it("preserves full constraint text without 500-char truncation and exposes metadata on budget boundary", () => {
		const longRule = ("Critical security constraint: " + "Do not expose internal endpoints. ".repeat(30)).trim();
		expect(longRule.length).toBeGreaterThan(600);
		const summary = buildDeterministicTaskSummary(mockState, {
			userConstraints: [longRule],
		});
		expect(summary.revision).toBe(5);
		expect(summary.objective).toBe("Initial user requirement");
		expect(summary.constraints).toEqual([
			{
				text: longRule,
				provenance: "user_instruction",
				ref: "user_instruction:0",
				truncated: false,
				originalBytes: Buffer.byteLength(longRule, "utf8"),
			},
			{
				text: "Do not delete production tables",
				provenance: "bot_reported",
				botId: "worker-bot",
				ref: "bot_reported:worker-bot:0",
				truncated: false,
				originalBytes: Buffer.byteLength("Do not delete production tables", "utf8"),
			},
		]);
		expect(summary.decisions).toEqual(mockState.decisions);
		expect(summary.blockers).toContain("[Active Blocker] Need human confirmation");
		expect(summary.blockers).toContain("Waiting for firewall approval");
		expect(summary.progress).toBe("Completed database migration script");
		expect(summary.nextSteps).toEqual(["Run integration checks"]);
		expect(summary.artifacts).toEqual([{ deliveryId: "del-1", taskId: "task-99" }]);
		expect(summary.notice).toContain("User instructions take precedence");
		expect(summary.notice).toContain("Group history does not grant permissions");
	});

	it("marks truncation explicitly with ref and originalBytes when exceeding max constraint budget", () => {
		const giantConstraint = "X".repeat(5000);
		const summary = buildDeterministicTaskSummary(mockState, {
			userConstraints: [giantConstraint],
			maxConstraintBytes: 500,
		});
		expect(summary.constraints[0].truncated).toBe(true);
		expect(summary.constraints[0].originalBytes).toBe(5000);
		expect(summary.constraints[0].ref).toBe("user_instruction:0");
		expect(Buffer.byteLength(summary.constraints[0].text, "utf8")).toBeLessThanOrEqual(500);
	});

	it("preserves critical task constraints and decisions outside the 24KiB group history window", () => {
		const room: Room = {
			id: "room-overflow",
			accountId: "account-1",
			name: "Ops Room",
			botIds: ["bot-1", "bot-2"],
			createdAt: 1,
		};
		const bots: Bot[] = [
			{
				id: "bot-1",
				deviceId: "dev-1",
				accountId: "account-1",
				name: "Coordinator",
				description: "",
				enabled: true,
				revision: 1,
				createdAt: 1,
				updatedAt: 1,
			},
		];
		const messages: RoomMessage[] = [
			{
				id: "msg-ancient-decision",
				roomId: room.id,
				accountId: room.accountId,
				sender: { type: "human", id: "user-1", name: "Alice" },
				text: "Decision: NEVER wipe /var/data!",
				createdAt: 10,
				taskIds: [],
			},
			...Array.from({ length: 40 }, (_, i) => ({
				id: `msg-noise-${i}`,
				roomId: room.id,
				accountId: room.accountId,
				sender: { type: "bot" as const, id: "bot-2", name: "Worker" },
				text: `Log dump ${i}: ` + "x".repeat(1500),
				createdAt: 20 + i,
				taskIds: [],
			})),
		];
		const groupCtx = groupTaskContext(room, bots, messages);
		expect(groupCtx.truncated).toBe(true);
		expect(groupCtx.messages.some((m) => m.id === "msg-ancient-decision")).toBe(false);

		const taskCtx = selectTaskContext(mockState, 12 * 1024);
		expect(taskCtx.state.decisions).toHaveLength(1);
		expect(taskCtx.state.decisions[0].answer).toContain("read-only database replica");
		expect(taskCtx.state.reported?.constraints).toContain("Do not delete production tables");
		expect(taskCtx.selection.omitted.decisions).toBe(0);
	});
});

describe("deterministic report evidence pagination, boundary alignment & version digest", () => {
	it("aligns non-boundary offset backward to code point start without replacement characters", () => {
		// "🙂" is 4 bytes: [0xf0, 0x9f, 0x99, 0x82]
		const text = "Prefix🙂Suffix";
		const rawBuf = Buffer.from(text, "utf8");
		// Index of 🙂 start is 6, continuation bytes are 7, 8, 9
		const unalignedOffset = 8;
		expect((rawBuf[unalignedOffset] & 0xc0) === 0x80).toBe(true);

		const result = queryTaskReportChunk("task-test", text, unalignedOffset, 256);
		// Must align backward to index 6
		expect(result.offset).toBe(6);
		expect(result.chunk.startsWith("🙂")).toBe(true);
		expect(result.chunk).not.toContain("\uFFFD");
	});

	it("shrinks end boundary backward to never exceed limit by 1-3 bytes", () => {
		const text = "A".repeat(10) + "🙂" + "B".repeat(10);
		// Buffer length is 24. If offset is 0 and limit is 12:
		// Bytes 0..9 are 'A', byte 10 is 0xf0, byte 11 is 0x9f.
		// If naive forward search was used, end would be 14 (14 > 12, exceeding limit).
		// Our backward shrink ensures end is 10 (length 10 <= 12).
		const result = queryTaskReportChunk("task-test", text, 0, 12);
		expect(Buffer.byteLength(result.chunk, "utf8")).toBeLessThanOrEqual(12);
		expect(result.chunk).toBe("A".repeat(10));
	});

	it("binds digest to task, attemptId, revision and totalBytes to prevent cross-version mix-reading", () => {
		const text = "Report content line";
		const chunkA = queryTaskReportChunk("task-1", text, 0, 1024, { attemptId: "att-1", revision: 1 });
		const chunkB = queryTaskReportChunk("task-1", text, 0, 1024, { attemptId: "att-2", revision: 1 });
		const chunkC = queryTaskReportChunk("task-1", text, 0, 1024, { attemptId: "att-1", revision: 2 });

		expect(chunkA.sha256).toBe(chunkB.sha256); // content sha256 identical
		expect(chunkA.digest).not.toBe(chunkB.digest); // attempt differs
		expect(chunkA.digest).not.toBe(chunkC.digest); // revision differs
	});

	it("differentiates full_report from report_excerpt and detects excerpt truncation markers", () => {
		const excerptText = "Start\n[Report excerpt: 50000 original UTF-8 bytes; middle omitted]\nEnd";
		const evidence = queryTaskReportChunk("task-1", excerptText, 0, 1024, {
			source: "report_excerpt",
			complete: false,
		});
		expect(evidence.source).toBe("report_excerpt");
		expect(evidence.complete).toBe(false);
		expect(evidence.isExcerpt).toBe(true);

		const fullEvidence = queryTaskReportChunk("task-1", "Full un-truncated output", 0, 1024, {
			source: "full_report",
			complete: true,
			reportRef: "ref-abc",
		});
		expect(fullEvidence.source).toBe("full_report");
		expect(fullEvidence.complete).toBe(true);
		expect(fullEvidence.isExcerpt).toBe(false);
		expect(fullEvidence.reportRef).toBe("ref-abc");
	});

	it("strictly validates offset and limit parameters against negative/NaN values", () => {
		expect(() => queryTaskReportChunk("task-1", "text", -1)).toThrow(RangeError);
		expect(() => queryTaskReportChunk("task-1", "text", NaN)).toThrow(RangeError);
		expect(() => queryTaskReportChunk("task-1", "text", 0, 0)).toThrow(RangeError);
		expect(() => queryTaskReportChunk("task-1", "text", 0, -5)).toThrow(RangeError);
		expect(() => queryTaskReportChunk("task-1", "text", 0, NaN)).toThrow(RangeError);
	});
});

describe("collab tool task_state & task_evidence endpoints and real report store integration", () => {
	it("integrates with createTaskReportStore to retrieve genuine full reports", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "report-store-test-"));
		dirs.push(tempDir);
		const store = createTaskReportStore(tempDir, "hub");
		const fullText = "Full detailed report:\n" + "Trace event: 123\n".repeat(300);
		const meta = store.saveFullReport("task-store-1", "attempt-1", "room-1", "account-1", fullText);
		expect(meta.complete).toBe(true);

		const fetched = store.getReport("task-store-1", "attempt-1", "account-1", "room-1");
		expect(fetched).not.toBeNull();
		expect(fetched!.text).toBe(fullText);

		const evidence = queryTaskReportChunk("task-store-1", fetched!.text!, 0, 512, {
			attemptId: "attempt-1",
			revision: 3,
			source: "full_report",
			complete: fetched!.meta.complete,
			reportRef: fetched!.meta.storageLocation.reportRef,
		});
		expect(evidence.source).toBe("full_report");
		expect(evidence.complete).toBe(true);
		expect(evidence.totalBytes).toBe(Buffer.byteLength(fullText, "utf8"));
		expect(evidence.reportRef).toBeDefined();
	});

	it("validates task_evidence input and defaults to bound conversation and task", async () => {
		validateDeviceCollabInput({
			action: "task_evidence",
			taskId: "task-100",
			offset: 0,
			limit: 1024,
		});
		for (const invalid of [{ offset: -1 }, { offset: NaN }, { limit: 0 }, { limit: -10 }, { limit: 70000 }]) {
			expect(() => validateDeviceCollabInput({ action: "task_evidence", ...invalid })).toThrow();
		}

		const f = fixture();
		setDeviceCollabService(f.service);
		const result = await invoke({ action: "task_evidence", offset: 0, limit: 256 });
		expect(f.request).toHaveBeenCalledTimes(1);
		const url = String(f.request.mock.calls[0][0]);
		expect(url).toContain("/rooms/room-1/conversations/conv-1/evidence?");
		expect(url).toContain("offset=0");
		expect(url).toContain("limit=256");

		const details = (result.details as any).summary;
		expect(details.evidence).toBeDefined();
		expect(details.evidence.taskId).toBe("task-100");
		expect(details.evidence.hasMore).toBe(true);
		expect(details.evidence.digest).toBeDefined();
		expect(details.summary).toBeDefined();
		expect(details.summary.revision).toBe(5);
	});

	it("queries task_state with beforeSequence pagination and receives summary and events", async () => {
		const f = fixture();
		setDeviceCollabService(f.service);
		const result = await invoke({ action: "task_state", beforeSequence: 3 });
		expect(f.request).toHaveBeenCalledTimes(1);
		const url = String(f.request.mock.calls[0][0]);
		expect(url).toContain("/rooms/room-1/conversations/conv-1/task-state?");
		expect(url).toContain("beforeSequence=3");

		const details = (result.details as any).summary;
		expect(details.taskState).toBeDefined();
		expect(details.taskState.revision).toBe(5);
		expect(details.events).toHaveLength(2);
		expect(details.summary).toBeDefined();
		expect(details.summary.constraints).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ text: expect.stringContaining("zero-downtime"), provenance: "user_instruction" }),
				expect.objectContaining({ text: "Do not delete production tables", provenance: "bot_reported" }),
			]),
		);
	});

	it("projects evidence and summary without leaking private fields", () => {
		const raw = {
			taskState: mockState,
			privateCredentials: "token-123",
			summary: {
				...buildDeterministicTaskSummary(mockState),
				secretField: "do-not-leak",
			},
			evidence: {
				...queryTaskReportChunk("task-100", "Sample report", 0, 1024, {
					attemptId: "att-1",
					revision: 2,
					source: "full_report",
					complete: true,
				}),
				token: "leak-test",
			},
		};
		const projected = projectTaskState(raw);
		const str = JSON.stringify(projected);
		expect(str).not.toContain("token-123");
		expect(str).not.toContain("do-not-leak");
		expect(str).not.toContain("leak-test");
		expect((projected as any).summary.constraints).toBeDefined();
		expect((projected as any).evidence.sha256).toBeDefined();
		expect((projected as any).evidence.digest).toBeDefined();
		expect((projected as any).evidence.source).toBe("full_report");
	});
});

describe("hub HTTP endpoints integration: task-state & evidence", () => {
	it("enforces strict query validation, pagination and truthful report source differentiation", async () => {
		const { createDeviceHub } = await import("../../server/device-center/hub.js");
		const { hashSecret } = await import("../../server/device-center/store.js");
		const { request: httpRequest } = await import("node:http");

		const tempDir = await mkdtemp(join(tmpdir(), "hub-evidence-test-"));
		dirs.push(tempDir);

		const hub = await createDeviceHub({
			dataDir: tempDir,
			publicUrl: "https://hub.test",
			onTask: () => {},
			onRevoke: () => {},
		});
		await new Promise<void>((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
		const address = hub.server.address() as { port: number };

		try {
			// Setup account, device, bot, room, conversation, task using hub.store
			await hub.store.transact((s) => {
				s.accounts.push({ id: "acc-1", username: "user1", passwordHash: "h", createdAt: 1 });
				s.devices.push({
					id: "dev-1",
					accountId: "acc-1",
					name: "Dev1",
					credentialHash: hashSecret("dev-secret"),
					createdAt: 1,
				});
				s.bots.push({
					id: "bot-1",
					deviceId: "dev-1",
					accountId: "acc-1",
					name: "Bot1",
					description: "",
					enabled: true,
					revision: 1,
					createdAt: 1,
					updatedAt: 1,
				});
				s.rooms.push({
					id: "room-1",
					accountId: "acc-1",
					name: "Room1",
					botIds: ["bot-1"],
					createdAt: 1,
				});
				s.conversations.push({
					id: "conv-1",
					accountId: "acc-1",
					roomId: "room-1",
					botId: "bot-1",
					deviceId: "dev-1",
					botRevision: 1,
					name: "Test Conv",
					rootTaskId: "task-1",
					latestTaskId: "task-1",
					dispatchDepth: 0,
					createdAt: 1,
					updatedAt: 1,
					taskState: {
						revision: 2,
						objective: "User objective",
						currentTaskId: "task-1",
						phase: "completed",
						decisions: [],
						artifacts: [],
						reported: {
							taskId: "task-1",
							botId: "bot-1",
							updatedAt: 1,
							provenance: "bot_reported",
							constraints: ["No force-push"],
							progress: "Done",
							blockers: [],
							nextSteps: [],
						},
					},
					events: [
						{ id: "e1", sequence: 1, type: "user_message", sourceId: "user", createdAt: 1, text: "Init" },
						{ id: "e2", sequence: 2, type: "execution_completed", sourceId: "task-1", createdAt: 2 },
					],
				});
				s.tasks.push({
					id: "task-1",
					attemptId: "att-1",
					conversationId: "conv-1",
					accountId: "acc-1",
					roomId: "room-1",
					botId: "bot-1",
					deviceId: "dev-1",
					botRevision: 1,
					text: "Run task",
					status: "completed",
					createdAt: 1,
					updatedAt: 2,
					report: "Short summary\n[Report excerpt: 40000 original UTF-8 bytes; middle omitted]\nFinal outcome",
				});
			});

			const req = (path: string) =>
				new Promise<{ status: number; body: any }>((resolve, reject) => {
					const r = httpRequest(
						`http://127.0.0.1:${address.port}${path}`,
						{
							method: "GET",
							headers: {
								Host: "hub.test",
								Origin: "https://hub.test",
								"X-Device-Id": "dev-1",
								Authorization: "Bearer dev-secret",
							},
						},
						(res) => {
							let data = "";
							res.setEncoding("utf8");
							res.on("data", (chunk) => (data += chunk));
							res.on("end", () => {
								try {
									resolve({ status: res.statusCode!, body: JSON.parse(data) });
								} catch {
									resolve({ status: res.statusCode!, body: data });
								}
							});
						},
					);
					r.on("error", reject);
					r.end();
				});

			// 1. Strict query validation on task-state
			const invalidQuery = await req(
				"/api/agent/rooms/room-1/conversations/conv-1/task-state?sourceBotId=bot-1&rogueParam=123",
			);
			expect(invalidQuery.status).toBe(400);

			const invalidSeq = await req(
				"/api/agent/rooms/room-1/conversations/conv-1/task-state?sourceBotId=bot-1&beforeSequence=-1",
			);
			expect(invalidSeq.status).toBe(400);

			// 2. Normal task-state with beforeSequence
			const validState = await req(
				"/api/agent/rooms/room-1/conversations/conv-1/task-state?sourceBotId=bot-1&beforeSequence=2",
			);
			expect(validState.status).toBe(200);
			expect(validState.body.events).toHaveLength(1);
			expect(validState.body.events[0].sequence).toBe(1);
			expect(validState.body.summary.constraints[0].text).toBe("No force-push");

			// 3. Evidence endpoint: before full report is stored, returns report_excerpt with complete=false
			const excerptEvidence = await req("/api/agent/rooms/room-1/conversations/conv-1/evidence?sourceBotId=bot-1");
			expect(excerptEvidence.status).toBe(200);
			expect(excerptEvidence.body.evidence.source).toBe("report_excerpt");
			expect(excerptEvidence.body.evidence.complete).toBe(false);
			expect(excerptEvidence.body.evidence.isExcerpt).toBe(true);

			// 4. Save genuine >64KiB full report to createTaskReportStore and verify endpoint returns full_report with complete=true
			const reportStore = createTaskReportStore(tempDir, "hub");
			// Create a 80,000 bytes full report (clearly exceeds 64 KiB)
			const realFullText =
				"Header: un-truncated start\n" +
				"Middle log line payload: 0123456789ABCDEF\n".repeat(2000) +
				"Footer: un-truncated end\n";
			const fullBytes = Buffer.byteLength(realFullText, "utf8");
			expect(fullBytes).toBeGreaterThan(65536);

			reportStore.saveFullReport("task-1", "att-1", "room-1", "acc-1", realFullText);

			// First chunk reading from 0
			const firstChunkRes = await req(
				"/api/agent/rooms/room-1/conversations/conv-1/evidence?sourceBotId=bot-1&offset=0&limit=32768",
			);
			expect(firstChunkRes.status).toBe(200);
			const firstChunk = firstChunkRes.body.evidence;
			expect(firstChunk.source).toBe("full_report");
			expect(firstChunk.complete).toBe(true);
			expect(firstChunk.totalBytes).toBe(fullBytes);
			expect(firstChunk.hasMore).toBe(true);
			expect(firstChunk.nextOffset).toBe(32768);
			expect(firstChunk.chunk.startsWith("Header: un-truncated start\n")).toBe(true);
			const canonicalDigest = firstChunk.digest;
			expect(canonicalDigest).toBeDefined();

			// Second chunk reading second half (>64KiB at offset=70000) with expectedDigest
			const secondChunkRes = await req(
				`/api/agent/rooms/room-1/conversations/conv-1/evidence?sourceBotId=bot-1&offset=70000&limit=16384&expectedDigest=${canonicalDigest}`,
			);
			expect(secondChunkRes.status).toBe(200);
			const secondChunk = secondChunkRes.body.evidence;
			expect(secondChunk.source).toBe("full_report");
			expect(secondChunk.complete).toBe(true);
			expect(secondChunk.totalBytes).toBe(fullBytes); // Full totalBytes preserved!
			expect(secondChunk.offset).toBe(70000);
			expect(secondChunk.digest).toBe(canonicalDigest);
			expect(secondChunk.chunk).toContain("Footer: un-truncated end\n");

			// Version drift check: tampered expectedDigest must be rejected with 409
			const conflictRes = await req(
				`/api/agent/rooms/room-1/conversations/conv-1/evidence?sourceBotId=bot-1&offset=70000&limit=16384&expectedDigest=mismatched-drifted-digest`,
			);
			expect(conflictRes.status).toBe(409);

			// 5. Strict query validation on evidence
			const invalidEvQuery = await req(
				"/api/agent/rooms/room-1/conversations/conv-1/evidence?sourceBotId=bot-1&unknown=1",
			);
			expect(invalidEvQuery.status).toBe(400);

			const invalidOffset = await req(
				"/api/agent/rooms/room-1/conversations/conv-1/evidence?sourceBotId=bot-1&offset=-10",
			);
			expect(invalidOffset.status).toBe(400);
		} finally {
			await hub.close();
		}
	});
});
