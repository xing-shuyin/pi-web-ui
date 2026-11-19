/**
 * 浏览器翻译桥的纯函数：URL 拼接与参数校验。
 * 主进程拿 agentUrl（可能带 token query）拼出 /api/translate，绝不信任页面传来的地址。
 */

export interface TranslateBridgeRequest {
	texts: string[];
	target?: string;
	style?: string;
}

const MAX_TEXTS = 64;
const MAX_TEXT_CHARS = 2_000;
const MAX_TOTAL_CHARS = 16_000;
const TARGETS = new Set(["auto", "zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru", "pt", "it", "tr"]);
const STYLES = new Set(["natural", "literal", "technical"]);

/** 从 Agent URL 派生翻译端点：只保留 origin + token，丢掉 Agent 自己的 path/hash。 */
export function translateEndpoint(agentUrl: string): string {
	const url = new URL(agentUrl);
	const endpoint = new URL("/api/translate", url.origin);
	const token = url.searchParams.get("token");
	if (token) endpoint.searchParams.set("token", token);
	return endpoint.href;
}

/** 校验页面桥请求；非法输入直接拒绝，错误文案不泄露内部细节。 */
export function parseTranslateBridgeRequest(value: unknown): TranslateBridgeRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid translation request");
	const input = value as Record<string, unknown>;
	if (!Array.isArray(input.texts) || !input.texts.length || input.texts.length > MAX_TEXTS)
		throw new Error(`texts must be 1-${MAX_TEXTS} items`);
	let total = 0;
	const texts = input.texts.map((text) => {
		if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_CHARS)
			throw new Error(`Each text must be non-empty and <= ${MAX_TEXT_CHARS} chars`);
		total += text.length;
		return text;
	});
	if (total > MAX_TOTAL_CHARS) throw new Error(`Total text exceeds ${MAX_TOTAL_CHARS} chars`);
	if (input.target !== undefined && !TARGETS.has(String(input.target))) throw new Error("Invalid target language");
	if (input.style !== undefined && !STYLES.has(String(input.style))) throw new Error("Invalid translation style");
	return {
		texts,
		...(input.target !== undefined ? { target: String(input.target) } : {}),
		...(input.style !== undefined ? { style: String(input.style) } : {}),
	};
}
