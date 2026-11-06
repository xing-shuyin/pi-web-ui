export interface PluginConversationShape {
	isSubagent: boolean;
	lastActiveAt: number;
}

export function pickClientConversation<T extends PluginConversationShape>(
	conversations: Iterable<T>,
	opts: { active?: T | undefined; includeSubagents?: boolean } = {},
): T | null {
	const include = opts.includeSubagents === true;
	const active = opts.active;
	if (active && (include || !active.isSubagent)) return active;
	let best: T | null = null;
	for (const c of conversations) {
		if (!include && c.isSubagent) continue;
		if (!best || c.lastActiveAt > best.lastActiveAt) best = c;
	}
	return best;
}

export function pickLatestClientSnapshot<T extends { isSubagent: boolean; at: number }>(
	snapshots: Iterable<T | null | undefined>,
): T | null {
	let best: T | null = null;
	for (const s of snapshots) {
		if (!s || s.isSubagent) continue;
		if (!best || s.at > best.at) best = s;
	}
	return best;
}

export function modelChangeKey(snap: { clientId: string; conversationId: string; model?: string }): string {
	return `${snap.clientId}\u0000${snap.conversationId}\u0000${snap.model ?? ""}`;
}
