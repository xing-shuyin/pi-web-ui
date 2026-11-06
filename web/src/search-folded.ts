interface FoldedBlock {
	type: string;
	id?: unknown;
	text?: unknown;
	thinking?: unknown;
	name?: unknown;
	argumentsText?: unknown;
	command?: unknown;
	output?: unknown;
}

export interface FoldedMessage {
	id: string;
	role: string;
	content: FoldedBlock[];
}

export interface FoldedResultMessage {
	content: FoldedBlock[];
}

export function foldedResultText(m: FoldedResultMessage): string {
	const parts: string[] = [];
	for (const b of m.content) {
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n");
}

export function foldedSearchText(m: FoldedMessage, results: ReadonlyMap<string, FoldedResultMessage>): string {
	const parts: string[] = [];
	for (const b of m.content) {
		if (b.type === "text" && typeof b.text === "string") {
			parts.push(b.text);
		} else if (b.type === "thinking" && typeof b.thinking === "string") {
			parts.push(b.thinking);
		} else if (b.type === "toolCall") {
			if (typeof b.name === "string") parts.push(b.name);
			if (typeof b.argumentsText === "string") parts.push(b.argumentsText);
			if (typeof b.id === "string") {
				const r = results.get(b.id);
				if (r) {
					const t = foldedResultText(r);
					if (t) parts.push(t);
				}
			}
		} else if (b.type === "bash") {
			if (typeof b.command === "string") parts.push(b.command);
			if (typeof b.output === "string") parts.push(b.output);
		}
	}
	return parts.join("\n");
}

function countOccurrences(text: string, needle: string): number {
	let n = 0;
	let idx = text.indexOf(needle);
	while (idx !== -1) {
		n++;
		idx = text.indexOf(needle, idx + needle.length);
	}
	return n;
}

export function collectFoldedHits(
	messages: readonly FoldedMessage[],
	collapsedIds: ReadonlySet<string>,
	query: string,
	results: ReadonlyMap<string, FoldedResultMessage>,
): Map<string, number> {
	const out = new Map<string, number>();
	const needle = query.toLowerCase();
	if (!needle) return out;
	for (const m of messages) {
		if (!collapsedIds.has(m.id)) continue;
		const n = countOccurrences(foldedSearchText(m, results).toLowerCase(), needle);
		if (n > 0) out.set(m.id, n);
	}
	return out;
}
