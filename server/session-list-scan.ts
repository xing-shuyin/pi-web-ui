/**
 * 会话列表元信息扫描（左栏历史列表用）：字节级、可增量。
 *
 * 与 parseSessionInfoFast（列表模式）提取相同字段、同一套规则：
 * - session 头：id / cwd / timestamp / parentSession；session_info：最后一个非空 name；
 * - message：计数、最大 message.timestamp、第一条用户消息文本；
 * - 已拿到 id 与首条用户消息后，超过 512 字节、且不含 "session_info" 的长行不做 JSON.parse，
 *   只看行首判断是否 message 并取第一个数值型 "timestamp"。
 *
 * 相对原实现的改进：
 * 1. 按字节读取、按换行字节切行（UTF-8 中 0x0A 不会出现在多字节序列里），长行走快路径时
 *    完全不解码成字符串、也不经过逐字符的 base64 过滤器；
 * 2. 增量：记录最后一个完整行之后的字节偏移与两处指纹（文件头 + 偏移前一小段）。会话文件是
 *    追加写入的，再次扫描时若两处指纹未变，只解析新增的字节；文件被改写（链修复、截断等）
 *    指纹不符则整份重扫。末尾未写完的半行计入本次结果但不推进偏移，下次随完整行重读。
 */
import { promises as fsPromises } from "node:fs";
import { setImmediate } from "node:timers/promises";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

const CHUNK_BYTES = 64 * 1024;
const FAST_PATH_MIN_BYTES = 512;
const HEAD_SIG_BYTES = 128;
const TAIL_SIG_BYTES = 64;
/** 需要完整解析的超长行先剔除内嵌 base64（"data":"…"），避免把图片载荷解析成对象。 */
const STRIP_DATA_MIN_CHARS = 64 * 1024;
const DATA_VALUE_RE = /"data"\s*:\s*"(?:[^"\\]|\\.)*"/g;

export interface SessionListScanState {
	/** 已完整消费到的字节偏移（最后一个换行之后）。 */
	offset: number;
	headSig: string;
	tailSig: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	headerTime: number;
	firstMessage: string;
	messageCount: number;
	lastActivityTime: number;
}

const COLON = 0x3a;
const TIMESTAMP_KEY = Buffer.from('"timestamp"');
const SESSION_INFO_KEY = Buffer.from('"session_info"');
const MESSAGE_TYPE_RE = /"type"\s*:\s*"message"/;

function isWs(b: number): boolean {
	return b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a;
}

/** 等价于 /"timestamp"\s*:\s*(\d{10,16})/.exec(line) 的第一个匹配，直接在字节上找。 */
function firstNumericTimestamp(line: Buffer): number | null {
	let from = 0;
	for (;;) {
		const k = line.indexOf(TIMESTAMP_KEY, from);
		if (k < 0) return null;
		let i = k + TIMESTAMP_KEY.length;
		while (i < line.length && isWs(line[i]!)) i++;
		if (line[i] === COLON) {
			i++;
			while (i < line.length && isWs(line[i]!)) i++;
			let j = i;
			while (j < line.length && j - i < 16 && line[j]! >= 0x30 && line[j]! <= 0x39) j++;
			if (j - i >= 10) return Number(line.toString("latin1", i, j));
		}
		from = k + 1;
	}
}

function messageText(msg: Record<string, unknown>): string {
	if (typeof msg.content === "string") return msg.content;
	let text = "";
	if (Array.isArray(msg.content)) {
		for (const part of msg.content as { text?: unknown }[]) {
			if (part && typeof part.text === "string") text += (text ? " " : "") + part.text;
		}
	}
	return text;
}

function isBlank(line: Buffer): boolean {
	for (let i = 0; i < line.length; i++) if (!isWs(line[i]!)) return false;
	return true;
}

type Fields = Omit<SessionListScanState, "offset" | "headSig" | "tailSig">;

function applyLine(line: Buffer, st: Fields): void {
	if (line.length === 0 || isBlank(line)) return;
	if (st.id && st.firstMessage && line.length > FAST_PATH_MIN_BYTES && line.indexOf(SESSION_INFO_KEY) < 0) {
		const head = line.toString("utf8", 0, 140);
		if (MESSAGE_TYPE_RE.test(head)) {
			st.messageCount++;
			const ts = firstNumericTimestamp(line);
			if (ts !== null && ts > st.lastActivityTime) st.lastActivityTime = ts;
		}
		return;
	}
	let text = line.toString("utf8");
	if (text.length > STRIP_DATA_MIN_CHARS) text = text.replace(DATA_VALUE_RE, '"data":""');
	let rec: Record<string, unknown> | null;
	try {
		rec = JSON.parse(text) as Record<string, unknown> | null;
	} catch {
		return;
	}
	if (!rec || typeof rec !== "object") return;
	if (rec.type === "session") {
		st.id = typeof rec.id === "string" ? rec.id : "";
		st.cwd = typeof rec.cwd === "string" ? rec.cwd : "";
		if (typeof rec.timestamp === "string") st.headerTime = new Date(rec.timestamp).getTime();
		if (typeof rec.parentSession === "string") st.parentSessionPath = rec.parentSession;
	} else if (rec.type === "session_info") {
		if (typeof rec.name === "string" && rec.name.trim()) st.name = rec.name.trim();
	} else if (rec.type === "message") {
		st.messageCount++;
		const msg = rec.message as Record<string, unknown> | null;
		if (msg && typeof msg === "object") {
			if (typeof msg.timestamp === "number") st.lastActivityTime = Math.max(st.lastActivityTime, msg.timestamp);
			if (!st.firstMessage && msg.role === "user") {
				const t = messageText(msg);
				if (t) st.firstMessage = t;
			}
		}
	}
}

