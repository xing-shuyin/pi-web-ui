export interface MobileNotificationEvent {
	eventId: string;
	kind: "done" | "error" | "question" | "approval" | "subagentDone";
	clientId: string;
	sessionId: string;
	conversationId?: string;
	/** Trusted source device identity, supplied by the authenticated Hub ingress. */
	deviceId?: string;
	deviceName?: string;
	occurredAt: number;
}

export type MobileNotificationCallback = (event: MobileNotificationEvent) => void | Promise<void>;

export interface MobileNotificationTurn {
	id: string;
	sessionId: string;
	settled: boolean;
	error: boolean;
	aborted: boolean;
	notified: boolean;
	compactionPending?: boolean;
}

export function mobileNotificationOutcome(messages: readonly unknown[]): { error: boolean; aborted: boolean } {
	const assistant = [...messages].reverse().find((message) => (message as { role?: unknown })?.role === "assistant") as
		{ stopReason?: string; errorMessage?: string } | undefined;
	return {
		error: assistant?.stopReason === "error" || !!assistant?.errorMessage,
		aborted: assistant?.stopReason === "aborted",
	};
}

/** Notification delivery must never fail a prompt or create an unhandled rejection. */
export function deliverMobileNotificationEvent(
	callback: MobileNotificationCallback | undefined,
	event: MobileNotificationEvent,
): void {
	try {
		void Promise.resolve(callback?.(event)).catch(() => {});
	} catch {
		// Delivery owns its own persistence/retry policy, independently of the session.
	}
}
