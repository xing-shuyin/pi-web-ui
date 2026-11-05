/**
 * 悬空 toolCall 检测与修复（issue #280、issue #332）。
 *
 * 背景：流式中模型卡死 → 工具看门狗 abort 无效 → forceResetConversation
 * dispose 在飞运行时并从磁盘重建。内存里未落盘的工具结果静默蒸发，
 * 会话文件尾留下一个「有调用、无结果」的悬空 toolCall；重建后继续
 * prompt 会把非法转录链喂给 provider——请求有发起迹象但零落盘、零报错，
 * 用户在往黑洞里打字。
 *
 * 缺陷与收紧（issue #332）：
 * 不能将全文件所有找不到 toolResult 的调用一律视为悬空并追加合成结果：
 * 1. 上线检查：若 assistant 的 stopReason 是 "error" 或 "aborted"，
 *    pi 在发送给 provider 前会丢弃该 assistant（transformMessages）。
 *    该调用属于永不上线的幽灵调用，补合成结果反而会构造出没有前置 tool_calls
 *    的孤儿 role: "tool"，导致 provider 400（DeepSeek/OpenAI Responses 等）；
 * 2. 分支检查：会话文件由树状结构追加存储，老分支被遗弃的 toolCall 不在当前分支上；
 *    若在文件尾（当前活跃分支末尾）追加老分支调用的合成结果，也会制造孤儿 toolResult。
 *    因此落盘修复必须沿当前活跃分支（lastId 开始回溯）定位尾部生效 assistant。
 *
 * 本模块：
 * - findDanglingToolCalls：纯函数，消息/条目数组里找「有调用、无后继结果」的 toolCall；
 * - tailAssistantToolCallIds：沿当前分支回溯，定位尾部会上线的 assistant 的 toolCallId 集合；
 * - healDanglingToolCallFile：落盘版，仅针对当前分支尾部生效的悬空调用追加合成 toolResult；
 * - 合成结果文案：danglingToolResultText(cause)（按成因归因，中英各一，toolResult content 只带一条文本）。
 */
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * 合成结果的归因（issue #574）：悬空调用的「成因」决定文案内容。
 * - restart：本次是服务重启把在飞的工具调用腰斩（pi-web-ui 自己知道，见 resumeInterrupted）；
 * - generic：成因不确定（工具超时 / 模型流卡死 / 服务中断 / /reload 都可能）。
 * 两种文案都提醒「可能已部分或全部执行」，避免模型把它当成「没执行过」去重跑带副作用的命令。
 */
export type DanglingCause = "restart" | "generic";

const DANGLING_TEXT: Record<DanglingCause, { zh: string; en: string }> = {
	generic: {
		zh: "（系统：上一次运行未正常结束（可能是工具执行超时、模型流卡死或服务中断），该工具调用没有返回结果。为避免对话记录损坏，已自动填入一条合成结果。该命令可能已部分或全部执行，若需重跑请先确认是否会产生重复副作用。）",
		en: "(System: the previous run did not finish cleanly (possibly a tool timeout, a hung model stream, or a service interruption) and this tool call never returned. A synthetic result was inserted automatically to keep the transcript valid. The command may have partly or fully run; confirm before re-running anything with side effects.)",
	},
	restart: {
		zh: "（系统：上一次运行因服务重启被中断，该工具调用没有返回结果——它可能已经执行过。为避免对话记录损坏，已自动填入一条合成结果。重跑前请先确认是否会产生重复副作用（如删除、部署、推送）。）",
		en: "(System: the previous run was interrupted by a service restart and this tool call never returned — it may already have executed. A synthetic result was inserted automatically to keep the transcript valid. Confirm before re-running anything with side effects such as deletes, deploys or pushes.)",
	},
};

/** 合成 toolResult 的文本（中英各一，content 只带一条文本）。 */
export function danglingToolResultText(cause: DanglingCause = "generic"): string {
	const t = DANGLING_TEXT[cause];
	return `${t.zh}\n${t.en}`;
}

export interface DanglingToolCall {
	toolCallId: string;
	toolName: string;
}

interface ContentBlock {
	type?: unknown;
	id?: unknown;
	name?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
}