function emptyFields(): Fields {
	return { id: "", cwd: "", headerTime: 0, firstMessage: "", messageCount: 0, lastActivityTime: 0 };
}

async function readSig(fh: fsPromises.FileHandle, position: number, length: number): Promise<string> {
	if (length <= 0 || position < 0) return "";
	const buf = Buffer.allocUnsafe(length);
	const { bytesRead } = await fh.read(buf, 0, length, position);
	return buf.toString("base64", 0, bytesRead);
}

function toInfo(filePath: string, fileMtime: number, f: Fields): SessionInfo | null {
	if (!f.id) return null;
	const modified = f.lastActivityTime > 0 ? f.lastActivityTime : f.headerTime > 0 ? f.headerTime : fileMtime;
	return {
		path: filePath,
		id: f.id,
		cwd: f.cwd,
		name: f.name,
		parentSessionPath: f.parentSessionPath,
		created: new Date(f.headerTime || fileMtime),
		modified: new Date(modified),
		messageCount: f.messageCount,
		firstMessage: f.firstMessage || "(no messages)",
		allMessagesText: "",
	};
}

export interface SessionListScanResult {
	info: SessionInfo | null;
	state: SessionListScanState;
	/** 本次实际解析的起始偏移（0 = 全量；> 0 = 增量）。 */
	resumedFrom: number;
}

/**
 * 扫描会话文件的列表元信息。`prev` 为上次扫描的状态：文件只是被追加时，从上次偏移继续；
 * 否则整份重扫。返回 null 仅在文件不可读时。
 */
export async function scanSessionListInfo(
	filePath: string,
	fileMtime: number,
	prev?: SessionListScanState,
): Promise<SessionListScanResult | null> {
	let fh: fsPromises.FileHandle;
	try {
		fh = await fsPromises.open(filePath, "r");
	} catch {
		return null;
	}
	try {
		const size = (await fh.stat()).size;
		const headSig = await readSig(fh, 0, Math.min(HEAD_SIG_BYTES, size));
		let start = 0;
		let fields = emptyFields();
		if (prev && prev.offset > 0 && prev.offset <= size && prev.headSig === headSig) {
			const tailLen = Math.min(TAIL_SIG_BYTES, prev.offset);
			const tailSig = await readSig(fh, prev.offset - tailLen, tailLen);
			if (tailSig === prev.tailSig) {
				start = prev.offset;
				const { offset: _o, headSig: _h, tailSig: _t, ...rest } = prev;
				fields = { ...rest };
			}
		}

		let pos = start;
		let committed = start;
		let pending: Buffer[] = [];
		for (;;) {
			const buf = Buffer.allocUnsafe(CHUNK_BYTES);
			const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, pos);
			if (bytesRead === 0) break;
			const view = buf.subarray(0, bytesRead);
			let s = 0;
			let nl: number;
			while ((nl = view.indexOf(0x0a, s)) !== -1) {
				const piece = view.subarray(s, nl);
				const line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
				pending = [];
				applyLine(line, fields);
				committed = pos + nl + 1;
				s = nl + 1;
			}
			if (s < bytesRead) pending.push(view.subarray(s));
			pos += bytesRead;
			await setImmediate();
		}

		const tailLen = Math.min(TAIL_SIG_BYTES, committed);
		const state: SessionListScanState = {
			...fields,
			offset: committed,
			headSig,
			tailSig: await readSig(fh, committed - tailLen, tailLen),
		};
		// 末尾未写完的半行：计入本次结果，但不进入可续扫状态（下次随完整行重读）
		let resultFields = fields;
		if (pending.length > 0) {
			resultFields = { ...fields };
			applyLine(Buffer.concat(pending), resultFields);
		}
		return { info: toInfo(filePath, fileMtime, resultFields), state, resumedFrom: start };
	} catch {
		return null;
	} finally {
		await fh.close().catch(() => {});
	}
}
