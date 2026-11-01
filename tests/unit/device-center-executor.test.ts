import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { createDeviceTaskExecutor } from "../../server/device-center/executor.js";
import type { LocalBot } from "../../server/device-center/bots.js";
import { getBotExecution } from "../../server/device-center/bot-execution.js";
import { getBotExecutionInstructions } from "../../server/device-center/execution-instructions.js";
import type { ClientMessage, UiState } from "../../server/protocol.js";
import { deviceTaskFailure } from "../../server/device-center/task-error.js";
import { DeviceExecutionError } from "../../server/device-center/execution-failure.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
const cwd = resolve(".");
const bot: LocalBot = {
	id: "executor-bot",
	revision: 1,
	name: "Test Bot",
	description: "",
	systemPrompt: "Local instructions",
	cwd,
	tools: ["read"],
	skills: [],
	mcpServers: [],
	enabled: true,
};
let taskSequence = 0;
const task = () => ({
	id: `executor-test-${++taskSequence}`,
	botId: bot.id,
	botRevision: bot.revision,
	deviceId: "device",
	attemptId: "attempt-1",
	text: "Run the verification",
});
const assistant = (text: string) => ({ id: "a-1", role: "assistant", content: [{ type: "text", text }] });

async function fixture(
	onPrompt?: (socket: WebSocket, state: UiState) => void,
	opts: {
		bot?: LocalBot;
		onPlanReady?: import("../../server/device-center/executor.js").DeviceTaskCallbacks["onPlanReady"];
		onFullReport?: import("../../server/device-center/executor.js").DeviceTaskCallbacks["onFullReport"];
		changeCwd?: boolean;
		gap?: boolean;
		refuseNew?: boolean;
		onNew?: (socket: WebSocket, state: UiState) => void;
		onSwitch?: (socket: WebSocket, state: UiState) => void;
		onHello?: (socket: WebSocket, state: UiState) => void;
		onSession?: (taskId: string, sessionId: string | undefined) => void;
		resumePath?: string;
		onSessionPath?: (taskId: string, path: string) => void;
		onActivity?: () => void;
		onProgress?: (activity: { phase: "model" | "tool" | "waiting"; text?: string; toolName?: string }) => void;
	} = {},
) {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(server, "listening");
	const address = server.address();
	if (typeof address === "string" || !address) throw new Error("No address");
	const origin = `http://127.0.0.1:${address.port}`;
	const received: ClientMessage[] = [];
	let authorization: string | undefined;
	let initialId = "old-chat";
	let snapshot: UiState;
	const push = (socket: WebSocket, patch: Partial<UiState> = {}) => {
		snapshot = { ...snapshot, ...patch, rev: snapshot.rev + 1 };
		socket.send(JSON.stringify({ type: "snapshot", state: snapshot }));
	};
	server.on("connection", (socket, request) => {
		authorization = request.headers.authorization;
		expect(request.url).toBe("/ws");
		socket.on("message", (raw) => {
			const msg = JSON.parse(raw.toString()) as ClientMessage;
			received.push(msg);
			if (msg.type === "hello") {
				expect(msg.clientId).toMatch(/^device-task-/);
				snapshot = {
					clientId: msg.clientId,
					sessionId: "old-sdk-session",
					cwd: opts.changeCwd ? resolve("other") : cwd,
					conversationId: initialId,
					rev: 1,
					messages: [assistant("OLD HISTORY")],
					isStreaming: false,
					streamingMessage: null,
				} as UiState;
				socket.send(JSON.stringify({ type: "ready", clientId: msg.clientId }));
				// ready precedes attach completion: no new_chat until this snapshot.
				setImmediate(() => {
					if (opts.onHello) opts.onHello(socket, snapshot);
					else push(socket);
				});
			} else if (msg.type === "set_cwd") {
				push(socket, { cwd, messages: [assistant("RESUMED HISTORY")] });
				socket.send(JSON.stringify({ type: "transition_progress", kind: "cwd", phase: "done" }));
			} else if (msg.type === "new_chat") {
				if (opts.onNew) {
					opts.onNew(socket, snapshot);
					return;
				}
				if (opts.refuseNew) {
					socket.send(
						JSON.stringify({
							type: "transition_progress",
							kind: "new_chat",
							phase: "error",
							text: "Conversation limit",
						}),
					);
					return;
				}
				initialId = "task-chat";
				push(socket, { conversationId: initialId, sessionId: "task-sdk-session", messages: [], isEphemeral: false });
			} else if (msg.type === "switch_session") {
				if (opts.onSwitch) return opts.onSwitch(socket, snapshot);
				initialId = "restored-chat";
				push(socket, {
					conversationId: initialId,
					sessionId: "restored-sdk-session",
					sessionFile: msg.path,
					messages: [assistant("OLD HISTORY")],
					historyTotal: 1,
					isEphemeral: false,
				});
			} else if (msg.type === "get_state") push(socket);
			else if (msg.type === "prompt") {
				if (opts.gap)
					socket.send(
						JSON.stringify({
							type: "snapshot_delta",
							conversationId: initialId,
							baseRev: -99,
							rev: 99,
							state: snapshot,
							appended: [assistant("FAKE GAP TEXT")],
						}),
					);
				onPrompt?.(socket, snapshot);
			}
		});
	});
	const executor = createDeviceTaskExecutor({
		localOrigin: origin,
		bot: opts.bot ?? bot,
		onPlanReady: opts.onPlanReady,
		onFullReport: opts.onFullReport,
		cwd,
		localAuthToken: "test-token",
		allowExecution: true,
		onSession: opts.onSession,
		resumePath: opts.resumePath,
		onSessionPath: opts.onSessionPath,
		onActivity: opts.onActivity,
		onProgress: opts.onProgress,
	});
	cleanup.push(async () => {
		void executor.close().catch(() => {});
		for (const socket of server.clients) socket.terminate();
		await new Promise<void>((done) => server.close(() => done()));
	});
	return { executor, received, origin, push, authorization: () => authorization };
}

