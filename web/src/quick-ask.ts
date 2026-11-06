export interface QuickAskOpenRequest {
	selection?: string;
	anchor?: { left: number; right: number; top: number; bottom: number };
}

export const QUICK_ASK_OPEN_EVENT = "pi:quick-ask-open";

/** The selection menu only opens the independent window; it never touches the composer. */
export function openQuickAsk(request: QuickAskOpenRequest = {}): void {
	window.dispatchEvent(new CustomEvent<QuickAskOpenRequest>(QUICK_ASK_OPEN_EVENT, { detail: request }));
}

export function explainSelectionPrompt(template: string | undefined, input: string): string {
	return (template?.trim() || "解释下: {{input}}").replaceAll("{{input}}", () => input);
}

export interface QuickAskMessage {
	role: "user" | "assistant";
	content: string;
}

/** Replace an unanswered turn when sending a revised question after cancellation/failure. */
export function appendQuickAskQuestion(messages: QuickAskMessage[], content: string): QuickAskMessage[] {
	const history = messages.at(-1)?.role === "user" ? messages.slice(0, -1) : messages;
	return [...history, { role: "user", content }];
}
