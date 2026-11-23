import type { UiMessage } from "../../protocol.js";
import { serializeMessage } from "../../serialize.js";
import type { AnySessionEntry } from "../../session-branch.js";
import { buildSessionTranscript, projectSessionText, type SessionTranscript } from "../../session-projection.js";

/** 一份转录投影后的可见面：已序列化、按条目顺序排列、id 稳定。 */
export interface TranscriptProjection {
	messages: UiMessage[];
}

export interface ProjectionResult {
	projection: TranscriptProjection;
	/** 选出的叶；空转录或整份不可用时为 null。 */
	leafId: string | null;
	/** 没贡献任何消息的输入条数：坏 jsonl 行 + 序列化为 null 的消息；整份不可用时为全部非空行。 */
	skippedLines: number;
}

/** jsonl 一行一条，解析器只跳过空行与 JSON 坏行（与 `parseSessionEntries` 同口径，这里只数不改解析）。 */
function countLines(text: string): { nonBlank: number; unparsable: number } {
	let nonBlank = 0;
	let unparsable = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		nonBlank += 1;
		try {
			JSON.parse(line);
		} catch {
			unparsable += 1;
		}
	}
	return { nonBlank, unparsable };
}

/**
 * 投影 → 序列化消息。条目顺序就是投影顺序（叶链根→叶、压缩感知、`context_edit` 已应用），
 * 域内不重排。
 *
 * `seq` 只参与 id（`uiMessageId` 拼「消息时间戳-seq」），并且只随真正产出的消息递增：
 * 同一份输入两次投影得到同一串 id，不取 `Date.now()`，也不生成随机 id。
 */
function projectOf(transcript: SessionTranscript, startSeq: number): ProjectionResult {
	const messages: UiMessage[] = [];
	let seq = startSeq;
	let skippedLines = 0;
	for (const entry of transcript.entries) {
		for (const message of entry.messages) {
			const ui = serializeMessage(message, seq);
			if (!ui) {
				skippedLines += 1;
				continue;
			}
			messages.push(ui);
			seq += 1;
		}
	}
	return { projection: { messages }, leafId: transcript.leafId, skippedLines };
}

function unavailable(skippedLines: number): ProjectionResult {
	return { projection: { messages: [] }, leafId: null, skippedLines };
}

/**
 * 整份 jsonl 文本 → 投影。坏行只丢该行（`skippedLines` 计数），投影本身抛错时退化成空投影，不抛。
 */
export function projectTranscriptText(text: string, opts?: { seq?: number }): ProjectionResult {
	const { nonBlank, unparsable } = countLines(text);
	try {
		const result = projectOf(projectSessionText(text), opts?.seq ?? 0);
		return { ...result, skippedLines: result.skippedLines + unparsable };
	} catch {
		return unavailable(nonBlank);
	}
}

/** 已解析条目 → 投影（历史检索等已经拿到条目的场景，不再回读文件）。 */
export function projectTranscriptEntries(entries: readonly unknown[]): ProjectionResult {
	try {
		return projectOf(buildSessionTranscript(entries as AnySessionEntry[]), 0);
	} catch {
		return unavailable(entries.length);
	}
}