function toolCallsOfMessage(msg: unknown): DanglingToolCall[] {
	if (typeof msg !== "object" || msg === null) return [];
	const m = msg as { role?: unknown; content?: unknown; stopReason?: unknown };
	if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
	if (m.stopReason === "error" || m.stopReason === "aborted") return [];
	const out: DanglingToolCall[] = [];
	for (const b of m.content as ContentBlock[]) {
		if (typeof b !== "object" || b === null || b.type !== "toolCall") continue;
		const id = typeof b.id === "string" ? b.id : "";
		if (!id) continue;
		const name = typeof b.name === "string" && b.name ? b.name : "unknown";
		out.push({ toolCallId: id, toolName: name });
	}
	return out;
}

function toolResultIdsOfMessage(msg: unknown): Set<string> {
	const ids = new Set<string>();
	if (typeof msg !== "object" || msg === null) return ids;
	const m = msg as { role?: unknown; toolCallId?: unknown; content?: unknown };
	if (m.role === "toolResult" && typeof m.toolCallId === "string") ids.add(m.toolCallId);
	// 兼容：个别版本把结果放在 content 块里。
	if (Array.isArray(m.content)) {
		for (const b of m.content as ContentBlock[]) {
			if (typeof b !== "object" || b === null) continue;
			if ((b.type === "toolResult" || b.type === "tool_result") && typeof b.toolCallId === "string") {
				ids.add(b.toolCallId);
			}
		}
	}
	return ids;
}

function messagesOfEntries(entries: unknown[]): unknown[] {
	return entries.map((e) => {
		if (typeof e === "object" && e !== null && "message" in e) {
			const msg = (e as { message?: unknown }).message;
			if (typeof msg === "object" && msg !== null && "role" in msg) return msg;
		}
		return e;
	});
}

/**
 * 找悬空 toolCall：出现过调用、但之后没有任何 toolResult 与之配对的。
 * 输入既可以是 Message[]（内存 agent.state.messages），也可以是
 * SessionManager entry[]（带 { message } 包装的落盘条目）——统一按顺序扫。
 */
export function findDanglingToolCalls(messagesOrEntries: unknown[]): DanglingToolCall[] {
	const messages = messagesOfEntries(messagesOrEntries);
	const calls: { call: DanglingToolCall; index: number }[] = [];
	const results = new Map<string, number[]>();
	messages.forEach((msg, index) => {
		for (const c of toolCallsOfMessage(msg)) calls.push({ call: c, index });
		for (const id of toolResultIdsOfMessage(msg)) {
			let arr = results.get(id);
			if (!arr) {
				arr = [];
				results.set(id, arr);
			}
			arr.push(index);
		}
	});
	const out: DanglingToolCall[] = [];
	const seen = new Set<string>();
	for (const { call, index } of calls) {
		const later = (results.get(call.toolCallId) ?? []).some((ri) => ri > index);
		if (!later && !seen.has(call.toolCallId)) {
			seen.add(call.toolCallId);
			out.push(call);
		}
	}
	return out;
}

/**
 * 沿当前分支从 lastId 往前回溯，定位当前分支尾部生效 assistant 的 toolCallId 集合（issue #332）。
 *
 * 两个守卫条件：
 * 1. 分支检查：严格沿 parentId 链回溯，老分支（不在当前分支路径上）的条目绝不纳入，
 *    避免在当前分支尾部追加针对老分支调用的合成结果而制造孤儿 toolResult；
 * 2. 上线检查：若遇到的 assistant 是 stopReason: "error" | "aborted"，
 *    说明该 assistant 已被中断/报错，pi 在发送给模型前会直接跳过丢弃它（transformMessages），
 *    其 toolCall 属于绝不上线的幽灵调用，必须跳过且绝不能为其补结果。
 *
 * 此外，若在回溯中遇到了 user 消息，说明当前尾部已经退出该回合（例如最新是 user 消息），
 * 绝不能跨过 user 消息去为更早的 assistant 补 toolResult，应立即停止。
 */
export function tailAssistantToolCallIds(entries: unknown[], lastId: string | null): Set<string> {
	if (!lastId) return new Set();
	const byId = new Map<string, unknown>();
	for (const e of entries) {
		if (typeof e === "object" && e !== null && typeof (e as { id?: unknown }).id === "string") {
			byId.set((e as { id: string }).id, e);
		}
	}
	const seen = new Set<string>();
	let cursor: string | null = lastId;
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		const entry = byId.get(cursor);
		if (!entry || typeof entry !== "object") break;
		const msg =
			"message" in entry && typeof (entry as { message?: unknown }).message === "object"
				? (entry as { message: unknown }).message
				: null;
		if (msg && typeof msg === "object" && "role" in msg) {
			const m = msg as { role?: unknown; stopReason?: unknown };
			if (m.role === "user") {
				// 跨入更早的用户回合，尾部无正在等待结果的 assistant
				break;
			}
			if (m.role === "assistant") {
				if (m.stopReason !== "error" && m.stopReason !== "aborted") {
					return new Set(toolCallsOfMessage(m).map((c) => c.toolCallId));
				}
				// 尾部最新 assistant 处于 aborted/error 状态，幽灵调用不上线；且不可越过它去修更早回合
				break;
			}
		}
		cursor =
			typeof (entry as { parentId?: unknown }).parentId === "string" ? (entry as { parentId: string }).parentId : null;
	}
	return new Set();
}

