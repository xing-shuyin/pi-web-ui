/**
 * plugins/slack/markdown-chunks.mjs
 * Structure-aware Markdown chunking utility for IM bots (Feishu, DingTalk, WeChat).
 * Preserves code fences (``` or ~~~) across chunk boundaries so rendered
 * syntax highlighting is never broken by length limits.
 */

const DEFAULT_CHUNK_LIMIT = 3800;
const CODE_FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Returns a slice index that does not bisect a UTF-16 surrogate pair.
 */
export function safeSliceIndex(value, limit) {
	let index = Math.min(limit, value.length);
	if (index <= 0) return 0;
	const before = value.charCodeAt(index - 1);
	const after = value.charCodeAt(index);
	if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
		index -= 1;
	}
	return Math.max(1, index);
}

function openingFence(line) {
	const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
	const match = CODE_FENCE_OPEN.exec(normalized);
	if (!match) return null;
	if (match[2][0] === "`" && match[3].includes("`")) return null;
	return { delimiter: match[2], info: match[3], indent: match[1].length };
}

function closesFence(line, opening) {
	const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
	return Boolean(match && match[1][0] === opening.delimiter[0] && match[1].length >= opening.delimiter.length);
}

function longestLeadingRun(text, character) {
	let longest = 0;
	for (const line of text.split("\n")) {
		let offset = 0;
		while (offset < 3 && line[offset] === " ") offset += 1;
		let length = 0;
		while (line[offset + length] === character) length += 1;
		longest = Math.max(longest, length);
	}
	return longest;
}

function safeCodeFence(text, info) {
	const backticks = "`".repeat(Math.max(3, longestLeadingRun(text, "`") + 1));
	const tildes = "~".repeat(Math.max(3, longestLeadingRun(text, "~") + 1));
	if (info.includes("`")) return tildes;
	return backticks.length <= tildes.length ? backticks : tildes;
}

function splitRawText(text, limit) {
	if (text.length <= limit) return [text];
	const parts = [];
	let remaining = text;
	while (remaining.length > limit) {
		let index = safeSliceIndex(remaining, limit);
		const newline = remaining.lastIndexOf("\n", index - 1);
		if (newline >= 0 && newline >= Math.floor(limit * 0.4)) {
			index = newline + 1;
		}
		parts.push(remaining.slice(0, index));
		remaining = remaining.slice(index);
	}
	if (remaining || parts.length === 0) parts.push(remaining);
	return parts;
}

/**
 * Splits arbitrary Markdown text into chunks of at most `limit` characters,
 * ensuring any code fence open at the boundary is properly closed on the
 * outgoing chunk and reopened on the incoming chunk with identical info string.
 *
 * @param {string} text - Raw Markdown text to chunk.
 * @param {number} [limit=3800] - Maximum chunk character length (must be > 20).
 * @returns {string[]} An array of valid Markdown chunks.
 */
export function chunkMarkdownText(text, limit = DEFAULT_CHUNK_LIMIT) {
	const raw = String(text ?? "").trim();
	if (!raw) return [];
	const bound = Math.max(50, Number(limit) || DEFAULT_CHUNK_LIMIT);
	if (raw.length <= bound) return [raw];

	const lines = raw.split("\n");
	const chunks = [];
	let currentLines = [];
	let currentLen = 0;
	let activeFence = null;

	function flushChunk() {
		if (currentLines.length === 0) return;
		if (activeFence) {
			// Close fence for this chunk
			const closing = `${activeFence.delimiter}\n`;
			currentLines.push(activeFence.delimiter);
			chunks.push(currentLines.join("\n"));
			// Reopen fence for next chunk
			currentLines = [`${activeFence.delimiter}${activeFence.info}`];
			currentLen = currentLines[0].length + 1;
		} else {
			chunks.push(currentLines.join("\n"));
			currentLines = [];
			currentLen = 0;
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineLen = line.length + 1; // including \n

		// Check fence toggles
		if (activeFence) {
			if (closesFence(line, activeFence)) {
				activeFence = null;
			}
		} else {
			const open = openingFence(line);
			if (open) {
				activeFence = open;
			}
		}

		if (currentLen + lineLen > bound) {
			// If a single line exceeds the bound, split raw
			if (currentLines.length === 0) {
				const parts = splitRawText(line, bound - (activeFence ? 20 : 0));
				for (let p = 0; p < parts.length; p++) {
					currentLines.push(parts[p]);
					if (p < parts.length - 1) flushChunk();
				}
				currentLen = currentLines.join("\n").length + 1;
				continue;
			}

			flushChunk();
		}

		currentLines.push(line);
		currentLen += lineLen;
	}

	if (currentLines.length > 0) {
		chunks.push(currentLines.join("\n"));
	}

	return chunks;
}
