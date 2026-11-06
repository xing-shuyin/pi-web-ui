import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { pick, type ServerLang } from "../i18n.js";

export interface SessionHeader {
	id?: string;
	cwd?: string;
	createdAt?: number;
	version?: number;
	[key: string]: unknown;
}

export interface SessionLog {
	header: SessionHeader | null;
	events: { type: string; seq: number; time: number; data: Record<string, unknown> }[];
}

export function projectKey(cwd: string): string {
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

function decodeStorageRecord(value: Record<string, unknown>): Record<string, unknown>[] {
	const t = value.type;
	if (t === "text-chunks" || t === "reasoning-chunks" || t === "tool-call-chunks") {
		const { seq0, time0, data } = value as {
			seq0?: number;
			time0?: number;
			data?: {
				texts?: unknown[];
				args?: unknown[];
				index?: number;
				id?: string;
				name?: string;
				turn?: number;
				step?: number;
				dt?: number[];
			};
		};
		if (!data || (!Array.isArray(data.texts) && !Array.isArray(data.args))) {
			return [value];
		}
		const texts = Array.isArray(data.texts) ? data.texts : [];
		const args = Array.isArray(data.args) ? data.args : [];
		const count = t === "tool-call-chunks" ? args.length : texts.length;
		const out: Record<string, unknown>[] = [];
		let time = time0 ?? 0;
		for (let k = 0; k < count; k++) {
			if (k > 0 && Array.isArray(data.dt) && k - 1 < data.dt.length) {
				time += data.dt[k - 1];
			}
			const chunk =
				t === "text-chunks"
					? { type: "text-delta", index: data.index, text: texts[k] }
					: t === "reasoning-chunks"
						? { type: "reasoning-delta", index: data.index, text: texts[k] }
						: {
								type: "tool-call-delta",
								index: data.index,
								id: data.id,
								name: data.name,
								argumentsDelta: args[k],
							};
			out.push({
				type: "assistant/chunk",
				seq: (seq0 ?? 0) + k,
				time,
				data: { turn: data.turn, step: data.step, chunk },
			});
		}
		return out;
	}
	return [value];
}

function zstdDecompressAll(buf: Buffer): string {
	const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
	const starts: number[] = [];
	for (let i = 0; i + 4 <= buf.length; i++) {
		if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
			starts.push(i);
		}
	}
	let out = "";
	let i = 0;
	while (i < starts.length) {
		const from = starts[i];
		let nextIdx = i + 1;
		let decompressed: Buffer | null = null;
		while (nextIdx <= starts.length) {
			const to = nextIdx < starts.length ? starts[nextIdx] : buf.length;
			try {
				decompressed = zstdDecompressSync(buf.subarray(from, to));
				break;
			} catch {
				nextIdx++;
			}
		}
		if (decompressed) {
			out += decompressed.toString("utf8");
			i = nextIdx;
		} else {
			i++;
		}
	}
	return out || buf.toString("utf8");
}

export function sessionLogPermission(log: SessionLog): string | null {
	let selected: string | null = null;
	for (const ev of log.events) {
		if (ev.type === "permission/preset") {
			const id = (ev.data as { preset?: unknown } | undefined)?.preset;
			if (typeof id === "string" && id) selected = id;
		}
	}
	return selected;
}

export function sessionLogPreset(log: SessionLog): string | null {
	let selected: string | null = null;
	for (const ev of log.events) {
		if (ev.type === "agent-preset/selected") {
			const id = (ev.data as { agentPreset?: unknown } | undefined)?.agentPreset;
			if (typeof id === "string" && id) selected = id;
		}
	}
	if (selected) return selected;
	const h = log.header?.agentPreset;
	return typeof h === "string" && h ? h : null;
}

export function readSessionLog(file: string): SessionLog {
	const raw = readFileSync(file);
	const text = file.endsWith(".jsonl.zstd") ? zstdDecompressAll(raw) : raw.toString("utf8");
	const lines = text.split("\n").filter((l) => l.trim());
	let header: SessionHeader | null = null;
	const events: SessionLog["events"] = [];
	for (const line of lines) {
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (!value || typeof value !== "object") continue;
		if (value.type === "session") {
			header = value as unknown as SessionHeader;
			continue;
		}
		for (const ev of decodeStorageRecord(value)) {
			events.push(ev as SessionLog["events"][number]);
		}
	}
	return { header, events };
}

