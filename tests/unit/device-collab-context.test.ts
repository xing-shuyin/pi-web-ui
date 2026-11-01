import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceCollabService } from "../../server/device-center/collab-service.js";
import { createDeviceRuntime } from "../../server/device-center/runtime.js";
import { createLocalBotRegistry } from "../../server/device-center/bots.js";
import {
	makeDeviceCollabTool,
	setDeviceCollabService,
	type DeviceCollabExecutionContext,
	type DeviceCollabInput,
} from "../../server/device-center/collab-tool.js";

const config = { hubUrl: "http://127.0.0.1:8999", deviceId: "device", credential: "secret", allowExecution: true };
const context = { cwd: resolve("context-project"), sessionId: "session" };
const binding: DeviceCollabExecutionContext = {
	roomId: "room",
	botId: "bot",
	taskId: "task",
	conversationId: "own",
	sourceConversationId: "sender",
	requestId: "request",
	kind: "request",
};
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	setDeviceCollabService(undefined);
	vi.unstubAllGlobals();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture(bound: DeviceCollabExecutionContext | undefined = binding) {
	const request = vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(JSON.stringify({ ok: true }), { status: 200 }),
	);
	const release = vi.fn();
	const workspaceResolver = vi.fn(async () => ({ root: context.cwd, files: {} as any, release }));
	const service = createDeviceCollabService({
		getConfig: () => config,
		getExecutionContext: () => bound,
		workspaceResolver,
		fetch: request,
	});
	return { service, request, workspaceResolver, release };
}
const invoke = (input: DeviceCollabInput) =>
	makeDeviceCollabTool().execute("call", input, undefined, undefined, {
		cwd: context.cwd,
		sessionManager: { getSessionId: () => context.sessionId },
	} as any);
const delivery = {
	repository: "owner/repo",
	baseCommit: "a".repeat(40),
	commit: "b".repeat(40),
	summary: "Implemented",
	checks: [],
};