/**
 * 落盘修复：向会话文件尾追加合成 toolResult（仅针对当前分支尾部生效的悬空调用），
 * parentId 链式接在当前尾行之后。append-only——历史字节不动，无需备份。
 * 返回追加条数（0 = 健康，无需处理；-1 = 文件不可读/不可写）。
 */
export function healDanglingToolCallFile(filePath: string, cause: DanglingCause = "generic"): number {
	// 健康指纹命中：文件自上次判定"无悬空调用"后 mtime/size 未变，结果必然仍为 0，
	// 跳过整文件同步读取（打开大转录时这是阻塞事件循环的主要来源之一）。
	let sig: string | null = null;
	try {
		const st = statSync(filePath);
		sig = `${st.mtimeMs}:${st.size}`;
		if (isDanglingHealthyCached(filePath, sig)) return 0;
	} catch {
		return -1;
	}
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return -1;
	}
	const result = healDanglingToolCallsInText(filePath, raw, cause);
	if (result === 0 && sig) rememberHealthyDangling(filePath, sig);
	else healthyDanglingCache.delete(filePath);
	return result;
}

/** 已判定无悬空调用的文件指纹（filePath -> `${mtimeMs}:${size}`，LRU）。 */
const healthyDanglingCache = new Map<string, string>();
const HEALTHY_DANGLING_CACHE_MAX = 512;

/** 指纹命中即续期（LRU）。 */
export function isDanglingHealthyCached(filePath: string, sig: string): boolean {
	if (healthyDanglingCache.get(filePath) !== sig) return false;
	healthyDanglingCache.delete(filePath);
	healthyDanglingCache.set(filePath, sig);
	return true;
}

export function rememberHealthyDangling(filePath: string, sig: string): void {
	healthyDanglingCache.delete(filePath);
	healthyDanglingCache.set(filePath, sig);
	while (healthyDanglingCache.size > HEALTHY_DANGLING_CACHE_MAX) {
		const oldest = healthyDanglingCache.keys().next();
		if (oldest.done) break;
		healthyDanglingCache.delete(oldest.value);
	}
}

export function forgetHealthyDangling(filePath: string): void {
	healthyDanglingCache.delete(filePath);
}

/** 测试用：清空健康指纹缓存。 */
export function resetHealthyDanglingCacheForTest(): void {
	healthyDanglingCache.clear();
}

/** 长行只取开头的这段做头字段提取（type/id/parentId 在 SDK 落盘格式里总是最前面几个键）。 */
const HEADER_SCAN_CHARS = 260;
/** 不超过此长度的行直接完整解析（成本可忽略）。 */
const FULL_PARSE_MAX_LINE = 512;

interface LineHeader {
	id: string | null;
	parentId: string | null;
	/** 已完整解析的条目（短行或头字段提取失败时）；null = 仅提取了头字段。 */
	entry: Record<string, unknown> | null;
}

function parseLineFully(line: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(line);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * 取一行的 id / parentId。长行（数十 KB~数 MB 的工具输出、图片）只扫开头一小段：
 * 要求 id 与 parentId 都出现在第一个嵌套 `{` 之前，确保匹配的是顶层键；否则回退完整解析。
 * 返回 null = 该行不是合法 JSON 对象（脏行，SDK 加载时同样跳过）。
 */
function lineHeader(line: string): LineHeader | null {
	if (line.length > FULL_PARSE_MAX_LINE) {
		const head = line.slice(0, HEADER_SCAN_CHARS);
		const brace = head.indexOf("{", 1);
		const topLevel = brace === -1 ? head : head.slice(0, brace);
		if (topLevel.startsWith("{")) {
			const idMatch = /"id"\s*:\s*"([^"\\]+)"/.exec(topLevel);
			const parentStr = /"parentId"\s*:\s*"([^"\\]*)"/.exec(topLevel);
			const parentNull = !parentStr && /"parentId"\s*:\s*null/.test(topLevel);
			if (idMatch && (parentStr || parentNull)) {
				return { id: idMatch[1], parentId: parentStr ? parentStr[1] : null, entry: null };
			}
		}
	}
	const entry = parseLineFully(line);
	if (!entry) return null;
	return {
		id: typeof entry.id === "string" ? entry.id : null,
		parentId: typeof entry.parentId === "string" ? entry.parentId : null,
		entry,
	};
}

