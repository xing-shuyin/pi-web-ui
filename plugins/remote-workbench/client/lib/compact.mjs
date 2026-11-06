const ANSI_REGEX = new RegExp(
	// eslint-disable-next-line no-control-regex
	"[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
	"g",
);

export function stripAnsi(text) {
	if (!text) return "";
	return String(text).replace(ANSI_REGEX, "");
}

/**
 * 清洗并压缩终端文本，专为 LLM 上下文与日志导出设计
 * @param {string} text 原始终端输出
 * @returns {string} 压缩后的纯净输出
 */
export function compact(text) {
	if (!text) return "";
	const s = String(text);

	let cleaned = stripAnsi(s);

	let buf = "";
	for (let i = 0; i < cleaned.length; i++) {
		const code = cleaned.charCodeAt(i);
		if (code < 32 && code !== 13 && code !== 10 && code !== 9) {
			continue;
		}
		if (code === 127) {
			continue;
		}
		buf += cleaned[i];
	}
	cleaned = buf;

	cleaned = cleaned.replace(/\r\n/g, "\n");

	const lines = cleaned.split("\n");
	const result = [];
	for (let line of lines) {
		const lastCr = line.lastIndexOf("\r");
		if (lastCr >= 0) {
			line = line.slice(lastCr + 1);
		}
		line = line.trimEnd();
		result.push(line);
	}
	cleaned = result.join("\n");

	cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

	cleaned = cleaned.trim();

	return cleaned;
}
