import { describe, expect, it, vi } from "vitest";
import { createDeviceCollabService } from "../../server/device-center/collab-service.js";

function fixture(boundBot?: string) {
	const request = vi.fn(async () =>
		Response.json({
			bots: [
				{ id: "local", deviceId: "device" },
				{ id: "remote", deviceId: "other" },
			],
		}),
	);
	const release = vi.fn();
	const workspaceResolver = vi.fn(async () => ({ root: process.cwd(), files: {} as any, release }));
	const service = createDeviceCollabService({
		getConfig: () => ({
			hubUrl: "https://hub.example/base/",
			deviceId: "device",
			credential: "secret",
			allowExecution: true,
		}),
		workspaceResolver,
		getSourceBot: () => boundBot,
		getParentTask: () => "trusted-parent",
		fetch: request as any,
	});
	return { service, request, release, workspaceResolver, context: { cwd: process.cwd(), sessionId: "session" } };
}

describe("Bot collaboration identity", () => {
	it.each(["conversation_deliver", "conversation_review"] as const)(
		"posts %s with trusted identity, evidence and stable retry key",
		async (action) => {
			const f = fixture("local");
			const args = {
				roomId: "room/a",
				sourceBotId: "local",
				conversationId: "cid/a",
				parentTaskId: "trusted-parent",
				idempotencyKey: "retry",
				commit: "b".repeat(40),
				summary: "Evidence",
				...(action === "conversation_deliver"
					? {
							repository: "owner/repo",
							baseCommit: "a".repeat(40),
							checks: [{ command: "npm test", status: "not_run" as const }],
						}
					: { deliveryId: "delivery", verdict: "changes_requested" as const }),
			};
			await f.service.execute(action, args, undefined, f.context);
			const [url, init] = f.request.mock.calls[0] as unknown as [URL, RequestInit];
			expect(url.pathname).toBe(
				`/base/api/agent/rooms/room%2Fa/conversations/cid%2Fa/${action === "conversation_deliver" ? "deliveries" : "reviews"}`,
			);
			expect(init.method).toBe("POST");
			const body = JSON.parse(init.body as string);
			expect(body).toMatchObject({
				sourceBotId: "local",
				parentTaskId: "trusted-parent",
				idempotencyKey: "retry",
				commit: args.commit,
			});
			if (action === "conversation_deliver") {
				expect(body.checks).toEqual([{ command: "npm test", status: "not_run" }]);
				expect(body.limitations).toEqual([]);
			} else expect(body).toMatchObject({ deliveryId: "delivery", verdict: "changes_requested" });
			expect(f.release).toHaveBeenCalledOnce();
			f.request.mockClear();
			await expect(
				f.service.execute(action, { ...args, parentTaskId: "spoof" }, undefined, f.context),
			).rejects.toThrow();
			expect(f.request).not.toHaveBeenCalled();
		},
	);
	it("requires a trusted task for delivery and review", async () => {
		const request = vi.fn();
		const service = createDeviceCollabService({
			root: process.cwd(),
			getConfig: () => ({
				hubUrl: "https://hub.example",
				deviceId: "device",
				credential: "secret",
				allowExecution: true,
			}),
			fetch: request,
		});
		for (const action of ["conversation_deliver", "conversation_review"] as const)
			await expect(
				service.execute(
					action,
					{
						roomId: "r",
						sourceBotId: "local",
						conversationId: "cid",
						commit: "a".repeat(40),
						summary: "test",
						deliveryId: "d",
						verdict: "accepted",
						repository: "repo",
						baseCommit: "b".repeat(40),
						checks: [],
					},
					undefined,
					{ cwd: process.cwd() },
				),
			).rejects.toThrow();
		expect(request).not.toHaveBeenCalled();
	});
	it("reads history via GET with an encoded cursor and the verified source Bot", async () => {
		const f = fixture("local");
		const controller = new AbortController();
		const before = "opaque +/=&?游标";
		await f.service.execute(
			"read_history",
			{ roomId: "room/a?b", sourceBotId: "local", before },
			controller.signal,
			f.context,
		);
		expect(f.workspaceResolver).toHaveBeenCalledWith({
			roomId: "room/a?b",
			sourceBotId: "local",
			context: f.context,
			signal: controller.signal,
		});
		const [url, init] = f.request.mock.calls[0] as unknown as [URL, RequestInit];
		expect(url.pathname).toBe("/base/api/agent/rooms/room%2Fa%3Fb/history");
		expect([...url.searchParams]).toEqual([
			["sourceBotId", "local"],
			["before", before],
		]);
		expect(init).toMatchObject({
			method: "GET",
			signal: controller.signal,
			headers: { authorization: "Bearer secret", "X-Device-Id": "device" },
		});
		expect(init.body).toBeUndefined();
		expect(f.request).toHaveBeenCalledOnce();
		expect(f.release).toHaveBeenCalledOnce();
	});
	it("omits the cursor on the first history page", async () => {
		const f = fixture("local");
		await f.service.execute("read_history", { roomId: "room", sourceBotId: "local" }, undefined, f.context);
		const [url] = f.request.mock.calls[0] as unknown as [URL];
		expect([...url.searchParams]).toEqual([["sourceBotId", "local"]]);
	});
	it.each([
		{ roomId: "room", sourceBotId: "other-local" },
		{ roomId: "room" },
		{ sourceBotId: "local" },
		{ roomId: "room", sourceBotId: "local", before: "x".repeat(257) },
	])("rejects invalid history identity or arguments %#", async (args) => {
		const f = fixture("local");
		await expect(f.service.execute("read_history", args, undefined, f.context)).rejects.toThrow("request failed");
		expect(f.request).not.toHaveBeenCalled();
	});
	it("rejects history from another Bot workspace and releases the lease", async () => {
		const f = fixture("local");
		f.workspaceResolver.mockResolvedValueOnce({
			root: `${process.cwd()}/another-project`,
			files: {} as any,
			release: f.release,
		});
		await expect(
			f.service.execute("read_history", { roomId: "room", sourceBotId: "local" }, undefined, f.context),
		).rejects.toThrow("request failed");
		expect(f.request).not.toHaveBeenCalled();
		expect(f.release).toHaveBeenCalledOnce();
	});
	it("rejects history when room membership resolution fails", async () => {
		const f = fixture("local");
		f.workspaceResolver.mockRejectedValueOnce(new Error("private membership details"));
		await expect(
			f.service.execute("read_history", { roomId: "room", sourceBotId: "local" }, undefined, f.context),
		).rejects.toThrow(/^Device collaboration request failed\.$/);
		expect(f.request).not.toHaveBeenCalled();
	});
	it("cancels history after workspace resolution before fetching", async () => {
		const f = fixture("local");
		const controller = new AbortController();
		f.workspaceResolver.mockImplementationOnce(async () => {
			controller.abort();
			return { root: process.cwd(), files: {} as any, release: f.release };
		});
		await expect(
			f.service.execute("read_history", { roomId: "room", sourceBotId: "local" }, controller.signal, f.context),
		).rejects.toThrow("cancelled");
		expect(f.request).not.toHaveBeenCalled();
		expect(f.release).toHaveBeenCalledOnce();
	});
	it("discards history when cancelled while decoding the response", async () => {
		const release = vi.fn();
		const controller = new AbortController();
		const service = createDeviceCollabService({
			getConfig: () => ({
				hubUrl: "https://hub.example",
				deviceId: "device",
				credential: "secret",
				allowExecution: true,
			}),
			workspaceResolver: async () => ({ root: process.cwd(), files: {} as any, release }),
			fetch: vi.fn(async () => ({
				ok: true,
				json: async () => {
					controller.abort();
					return { messages: [{ text: "private history" }] };
				},
			})) as any,
		});
		await expect(
			service.execute("read_history", { roomId: "room", sourceBotId: "local" }, controller.signal, {
				cwd: process.cwd(),
			}),
		).rejects.toThrow("cancelled");
		expect(release).toHaveBeenCalledOnce();
	});
	it("marks local Bot candidates without disclosing credentials", async () => {
		const f = fixture();
		const result = await f.service.execute("list_bots", {}, undefined, f.context);
		expect(result).toEqual({
			bots: [
				{ id: "local", deviceId: "device", local: true },
				{ id: "remote", deviceId: "other", local: false },
			],
		});
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(f.workspaceResolver).not.toHaveBeenCalled();
	});
	it("rejects an execution session impersonating a second Bot in the same directory", async () => {
		const f = fixture("local");
		await expect(
			f.service.execute(
				"send_task",
				{ roomId: "room", sourceBotId: "other-local", targetBotId: "remote", prompt: "run" },
				undefined,
				f.context,
			),
		).rejects.toThrow("request failed");
		expect(f.request).not.toHaveBeenCalled();
		expect(f.workspaceResolver).not.toHaveBeenCalled();
		expect(f.release).not.toHaveBeenCalled();
	});
	it("binds task sender and target to Bots and uses the trusted parent", async () => {
		const f = fixture("local");
		await f.service.execute(
			"send_task",
			{ roomId: "room", sourceBotId: "local", targetBotId: "remote", prompt: "run", parentTaskId: "trusted-parent" },
			undefined,
			f.context,
		);
		const [url, init] = f.request.mock.calls[0] as unknown as [URL, RequestInit];
		expect(url.pathname).toBe("/base/api/agent/rooms/room/messages");
		expect(JSON.parse(init.body as string)).toMatchObject({
			sourceBotId: "local",
			targetBotIds: ["remote"],
			parentTaskId: "trusted-parent",
		});
		expect(f.release).toHaveBeenCalledOnce();
	});
	it.each(["conversation_list", "conversation_read"] as const)(
		"binds %s reads to project, room and source Bot",
		async (action) => {
			const f = fixture("local");
			const args = {
				roomId: "room/a",
				sourceBotId: "local",
				...(action === "conversation_read" ? { conversationId: "c/a" } : {}),
			};
			await f.service.execute(action, args, undefined, f.context);
			const [url, init] = f.request.mock.calls[0] as unknown as [URL, RequestInit];
			expect(url.pathname).toBe(
				"/base/api/agent/rooms/room%2Fa/conversations" + (action === "conversation_read" ? "/c%2Fa" : ""),
			);
			expect(url.searchParams.get("sourceBotId")).toBe("local");
			expect(init.method).toBe("GET");
			expect(f.workspaceResolver).toHaveBeenCalledWith({
				roomId: "room/a",
				sourceBotId: "local",
				context: f.context,
				signal: undefined,
			});
			expect(f.release).toHaveBeenCalledOnce();
			for (const bad of [
				{ ...args, sourceBotId: "other" },
				{ ...args, sourceBotId: undefined },
				{ ...args, roomId: undefined },
			]) {
				f.request.mockClear();
				await expect(f.service.execute(action, bad, undefined, f.context)).rejects.toThrow("request failed");
				expect(f.request).not.toHaveBeenCalled();
			}
			f.workspaceResolver.mockResolvedValueOnce({
				root: process.cwd() + "/other",
				files: {} as any,
				release: f.release,
			});
			await expect(f.service.execute(action, args, undefined, f.context)).rejects.toThrow("request failed");
			f.workspaceResolver.mockRejectedValueOnce(new Error("SECRET"));
			await expect(f.service.execute(action, args, undefined, f.context)).rejects.toThrow(
				/^Device collaboration request failed\.$/,
			);
			expect(f.request).not.toHaveBeenCalled();
		},
	);
	it.each(["conversation_create", "conversation_send"] as const)(
		"routes %s with trusted parent and stable retry key",
		async (action) => {
			const f = fixture("local");
			await f.service.execute(
				action,
				{
					roomId: "room",
					sourceBotId: "local",
					targetBotId: "remote",
					prompt: "start",
					conversationId: "cid",
					message: "continue",
					idempotencyKey: "retry",
				},
				undefined,
				f.context,
			);
			const [url, init] = f.request.mock.calls[0] as unknown as [URL, RequestInit];
			expect(url.pathname).toBe(
				"/base/api/agent/rooms/room/conversations" + (action === "conversation_send" ? "/cid/messages" : ""),
			);
			expect(init.method).toBe("POST");
			expect(JSON.parse(init.body as string)).toEqual(
				action === "conversation_create"
					? {
							targetBotId: "remote",
							text: "start",
							sourceBotId: "local",
							parentTaskId: "trusted-parent",
							idempotencyKey: "retry",
						}
					: {
							text: "continue",
							sourceBotId: "local",
							parentTaskId: "trusted-parent",
							idempotencyKey: "retry",
							kind: "message",
						},
			);
		},
	);
	it("creates a correlated request with the trusted task parent", async () => {
		const f = fixture("local");
		await f.service.execute(
			"conversation_create",
			{
				roomId: "room",
				sourceBotId: "local",
				targetBotId: "remote",
				prompt: "Review this task",
				kind: "request",
				requestId: "review-request",
				idempotencyKey: "request-retry",
			},
			undefined,
			f.context,
		);
		const [, init] = f.request.mock.calls[0] as unknown as [URL, RequestInit];
		expect(JSON.parse(init.body as string)).toMatchObject({
			kind: "request",
			requestId: "review-request",
			parentTaskId: "trusted-parent",
			idempotencyKey: "request-retry",
		});
	});
	it.each(["send_task", "conversation_create", "conversation_send"] as const)(
		"rejects caller parent spoof for %s",
		async (action) => {
			const f = fixture("local");
			await expect(
				f.service.execute(
					action,
					{
						roomId: "room",
						sourceBotId: "local",
						targetBotId: "remote",
						prompt: "start",
						conversationId: "cid",
						message: "continue",
						parentTaskId: "forged",
					},
					undefined,
					f.context,
				),
			).rejects.toThrow("request failed");
			expect(f.request).not.toHaveBeenCalled();
			expect(f.workspaceResolver).not.toHaveBeenCalled();
			expect(f.release).not.toHaveBeenCalled();
		},
	);
	it("passes recursive intent and bounded omissions through file staging", async () => {
		const f = fixture("local");
		const exclusions = [{ path: "src/.env", reason: "sensitive" }];
		const prepare = vi.fn(async () => ({ manifest: { exclusions, totalExcluded: 1 }, files: [] }));
		f.workspaceResolver.mockResolvedValueOnce({ root: process.cwd(), files: { prepare } as any, release: f.release });
		const result = await f.service.execute(
			"sync_files",
			{ roomId: "room", sourceBotId: "local", targetBotId: "remote", paths: ["src"], recursive: true },
			undefined,
			f.context,
		);
		expect(prepare).toHaveBeenCalledWith({ paths: ["src"], recursive: true, signal: undefined });
		expect(result).toMatchObject({ exclusions, totalExcluded: 1 });
	});
	it("routes stop with only the bound source Bot and read cursor as a query", async () => {
		const f = fixture("local");
		await f.service.execute(
			"conversation_stop",
			{ roomId: "room/a", sourceBotId: "local", conversationId: "c/a" },
			undefined,
			f.context,
		);
		const [url, init] = f.request.mock.calls[0] as unknown as [URL, RequestInit];
		expect(url.pathname).toBe("/base/api/agent/rooms/room%2Fa/conversations/c%2Fa/stop");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({ sourceBotId: "local" });
		f.request.mockClear();
		await f.service.execute(
			"conversation_read",
			{ roomId: "r", sourceBotId: "local", conversationId: "cid", before: "cursor/a" },
			undefined,
			f.context,
		);
		const [readUrl] = f.request.mock.calls[0] as unknown as [URL, RequestInit];
		expect(readUrl.searchParams.get("before")).toBe("cursor/a");
		expect(readUrl.searchParams.get("sourceBotId")).toBe("local");
		f.request.mockClear();
		for (const args of [
			{ roomId: "r", sourceBotId: "other", conversationId: "cid" },
			{ roomId: "r", sourceBotId: "local", conversationId: "cid", parentTaskId: "spoof" },
			{ roomId: "r", conversationId: "cid" },
		]) {
			await expect(f.service.execute("conversation_stop", args, undefined, f.context)).rejects.toThrow(
				"request failed",
			);
		}
		for (const before of ["", "a".repeat(257)])
			await expect(
				f.service.execute(
					"conversation_read",
					{ roomId: "r", sourceBotId: "local", conversationId: "cid", before },
					undefined,
					f.context,
				),
			).rejects.toThrow("request failed");
		expect(f.request).not.toHaveBeenCalled();
	});
	it("validates a source Bot project before creating a room", async () => {
		const f = fixture();
		await f.service.execute(
			"create_room",
			{ name: "Team", sourceBotId: "local", targetBotId: "remote" },
			undefined,
			f.context,
		);
		expect(f.workspaceResolver).toHaveBeenCalledWith({
			roomId: "",
			sourceBotId: "local",
			context: f.context,
			signal: undefined,
		});
		const [, init] = f.request.mock.calls[0] as unknown as [URL, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({
			name: "Team",
			sourceBotId: "local",
			botIds: ["local", "remote"],
		});
		expect(f.release).toHaveBeenCalledOnce();
	});
});
