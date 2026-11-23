import { promises as fsPromises } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { setImmediate } from "node:timers/promises";
import { classifyTranscriptLine, type TranscriptLineMeta } from "./compaction-markers.js";

/** 分片粒度：一片大约 1 ms 的工作量，片间让出事件循环（单次停顿与文件大小无关） */
const CHUNK_BYTES = 512 * 1024;

export type TranscriptScanReason =
	"clean" | "pending-marker" | "duplicate-id" | "cycle" | "branch-order" | "unreadable";

export interface TranscriptScanResult {
	/** true = 文件未变的前提下修复必然不动文件（打开可以跳过整份 readFile） */
	clean: boolean;
	reason: TranscriptScanReason;
}

/**
 * 只保留 `(id, parentId, markerKind)` 元数据的扫描状态。
 *
 * 打开大会话时把全部 entry 实体攒在内存里是堆峰值的主因（issue #945），这里每个条目只留
 * 两个短字符串 + 若干 id 集合：内存随条目数线性，与条目正文大小无关。
 */
class TranscriptScanState {
	reason: TranscriptScanReason | null = null;
	/** 非 header 条目：id → parentId */
	private readonly entries = new Map<string, string | null>();
	/** 出现过的 parentId（用来算叶子：id 不在其中即为叶子） */
	private readonly parents = new Set<string>();
	/** 文件头（session）条目的 id，只参与查重 */
	private readonly headerIds = new Set<string>();
	private tailId: string | null = null;
	private sawEntry = false;
	private headerAfterEntry = false;

	/** 返回 true = 已能判定「必须整份修复」，可以提前结束扫描 */
	accept(line: string): boolean {
		const meta: TranscriptLineMeta = classifyTranscriptLine(line);
		if (!meta.entity || meta.id === null) return false;
		const id = meta.id;
		if (this.entries.has(id) || this.headerIds.has(id)) {
			this.reason = "duplicate-id";
			return true;
		}
		if (meta.header) {
			this.headerIds.add(id);
			if (this.sawEntry) this.headerAfterEntry = true;
			return false;
		}
		if (meta.marker === "pending") {
			this.reason = "pending-marker";
			return true;
		}
		this.sawEntry = true;
		this.entries.set(id, meta.parentId);
		if (meta.parentId !== null) this.parents.add(meta.parentId);
		this.tailId = id;
		return false;
	}

	verdict(): TranscriptScanResult {
		if (this.reason) return { clean: false, reason: this.reason };
		if (this.headerAfterEntry) return { clean: false, reason: "branch-order" };
		if (this.entries.size === 0) return { clean: true, reason: "clean" };
		if (this.hasCycle()) return { clean: false, reason: "cycle" };
		let leaf: string | null = null;
		let leaves = 0;
		for (const id of this.entries.keys()) {
			if (this.parents.has(id)) continue;
			leaves += 1;
			leaf = id;
			if (leaves > 1) break;
		}
		// 唯一叶子恰好是最后一条 ⇒ selectBestSessionLeaf 直接给出 changed=false，
		// reorderEntriesForMainBranch 在拿到全部 entry 实体之前就返回（无需遍历整个文件）。
		if (leaves === 1 && leaf === this.tailId) return { clean: true, reason: "clean" };
		return { clean: false, reason: "branch-order" };
	}

	private hasCycle(): boolean {
		const completed = new Set<string>();
		for (const [id, parent] of this.entries) {
			if (completed.has(id)) continue;
			const seen = new Set<string>([id]);
			let cur = parent;
			while (cur !== null && !completed.has(cur)) {
				if (seen.has(cur)) return true;
				seen.add(cur);
				const next = this.entries.get(cur);
				if (next === undefined) break;
				cur = next;
			}
			for (const s of seen) completed.add(s);
		}
		return false;
	}
}

/**
 * 打开前判定：`repairSessionTranscript` 这次会不会改文件（issue #945）。
 *
 * 流式按行扫描、逐行套同一个行分类口径（`classifyTranscriptLine`），不保留任何 entry 实体；
 * 判定条件与修复本体一致：pending 压缩标记、重复 id、父链成环、以及「叶子不是最后一条」
 * （分支顺序需要重排）。只有能证明「修复必然无操作」时才返回 `clean: true`，
 * 其余一律保守回退到整份读取。
 */
export async function scanTranscriptForRepair(filePath: string): Promise<TranscriptScanResult> {
	let fh: fsPromises.FileHandle;
	try {
		fh = await fsPromises.open(filePath, "r");
	} catch {
		return { clean: false, reason: "unreadable" };
	}
	try {
		const state = new TranscriptScanState();
		const decoder = new StringDecoder("utf8");
		/** 跨 chunk 的残行（永远只是最后一段，不会重拼整个文件） */
		let pending: string[] = [];
		let pos = 0;
		const feed = (text: string): boolean => {
			let start = 0;
			let nl: number;
			while ((nl = text.indexOf("\n", start)) !== -1) {
				const piece = text.slice(start, nl);
				const line = pending.length > 0 ? pending.join("") + piece : piece;
				pending = [];
				if (state.accept(line)) return false;
				start = nl + 1;
			}
			if (start < text.length) pending.push(text.slice(start));
			return true;
		};
		for (;;) {
			const buf = Buffer.allocUnsafe(CHUNK_BYTES);
			const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, pos);
			if (bytesRead === 0) break;
			pos += bytesRead;
			if (!feed(decoder.write(buf.subarray(0, bytesRead)))) {
				return { clean: false, reason: state.reason as TranscriptScanReason };
			}
			await setImmediate();
		}
		feed(decoder.end());
		if (pending.length > 0) state.accept(pending.join(""));
		return state.verdict();
	} catch {
		return { clean: false, reason: "unreadable" };
	} finally {
		await fh.close().catch(() => {});
	}
}
