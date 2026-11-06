export interface DiffWordToken {
	type: "same" | "add" | "del";
	text: string;
}

export interface DiffLine {
	type: "add" | "del" | "context" | "header";
	oldLineNum?: number;
	newLineNum?: number;
	content: string;
	tokens?: DiffWordToken[];
}

export interface DiffHunk {
	header: string;
	lines: DiffLine[];
}

export interface FileDiffStats {
	additions: number;
	deletions: number;
	totalLines?: number;
	isNewFile?: boolean;
}

export interface FileDiffData {
	filePath: string;
	toolName: string;
	isWrite: boolean;
	language: string;
	stats: FileDiffStats;
	hunks: DiffHunk[];
	content?: string;
	isStreamingPartial?: boolean;
}

const EXT_LANG_MAP: Record<string, string> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	html: "html",
	htm: "html",
	css: "css",
	scss: "scss",
	less: "less",
	py: "python",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
	md: "markdown",
	sql: "sql",
	xml: "xml",
	svg: "svg",
};

export function detectLanguage(filePath?: string): string {
	if (!filePath) return "plaintext";
	const ext = filePath.split(".").pop()?.toLowerCase();
	return (ext && EXT_LANG_MAP[ext]) || "plaintext";
}

const TOKEN_SPLIT_REGEX = /\s+|[a-zA-Z0-9_$]+|[^\s\w]/g;

