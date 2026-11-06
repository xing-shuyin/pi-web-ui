function argsOfBlock(blk: { arguments?: unknown; input?: unknown; args?: unknown }): unknown {
	if (typeof blk.arguments !== "undefined") return blk.arguments;
	if (typeof blk.input !== "undefined") return blk.input;
	return blk.args;
}

export function toolCallRefsOfContent(content: unknown): { name: string; args?: unknown }[] {
	if (!Array.isArray(content)) return [];
	const out: { name: string; args?: unknown }[] = [];
	for (const b of content) {
		if (!b || typeof b !== "object") continue;
		const blk = b as { type?: unknown; name?: unknown; arguments?: unknown; input?: unknown; args?: unknown };
		if (blk.type !== "toolCall" || typeof blk.name !== "string" || !blk.name) continue;
		const args = argsOfBlock(blk);
		if (typeof args === "undefined") out.push({ name: blk.name });
		else out.push({ name: blk.name, args });
	}
	return out;
}

export interface TouchableMessage {
	role: string;
	content?: unknown;
	command?: string;
	output?: string;
	timestamp?: number;
	toolCalls?: { name: string; args?: unknown }[] | undefined | null;
}

export function toolCallsOf(m: TouchableMessage | null | undefined): { name: string; args?: unknown }[] {
	if (!m || typeof m !== "object") return [];
	if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
		return m.toolCalls.filter(
			(t): t is { name: string; args?: unknown } =>
				!!t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string",
		);
	}
	return toolCallRefsOfContent(m.content);
}

const WRITE_TOOL_NAMES = new Set(["edit", "write", "edit_soft"]);

