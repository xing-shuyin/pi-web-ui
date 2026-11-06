const SDK_ABORT_MESSAGES = /^(This operation was aborted|Request aborted)$/;

export function isAbortedTurn(m: { stopReason?: string; errorMessage?: string }): boolean {
	if (m.stopReason === "aborted") return true;
	return m.stopReason === "error" && SDK_ABORT_MESSAGES.test((m.errorMessage ?? "").trim());
}