/**
 * 在转录文本上检测并落盘修复当前分支尾部的悬空 toolCall（语义同原全量版本）。
 *
 * 按需解析：先只取每行的 id/parentId（长行只扫行首），再沿 parentId 从尾部回溯，
 * 只完整解析回溯经过的行与尾部 assistant 之后的行。健康长转录（最常见：尾部是
 * 没有工具调用的 assistant 或 user）因此只需完整解析末尾几行，而不是逐行 JSON.parse
 * 整个文件。
 *
 * 与全量版本等价性：某个 toolCallId 悬空 ⇔ 存在一次出现之后没有对应结果。尾部
 * assistant 之前的同名调用若缺后继结果，尾部那次必然也缺，所以只看尾部 assistant
 * 及其之后的行即可得到相同集合。
 *
 * 返回追加条数（0 = 健康；-1 = 写入失败）。
 */
export function healDanglingToolCallsInText(filePath: string, raw: string, cause: DanglingCause = "generic"): number {
	const lines = raw.split("\n");
	const headers: (LineHeader | null)[] = new Array(lines.length).fill(null);
	const byId = new Map<string, number>();
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		const h = lineHeader(line);
		headers[i] = h;
		// 同名 id：后出现者覆盖（与全量版本 Map.set 语义一致）
		if (h?.id) byId.set(h.id, i);
	}
	const fullEntry = (i: number): Record<string, unknown> | null => {
		const h = headers[i];
		if (!h) return null;
		if (!h.entry) h.entry = parseLineFully(lines[i]);
		return h.entry;
	};

	// lastId = 文件里最后一条「能解析且带字符串 id」的条目。头字段提取不验证整行 JSON，
	// 崩溃残留的半截尾行可能被误认，所以这里从尾部往前逐行完整解析确认。
	let lastId: string | null = null;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!headers[i]) continue;
		const e = fullEntry(i);
		if (!e) {
			headers[i] = null;
			continue;
		}
		if (typeof e.id === "string") {
			lastId = e.id;
			break;
		}
	}
	if (!lastId) return 0;

	// 沿当前分支回溯，定位尾部生效 assistant（规则同 tailAssistantToolCallIds）。
	let tailIndex = -1;
	let tailIds = new Set<string>();
	const seen = new Set<string>();
	let cursor: string | null = lastId;
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		const idx = byId.get(cursor);
		if (idx === undefined) break;
		const entry = fullEntry(idx);
		if (!entry) break;
		const msg = typeof entry.message === "object" && entry.message !== null ? entry.message : null;
		if (msg && "role" in msg) {
			const m = msg as { role?: unknown; stopReason?: unknown };
			if (m.role === "user") break;
			if (m.role === "assistant") {
				if (m.stopReason !== "error" && m.stopReason !== "aborted") {
					tailIds = new Set(toolCallsOfMessage(m).map((c) => c.toolCallId));
					tailIndex = idx;
				}
				break;
			}
		}
		cursor = typeof entry.parentId === "string" ? entry.parentId : null;
	}
	if (tailIds.size === 0 || tailIndex < 0) return 0;

	const after: unknown[] = [];
	for (let i = tailIndex; i < lines.length; i++) {
		const e = fullEntry(i);
		if (e) after.push(e);
	}
	const dangling = findDanglingToolCalls(after).filter((d) => tailIds.has(d.toolCallId));
	if (dangling.length === 0) return 0;
	try {
		let parentId = lastId;
		for (const d of dangling) {
			const id = `synthetic-tool-result-${randomUUID().slice(0, 8)}`;
			const entry = {
				type: "message",
				id,
				parentId,
				timestamp: new Date().toISOString(),
				message: {
					role: "toolResult",
					toolCallId: d.toolCallId,
					toolName: d.toolName,
					content: [{ type: "text", text: danglingToolResultText(cause) }],
					isError: true,
					timestamp: Date.now(),
				},
			};
			const line = JSON.stringify(entry);
			if (!existsSync(filePath)) return -1;
			appendFileSync(filePath, `${line}\n`, "utf8");
			parentId = id;
		}
		return dangling.length;
	} catch {
		return -1;
	}
}
