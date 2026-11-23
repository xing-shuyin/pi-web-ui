import { promises as fsPromises } from "node:fs";
import { join } from "node:path";
import { mapSessionsConcurrent } from "../../../session-scan.js";
import { scanSessionListInfo, type SessionListInfo, type SessionListScanState } from "../../../session-list-scan.js";
import { compareText } from "./order.js";

/** 磁盘历史条目：`SessionListInfo` 在域内的窄面，只留列表要用的字段。 */
export interface HistoryEntry {
	id: string;
	title: string;
	cwd: string;
	updatedAt: number;
	sessionFile: string;
	/** 会话里的消息条数（`sessions` 帧要原样带着，老列表靠它判「空会话」）。 */
	messageCount: number;
}

export interface ScanHistoryInput {
	/** 某个项目的会话目录（只读这一层里的 `*.jsonl`）。 */
	root: string;
	/** 上一轮留下的续扫状态（`sessionFile → state`），命中就只读新增部分；没有就整份扫。 */
	state?: ReadonlyMap<string, SessionListScanState>;
	/** 最多返回多少条（按 `updatedAt` 降序取前 N）；不给就全量。 */
	limit?: number;
}

export interface ScanHistoryResult {
	entries: HistoryEntry[];
	/** 本轮每个文件的续扫状态，下次原样作为 `state` 传回来即可增量续扫。 */
	states: Map<string, SessionListScanState>;
	/** 目录不存在 / 不可读：调用方据此区分「真没有历史」与「这次没读到」。 */
	skipped: boolean;
}

interface ScannedFile {
	entry: HistoryEntry;
	state: SessionListScanState;
}

function entryOf(info: SessionListInfo): HistoryEntry {
	return {
		id: info.id,
		title: info.name?.trim() || info.firstMessage.trim() || info.id,
		cwd: info.cwd,
		updatedAt: info.modified.getTime(),
		sessionFile: info.path,
		// 老索引里读回来的扫描状态可能没有这个字段：缺了就按 0 条算，别出 `undefined`。
		messageCount: info.messageCount ?? 0,
	};
}

async function scanFile(file: string, prev?: SessionListScanState): Promise<ScannedFile | null> {
	let mtime: number;
	try {
		mtime = (await fsPromises.stat(file)).mtimeMs;
	} catch {
		return null;
	}
	const scanned = await scanSessionListInfo(file, mtime, prev);
	if (!scanned?.info) return null;
	return { entry: entryOf(scanned.info), state: scanned.state };
}

/**
 * 项目历史会话列表的薄封装：枚举目录 → 逐个 `scanSessionListInfo` → 映射成 `HistoryEntry`。
 * 扫描规则、增量续扫、坏行容错都在 `session-list-scan.ts`，这里只做枚举 / 映射 / 排序。
 */
export async function scanHistory(input: ScanHistoryInput): Promise<ScanHistoryResult> {
	const states = new Map<string, SessionListScanState>();
	let names: string[];
	try {
		names = await fsPromises.readdir(input.root);
	} catch {
		return { entries: [], states, skipped: true };
	}
	const files = names
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(input.root, name))
		.sort();
	const scanned = await mapSessionsConcurrent(files, (file) => scanFile(file, input.state?.get(file)));
	const entries: HistoryEntry[] = [];
	for (const item of scanned) {
		if (!item) continue;
		entries.push(item.entry);
		// 续扫状态不受 limit 影响：这一轮没返回的文件下一轮照样能续扫。
		states.set(item.entry.sessionFile, item.state);
	}
	entries.sort((a, b) =>
		a.updatedAt === b.updatedAt ? compareText(a.sessionFile, b.sessionFile) : b.updatedAt - a.updatedAt,
	);
	const cap = input.limit === undefined ? entries.length : Math.max(0, Math.floor(input.limit));
	return { entries: entries.slice(0, cap), states, skipped: false };
}
