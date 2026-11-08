import { extractSessionIdFromPath } from "./session-url";

/**
 * 左栏会话身份单源。
 *
 * 「运行中对话」（conversations 通道）和「历史会话」（sessions 通道）指的常常是同一批会话，
 * 客户端必须把它们认成同一条，否则同一条会话会在左栏出现两行（会话行 + 历史行）。
 * 认身份只允许走这里，不要在组件里另写 file:/sid:/conv: 之类的临时键。
 *
 * 身份键（命名空间互不混淆）：
 * - `conv:` 对话 id。引擎把会话 id 直接当 path 用时（universal 底座的 claude / codex）单靠它就够。
 * - `sid:`  会话 id。显式 sessionId，或从 `<时间戳>_<uuid>.jsonl` 文件名推导出的 uuid。
 * - `file:` 归一化后的会话文件路径。
 *
 * 裸 token（不含目录分隔符）的 path 视为会话 id：universal 底座就是这种形态，
 * 这样即使引擎漏发 sessionId 也不会重复。
 */
export interface SessionIdentitySource {
	id?: string | null;
	sessionId?: string | null;
	sessionFile?: string | null;
	path?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const normalizePath = (value: string | null | undefined): string =>
	value ? value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : "";

const isTranscriptPath = (value: string): boolean => value.endsWith(".jsonl");

/** 会话身份是否来自规范文件名（`<时间戳>_<uuid>.jsonl`）；泛化文件名的推导不可信，不参与判等。 */
function transcriptSessionId(file: string): string | null {
	if (!isTranscriptPath(file)) return null;
	const derived = extractSessionIdFromPath(file)?.trim() ?? "";
	return UUID.test(derived) ? derived.toLowerCase() : null;
}

/** 强身份键：参与去重，也参与运行态关联。 */
export function sessionIdentityKeys(source: SessionIdentitySource): string[] {
	const keys: string[] = [];
	const conversationId = source.id?.trim();
	if (conversationId) keys.push(`conv:${conversationId.replace(/\\/g, "/").toLowerCase()}`);
	const explicitId = source.sessionId?.trim();
	if (explicitId) keys.push(`sid:${explicitId.toLowerCase()}`);
	const file = normalizePath(source.sessionFile || source.path);
	if (file) {
		keys.push(`file:${file}`);
		const derived = transcriptSessionId(file);
		if (derived) keys.push(`sid:${derived}`);
		else if (!file.includes("/")) keys.push(`conv:${file}`);
	}
	return [...new Set(keys)];
}

/**
 * 弱身份键：只用于关联运行态（状态点、未读、停止按钮）。
 * `fn:`（裸文件名）不进强键集合——不同目录可能同名，用它去重会误吞历史行。
 */
export function sessionLookupKeys(source: SessionIdentitySource): string[] {
	const keys = sessionIdentityKeys(source);
	const file = normalizePath(source.sessionFile || source.path);
	const fileName = file.split("/").pop();
	return fileName ? [...keys, `fn:${fileName}`] : keys;
}

/** 按键查表的小索引：多键指向同一条会话，后写覆盖先写。 */
export class SessionIdentityIndex<T> {
	private readonly items = new Map<string, T>();

	add(source: SessionIdentitySource, value: T, keys = sessionIdentityKeys(source)): T {
		for (const key of keys) this.items.set(key, value);
		return value;
	}

	get(source: SessionIdentitySource, keys = sessionIdentityKeys(source)): T | undefined {
		for (const key of keys) {
			const hit = this.items.get(key);
			if (hit !== undefined) return hit;
		}
		return undefined;
	}

	has(source: SessionIdentitySource): boolean {
		return this.get(source) !== undefined;
	}

	get size(): number {
		return this.items.size;
	}
}
