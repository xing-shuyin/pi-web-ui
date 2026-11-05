import { afterEach, describe, expect, it, vi } from "vitest";
import {
	makeDeviceCollabTool,
	projectExecutionEvidence,
	setDeviceCollabService,
	validateDeviceCollabInput,
} from "../../server/device-center/collab-tool.js";
import { createDeviceCollabService } from "../../server/device-center/collab-service.js";

const artifact = {
	id: "artifact-1",
	digest: "a".repeat(64),
	producer: {
		deviceId: "device-1",
		botId: "bot-1",
		taskId: "task-1",
		attemptId: "attempt-1",
		contractDigest: "b".repeat(64),
		manifestDigest: "c".repeat(64),
		cwd: "/private/source",
	},
	baseline: { repositoryId: "repo-1", commit: "d".repeat(40) },
	inputTree: "e".repeat(40),
	outputTree: "f".repeat(40),
	patchSha256: "0".repeat(64),
	createdAt: 1,
	patchBase64: "raw-private-payload",
	localPath: "/private/artifact.patch",
};
const task = {
	id: "task-1",
	status: "completed",
	executionMode: "code",
	executionCompleted: true,
	artifactProduced: true,
	contract: {
		id: "contract-1",
		revision: 2,
		digest: "b".repeat(64),
		executionMode: "code",
		baseline: artifact.baseline,
		inputArtifacts: [artifact],
	},
	contextManifest: {
		version: 1,
		digest: "c".repeat(64),
		contractId: "contract-1",
		contractRevision: 2,
		contractDigest: "b".repeat(64),
		context: { private: "not-for-summary" },
	},
	artifact,
	leaseToken: "private-lease",
};
const context = { cwd: process.cwd(), sessionManager: { getSessionId: () => "session-1" } } as any;
afterEach(() => setDeviceCollabService(undefined));

describe("code artifact tool evidence", () => {
	it("shows bounded execution identities while excluding raw inputs and host paths", () => {
		const summary = projectExecutionEvidence(task);
		expect(summary).toMatchObject({
			executionMode: "code",
			executionCompleted: true,
			artifactProduced: true,
			contract: { id: "contract-1", revision: 2, digest: "b".repeat(64) },
			artifact: { id: "artifact-1", digest: artifact.digest, patchSha256: artifact.patchSha256 },
		});
		const json = JSON.stringify(summary);
		for (const secret of [
			"/private",
			"raw-private-payload",
			"not-for-summary",
			"private-lease",
			"inputArtifacts",
			"patchBase64",
		])
			expect(json).not.toContain(secret);
	});

	it.each(["send_task", "conversation_read"] as const)("keeps evidence in actual %s tool output", async (action) => {
		setDeviceCollabService({ execute: async () => ({ tasks: [task] }) });
		const tool = makeDeviceCollabTool();
		const input =
			action === "send_task"
				? { action, roomId: "room-1", sourceBotId: "source-1", targetBotId: "bot-1", prompt: "Work" }
				: { action, roomId: "room-1", sourceBotId: "source-1", conversationId: "conversation-1" };
		const result = await tool.execute("call-1", input, undefined, undefined, context);
		const details = result.details as any;
		expect(details.summary.tasks[0]).toMatchObject({
			id: "task-1",
			artifactProduced: true,
			contract: { revision: 2 },
			artifact: { digest: artifact.digest },
		});
		expect(JSON.stringify(result)).not.toContain("raw-private-payload");
		expect(JSON.stringify(result)).not.toContain("/private");
	});

	it("returns a complete bounded base64 page with the artifact's verification metadata", async () => {
		const bytes = Buffer.alloc(24 * 1024, 191);
		const data = bytes.toString("base64");
		setDeviceCollabService({
			execute: async () => ({
				conversationId: "conversation-1",
				taskId: "task-1",
				artifact,
				content: {
					encoding: "base64",
					data,
					offset: 0,
					limit: bytes.length,
					totalBytes: bytes.length + 1,
					nextOffset: bytes.length,
					truncated: true,
				},
			}),
		});
		const result = await makeDeviceCollabTool().execute(
			"call-1",
			{
				action: "task_evidence",
				evidenceKind: "artifact",
				roomId: "room-1",
				sourceBotId: "source-1",
				conversationId: "conversation-1",
				taskId: "task-1",
				limit: bytes.length,
				expectedDigest: artifact.digest,
			},
			undefined,
			undefined,
			context,
		);
		const summary = (result.details as any).summary;
		expect(summary).toMatchObject({
			conversationId: "conversation-1",
			taskId: "task-1",
			artifact: { digest: artifact.digest, patchSha256: artifact.patchSha256 },
			content: { encoding: "base64", data, nextOffset: bytes.length },
		});
		expect(Buffer.from(summary.content.data, "base64")).toEqual(bytes);
		expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThan(48 * 1024);
		expect(JSON.stringify(result)).not.toContain("/private");
	});

	it("forwards artifact digest and byte pagination through the service", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
		const api = createDeviceCollabService({
			root: process.cwd(),
			fetch: fetcher,
			getConfig: () => ({
				hubUrl: "http://127.0.0.1:8999",
				deviceId: "device-1",
				credential: "test-token",
				allowExecution: true,
			}),
		});
		await api.execute(
			"task_evidence",
			{
				roomId: "room-1",
				sourceBotId: "source-1",
				conversationId: "conversation-1",
				taskId: "task-1",
				evidenceKind: "artifact",
				offset: 7,
				limit: 1024,
				expectedDigest: artifact.digest,
			},
			undefined,
			{ cwd: process.cwd() },
		);
		const url = new URL(String(fetcher.mock.calls[0]![0]));
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			evidenceKind: "artifact",
			offset: "7",
			limit: "1024",
			expectedDigest: artifact.digest,
		});
	});

	it("rejects pages whose encoded data would exceed the tool budget", () => {
		expect(() =>
			validateDeviceCollabInput({ action: "task_evidence", evidenceKind: "artifact", limit: 65536 }),
		).toThrow("24576");
	});
});