function delta(socket: WebSocket, state: UiState, patch: Partial<UiState>, appended: unknown[] = []) {
	socket.send(
		JSON.stringify({
			type: "snapshot_delta",
			conversationId: state.conversationId,
			baseRev: state.rev,
			rev: state.rev + 1,
			state: { ...state, ...patch, rev: state.rev + 1, messages: undefined },
			appended,
		}),
	);
}

// These tests use real loopback sockets and the production protocol envelope,
// without invoking models or weakening the existing approval mechanism.
describe("device task executor", () => {
	it("waits for durable full report persistence before settling its bounded result", async () => {
		let persisted!: () => void;
		const text = "完整报告中文🙂".repeat(9000);
		const onFullReport = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					persisted = resolve;
				}),
		);
		const f = await fixture((socket, state) => delta(socket, state, { isStreaming: false }, [assistant(text)]), {
			onFullReport,
		});
		let finished = false;
		const current = task();
		const execution = f.executor.run(current).finally(() => {
			finished = true;
		});
		await vi.waitFor(() => expect(onFullReport).toHaveBeenCalledExactlyOnceWith(current.id, current.attemptId, text));
		expect(finished).toBe(false);
		persisted();
		const excerpt = await execution;
		expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(16384);
		expect(excerpt).toContain("Report excerpt");
	});
	it("propagates durable full report write failure instead of reporting completed", async () => {
		const f = await fixture((socket, state) => delta(socket, state, { isStreaming: false }, [assistant("original")]), {
			onFullReport: async () => {
				throw new Error("Report disk write failed");
			},
		});
		await expect(f.executor.run(task())).rejects.toThrow("Report disk write failed");
	});
	it("waits for the plan persistence ACK before completing the execution", async () => {
		let acknowledge!: (accepted: boolean) => void;
		const onPlanReady = vi.fn(
			(_taskId: string, _plan: import("../../server/protocol.js").DeviceTaskPlanReadyFrame["plan"]) =>
				new Promise<boolean>((resolve) => {
					acknowledge = resolve;
				}),
		);
		const steps = [{ id: "inspect", title: "Inspect and write after approval", status: "pending" as const }];
		const f = await fixture(
			(socket, state) => {
				const plan = { steps, updatedAt: Date.now() };
				delta(socket, state, { isStreaming: false, plan }, [
					{
						id: "plan-result",
						role: "toolResult",
						toolName: "plan_update",
						toolCallId: "plan-call",
						isError: false,
						details: { plan },
						content: [],
					},
					assistant("Plan ready"),
				]);
			},
			{ bot: { ...bot, tools: ["read", "plan_update"] }, onPlanReady },
		);
		let finished = false;
		const execution = f.executor.run({ ...task(), planOnly: true }).finally(() => {
			finished = true;
		});
		await vi.waitFor(() => expect(onPlanReady).toHaveBeenCalledOnce());
		expect(onPlanReady.mock.calls[0]?.[1]).toEqual({ state: "ready", steps, summary: "Plan ready" });
		expect(finished).toBe(false);
		acknowledge(true);
		await expect(execution).resolves.toBe("Plan ready");
	});
	it("fails a planning execution when Hub rejects its plan", async () => {
		const f = await fixture(
			(socket, state) => {
				const plan = { steps: [], updatedAt: Date.now() };
				delta(socket, state, { isStreaming: false, plan }, [
					{
						id: "plan-result",
						role: "toolResult",
						toolName: "plan_update",
						toolCallId: "plan-call",
						isError: false,
						details: { plan },
						content: [],
					},
					assistant("No real plan"),
				]);
			},
			{ bot: { ...bot, tools: ["read", "plan_update"] }, onPlanReady: async () => false },
		);
		await expect(f.executor.run({ ...task(), planOnly: true })).rejects.toThrow("Plan was not persisted by Hub");
	});
	it("rejects a resumed planning turn that reuses old steps without a new successful plan_update", async () => {
		const onPlanReady = vi.fn(async () => true);
		const oldPlan = { steps: [{ id: "old", title: "Old plan", status: "pending" as const }], updatedAt: 1 };
		const f = await fixture(
			(socket, state) => {
				delta(socket, state, { isStreaming: false }, [assistant("Reuse the previous plan")]);
			},
			{
				bot: { ...bot, tools: ["read", "plan_update"] },
				resumePath: resolve("old-plan-session.jsonl"),
				onPlanReady,
				onSwitch(socket) {
					f.push(socket, {
						conversationId: "restored-chat",
						sessionId: "restored-sdk-session",
						sessionFile: resolve("old-plan-session.jsonl"),
						messages: [
							{
								id: "old-plan-result",
								role: "toolResult",
								toolName: "plan_update",
								isError: false,
								details: { plan: oldPlan },
								content: [],
							},
						],
						plan: oldPlan,
						historyTotal: 1,
						isEphemeral: false,
					});
				},
			},
		);
		await expect(f.executor.run({ ...task(), resume: true, planOnly: true })).rejects.toThrow(
			"successful plan_update in this turn",
		);
		expect(onPlanReady).not.toHaveBeenCalled();
	});

	it("rejects a planning task when its Bot never authorized plan_update", async () => {
		const f = await fixture();
		await expect(f.executor.run({ ...task(), planOnly: true })).rejects.toThrow("plan_update authorization");
		expect(f.received).toEqual([]);
	});
	it("reports transcript restoration failures as switch_session without sending a prompt", async () => {
		const f = await fixture(
			() => {
				throw new Error("A failed restoration must not prompt the model");
			},
			{
				resumePath: resolve("bot-sessions/previous-task/history.jsonl"),
				onSwitch(socket) {
					socket.send(
						JSON.stringify({
							type: "notice",
							level: "error",
							text: "Only transcripts inside the session directory can be opened",
						}),
					);
				},
			},
		);
		await expect(f.executor.run({ ...task(), resume: true })).rejects.toMatchObject({
			failure: { phase: "switch_session" },
		});
		expect(f.received.some((message) => message.type === "prompt")).toBe(false);
		expect(f.received.some((message) => message.type === "new_chat")).toBe(false);
	});
	it("restores only the authorized transcript and reports only the new turn", async () => {
		const resumePath = resolve("persistent-session.jsonl");
		const onSession = vi.fn();
		const onSessionPath = vi.fn();
		const f = await fixture(
			(socket, state) => {
				// An idle restored snapshot after prompt must not complete from old history.
				f.push(socket);
				setImmediate(() =>
					f.push(socket, {
						messages: [...state.messages, { ...assistant("CONTINUED"), id: "new-answer" } as any],
					}),
				);
			},
			{ resumePath, onSession, onSessionPath },
		);
		const input = { ...task(), resume: true };
		expect(await f.executor.run(input)).toBe("CONTINUED");
		expect(f.received.some((m) => m.type === "new_chat")).toBe(false);
		expect(f.received).toContainEqual({ type: "switch_session", path: resumePath, independent: false });
		expect(onSession).toHaveBeenCalledWith(input.id, "restored-sdk-session");
		expect(onSessionPath).toHaveBeenCalledWith(input.id, resumePath);
	});

	it("fails a blocked transcript restore instead of waiting indefinitely after a warning", async () => {
		const f = await fixture(undefined, {
			resumePath: resolve("blocked-session.jsonl"),
			onSwitch(socket) {
				socket.send(JSON.stringify({ type: "notice", level: "warning", text: "Transcript still owned" }));
			},
		});
		await expect(f.executor.run({ ...task(), resume: true })).rejects.toThrow("Transcript still owned");
		expect(f.received.some((message) => message.type === "prompt")).toBe(false);
	});

	it.each([
		["executor-bot", "team", true, true],
		["other-bot", "team", false, true],
		["executor-bot", "team", false, false],
	] as const)(
		"scopes primary coordination to configured Bot %s in room %s",
		async (primaryBotId, contextRoomId, enabled, memberPresent) => {
			const f = await fixture((socket, state) => {
				const capability = getBotExecution(state.clientId);
				expect(capability?.groupContext?.roomId).toBe("team");
				expect(Object.isFrozen(capability?.groupContext)).toBe(true);
				const instructions = capability?.instructions ?? "";
				expect(instructions).toBe(getBotExecutionInstructions(enabled));
				expect(instructions.includes("configured primary Bot")).toBe(enabled);
				delta(socket, state, { isStreaming: true });
				delta(socket, { ...state, rev: state.rev + 1 }, { isStreaming: false }, [assistant("Ready")]);
			});
			await f.executor.run({
				...task(),
				roomId: "team",
				context: {
					roomId: contextRoomId,
					roomName: "Team",
					primaryBotId,
					members: memberPresent ? [{ id: bot.id, name: "Primary" }] : [],
					throughMessageId: null,
					messages: [],
					nextBefore: null,
					truncated: false,
					retentionLimit: 500,
				},
			});
			const prompt = f.received.find((message) => message.type === "prompt")?.text ?? "";
			expect(prompt).not.toContain("configured primary Bot");
		},
	);
	it("rejects group context from another room before connecting", async () => {
		const f = await fixture();
		await expect(
			f.executor.run({
				...task(),
				roomId: "team",
				context: {
					roomId: "other-room",
					roomName: "Other",
					members: [],
					messages: [],
					throughMessageId: null,
					nextBefore: null,
					truncated: false,
					retentionLimit: 500,
				},
			}),
		).rejects.toThrow("Group context room must match");
		expect(f.received).toEqual([]);
	});
	it("refuses resume without an authorized transcript", async () => {
		const f = await fixture();
		await expect(f.executor.run({ ...task(), resume: true })).rejects.toThrow("authorized local transcript");
		expect(f.received).toEqual([]);
	});
	it("handshakes in the fixed Bot cwd, creates a persistent task chat and extracts actual assistant text from deltas", async () => {
		const f = await fixture((socket, state) => {
			delta(socket, state, { isStreaming: true });
			delta(socket, { ...state, rev: state.rev + 1 }, { isStreaming: false }, [
				{ id: "tool", role: "toolResult", content: [{ type: "text", text: "SECRET TOOL OUTPUT" }] },
				{
					...assistant("Verified command: exit 0; repair commit abc123"),
					content: [
						{ type: "thinking", text: "HIDDEN THINKING" },
						{ type: "text", text: "Verified command: exit 0; repair commit abc123" },
					],
				},
			]);
		});
		const t = {
			...task(),
			roomId: "team",
			conversationId: "receiver-address",
			sourceConversationId: "origin-address",
			kind: "request" as const,
			requestId: "request-correlation",
			handoff: { repository: "repo", commit: "deadbeef", branch: "fix", instructions: "Verify first" },
			context: {
				roomId: "team",
				roomName: "Team",
				members: [],
				throughMessageId: "previous",
				nextBefore: "cursor",
				truncated: true,
				retentionLimit: 500,
				messages: [
					{
						id: "previous",
						text: "Earlier shared plan",
						sender: { type: "human" as const, id: "person", name: "Alice" },
						createdAt: 1,
						textStart: 0,
						textEnd: 19,
						fullTextLength: 19,
					},
				],
			},
		};
		const result = await f.executor.run(t);
		expect(result).toContain("Verified command: exit 0; repair commit abc123");
		expect(result).not.toContain("Local system:");
		expect(result).not.toContain("Conversation: task-chat");
		expect(result).not.toMatch(/OLD HISTORY|RESUMED HISTORY|SECRET TOOL OUTPUT|HIDDEN THINKING/);
		expect(f.authorization()).toBe("Bearer test-token");
		expect(f.received.map((m) => m.type)).toEqual(["hello", "new_chat", "prompt"]);
		expect(f.received.find((m) => m.type === "new_chat")).toEqual({
			type: "new_chat",
			ephemeral: false,
			independent: false,
		});
		const prompt = f.received.find((m) => m.type === "prompt");
		expect(prompt?.text).toContain("deadbeef");
		expect(prompt?.text).toContain('"conversationId":"receiver-address"');
		expect(prompt?.text).toContain('"sourceConversationId":"origin-address"');
		expect(prompt?.text).toContain('"requestId":"request-correlation"');
		expect(prompt?.text).not.toContain("reply_to_request");
		expect(prompt?.text).not.toContain("Earlier shared plan");
		expect(prompt?.text).not.toContain('"context":');
		expect(prompt?.text).toContain("Local system (measured by this bridge)");
		expect(prompt?.text).not.toMatch(
			/untrusted reference data|device_collab|dirty state|configured fixed workspace|final answer is delivered automatically/,
		);
	});

	it("rejects a previous client's initial snapshot without prompting or aborting its conversation", async () => {
		const f = await fixture(undefined, {
			onHello: (socket, state) =>
				socket.send(
					JSON.stringify({
						type: "snapshot",
						state: { ...state, clientId: "device-task-previous-client", conversationId: "previous-task-chat" },
					}),
				),
		});
		const error = await f.executor.run(task()).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(DeviceExecutionError);
		expect((error as DeviceExecutionError).failure).toMatchObject({ phase: "init", category: "ownership" });
		expect(f.received.map((message) => message.type)).toEqual(["hello"]);
		expect(deviceTaskFailure(error)).not.toContain("previous-client");
	});

	it("rejects initial workspace drift without switching cwd or prompting", async () => {
		const f = await fixture(undefined, { changeCwd: true });
		await expect(f.executor.run(task())).rejects.toThrow("fixed cwd");
		expect(f.received.map((m) => m.type)).toEqual(["hello"]);
	});

	it("rejects Bot identity, revision, device and local configuration drift before opening a connection", async () => {
		const f = await fixture();
		for (const patch of [{ botId: "other" }, { botRevision: 0 }, { deviceId: "" }]) {
			await expect(f.executor.run({ ...task(), ...patch })).rejects.toThrow("must match");
		}
		expect(f.received).toEqual([]);
	});

	it("is disabled by default and rejects non-loopback, credentials and non-origin URLs", async () => {
		for (const localOrigin of [
			"https://localhost",
			"http://example.com",
			"http://127.0.0.1.evil.test",
			"http://user:secret@localhost",
			"http://localhost/?token=secret",
			"http://localhost/proxy",
			"http://localhost/#x",
		]) {
			expect(() => createDeviceTaskExecutor({ localOrigin, cwd, bot })).toThrow(/localOrigin/);
		}
		const executor = createDeviceTaskExecutor({ localOrigin: "http://localhost:8999", cwd, bot });
		await expect(executor.run(task())).rejects.toThrow("disabled");
		executor.close();
	});

	it("allows disjoint Bot locks but rejects overlapping roots across executor instances", async () => {
		const f = await fixture();
		const first = f.executor.run(task());
		const rejected = expect(first).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(f.received.some((m) => m.type === "prompt")).toBe(true));
		const nestedBot = { ...bot, id: "nested-bot", cwd: resolve(cwd, "nested") };
		const nested = createDeviceTaskExecutor({
			localOrigin: f.origin,
			cwd: nestedBot.cwd,
			bot: nestedBot,
			allowExecution: true,
		});
		await expect(nested.run({ ...task(), botId: nestedBot.id })).rejects.toThrow("busy");
		const independentBot = { ...bot, id: "independent-bot", cwd: resolve(cwd, "../independent") };
		const independent = createDeviceTaskExecutor({
			localOrigin: f.origin,
			cwd: independentBot.cwd,
			bot: independentBot,
			allowExecution: true,
		});
		// The fixture serves the first cwd; reaching init proves admission passed
		// the process-wide lock while the first task is still running.
		await expect(independent.run({ ...task(), botId: independentBot.id })).rejects.toThrow("fixed cwd");
		await independent.close();
		await nested.close();
		void f.executor.close().catch(() => {});
		await rejected;
	});

	it("rejects busy work across instances, cancels only its own session and forbids repeated task IDs", async () => {
		const f = await fixture();
		const t = task();
		const running = f.executor.run(t);
		const rejected = expect(running).rejects.toThrow("cancelled");
		await expect(f.executor.run(task())).rejects.toThrow("busy");
		const other = createDeviceTaskExecutor({ localOrigin: f.origin, cwd, bot, allowExecution: true });
		await expect(other.run(task())).rejects.toThrow("busy");
		await vi.waitFor(() => expect(f.received.some((m) => m.type === "prompt")).toBe(true));
		f.executor.close();
		await rejected;
		await vi.waitFor(() => expect(f.received.filter((m) => m.type === "abort")).toHaveLength(1));
		await vi.waitFor(async () => {
			await expect(other.run({ ...t, attemptId: "different-attempt" })).rejects.toThrow("Duplicate task");
		});
		other.close();
	});

	it.each([
		"question_pending",
		"tool_approval_pending",
		"pendingQuestion",
		"pendingApproval",
		"pendingApprovals",
		"question_queue",
	])("waits for %s without completing idle or consuming the execution timeout", async (kind) => {
		let socket!: WebSocket;
		let baseline!: UiState;
		const f = await fixture((ws, state) => {
			socket = ws;
			baseline = state;
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let completed = false;
		const running = f.executor.run(task());
		void running.then(
			() => {
				completed = true;
			},
			() => {
				completed = true;
			},
		);
		for (let i = 0; i < 1000 && !socket; i++) await new Promise<void>((done) => setImmediate(done));
		expect(socket).toBeDefined();
		await vi.advanceTimersByTimeAsync(19 * 60 * 1000);
		const entry = { id: "human", conversationId: baseline.conversationId };
		const patch: Partial<UiState> = { messages: [assistant("Still waiting") as any], isStreaming: false };
		if (kind.startsWith("pending")) Object.assign(patch, { [kind]: kind === "pendingApprovals" ? [entry] : entry });
		else if (kind === "question_queue")
			socket.send(
				JSON.stringify({
					type: kind,
					questions: [{ ...entry, rootConversationId: baseline.conversationId, conversationId: "child" }],
				}),
			);
		else socket.send(JSON.stringify({ type: kind, ...entry }));
		f.push(socket, patch);
		// Drain real socket events before advancing the fake execution clock.
		for (let i = 0; i < 20; i++) await new Promise<void>((done) => setImmediate(done));
		await vi.advanceTimersByTimeAsync(40 * 60 * 1000);
		expect(completed).toBe(false);
		expect(
			f.received.some((m) => m.type === "abort" || m.type === "tool_approval_response" || m.type === "question_answer"),
		).toBe(false);
		if (kind === "question_pending") socket.send(JSON.stringify({ type: "question_retracted", id: entry.id }));
		if (kind === "tool_approval_pending") socket.send(JSON.stringify({ type: "tool_approval_resolved", id: entry.id }));
		if (kind === "question_queue") socket.send(JSON.stringify({ type: kind, questions: [] }));
		f.push(socket, { pendingQuestion: null, pendingApproval: null, pendingApprovals: [], isStreaming: true });
		for (let i = 0; i < 20; i++) await new Promise<void>((done) => setImmediate(done));
		await vi.advanceTimersByTimeAsync(19 * 60 * 1000);
		expect(completed).toBe(false);
		f.push(socket, { isStreaming: false, messages: [assistant("Human answered; done") as any] });
		expect(await running).toBe("Human answered; done");
	});

	it("keeps waiting until every approval resolves, then enforces a fresh execution timeout", async () => {
		let socket!: WebSocket;
		let baseline!: UiState;
		const f = await fixture((ws, state) => {
			socket = ws;
			baseline = state;
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let completed = false;
		const running = f.executor.run(task());
		const rejected = expect(running).rejects.toThrow("20 minute timeout");
		void running.then(
			() => {
				completed = true;
			},
			() => {
				completed = true;
			},
		);
		for (let i = 0; i < 1000 && !socket; i++) await new Promise<void>((done) => setImmediate(done));
		const approvals = ["first", "second"].map((id) => ({ id, conversationId: baseline.conversationId }));
		f.push(socket, { pendingApprovals: approvals as any, isStreaming: false, messages: [assistant("Waiting") as any] });
		for (let i = 0; i < 20; i++) await new Promise<void>((done) => setImmediate(done));
		socket.send(JSON.stringify({ type: "tool_approval_resolved", id: "first" }));
		f.push(socket, { pendingApprovals: [approvals[1]] as any });
		// Unrelated notifications must not release the remaining approval.
		socket.send(JSON.stringify({ type: "tool_approval_resolved", id: "unrelated" }));
		for (let i = 0; i < 20; i++) await new Promise<void>((done) => setImmediate(done));
		await vi.advanceTimersByTimeAsync(40 * 60 * 1000);
		expect(completed).toBe(false);
		socket.send(JSON.stringify({ type: "tool_approval_resolved", id: "second" }));
		f.push(socket, { pendingApprovals: [], isStreaming: true });
		for (let i = 0; i < 20; i++) await new Promise<void>((done) => setImmediate(done));
		await vi.advanceTimersByTimeAsync(20 * 60 * 1000 - 1);
		expect(completed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await rejected;
	});

	it("ignores human waits belonging to another conversation", async () => {
		const f = await fixture((socket, state) => {
			socket.send(JSON.stringify({ type: "question_pending", id: "other", conversationId: "other-chat" }));
			delta(
				socket,
				state,
				{
					pendingApprovals: [{ id: "other", conversationId: "other-chat" }] as any,
				},
				[assistant("done")],
			);
		});
		expect(await f.executor.run(task())).toBe("done");
	});

	it("close waits for the same SDK session to acknowledge idle after abort", async () => {
		let socket!: WebSocket;
		const f = await fixture((ws) => {
			socket = ws;
			f.push(ws, { isStreaming: true });
		});
		const running = f.executor.run(task());
		const rejected = expect(running).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(socket).toBeDefined());
		let stopped = false;
		const closing = f.executor.close().then(() => {
			stopped = true;
		});
		await rejected;
		await vi.waitFor(() => expect(f.received.some((m) => m.type === "get_state")).toBe(true));
		expect(stopped).toBe(false);
		f.push(socket, { isStreaming: false });
		await closing;
		expect(stopped).toBe(true);
	});

	it("close times out after 20 seconds without an idle acknowledgement", async () => {
		let started = false;
		const f = await fixture((socket) => {
			started = true;
			f.push(socket, { isStreaming: true });
		});
		const running = f.executor.run(task());
		const rejected = expect(running).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(started).toBe(true));
		vi.useFakeTimers();
		const closing = f.executor.close();
		const uncertain = expect(closing).rejects.toThrow("stop unconfirmed");
		await rejected;
		await vi.advanceTimersByTimeAsync(20_000);
		await uncertain;
		vi.useRealTimers();
	});

	it("close rejects uncertain disconnect instead of confirming idle", async () => {
		const f = await fixture((socket) => socket.close());
		await expect(f.executor.run(task())).rejects.toThrow("uncertain");
		await expect(f.executor.close()).rejects.toThrow("stop unconfirmed");
	});

	it("reports disconnect as uncertain and never reconnects or reruns", async () => {
		const f = await fixture((socket) => socket.close());
		await expect(f.executor.run(task())).rejects.toThrow(/disconnected.*uncertain/);
		expect(f.received.filter((m) => m.type === "hello")).toHaveLength(1);
		expect(f.received.filter((m) => m.type === "prompt")).toHaveLength(1);
	});

	it("refuses to abort a different current conversation", async () => {
		const f = await fixture((socket, state) =>
			socket.send(JSON.stringify({ type: "snapshot", state: { ...state, conversationId: "user-chat" } })),
		);
		await expect(f.executor.run(task())).rejects.toThrow("ownership changed");
		expect(f.received.some((m) => m.type === "abort")).toBe(false);
	});

	it("does not send a prompt when new_chat is refused", async () => {
		const f = await fixture(undefined, { refuseNew: true });
		await expect(f.executor.run(task())).rejects.toThrow("Conversation limit");
		expect(f.received.some((m) => m.type === "prompt")).toBe(false);
	});

	it("resynchronizes missing deltas and waits for actual final snapshots", async () => {
		const f = await fixture(
			(socket) => {
				f.push(socket, { isStreaming: true });
				f.push(socket, { isStreaming: false, messages: [assistant("ACTUAL RESULT")] });
			},
			{ gap: true },
		);
		const result = await f.executor.run(task());
		expect(result).toContain("ACTUAL RESULT");
		expect(result).not.toContain("FAKE GAP TEXT");
		expect(f.received.filter((m) => m.type === "prompt")).toHaveLength(1);
	});

	it("rejects assistant failures and empty results", async () => {
		for (const messages of [[], [{ ...assistant("partial"), stopReason: "error", errorMessage: "Model failed" }]]) {
			const f = await fixture((socket, state) => {
				delta(socket, state, { isStreaming: true });
				delta(socket, { ...state, rev: state.rev + 1 }, { isStreaming: false }, messages);
			});
			await expect(f.executor.run(task())).rejects.toThrow(/without assistant text|Model failed/);
		}
	});

	it.each([
		["Configured Bot model is unavailable", "model_missing"],
		["No API key found for provider", "model_auth"],
		["401 Unauthorized", "model_auth"],
		["429 Too many requests", "model_rate_limit"],
		["503 Service unavailable", "model_unavailable"],
		["Unsupported command", "unsupported_command"],
		["Bot execution capability has been revoked", "capability_revoked"],
		["Tool bash is denied", "tool_denied"],
		["unrecognized private provider dump", "execution_failed"],
	])("reports safe reason for %s without provider data", async (reason, category) => {
		const secret = "CREDENTIAL_SENTINEL_7fa43";
		const raw = `${reason}\nAuthorization: Bearer ${secret}\nhttps://user:${secret}@provider.invalid/private?api_key=${secret}\n/Users/private/.pi/auth.json C:\\private\\credentials.json\n{\"rawDump\":\"${secret}\"}`;
		const f = await fixture((socket, state) => {
			delta(socket, state, { isStreaming: false }, [
				{ ...assistant("partial"), stopReason: "error", errorMessage: raw },
			]);
		});
		const error = await f.executor.run(task()).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(DeviceExecutionError);
		const failure = error as DeviceExecutionError;
		expect(failure.failure.category).toBe(category);
		expect(failure.failure.phase).toBe(category === "tool_denied" ? "tool" : "model");
		expect(failure.message).toContain(secret); // Local-only diagnostic remains available.
		const outgoing = deviceTaskFailure(error);
		expect(outgoing).toContain(`category=${category}`);
		expect(outgoing).not.toContain(secret);
		expect(outgoing).not.toMatch(
			/CREDENTIAL_SENTINEL|provider\.invalid|https?:|Users|credentials\.json|rawDump|Authorization|partial/,
		);
	});

	it.each(["errorMessage", "error"])("fails on snapshot %s during initialization and new_chat", async (field) => {
		for (const stage of ["init", "new_chat"] as const) {
			const pushFailure = (socket: WebSocket, state: UiState) =>
				socket.send(
					JSON.stringify({
						type: "snapshot",
						state: { ...state, rev: state.rev + 1, [field]: "Configured Bot model is unavailable PRIVATE_SENTINEL" },
					}),
				);
			const f = await fixture(undefined, stage === "init" ? { onHello: pushFailure } : { onNew: pushFailure });
			const error = await f.executor.run(task()).catch((error: unknown) => error);
			expect(error).toBeInstanceOf(DeviceExecutionError);
			expect((error as DeviceExecutionError).failure).toMatchObject({ phase: stage, category: "model_missing" });
			expect(deviceTaskFailure(error)).not.toContain("PRIVATE_SENTINEL");
			expect(f.received.some((message) => message.type === "prompt")).toBe(false);
		}
	});

	it("records handshake errors before ready without exposing notice text", async () => {
		const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No address");
		server.on("connection", (socket) =>
			socket.on("message", () =>
				socket.send(
					JSON.stringify({
						type: "notice",
						level: "error",
						text: "Invalid Bot execution capability PRIVATE_SENTINEL",
					}),
				),
			),
		);
		const executor = createDeviceTaskExecutor({
			localOrigin: `http://127.0.0.1:${address.port}`,
			bot,
			cwd,
			allowExecution: true,
		});
		cleanup.push(async () => {
			await executor.close();
			for (const socket of server.clients) socket.terminate();
			await new Promise<void>((done) => server.close(() => done()));
		});
		const error = await executor.run(task()).catch((error: unknown) => error);
		expect((error as DeviceExecutionError).failure).toMatchObject({
			phase: "handshake",
			category: "capability_revoked",
		});
		expect(deviceTaskFailure(error)).not.toContain("PRIVATE_SENTINEL");
	});

	it("uses the English notice reason and records new_chat failure phase", async () => {
		const f = await fixture(undefined, {
			onNew: (socket) =>
				socket.send(
					JSON.stringify({
						type: "notice",
						level: "error",
						text: "无法初始化",
						textEn: "Configured Bot model is unavailable",
					}),
				),
		});
		const error = await f.executor.run(task()).catch((error: unknown) => error);
		expect((error as DeviceExecutionError).failure).toMatchObject({ phase: "new_chat", category: "model_missing" });
	});

	it("reports capability rejection on WebSocket close without leaking the close reason", async () => {
		const f = await fixture(undefined, {
			onNew: (socket) => socket.close(1008, "Invalid Bot execution capability PRIVATE_SENTINEL"),
		});
		const error = await f.executor.run(task()).catch((error: unknown) => error);
		expect((error as DeviceExecutionError).failure).toMatchObject({
			phase: "new_chat",
			category: "capability_revoked",
		});
		expect(deviceTaskFailure(error)).not.toContain("PRIVATE_SENTINEL");
	});

	it("limits UTF-8 reports to 16 KiB with a truncation notice", async () => {
		const f = await fixture((socket, state) =>
			delta(socket, state, { isStreaming: false }, [assistant("实际结果".repeat(10000))]),
		);
		const result = await f.executor.run(task());
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(16 * 1024);
		expect(result).toContain("Report excerpt");
	});

	it.each(["completed", "disconnect", "close", "timeout"])(
		"binds the SDK session before prompt and clears ownership on %s",
		async (outcome) => {
			const sessions = new Map<string, string>();
			const onSession = vi.fn((taskId: string, sessionId: string | undefined) => {
				if (sessionId) sessions.set(sessionId, taskId);
				else for (const [id, parent] of sessions) if (parent === taskId) sessions.delete(id);
			});
			const t = task();
			const f = await fixture(
				(socket, state) => {
					expect(state.sessionId).toBe("task-sdk-session");
					expect(sessions.get(state.sessionId)).toBe(t.id);
					expect(sessions.get(state.conversationId)).toBeUndefined();
					expect(sessions.get("same-root-human-sdk-session")).toBeUndefined();
					if (outcome === "completed") delta(socket, state, { isStreaming: false }, [assistant("done")]);
					if (outcome === "disconnect") socket.close();
				},
				{ onSession },
			);
			if (outcome === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const running = f.executor.run(t);
			const checked =
				outcome === "completed" ? expect(running).resolves.toContain("done") : expect(running).rejects.toThrow();
			if (outcome === "close" || outcome === "timeout") {
				for (let i = 0; i < 1000 && !f.received.some((m) => m.type === "prompt"); i++)
					await new Promise<void>((done) => setImmediate(done));
				expect(f.received.some((m) => m.type === "prompt")).toBe(true);
				if (outcome === "close") f.executor.close();
				else await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
			}
			await checked;
			vi.useRealTimers();
			expect(onSession.mock.calls).toEqual([
				[t.id, "task-sdk-session"],
				[t.id, undefined],
			]);
			expect(sessions.size).toBe(0);
			f.executor.close();
			expect(onSession).toHaveBeenCalledTimes(2);
			await expect(f.executor.run(task())).rejects.toThrow("closed");
		},
	);

	it("cleans up a failed ownership registration before any prompt", async () => {
		const onSession = vi.fn((_taskId: string, sessionId: string | undefined) => {
			if (sessionId) throw new Error("Registration failed");
		});
		const f = await fixture(undefined, { onSession });
		const t = task();
		await expect(f.executor.run(t)).rejects.toThrow("registration failed");
		expect(onSession.mock.calls).toEqual([
			[t.id, "task-sdk-session"],
			[t.id, undefined],
		]);
		expect(f.received.some((m) => m.type === "prompt")).toBe(false);
	});

	it("renews execution timeout for new task deltas, never duplicate or foreign frames", async () => {
		let socket!: WebSocket;
		const onActivity = vi.fn();
		const onProgress = vi.fn();
		const f = await fixture(
			(ws) => {
				socket = ws;
			},
			{ onActivity, onProgress },
		);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const running = f.executor.run(task());
		const rejected = expect(running).rejects.toThrow("20 minute timeout");
		for (let i = 0; i < 1000 && !socket; i++) await new Promise<void>((done) => setImmediate(done));
		await vi.advanceTimersByTimeAsync(19 * 60 * 1000);
		const frame = {
			type: "message_delta",
			conversationId: "task-chat",
			seq: 1,
			messageId: "live",
			usage: null,
			assistantMessageEvent: { type: "text_delta", delta: "Working" },
		};
		socket.send(JSON.stringify(frame));
		for (let i = 0; i < 1000 && !onActivity.mock.calls.length; i++)
			await new Promise<void>((done) => setImmediate(done));
		expect(onActivity).toHaveBeenCalledTimes(1);
		expect(onProgress).toHaveBeenCalledWith({ phase: "model", text: "Working" });
		await vi.advanceTimersByTimeAsync(19 * 60 * 1000);
		socket.send(JSON.stringify(frame));
		socket.send(JSON.stringify({ ...frame, conversationId: "foreign", seq: 2 }));
		for (let i = 0; i < 20; i++) await new Promise<void>((done) => setImmediate(done));
		expect(onActivity).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60 * 1000);
		await rejected;
	});

	it("does not renew timeout for repeated streaming snapshots with only revision or usage changes", async () => {
		let socket!: WebSocket;
		const onActivity = vi.fn();
		const f = await fixture(
			(ws) => {
				socket = ws;
			},
			{ onActivity },
		);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const running = f.executor.run(task());
		const rejected = expect(running).rejects.toThrow("20 minute timeout");
		for (let i = 0; i < 1000 && !socket; i++) await new Promise<void>((done) => setImmediate(done));
		await vi.advanceTimersByTimeAsync(19 * 60 * 1000);
		f.push(socket, { isStreaming: true, stats: { tokens: 123 } as any });
		for (let i = 0; i < 20; i++) await new Promise<void>((done) => setImmediate(done));
		expect(onActivity).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60 * 1000);
		await rejected;
	});

	it("times out after 20 minutes and sends abort", async () => {
		const f = await fixture();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const running = f.executor.run(task());
		const rejected = expect(running).rejects.toThrow("20 minute timeout");
		// Native socket events are still real; poll with native setImmediate.
		for (let i = 0; i < 1000 && !f.received.some((m) => m.type === "prompt"); i++)
			await new Promise<void>((done) => setImmediate(done));
		expect(f.received.some((m) => m.type === "prompt")).toBe(true);
		await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
		await rejected;
		vi.useRealTimers();
		await vi.waitFor(() => expect(f.received.some((m) => m.type === "abort")).toBe(true));
	});
});