describe("runtime-bound collaboration context", () => {
	it("fills identity before workspace validation without mutating arguments", async () => {
		const f = fixture();
		const args = Object.freeze({ message: "hello" });
		await f.service.execute("send_message", args, undefined, context);
		expect(args).toEqual({ message: "hello" });
		expect(f.workspaceResolver).toHaveBeenCalledWith({
			roomId: "room",
			sourceBotId: "bot",
			context,
			signal: undefined,
		});
		expect(JSON.parse(f.request.mock.calls[0]![1]!.body as string)).toMatchObject({
			sourceBotId: "bot",
			text: "hello",
		});
		expect(f.release).toHaveBeenCalledOnce();
	});

	it.each([{ sourceBotId: "spoof" }, { roomId: "spoof" }, { parentTaskId: "spoof" }])(
		"rejects spoofing before acquiring workspace: %j",
		async (patch) => {
			const f = fixture();
			await expect(
				f.service.execute("send_message", { message: "hello", ...patch }, undefined, context),
			).rejects.toThrow();
			expect(f.workspaceResolver).not.toHaveBeenCalled();
			expect(f.request).not.toHaveBeenCalled();
		},
	);

	it("defaults only attention and delivery to the executor's own conversation", async () => {
		const f = fixture();
		setDeviceCollabService(f.service);
		await invoke({ action: "conversation_attention", question: "Choose", attentionKind: "decision" });
		await invoke({ action: "conversation_deliver", ...delivery });
		expect(f.request.mock.calls.map(([url]) => String(url))).toEqual([
			"http://127.0.0.1:8999/api/agent/rooms/room/conversations/own/attention",
			"http://127.0.0.1:8999/api/agent/rooms/room/conversations/own/deliveries",
		]);
		for (const action of ["conversation_read", "conversation_send", "conversation_review"] as const)
			await expect(
				f.service.execute(
					action,
					{ message: "hello", ...delivery, deliveryId: "delivery", verdict: "accepted" },
					undefined,
					context,
				),
			).rejects.toThrow();
		expect(f.request).toHaveBeenCalledTimes(2);
	});

	it("correlates replies to the bound incoming request rather than the own conversation", async () => {
		const f = fixture();
		setDeviceCollabService(f.service);
		await invoke({ action: "reply_to_request", message: "Answer", idempotencyKey: "retry" });
		const [url, init] = f.request.mock.calls[0]!;
		expect(String(url)).toBe("http://127.0.0.1:8999/api/agent/rooms/room/conversations/sender/messages");
		expect(JSON.parse(init!.body as string)).toEqual({
			text: "Answer",
			sourceBotId: "bot",
			parentTaskId: "task",
			kind: "reply",
			requestId: "request",
			idempotencyKey: "retry",
		});
	});

	it.each([
		{ conversationId: "own" },
		{ requestId: "other" },
		{ kind: "request" as const },
		{ roomId: "other" },
		{ sourceBotId: "other" },
		{ parentTaskId: "other" },
	])("rejects conflicting reply routes: %j", async (patch) => {
		const f = fixture();
		await expect(
			f.service.execute("reply_to_request", { message: "Answer", ...patch }, undefined, context),
		).rejects.toThrow();
		expect(f.workspaceResolver).not.toHaveBeenCalled();
		expect(f.request).not.toHaveBeenCalled();
	});

	it.each([
		undefined,
		{ ...binding, kind: "message" as const },
		{ ...binding, sourceConversationId: undefined },
		{ ...binding, requestId: undefined },
	])("requires an incoming request binding: %j", async (bound) => {
		const f = fixture();
		const service = createDeviceCollabService({
			getConfig: () => config,
			root: context.cwd,
			fetch: f.request,
			getExecutionContext: () => bound,
		});
		await expect(
			service.execute(
				"reply_to_request",
				{ message: "Answer", sourceBotId: "bot", roomId: "room", conversationId: "sender", requestId: "request" },
				undefined,
				context,
			),
		).rejects.toThrow();
		expect(f.request).not.toHaveBeenCalled();
	});

	it("preserves unbound explicit callers and legacy authority callbacks", async () => {
		const f = fixture();
		const service = createDeviceCollabService({
			getConfig: () => config,
			root: context.cwd,
			fetch: f.request,
			getSourceBot: () => "bot",
			getParentTask: () => "legacy",
		});
		await service.execute(
			"conversation_send",
			{ roomId: "room", sourceBotId: "bot", conversationId: "explicit", message: "hello" },
			undefined,
			context,
		);
		expect(JSON.parse(f.request.mock.calls[0]![1]!.body as string)).toMatchObject({
			sourceBotId: "bot",
			parentTaskId: "legacy",
		});
		const unbound = createDeviceCollabService({ getConfig: () => config, root: context.cwd, fetch: f.request });
		setDeviceCollabService(unbound);
		await expect(invoke({ action: "send_message", message: "hello" })).rejects.toThrow();
		await expect(invoke({ action: "send_message", sourceBotId: "bot", message: "hello" })).rejects.toThrow();
		await invoke({ action: "send_message", sourceBotId: "bot", roomId: "room", message: "hello" });
		await expect(invoke({ action: "current_task" })).rejects.toThrow();
		expect(f.request).toHaveBeenCalledTimes(2);
	});

	it("projects only bounded current identifiers and releases the workspace", async () => {
		const f = fixture({ ...binding, root: "/secret/path", credential: "secret" } as DeviceCollabExecutionContext);
		setDeviceCollabService(f.service);
		const result = await invoke({ action: "current_task" });
		expect((result.details as { summary: unknown }).summary).toEqual(binding);
		expect(f.request).not.toHaveBeenCalled();
		expect(f.release).toHaveBeenCalledOnce();
		const invalid = fixture({ ...binding, requestId: "x".repeat(257) });
		await expect(invalid.service.execute("current_task", {}, undefined, context)).rejects.toThrow();
		expect(invalid.release).toHaveBeenCalledOnce();
	});

	it("uses each current executor binding and removes authority when a task finishes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "collab-context-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const root = join(dir, "project");
		await mkdir(root);
		const bots = await createLocalBotRegistry(join(dir, "data"));
		const bot = await bots.upsert({
			name: "Bot",
			description: "",
			systemPrompt: "",
			cwd: root,
			tools: ["read"],
			skills: [],
			mcpServers: [],
			enabled: true,
		});
		const request = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true })),
		);
		vi.stubGlobal("fetch", request);
		let runtime!: ReturnType<typeof createDeviceRuntime>;
		const taskContext = { cwd: root, sessionId: "sdk-session" };
		runtime = createDeviceRuntime({
			config,
			localOrigin: "http://127.0.0.1:8989",
			dataDir: join(dir, "data"),
			bots,
			executorFactory(options) {
				return {
					async run(task) {
						options.onSession?.(task.id, "sdk-session");
						const current = await runtime.collabService.execute("current_task", {}, undefined, taskContext);
						expect(current).toEqual({
							roomId: "room",
							taskId: task.id,
							botId: bot.id,
							sourceConversationId: task.sourceConversationId,
							requestId: task.requestId,
							kind: task.kind,
						});
						await runtime.collabService.execute("reply_to_request", { message: "answer" }, undefined, taskContext);
						await runtime.collabService.execute(
							"send_task",
							{ targetBotId: "remote", prompt: "work" },
							undefined,
							taskContext,
						);
						await expect(
							runtime.collabService.execute("current_task", {}, undefined, { cwd: root, sessionId: "unbound" }),
						).rejects.toThrow();
						return "done";
					},
					close() {},
				};
			},
		});
		cleanups.push(() => runtime.close());
		for (const id of ["first", "second"]) {
			await runtime.onTask(
				{
					id,
					attemptId: `attempt-${id}`,
					botId: bot.id,
					botRevision: bot.revision,
					deviceId: "device",
					roomId: "room",
					text: "work",
					sourceConversationId: `sender-${id}`,
					requestId: `request-${id}`,
					kind: "request",
					leaseToken: "test-lease",
				} as any,
				new AbortController().signal,
			);
			await expect(runtime.collabService.execute("current_task", {}, undefined, taskContext)).rejects.toThrow();
		}
		expect(
			request.mock.calls
				.filter(([url]) => String(url).includes("/conversations/"))
				.map(([url, init]) => [String(url), JSON.parse(init!.body as string).requestId]),
		).toEqual([
			["http://127.0.0.1:8999/api/agent/rooms/room/conversations/sender-first/messages", "request-first"],
			["http://127.0.0.1:8999/api/agent/rooms/room/conversations/sender-second/messages", "request-second"],
		]);
	});
});
