export function textBlocks(content: Array<{ type: string; text?: unknown }>): string[] {
	const out: string[] = [];
	for (const b of content) {
		if (b?.type === "text" && typeof b.text === "string" && b.text.length > 0) out.push(b.text);
	}
	return out;
}

export function messageMarkdown(content: Array<{ type: string; text?: unknown }>): string {
	return textBlocks(content).join("\n\n");
}

export function messagePlainText(content: Array<{ type: string; text?: unknown }>): string {
	return stripMarkdown(messageMarkdown(content));
}

export function stripMarkdown(md: string): string {
	const lines = md.split("\n");
	const out: string[] = [];
	let inFence = false;
	for (let line of lines) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}
		line = line
			.replace(/^\s{0,3}#{1,6}\s+/, "")
			.replace(/^\s*(>\s*)+/, "")
			.replace(/^\s*(?:[-*+]\s+|\d{1,9}[.)]\s+)/, "")
			.replace(/^\s*\[[ xX]\]\s+/, "");
		if (/^\s*\|?\s*[:-]+\s*(\|\s*[:-]+\s*)*\|?\s*$/.test(line) && /[-:]/.test(line)) continue;
		out.push(line);
	}
	return out
		.join("\n")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1$2")
		.replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, "$1$2")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/^\s*\|/gm, "")
		.replace(/\|\s*$/gm, "")
		.replace(/\|/g, " ")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+#+\s*$/gm, "")
		.split("\n")
		.map((l) => l.replace(/[ \t]+/g, " ").replace(/^\s+|\s+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