export function unescapeJsonString(text: string): string {
	if (!text) return "";
	return text.replace(/\\([nrtbfv\\/"]|u[0-9a-fA-F]{4})/g, (_, escapeSeq: string) => {
		switch (escapeSeq) {
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "b":
				return "\b";
			case "f":
				return "\f";
			case "v":
				return "\v";
			case "\\":
				return "\\";
			case "/":
				return "/";
			case '"':
				return '"';
			default:
				if (escapeSeq.startsWith("u")) {
					try {
						return String.fromCharCode(parseInt(escapeSeq.slice(1), 16));
					} catch {
						return `\\${escapeSeq}`;
					}
				}
				return `\\${escapeSeq}`;
		}
	});
}

export function computeWordDiff(
	oldText: string,
	newText: string,
): { oldTokens: DiffWordToken[]; newTokens: DiffWordToken[] } {
	if (!oldText || !newText || oldText.length > 800 || newText.length > 800) {
		return {
			oldTokens: [{ type: "del", text: oldText }],
			newTokens: [{ type: "add", text: newText }],
		};
	}

	const oldWords = oldText.match(TOKEN_SPLIT_REGEX) || [oldText];
	const newWords = newText.match(TOKEN_SPLIT_REGEX) || [newText];

	const n = oldWords.length;
	const m = newWords.length;

	if (n * m > 4000) {
		return {
			oldTokens: [{ type: "del", text: oldText }],
			newTokens: [{ type: "add", text: newText }],
		};
	}

	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			if (oldWords[i - 1] === newWords[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	const commonCount = dp[n][m];
	const maxLen = Math.max(n, m);
	if (maxLen > 0 && commonCount / maxLen < 0.25) {
		return {
			oldTokens: [{ type: "del", text: oldText }],
			newTokens: [{ type: "add", text: newText }],
		};
	}

	const oldTokens: DiffWordToken[] = [];
	const newTokens: DiffWordToken[] = [];

	let i = n;
	let j = m;
	const oldAcc: DiffWordToken[] = [];
	const newAcc: DiffWordToken[] = [];

	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
			oldAcc.push({ type: "same", text: oldWords[i - 1] });
			newAcc.push({ type: "same", text: newWords[j - 1] });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			newAcc.push({ type: "add", text: newWords[j - 1] });
			j--;
		} else if (i > 0) {
			oldAcc.push({ type: "del", text: oldWords[i - 1] });
			i--;
		}
	}

	oldAcc.reverse();
	newAcc.reverse();

	for (const token of oldAcc) {
		const last = oldTokens[oldTokens.length - 1];
		if (last && last.type === token.type) {
			last.text += token.text;
		} else {
			oldTokens.push({ ...token });
		}
	}
	for (const token of newAcc) {
		const last = newTokens[newTokens.length - 1];
		if (last && last.type === token.type) {
			last.text += token.text;
		} else {
			newTokens.push({ ...token });
		}
	}

	return { oldTokens, newTokens };
}

const SDK_DISPLAY_DIFF_RE = /^([+\- ])(\s*\d+)?\s(.*)$/;

export function parseUnifiedDiffText(diffText: string): { hunks: DiffHunk[]; stats: FileDiffStats } {
	const hunks: DiffHunk[] = [];
	let currentHunk: DiffHunk | null = null;
	let additions = 0;
	let deletions = 0;

	let oldLine = 1;
	let newLine = 1;

	const rawLines = diffText.split("\n");

	let pendingDels: DiffLine[] = [];
	let pendingAdds: DiffLine[] = [];

	const flushWordDiff = () => {
		if (pendingDels.length === 1 && pendingAdds.length === 1) {
			const { oldTokens, newTokens } = computeWordDiff(pendingDels[0].content, pendingAdds[0].content);
			pendingDels[0].tokens = oldTokens;
			pendingAdds[0].tokens = newTokens;
		}
		pendingDels = [];
		pendingAdds = [];
	};

	const ensureHunk = (header = "@@ Changes @@") => {
		if (!currentHunk) {
			currentHunk = {
				header,
				lines: [],
			};
			hunks.push(currentHunk);
		}
		return currentHunk;
	};

	for (const raw of rawLines) {
		if (raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("===") || raw.startsWith("Index:")) {
			continue;
		}

		if (raw.startsWith("@@")) {
			flushWordDiff();
			const match = /@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@(.*)/.exec(raw);
			if (match) {
				oldLine = parseInt(match[1], 10);
				newLine = parseInt(match[2], 10);
			}
			currentHunk = {
				header: raw.trim(),
				lines: [],
			};
			hunks.push(currentHunk);
			continue;
		}

		if (/^\s+\.\.\.\s*$/.test(raw)) {
			flushWordDiff();
			currentHunk = {
				header: "@@ ... @@",
				lines: [],
			};
			hunks.push(currentHunk);
			continue;
		}

		const sdkMatch = SDK_DISPLAY_DIFF_RE.exec(raw);
		if (sdkMatch) {
			const prefix = sdkMatch[1];
			const numStr = sdkMatch[2] ? sdkMatch[2].trim() : undefined;
			const explicitLineNum = numStr ? parseInt(numStr, 10) : undefined;
			const text = sdkMatch[3];

			const hunk = ensureHunk();

			if (prefix === "+") {
				additions++;
				const lineNum = explicitLineNum ?? newLine++;
				const line: DiffLine = {
					type: "add",
					newLineNum: lineNum,
					content: text,
				};
				hunk.lines.push(line);
				pendingAdds.push(line);
			} else if (prefix === "-") {
				deletions++;
				const lineNum = explicitLineNum ?? oldLine++;
				const line: DiffLine = {
					type: "del",
					oldLineNum: lineNum,
					content: text,
				};
				hunk.lines.push(line);
				pendingDels.push(line);
			} else {
				flushWordDiff();
				const lineNum = explicitLineNum ?? oldLine++;
				if (!explicitLineNum) newLine++;
				const line: DiffLine = {
					type: "context",
					oldLineNum: lineNum,
					newLineNum: lineNum,
					content: text,
				};
				hunk.lines.push(line);
			}
			continue;
		}

		if (raw.length > 0) {
			const prefix = raw[0];
			const text = raw.slice(1);
			const hunk = ensureHunk();

			if (prefix === "+") {
				additions++;
				const line: DiffLine = {
					type: "add",
					newLineNum: newLine++,
					content: text,
				};
				hunk.lines.push(line);
				pendingAdds.push(line);
			} else if (prefix === "-") {
				deletions++;
				const line: DiffLine = {
					type: "del",
					oldLineNum: oldLine++,
					content: text,
				};
				hunk.lines.push(line);
				pendingDels.push(line);
			} else if (prefix === " ") {
				flushWordDiff();
				const line: DiffLine = {
					type: "context",
					oldLineNum: oldLine++,
					newLineNum: newLine++,
					content: text,
				};
				hunk.lines.push(line);
			}
		}
	}

	flushWordDiff();

	return {
		hunks,
		stats: { additions, deletions },
	};
}

export function buildHunksFromEdits(edits: Array<{ oldText?: string; newText?: string }>): {
	hunks: DiffHunk[];
	stats: FileDiffStats;
} {
	const hunks: DiffHunk[] = [];
	let additions = 0;
	let deletions = 0;

	edits.forEach((edit, idx) => {
		const oldText = typeof edit.oldText === "string" ? edit.oldText : "";
		const newText = typeof edit.newText === "string" ? edit.newText : "";

		const oldLines = oldText ? oldText.split("\n") : [];
		const newLines = newText ? newText.split("\n") : [];

		deletions += oldLines.length;
		additions += newLines.length;

		const lines: DiffLine[] = [];

		if (oldLines.length === 1 && newLines.length === 1) {
			const { oldTokens, newTokens } = computeWordDiff(oldLines[0], newLines[0]);
			lines.push({
				type: "del",
				content: oldLines[0],
				tokens: oldTokens,
			});
			lines.push({
				type: "add",
				content: newLines[0],
				tokens: newTokens,
			});
		} else {
			for (const line of oldLines) {
				lines.push({ type: "del", content: line });
			}
			for (const line of newLines) {
				lines.push({ type: "add", content: line });
			}
		}

		hunks.push({
			header: `@@ Hunk #${idx + 1} (${oldLines.length} lines -> ${newLines.length} lines) @@`,
			lines,
		});
	});

	return {
		hunks,
		stats: { additions, deletions },
	};
}

export function parseFileMutationArgs(
	toolName: string,
	argsText?: string,
	details?: unknown,
	output?: string,
): FileDiffData | null {
	const isWrite = toolName === "write";
	const isEdit = toolName === "edit" || toolName === "edit_soft" || toolName === "patch";

	if (!isWrite && !isEdit) {
		return null;
	}

	let path = "";
	let isStreamingPartial = false;

	let parsedArgs: Record<string, unknown> | null = null;
	if (argsText) {
		try {
			parsedArgs = JSON.parse(argsText) as Record<string, unknown>;
			if (typeof parsedArgs.path === "string") {
				path = parsedArgs.path;
			} else if (typeof parsedArgs.file_path === "string") {
				path = parsedArgs.file_path;
			}
		} catch {
			isStreamingPartial = true;
			const match = /"(?:path|file_path|filePath)"\s*:\s*"((?:[^"\\\n]|\\.){0,2000})"/.exec(argsText);
			if (match) {
				try {
					path = JSON.parse(`"${match[1]}"`) as string;
				} catch {
					path = match[1];
				}
			}
		}
	}

	if (!path && output) {
		const outMatch =
			/(?:Successfully (?:wrote to|replaced \d+ block\(s\) in)|written to|Created)\s+([^\s\n\r"']+)/i.exec(output);
		if (outMatch) {
			path = outMatch[1].trim();
		}
	}

	const language = detectLanguage(path);

	if (isWrite) {
		let content = "";
		if (parsedArgs && typeof parsedArgs.content === "string") {
			content = parsedArgs.content;
		} else if (argsText) {
			const contentMatch = /"content"\s*:\s*"/i.exec(argsText);
			if (contentMatch) {
				const start = contentMatch.index + contentMatch[0].length;
				let rawSlice = argsText.slice(start);
				const nextKeyMatch = /",\s*"(?:path|file_path|filePath)"/i.exec(rawSlice);
				if (nextKeyMatch) {
					rawSlice = rawSlice.slice(0, nextKeyMatch.index);
				} else {
					rawSlice = rawSlice.replace(/\s*(?:\.\.\.\s*\[truncated\])?\s*"?\s*}?\s*$/, "");
				}
				content = unescapeJsonString(rawSlice);
			} else {
				content = unescapeJsonString(argsText);
			}
		}

		const totalLines = content ? content.split("\n").length : 0;
		return {
			filePath: path,
			toolName,
			isWrite: true,
			language,
			content,
			isStreamingPartial,
			stats: {
				additions: totalLines,
				deletions: 0,
				totalLines,
				isNewFile: true,
			},
			hunks: [],
		};
	}

	const detailsPatch =
		details && typeof details === "object" && typeof (details as { patch?: unknown }).patch === "string"
			? (details as { patch: string }).patch
			: undefined;

	if (detailsPatch) {
		const res = parseUnifiedDiffText(detailsPatch);
		if (res.hunks.length > 0 && res.hunks.some((h) => h.lines.length > 0)) {
			return {
				filePath: path,
				toolName,
				isWrite: false,
				language,
				stats: res.stats,
				hunks: res.hunks,
				isStreamingPartial: false,
			};
		}
	}

	const detailsDiff =
		details && typeof details === "object" && typeof (details as { diff?: unknown }).diff === "string"
			? (details as { diff: string }).diff
			: undefined;

	if (detailsDiff) {
		const res = parseUnifiedDiffText(detailsDiff);
		if (res.hunks.length > 0 && res.hunks.some((h) => h.lines.length > 0)) {
			return {
				filePath: path,
				toolName,
				isWrite: false,
				language,
				stats: res.stats,
				hunks: res.hunks,
				isStreamingPartial: false,
			};
		}
	}

	let edits: Array<{ oldText?: string; newText?: string }> = [];
	if (parsedArgs && Array.isArray(parsedArgs.edits)) {
		edits = parsedArgs.edits as Array<{ oldText?: string; newText?: string }>;
	}

	if (edits.length > 0) {
		const { hunks, stats } = buildHunksFromEdits(edits);
		return {
			filePath: path,
			toolName,
			isWrite: false,
			language,
			stats,
			hunks,
			isStreamingPartial,
		};
	}

	return {
		filePath: path,
		toolName,
		isWrite: false,
		language,
		stats: { additions: 0, deletions: 0 },
		hunks: [],
		isStreamingPartial: true,
	};
}