export function findSessionFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.name.endsWith(".jsonl") || e.name.endsWith(".jsonl.zstd")) {
				out.push(full);
			}
		}
	};
	walk(root);
	return out.sort(sessionFileNewest);
}

function sessionFileNewest(a: string, b: string): number {
	try {
		return statSync(b).mtimeMs - statSync(a).mtimeMs;
	} catch {
		return 0;
	}
}

export function findSessionFilesForCwd(sessionRoot: string, cwd: string): string[] {
	const dirs = [join(sessionRoot, projectKey(cwd)), join(sessionRoot, encodeURIComponent(cwd), projectKey(cwd))];
	const out: string[] = [];
	for (const d of dirs) out.push(...findSessionFiles(d));
	return out.sort(sessionFileNewest);
}

export function isDshInternalUserMessage(data: Record<string, unknown> | undefined): boolean {
	if (!data) return false;
	const src = (data.source ?? (data.message as { source?: unknown } | undefined)?.source) as
		{ kind?: string } | undefined;

	if (src && typeof src.kind === "string") {
		return src.kind !== "user";
	}

	const content = (data.content ?? (data.message as { content?: unknown } | undefined)?.content) as
		Array<{ type?: string; text?: string }> | undefined;
	if (Array.isArray(content)) {
		for (const b of content) {
			const text = b?.text;
			if (
				typeof text === "string" &&
				(text.includes("<system-reminder>") ||
					text.includes("<goal_round") ||
					text.includes("<available_skills>") ||
					text.includes("Current runtime context.") ||
					text.includes("Current DSH file policy:") ||
					text.startsWith("Current runtime context"))
			) {
				return true;
			}
		}
	}
	return false;
}

export function firstUserText(events: SessionLog["events"], lang: ServerLang = "en"): string {
	for (const ev of events) {
		if (ev.type === "user/message" && !isDshInternalUserMessage(ev.data)) {
			const blocks = ev.data?.content;
			if (Array.isArray(blocks)) {
				for (const b of blocks) {
					const bb = b as { type?: string; text?: string };
					if (bb?.type === "text" && typeof bb.text === "string" && bb.text.trim()) {
						const clean = bb.text
							.replace(/\n\[(?:文件引用|File reference|上传文件|Uploaded file|图片附件|Image attachment):[\s\S]*$/u, "")
							.trim()
							.replace(/\s+/g, " ");
						const t = clean || bb.text.trim().replace(/\s+/g, " ");
						return t.length > 30 ? `${t.slice(0, 30)}…` : t;
					}
				}
			}
		}
	}
	return pick(lang, "新对话", "New chat", "dsh.sessions.untitled");
}

export function sessionLogTitle(events: SessionLog["events"]): string | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev.type === "session/title") {
			const t = (ev.data as { title?: unknown })?.title;
			if (
				typeof t === "string" &&
				t.trim() &&
				!t.startsWith("chat-") &&
				!t.startsWith("web-") &&
				!t.startsWith("fork-") &&
				t !== "新对话" &&
				t !== "New chat"
			) {
				return t.trim();
			}
		}
	}
	return undefined;
}

import type { UiMessage } from "../protocol.js";
import {
	assistantMessageEventToUiMessage,
	toolResultEventToUiMessage,
	userMessageEventToUiMessage,
} from "./dsh-serialize.js";

export function replayEventsToMessages(events: SessionLog["events"]): UiMessage[] {
	const messages: UiMessage[] = [];
	const seen = new Set<string>();
	for (const ev of events) {
		let msg: UiMessage | null = null;
		if (ev.type === "user/message") {
			if (isDshInternalUserMessage(ev.data)) continue;
			msg = userMessageEventToUiMessage(ev.data as never);
		} else if (ev.type === "assistant/message") {
			msg = assistantMessageEventToUiMessage(ev.data as never);
		} else if (ev.type === "tool/result") {
			msg = toolResultEventToUiMessage(ev.data as never);
		}
		if (msg && !seen.has(msg.id)) {
			seen.add(msg.id);
			messages.push(msg);
		}
	}
	return messages;
}
