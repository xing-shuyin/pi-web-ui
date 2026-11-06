import type { ClientMessage, ServerMessage } from "./types";
import { notify } from "./notify";
import { playSound } from "./sounds";
import { currentUiLocale } from "./ui-locale";
import { isZhLocale } from "./pick-locale";
import zh from "./i18n/messages/native-cli-session/zh.json";
import en from "./i18n/messages/native-cli-session/en.json";
import { randomUuid } from "./uuid";

type ControlRequest = Extract<ClientMessage, { type: "terminal_cli_control" }>;
type ControlResult = Extract<ServerMessage, { type: "terminal_cli_control_result" }>;
type NativeCliEvent = Extract<ServerMessage, { type: "native_cli_event" }>;
export type NativeCliControlAction = ControlRequest["action"];
export interface NativeCliControlOutcome {
	ok: boolean;
	error?: string;
	reason?: "timeout" | "cancelled" | "unavailable";
}

const pendingControls = new Map<
	string,
	{
		terminalId: string;
		conversationId: string;
		finish: (result: NativeCliControlOutcome) => void;
	}
>();

export function requestNativeCliControl(
	send: (message: ClientMessage) => boolean,
	target: Pick<ControlRequest, "terminalId" | "conversationId" | "action">,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<NativeCliControlOutcome> {
	return new Promise((resolve) => {
		if (options.signal?.aborted) {
			resolve({ ok: false, reason: "cancelled" });
			return;
		}
		const requestId = randomUuid();
		const finish = (result: NativeCliControlOutcome) => {
			if (!pendingControls.delete(requestId)) return;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", cancel);
			resolve(result);
		};
		const cancel = () => finish({ ok: false, reason: "cancelled" });
		const timer = setTimeout(
			() => finish({ ok: false, reason: "timeout" }),
			options.timeoutMs ?? (target.action === "reconnect" ? 120_000 : target.action === "stop" ? 60_000 : 15_000),
		);
		pendingControls.set(requestId, { ...target, finish });
		options.signal?.addEventListener("abort", cancel, { once: true });
		try {
			if (!send({ type: "terminal_cli_control", requestId, ownerKind: "conversation", ...target })) {
				finish({ ok: false, reason: "unavailable" });
			}
		} catch {
			finish({ ok: false, reason: "unavailable" });
		}
	});
}

export function resolveNativeCliControlResult(message: ControlResult): boolean {
	const pending = pendingControls.get(message.requestId);
	if (!pending || pending.terminalId !== message.terminalId || pending.conversationId !== message.conversationId) {
		return false;
	}
	pending.finish({ ok: message.ok, error: message.error });
	return true;
}

const seenEvents = new Set<string>();
const MAX_SEEN_EVENTS = 512;
const eventText = {
	done: ["nativeCliSession.doneTitle", "nativeCliSession.doneBody"],
	error: ["nativeCliSession.errorTitle", "nativeCliSession.errorBody"],
	question: ["nativeCliSession.questionTitle", "nativeCliSession.questionBody"],
	approval: ["nativeCliSession.approvalTitle", "nativeCliSession.approvalBody"],
} as const;

export function handleNativeCliEvent(message: NativeCliEvent): void {
	if (
		!message.eventId?.trim() ||
		!message.conversationId?.trim() ||
		!message.sessionId?.trim() ||
		!Number.isFinite(message.occurredAt) ||
		!Object.hasOwn(eventText, message.kind)
	)
		return;
	const id = JSON.stringify([message.conversationId, message.eventId]);
	if (seenEvents.has(id)) return;
	seenEvents.add(id);
	if (seenEvents.size > MAX_SEEN_EVENTS) seenEvents.delete(seenEvents.values().next().value!);
	const strings = isZhLocale(currentUiLocale()) ? zh : en;
	const [title, body] = eventText[message.kind];
	playSound(message.kind);
	void notify(strings[title], strings[body], message.kind, message.sessionId);
}
