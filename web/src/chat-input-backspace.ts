interface BackspaceAttachmentLike {
	path?: string;
	name?: string;
	mode?: string;
	key?: string;
	conversationId?: string;
	sessionPath?: string;
}

interface BackspaceMentionResult<T extends BackspaceAttachmentLike = BackspaceAttachmentLike> {
	tokenStart: number;
	attachment?: T;
}

export function resolveBackspaceMention<T extends BackspaceAttachmentLike>(
	before: string,
	pos: number,
	attachments: readonly T[],
): BackspaceMentionResult<T> | null {
	if (pos <= 0 || !before) return null;

	let bestHit: { attachment: T; tokenLen: number; withSpace: boolean } | null = null;

	for (const a of attachments) {
		const isPageOrConv = a.mode === "page" || a.mode === "conversation";
		const primary = isPageOrConv ? a.name : a.path;
		const fallback = a.name;

		const candidates = [primary, fallback].filter((s): s is string => typeof s === "string" && s.trim().length > 0);

		for (const cand of candidates) {
			const tok = "@" + cand;
			const withSpace = before.endsWith(tok + " ");
			if (withSpace || before.endsWith(tok)) {
				const tokenLen = tok.length;
				if (!bestHit || tokenLen > bestHit.tokenLen) {
					bestHit = { attachment: a, tokenLen, withSpace };
				}
			}
		}
	}

	let tokenStart = -1;
	let hitAttachment = bestHit?.attachment;

	if (bestHit) {
		const cand = pos - (bestHit.withSpace ? bestHit.tokenLen + 1 : bestHit.tokenLen);
		if (cand > 0 && /[\w.\-/]/.test(before[cand - 1])) {
			tokenStart = -1;
			hitAttachment = undefined;
		} else {
			tokenStart = cand;
		}
	}

	if (tokenStart < 0) {
		const gm = /(^|[\s(（"'"“‘[【])(@[^\s@,.;:!?，。！？)\]】」]+)(\s?)$/.exec(before);
		if (gm) {
			tokenStart = pos - gm[2].length - gm[3].length;
			const rawToken = before.slice(tokenStart, pos).trim().replace(/^@/, "");
			const baseName = rawToken.split("/").pop() ?? rawToken;

			hitAttachment =
				attachments.find((a) => a.path && a.path === rawToken) ??
				attachments.find((a) => a.name && a.name === rawToken) ??
				attachments.find((a) => a.mode !== "page" && a.mode !== "conversation" && a.name === baseName);
		}
	}

	if (tokenStart >= 0 && tokenStart < pos) {
		return { tokenStart, ...(hitAttachment ? { attachment: hitAttachment } : {}) };
	}

	return null;
}
