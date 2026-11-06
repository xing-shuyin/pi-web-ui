import { describe, expect, it, vi } from "vitest";
import type { DeviceWorkContractInput } from "../../server/protocol.js";
import { createDeviceCollabService } from "../../server/device-center/collab-service.js";
import { validateDeviceCollabInput, type DeviceCollabInput } from "../../server/device-center/collab-tool.js";

const contract: DeviceWorkContractInput = {
	id: "work-item-1",
	revision: 2,
	executionMode: "code",
	goal: "Fix the parser",
	constraints: ["Preserve the public API"],
	acceptanceCriteria: ["The parser regression passes"],
	baseline: { repositoryId: "repo-1", commit: "a".repeat(40) },
};

function service() {
	const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
	return {
		fetcher,
		service: createDeviceCollabService({
			root: process.cwd(),
			getConfig: () =>
				({
					hubUrl: "http://127.0.0.1:8999",
					deviceId: "device-1",
					credential: "test-token",
					allowExecution: true,
				}) as any,
			fetch: fetcher,
		}),
	};
}

describe("versioned contract collaboration API", () => {
	it.each(["send_task", "conversation_create", "conversation_send"] as const)(
		"forwards the exact contract and retry key through %s",
		async (action) => {
			const { service: api, fetcher } = service();
			const input: DeviceCollabInput = {
				action,
				roomId: "room-1",
				sourceBotId: "source-1",
				...(action === "conversation_send"
					? { conversationId: "conversation-1", message: "Fix the parser" }
					: { targetBotId: "target-1", prompt: "Fix the parser" }),
				executionMode: "code",
				contract,
				idempotencyKey: "same-request",
			};
			validateDeviceCollabInput(input);
			const { action: _, ...args } = input;
			await api.execute(action, args, undefined, { cwd: process.cwd() });
			expect(fetcher).toHaveBeenCalledOnce();
			const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
			expect(body).toMatchObject({ executionMode: "code", contract, idempotencyKey: "same-request" });
			expect(body).not.toHaveProperty("contextManifest");
		},
	);

	it("keeps ordinary tasks free of synthesized execution inputs", async () => {
		const { service: api, fetcher } = service();
		await api.execute(
			"send_task",
			{ roomId: "room-1", sourceBotId: "source-1", targetBotId: "target-1", prompt: "Discuss the bug" },
			undefined,
			{ cwd: process.cwd() },
		);
		const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
		expect(body).not.toHaveProperty("executionMode");
		expect(body).not.toHaveProperty("contract");
	});

	it.each([
		{ executionMode: "code", contract: { ...contract, executionMode: "chat" } },
		{ executionMode: "code", contract: { ...contract, baseline: undefined } },
		{ contract: { ...contract, revision: 0 } },
		{ contract: { ...contract, contextManifest: { digest: "forged" } } },
	])("rejects invalid or caller-sealed execution inputs before contacting the Hub", async (execution) => {
		const { service: api, fetcher } = service();
		await expect(
			api.execute(
				"send_task",
				{ roomId: "room-1", sourceBotId: "source-1", targetBotId: "target-1", prompt: "Fix", ...execution } as any,
				undefined,
				{ cwd: process.cwd() },
			),
		).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("does not accept code execution fields on a plain message", () => {
		expect(() =>
			validateDeviceCollabInput({
				action: "send_message",
				roomId: "room-1",
				sourceBotId: "source-1",
				message: "Discuss",
				executionMode: "code",
				contract,
			} as any),
		).toThrow("Unsupported");
	});
});
