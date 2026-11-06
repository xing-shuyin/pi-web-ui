import { afterEach, describe, expect, it, vi } from "vitest";
import {
	makeDeviceCollabTool,
	setDeviceCollabService,
	validateDeviceCollabInput,
} from "../../server/device-center/collab-tool.js";
import { createDeviceCollabService } from "../../server/device-center/collab-service.js";

const digest = "a".repeat(64);
const verificationDigest = "b".repeat(64);
const bound = { roomId: "room", botId: "author", taskId: "current", conversationId: "conversation" };
const delivery = {
	action: "conversation_deliver",
	roomId: "room",
	sourceBotId: "author",
	conversationId: "conversation",
	artifactTaskId: "previous-code-task",
	summary: "Captured result",
} as const;
const review = {
	action: "conversation_review",
	roomId: "room",
	sourceBotId: "reviewer",
	conversationId: "conversation",
	deliveryId: "delivery",
	artifactDigest: digest,
	integrationId: "integration",
	verificationDigest,
	criteriaResults: [
		{ criterionIndex: 0, verdict: "met", evidence: "The verification log and captured patch satisfy the criterion." },
	],
	verdict: "accepted",
	summary: "Reviewed",
} as const;
const ref = {
	artifactTaskId: "previous-code-task",
	attemptId: "attempt",
	artifactId: "artifact",
	artifactDigest: digest,
	contractId: "contract",
	contractRevision: 2,
	contractDigest: "c".repeat(64),
	manifestDigest: "d".repeat(64),
	baselineCommit: "1".repeat(40),
	repositoryId: "git:example/repo",
	inputTree: "2".repeat(40),
	outputTree: "3".repeat(40),
};
function service() {
	const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}", { status: 200 }));
	const api = createDeviceCollabService({
		root: process.cwd(),
		fetch: fetcher,
		getExecutionContext: () => bound,
		getConfig: () => ({
			hubUrl: "http://127.0.0.1:8999",
			deviceId: "device",
			credential: "fixture",
			allowExecution: true,
		}),
	});
	return { api, fetcher };
}
afterEach(() => setDeviceCollabService(undefined));

