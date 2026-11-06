import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { canonicalizeJson } from "../../server/device-center/work-contract.js";
import {
	makeDeviceCollabTool,
	setDeviceCollabService,
	validateDeviceCollabInput,
} from "../../server/device-center/collab-tool.js";
import { createDeviceCollabService } from "../../server/device-center/collab-service.js";
const contractDigest = "a".repeat(64);
const context = { cwd: process.cwd(), sessionManager: { getSessionId: () => "session" } } as any;
afterEach(() => setDeviceCollabService(undefined));
describe("complete sealed acceptance evidence", () => {
	it("reassembles exact canonical criteria across byte pages without leaking unrelated metadata", async () => {
		const criteria = [
			"网络入口必须校验版本。".repeat(100),
			"The exact condition includes its final qualifier.".repeat(100),
		];
		const bytes = Buffer.from(canonicalizeJson(criteria));
		const criteriaDigest = createHash("sha256").update(bytes).digest("hex");
		const chunks: Buffer[] = [];
		const offsets = [0, 7];
		for (let i = 0; i < offsets.length; i++) {
			const offset = offsets[i]!;
			const end = i === 0 ? 7 : bytes.length;
			setDeviceCollabService({
				execute: async () => ({
					conversationId: "conversation",
					taskId: "source",
					deliveryId: "delivery",
					acceptance: {
						contractId: "contract",
						contractRevision: 2,
						contractDigest,
						criteriaDigest,
						criteriaCount: criteria.length,
						root: "/private/root",
					},
					content: {
						encoding: "base64",
						data: bytes.subarray(offset, end).toString("base64"),
						offset,
						limit: end - offset,
						totalBytes: bytes.length,
						nextOffset: end < bytes.length ? end : null,
						truncated: end < bytes.length,
					},
					privateContext: "hidden",
				}),
			});
			const result = await makeDeviceCollabTool().execute(
				"page",
				{
					action: "task_evidence",
					roomId: "room",
					sourceBotId: "reviewer",
					conversationId: "conversation",
					deliveryId: "delivery",
					evidenceKind: "acceptance",
					expectedDigest: contractDigest,
					offset,
					limit: end - offset,
				},
				undefined,
				undefined,
				context,
			);
			const summary = (result.details as any).summary;
			expect(summary.acceptance).toEqual({
				contractId: "contract",
				contractRevision: 2,
				contractDigest,
				criteriaDigest,
				criteriaCount: criteria.length,
			});
			expect(summary).toMatchObject({ taskId: "source", deliveryId: "delivery" });
			expect(JSON.stringify(result)).not.toMatch(/private|hidden/);
			expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThan(48 * 1024);
			chunks.push(Buffer.from(summary.content.data, "base64"));
		}
		const reconstructed = Buffer.concat(chunks);
		expect(JSON.parse(reconstructed.toString("utf8"))).toEqual(criteria);
		expect(createHash("sha256").update(reconstructed).digest("hex")).toBe(criteriaDigest);
	});
	it("forwards the contract digest and exact delivery subject in an acceptance request", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}", { status: 200 }));
		const api = createDeviceCollabService({
			root: process.cwd(),
			fetch: fetcher,
			getConfig: () => ({
				hubUrl: "http://127.0.0.1:8999",
				deviceId: "device",
				credential: "fixture",
				allowExecution: true,
			}),
		});
		await api.execute(
			"task_evidence",
			{
				roomId: "room",
				sourceBotId: "reviewer",
				conversationId: "conversation",
				deliveryId: "delivery",
				evidenceKind: "acceptance",
				expectedDigest: contractDigest,
				offset: 7,
				limit: 24576,
			},
			undefined,
			{ cwd: process.cwd() },
		);
		expect(Object.fromEntries(new URL(String(fetcher.mock.calls[0]![0])).searchParams)).toMatchObject({
			deliveryId: "delivery",
			evidenceKind: "acceptance",
			expectedDigest: contractDigest,
			offset: "7",
			limit: "24576",
		});
		expect(() =>
			validateDeviceCollabInput({ action: "task_evidence", evidenceKind: "acceptance", limit: 24577 }),
		).toThrow("24576");
	});
	it("keeps each displayed condition complete and marks a bounded summary as incomplete", async () => {
		const criterion = "x".repeat(1000) + " FINAL QUALIFIER";
		setDeviceCollabService({
			execute: async () => ({
				conversation: {
					id: "conversation",
					latestDelivery: {
						id: "delivery",
						acceptanceCriteria: Array.from({ length: 64 }, () => criterion),
						checks: [],
					},
				},
			}),
		});
		const result = await makeDeviceCollabTool().execute(
			"read",
			{ action: "conversation_read", roomId: "room", sourceBotId: "reviewer", conversationId: "conversation" },
			undefined,
			undefined,
			context,
		);
		const summary = (result.details as any).summary;
		const delivery = summary.conversation.latestDelivery;
		expect(delivery.acceptanceCriteriaCount).toBe(64);
		expect(delivery.acceptanceCriteriaTruncated).toBe(true);
		expect(delivery.acceptanceCriteria.length).toBeGreaterThan(0);
		expect(delivery.acceptanceCriteria.length).toBeLessThan(64);
		expect(delivery.acceptanceCriteria.every((value: string) => value === criterion)).toBe(true);
		expect(summary.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThan(48 * 1024);
	});
});