function pathOfWriteArgs(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const a = args as { path?: unknown; file_path?: unknown; filePath?: unknown };
	for (const k of ["path", "file_path", "filePath"] as const) {
		const v = a[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return undefined;
}

export function normalizeTouchPath(p: string): string {
	let s = p.trim().replace(/\\/g, "/");
	while (s.startsWith("./")) s = s.slice(2);
	return s;
}

export function patchWriteTargets(patchText: string): string[] {
	const out: string[] = [];
	for (const m of patchText.matchAll(/^\s*\[([^#\]\r\n]+)(?:#[0-9A-Fa-f]{4})?\]\s*$/gm)) {
		out.push(m[1].trim());
	}
	for (const m of patchText.matchAll(/^\s*MV\s+(\S+)/gim)) out.push(m[1]);
	return out;
}

export interface TouchedFile {
	path: string;
	count: number;
	lastTs: number;
}

function tokenizeShell(cmd: string): string[] {
	const toks: string[] = [];
	let cur = "";
	let quote: string | null = null;
	let i = 0;
	const push = () => {
		if (cur !== "") {
			toks.push(cur);
			cur = "";
		}
	};
	while (i < cmd.length) {
		const ch = cmd[i];
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < cmd.length) {
				cur += cmd[i + 1];
				i += 2;
				continue;
			}
			if (ch === quote) quote = null;
			else cur += ch;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < cmd.length) {
			cur += cmd[i + 1];
			i += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
			push();
			i++;
			continue;
		}
		const three = cmd.slice(i, i + 3);
		const two = cmd.slice(i, i + 2);
		if (/^\d>>/.test(three) || three === "<<<") {
			push();
			toks.push(three);
			i += 3;
			continue;
		}
		if (two === ">>" || two === "<<" || two === "&&" || two === "||" || /^\d>$/.test(two) || /^\d</.test(two)) {
			push();
			toks.push(two);
			i += 2;
			continue;
		}
		if (ch === ">" || ch === "<" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
			push();
			toks.push(ch);
			i++;
			continue;
		}
		cur += ch;
		i++;
	}
	push();
	return toks;
}

const SEGMENT_SEPS = new Set([";", "&&", "||", "|", "&", "(", ")"]);
const WRAPPER_WORDS = new Set(["sudo", "env", "command", "time", "nohup", "doas"]);
const MULTI_TARGET_WRITES = new Set(["rm", "rmdir", "mkdir", "touch"]);
const DEST_ONLY_WRITES = new Set(["cp", "mv"]);
function isNonFileTarget(t: string): boolean {
	if (t === "/dev/null" || t.toLowerCase() === "nul") return true;
	if (/^&\d*$/.test(t)) return true;
	if (t === "-") return true;
	return false;
}

export function bashWriteTargets(command: string): string[] {
	if (typeof command !== "string" || !command.trim()) return [];
	const toks = tokenizeShell(command);
	const out: string[] = [];
	let cmd: string | null = null;
	let pendingMulti: string[] = [];
	let pendingDest: string | null = null;
	let afterDoubleDash = false;
	let skipNext = false;
	const flush = () => {
		out.push(...pendingMulti);
		if (pendingDest !== null) out.push(pendingDest);
		pendingMulti = [];
		pendingDest = null;
	};
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (SEGMENT_SEPS.has(t)) {
			flush();
			cmd = null;
			afterDoubleDash = false;
			continue;
		}
		if (/^(\d*)(>>?)$/.test(t) || t === "<<" || t === "<<<" || /^(\d*)<<<?$/.test(t)) {
			const next = toks[i + 1];
			if (typeof next !== "undefined" && !SEGMENT_SEPS.has(next)) {
				if (t.includes(">") && !isNonFileTarget(next)) out.push(next);
				skipNext = true;
			}
			continue;
		}
		if (t === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (cmd === null) {
			if (WRAPPER_WORDS.has(t)) continue;
			if (t.includes("=") && !t.startsWith("-")) continue;
			cmd = t;
			if (cmd === "xargs") cmd = "\0xargs-opaque";
			continue;
		}
		if (cmd === "\0xargs-opaque") continue;
		if (!afterDoubleDash && t.startsWith("-") && t.length > 1) continue;
		if (MULTI_TARGET_WRITES.has(cmd)) pendingMulti.push(t);
		else if (DEST_ONLY_WRITES.has(cmd)) pendingDest = t;
	}
	flush();
	return out.filter((p) => p !== "" && !isNonFileTarget(p));
}

export interface ExtractTouchesOpts {
	maxMessages?: number;
}

export function extractTouches(
	messages: readonly TouchableMessage[] | undefined | null,
	opts?: ExtractTouchesOpts,
): TouchedFile[] {
	if (!Array.isArray(messages) || messages.length === 0) return [];
	const max = Math.max(1, Math.floor(opts?.maxMessages ?? 500));
	const slice = messages.slice(Math.max(0, messages.length - max));
	const acc = new Map<string, { count: number; lastTs: number }>();
	const bump = (raw: string, ts: number) => {
		const path = normalizeTouchPath(raw);
		if (!path) return;
		const e = acc.get(path);
		if (e) {
			e.count++;
			if (ts > e.lastTs) e.lastTs = ts;
		} else {
			acc.set(path, { count: 1, lastTs: ts });
		}
	};
	for (const m of slice) {
		if (!m || typeof m !== "object") continue;
		const ts = typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : 0;
		for (const call of toolCallsOf(m)) {
			const name = call.name;
			if (name === "patch") {
				const args = call.args as { patch?: unknown } | undefined;
				if (args && typeof args.patch === "string") {
					for (const p of patchWriteTargets(args.patch)) bump(p, ts);
				}
				continue;
			}
			if (WRITE_TOOL_NAMES.has(name)) {
				const p = pathOfWriteArgs(call.args);
				if (p) bump(p, ts);
				continue;
			}
			if (name === "bash" && call.args && typeof call.args === "object") {
				const c = (call.args as { command?: unknown }).command;
				if (typeof c === "string") {
					for (const p of bashWriteTargets(c)) bump(p, ts);
				}
			}
		}
		if (m.role === "bashExecution" && typeof m.command === "string") {
			for (const p of bashWriteTargets(m.command)) bump(p, ts);
		}
	}
	return [...acc.entries()]
		.map(([path, e]) => ({ path, count: e.count, lastTs: e.lastTs }))
		.sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
}

export function unionTouchLists(a: TouchedFile[], b: TouchedFile[]): TouchedFile[] {
	const acc = new Map<string, { count: number; lastTs: number }>();
	for (const f of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
		if (!f || typeof f.path !== "string") continue;
		const e = acc.get(f.path);
		const count = typeof f.count === "number" && Number.isFinite(f.count) ? f.count : 0;
		const lastTs = typeof f.lastTs === "number" && Number.isFinite(f.lastTs) ? f.lastTs : 0;
		if (e) {
			if (count > e.count) e.count = count;
			if (lastTs > e.lastTs) e.lastTs = lastTs;
		} else {
			acc.set(f.path, { count, lastTs });
		}
	}
	return [...acc.entries()]
		.map(([path, e]) => ({ path, count: e.count, lastTs: e.lastTs }))
		.sort((x, y) => y.count - x.count || y.lastTs - x.lastTs);
}

export function intersectTouches(a: TouchedFile[], b: TouchedFile[]): TouchedFile[] {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return [];
	const inB = new Set(b.map((f) => f.path));
	return a.filter((f) => inB.has(f.path));
}

export function formatTouchEntry(f: TouchedFile, perItemCap = 60): string {
	const full = f.count > 1 ? `${f.path} ×${f.count}` : f.path;
	if (full.length <= perItemCap) return full;
	return f.path;
}

export interface FormatTouchesOpts {
	maxItems?: number;
	perItemCap?: number;
}

export function formatTouchesCompact(files: TouchedFile[], opts?: FormatTouchesOpts): string {
	if (!Array.isArray(files) || files.length === 0) return "";
	const maxItems = Math.max(1, Math.floor(opts?.maxItems ?? 3));
	const cap = Math.max(10, Math.floor(opts?.perItemCap ?? 60));
	const shown = files.slice(0, maxItems).map((f) => formatTouchEntry(f, cap));
	if (files.length > maxItems) shown.push(`… (+${files.length - maxItems})`);
	return shown.join("、");
}
