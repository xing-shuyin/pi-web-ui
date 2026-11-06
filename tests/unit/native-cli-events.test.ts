// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "../../web/src/types";
import {
	handleNativeCliEvent,
	requestNativeCliControl,
	resolveNativeCliControlResult,
} from "../../web/src/native-cli-events";
import { announceUiLocale } from "../../web/src/ui-locale";
import { notify } from "../../web/src/notify";
import { playSound } from "../../web/src/sounds";

vi.mock("../../web/src/notify", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("../../web/src/sounds", () => ({ playSound: vi.fn() }));
type ControlRequest = Extract<ClientMessage, { type: "terminal_cli_control" }>;
type CliEvent = Extract<ServerMessage, { type: "native_cli_event" }>;
const target = { terminalId: "term-a", conversationId: "conv-a", action: "detach" as const };
const ack = (request: ControlRequest, updates = {}) => ({
	type: "terminal_cli_control_result" as const,
	requestId: request.requestId,
	terminalId: request.terminalId,
	conversationId: request.conversationId,
	ok: true,
	...updates,
});
let sequence = 0;
const event = (updates: Partial<CliEvent> = {}): CliEvent => ({
	type: "native_cli_event",
	eventId: `event-${sequence++}`,
	kind: "done",
	conversationId: "conv-background",
	sessionId: "web-session-background",
	occurredAt: Date.now(),
	...updates,
});

beforeEach(() => {
	vi.clearAllMocks();
	announceUiLocale("en");
});
afterEach(() => vi.useRealTimers());

describe("native CLI control acknowledgements", () => {
	it("matches request, terminal and conversation ownership before settling", async () => {
		let request!: ControlRequest;
		const send = vi.fn((message: ClientMessage) => {
			request = message as ControlRequest;
			return true;
		});
		const result = requestNativeCliControl(send, target);
		expect(request).toMatchObject({ type: "terminal_cli_control", ownerKind: "conversation", ...target });
		expect(resolveNativeCliControlResult(ack(request, { conversationId: "conv-b" }))).toBe(false);
		expect(resolveNativeCliControlResult(ack(request, { terminalId: "term-b" }))).toBe(false);
		expect(resolveNativeCliControlResult(ack(request, { requestId: "wrong" }))).toBe(false);
		expect(resolveNativeCliControlResult(ack(request, { ok: false, error: "permission denied" }))).toBe(true);
		await expect(result).resolves.toEqual({ ok: false, error: "permission denied" });
		expect(resolveNativeCliControlResult(ack(request))).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
	});
	it("registers before sending and accepts synchronous acknowledgements", async () => {
		const send = (message: ClientMessage) => {
			resolveNativeCliControlResult(ack(message as ControlRequest));
			return true;
		};
		await expect(requestNativeCliControl(send, target)).resolves.toMatchObject({ ok: true });
	});
	it("times out once without retrying and ignores a late acknowledgement", async () => {
		vi.useFakeTimers();
		const send = vi.fn(() => true);
		const result = requestNativeCliControl(send, target);
		await vi.advanceTimersByTimeAsync(15_000);
		await expect(result).resolves.toEqual({ ok: false, reason: "timeout" });
		expect(send).toHaveBeenCalledTimes(1);
		expect(resolveNativeCliControlResult(ack((send.mock.calls as any)[0][0]))).toBe(false);
	});
	it("cancels pending requests and never sends already cancelled requests", async () => {
		const controller = new AbortController();
		const send = vi.fn(() => true);
		const result = requestNativeCliControl(send, target, { signal: controller.signal });
		controller.abort();
		await expect(result).resolves.toEqual({ ok: false, reason: "cancelled" });
		expect(resolveNativeCliControlResult(ack((send.mock.calls as any)[0][0]))).toBe(false);
		await expect(requestNativeCliControl(send, target, { signal: controller.signal })).resolves.toMatchObject({
			reason: "cancelled",
		});
		expect(send).toHaveBeenCalledTimes(1);
	});
	it.each([
		() => false,
		() => {
			throw new Error("closed socket");
		},
	])("reports unavailable transport without retrying", async (send) => {
		await expect(requestNativeCliControl(send, target)).resolves.toEqual({ ok: false, reason: "unavailable" });
	});
});

describe("native CLI authoritative event notifications", () => {
	it.each(["done", "error", "question", "approval"] as const)(
		"plays configured %s sound and routes fixed text to the event's Web session",
		(kind) => {
			const message = event({ kind });
			handleNativeCliEvent({
				...message,
				body: "private task content",
				nativeSessionId: "native-not-navigation",
			} as any);
			expect(playSound).toHaveBeenCalledWith(kind);
			expect(notify).toHaveBeenCalledWith(expect.any(String), expect.any(String), kind, "web-session-background");
			expect(JSON.stringify(vi.mocked(notify).mock.calls)).not.toContain("private task content");
			expect(JSON.stringify(vi.mocked(notify).mock.calls)).not.toContain("native-not-navigation");
		},
	);
	it("deduplicates replayed events and scopes event IDs to the owning conversation", () => {
		const message = event();
		handleNativeCliEvent(message);
		handleNativeCliEvent(message);
		handleNativeCliEvent({ ...message, conversationId: "conv-other", sessionId: "web-other" });
		expect(notify).toHaveBeenCalledTimes(2);
	});
	it("bounds the dedupe history", () => {
		const first = event();
		handleNativeCliEvent(first);
		for (let i = 0; i < 512; i++) handleNativeCliEvent(event());
		handleNativeCliEvent(first);
		expect(notify).toHaveBeenCalledTimes(514);
	});
	it("uses the current UI locale for all four fixed message pairs", () => {
		announceUiLocale("zh");
		for (const kind of ["done", "error", "question", "approval"] as const) handleNativeCliEvent(event({ kind }));
		expect(vi.mocked(notify).mock.calls.map(([title]) => title)).toEqual([
			"CLI 任务已完成",
			"CLI 任务失败",
			"CLI 需要输入",
			"CLI 需要授权",
		]);
	});
	it("ignores malformed events rather than falling back to the active conversation", () => {
		for (const updates of [
			{ sessionId: "" },
			{ conversationId: "" },
			{ eventId: "" },
			{ occurredAt: NaN },
			{ kind: "exited" },
		]) {
			handleNativeCliEvent(event(updates as any));
		}
		expect(notify).not.toHaveBeenCalled();
		expect(playSound).not.toHaveBeenCalled();
	});
});