describe("artifact delivery and acceptance tool boundary", () => {
	it("allows a captured artifact subject without inventing a commit or declared checks", () => {
		expect(() => validateDeviceCollabInput({ ...delivery })).not.toThrow();
		expect(() => validateDeviceCollabInput({ ...review, criteriaResults: [...review.criteriaResults] })).not.toThrow();
	});
	it.each(["repository", "baseCommit", "commit", "branch"])(
		"rejects an ambiguous artifact plus %s subject",
		(field) => {
			expect(() =>
				validateDeviceCollabInput({
					...delivery,
					[field]: field.endsWith("Commit") || field === "commit" ? "1".repeat(40) : "other",
				} as any),
			).toThrow();
		},
	);
	it("preserves the required commit evidence for legacy deliveries", () => {
		const { artifactTaskId: _artifactTaskId, ...base } = delivery;
		expect(() => validateDeviceCollabInput({ ...base })).toThrow("Commit delivery");
		expect(() =>
			validateDeviceCollabInput({
				...base,
				repository: "repo",
				baseCommit: "1".repeat(40),
				commit: "2".repeat(40),
				checks: [],
			}),
		).not.toThrow();
	});
	it.each(["integrationId", "verificationDigest", "criteriaResults"])(
		"does not accept an artifact without %s",
		(field) => {
			const incomplete: any = { ...review };
			delete incomplete[field];
			expect(() => validateDeviceCollabInput(incomplete)).toThrow("Artifact acceptance");
		},
	);
	it.each(
		[
			[
				{ criterionIndex: 0, verdict: "met", evidence: "first" },
				{ criterionIndex: 0, verdict: "met", evidence: "duplicate" },
			],
			[{ criterionIndex: 0, verdict: "not_met", evidence: "Still failing" }],
			[{ criterionIndex: -1, verdict: "met", evidence: "wrong index" }],
			[{ criterionIndex: 0, verdict: "passed", evidence: "wrong verdict" }],
			[{ criterionIndex: 0, verdict: "met", evidence: "  " }],
			[{ criterionIndex: 0, verdict: "met", evidence: "evidence", verified: true }],
		].map((criteriaResults) => ({ criteriaResults })),
	)("rejects malformed criterion evidence", ({ criteriaResults }) => {
		expect(() => validateDeviceCollabInput({ ...review, criteriaResults } as any)).toThrow();
	});
	it("permits a bound changes request before verification and rejects fabricated receipts", () => {
		const {
			integrationId: _integrationId,
			verificationDigest: _verificationDigest,
			criteriaResults: _criteriaResults,
			...base
		} = review;
		expect(() => validateDeviceCollabInput({ ...base, verdict: "changes_requested" })).not.toThrow();
		expect(() => validateDeviceCollabInput({ ...delivery, artifactRef: ref } as any)).toThrow("Unsupported");
		expect(() => validateDeviceCollabInput({ ...review, verified: true } as any)).toThrow("Unsupported");
	});
	it("forwards the exact captured subject with current trusted task authority without mutating input", async () => {
		const { api, fetcher } = service();
		const input = { artifactTaskId: "previous-code-task", summary: "Captured result", idempotencyKey: "retry" };
		await api.execute("conversation_deliver", input, undefined, { cwd: process.cwd() });
		const [url, init] = fetcher.mock.calls[0]!;
		expect(String(url)).toContain("/api/agent/rooms/room/conversations/conversation/deliveries");
		const body = JSON.parse(String(init?.body));
		expect(body).toMatchObject({
			sourceBotId: "author",
			parentTaskId: "current",
			artifactTaskId: "previous-code-task",
			idempotencyKey: "retry",
			checks: [],
		});
		expect(body).not.toHaveProperty("commit");
		expect(input).toEqual({
			artifactTaskId: "previous-code-task",
			summary: "Captured result",
			idempotencyKey: "retry",
		});
	});
	it("validates direct service callers before contacting the Hub", async () => {
		const { api, fetcher } = service();
		await expect(
			api.execute(
				"conversation_deliver",
				{ artifactTaskId: "previous-code-task", summary: "result", commit: "1".repeat(40) },
				undefined,
				{ cwd: process.cwd() },
			),
		).rejects.toThrow("Device collaboration request failed.");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("forwards acceptance identifiers and criteria without promoting them to host verification", async () => {
		const { api, fetcher } = service();
		const { action: _action, sourceBotId: _sourceBotId, ...args } = review;
		await api.execute("conversation_review", { ...args, criteriaResults: [...review.criteriaResults] }, undefined, {
			cwd: process.cwd(),
		});
		const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
		expect(body).toMatchObject({
			artifactDigest: digest,
			integrationId: "integration",
			verificationDigest,
			criteriaResults: review.criteriaResults,
			parentTaskId: "current",
		});
		expect(body).not.toHaveProperty("commit");
		expect(body).not.toHaveProperty("verified");
	});
	it("projects bounded identities and verified references without private device logs or raw patches", async () => {
		setDeviceCollabService({
			execute: async () => ({
				conversation: {
					id: "conversation",
					latestDelivery: {
						id: "delivery",
						artifactRef: { ...ref, patchBase64: "private-patch" },
						acceptanceCriteria: ["Required behavior"],
						checks: [],
					},
					latestReview: {
						id: "review",
						artifactDigest: digest,
						integrationId: "integration",
						verificationDigest,
						verdict: "accepted",
						criteriaResults: review.criteriaResults,
					},
					latestIntegration: {
						id: "integration",
						status: "verified",
						artifactRef: ref,
						verification: {
							digest: verificationDigest,
							verifiedAt: 123,
							planDigest: "e".repeat(64),
							output: "/private/session",
						},
					},
				},
				integrations: [
					{
						id: "integration",
						status: "verified",
						materializedCommit: "4".repeat(40),
						artifactRef: ref,
						verification: { digest: verificationDigest, planDigest: "e".repeat(64), raw: "private-receipt" },
						validationCommands: [
							{
								command: "node check.cjs",
								status: "passed",
								exitCode: 0,
								output: "/private/output",
								outputPreview: "/private/preview",
								outputDigest: "f".repeat(64),
							},
						],
					},
				],
			}),
		});
		const response = await makeDeviceCollabTool().execute(
			"call",
			{ action: "conversation_read", roomId: "room", sourceBotId: "reviewer", conversationId: "conversation" },
			undefined,
			undefined,
			{ cwd: process.cwd(), sessionManager: { getSessionId: () => "session" } } as any,
		);
		const summary = (response.details as any).summary;
		expect(summary.conversation.latestDelivery).toMatchObject({
			artifactRef: ref,
			acceptanceCriteria: ["Required behavior"],
		});
		expect(summary.conversation.latestReview).toMatchObject({
			artifactDigest: digest,
			integrationId: "integration",
			verificationDigest,
			criteriaResults: review.criteriaResults,
		});
		expect(summary.integrations[0]).toMatchObject({ id: "integration", verification: { digest: verificationDigest } });
		expect(JSON.stringify(response)).not.toMatch(/private-patch|private-receipt|\/private\//);
		expect(Buffer.byteLength(JSON.stringify(response.details))).toBeLessThan(48 * 1024);
	});
});
