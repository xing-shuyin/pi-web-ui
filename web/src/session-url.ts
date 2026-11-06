export interface SessionUrlTarget {
	sessionId: string;
	messageId?: string;
}

export function parseSessionHash(hash: string | null | undefined): SessionUrlTarget | null {
	if (!hash) return null;
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	if (!raw.trim()) return null;
	const params = new URLSearchParams(raw);
	const sessionId = params.get("s")?.trim() ?? "";
	if (!sessionId) return null;
	const messageId = params.get("m")?.trim() || undefined;
	return messageId ? { sessionId, messageId } : { sessionId };
}

export function formatSessionHash(target: SessionUrlTarget | null | undefined): string {
	const sessionId = target?.sessionId?.trim() ?? "";
	if (!sessionId) return "";
	const messageId = target?.messageId?.trim() ?? "";
	const base = `#s=${encodeURIComponent(sessionId)}`;
	return messageId ? `${base}&m=${encodeURIComponent(messageId)}` : base;
}

export function buildSessionDeepLink(currentHref: string, target: SessionUrlTarget): string {
	const hash = formatSessionHash(target);
	try {
		const u = new URL(currentHref);
		u.searchParams.delete("token");
		u.hash = hash;
		return u.toString();
	} catch {
		const base = currentHref.split("#")[0] ?? currentHref;
		return `${base}${hash}`;
	}
}

export function extractSessionIdFromPath(sessionPath: string | null | undefined): string | null {
	if (!sessionPath) return null;
	const norm = sessionPath.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!norm) return null;
	const parts = norm.split("/");
	const base = parts[parts.length - 1] ?? "";
	if (!base) return null;
	if (base === "session.jsonl") {
		const parent = parts[parts.length - 2]?.trim() ?? "";
		return parent || null;
	}
	const stem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
	if (!stem) return null;
	const underscoreIdx = stem.lastIndexOf("_");
	const candidate = underscoreIdx >= 0 ? stem.slice(underscoreIdx + 1).trim() : stem.trim();
	return candidate || null;
}

export function resolveMessageIdForJump(
	messages: ReadonlyArray<{ id: string }>,
	targetMsgId: string | null | undefined,
): string | null {
	const want = targetMsgId?.trim() ?? "";
	if (!want || messages.length === 0) return null;
	const exact = messages.find((m) => m.id === want);
	if (exact) return exact.id;
	const prefixMatch = /^([a-z]+-\d+)-\d+$/.exec(want);
	if (prefixMatch) {
		const prefix = `${prefixMatch[1]}-`;
		const byPrefix = messages.find((m) => m.id.startsWith(prefix));
		if (byPrefix) return byPrefix.id;
	}
	return null;
}
