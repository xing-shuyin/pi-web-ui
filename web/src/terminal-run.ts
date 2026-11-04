/// <reference lib="dom" />

/**
 * 终端代码执行辅助模块：
 * 统一处理代码块命令提取、提示符清洗、Tab 标题提炼以及向终端派发运行事件。
 */

/**
 * 清洗代码块中的命令行提示符并规范化换行：
 * - 剥离每行开头的常见提示符（`$ `, `> `, `% `）；
 * - 统一换行符为 `\n`；
 * - 去除首尾空白行。
 */
export function normalizeTerminalCommand(code: string): string {
	const trimmed = code.trim();
	if (!trimmed) return "";
	const lines = trimmed.split(/\r?\n/);
	const cleaned = lines.map((line) => line.replace(/^\s*[$%>]\s+/, ""));
	return cleaned.join("\n").trim();
}

/**
 * 从清洗后的代码块中提取适合作为终端 Tab 标题的简短文本：
 * 1. 优先提取第一行非空且非纯注释（# 或 //）的命令行；
 * 2. 若全为注释或无法提取，则回退到第一行非空文本；
 * 3. 超过 28 个字符时优雅截断并追加省略号，防止 Tab 标题撑破布局。
 */
export function deriveTerminalTitle(cleanedCode: string): string {
	const lines = cleanedCode
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	if (lines.length === 0) return "";
	const commandLine = lines.find((l) => !l.startsWith("#") && !l.startsWith("//")) ?? lines[0];
	return commandLine.length > 28 ? commandLine.slice(0, 25).trimEnd() + "…" : commandLine;
}

/**
 * 派发全局事件将命令发送到终端中执行：
 * 触发 App.tsx 中统一的终端生命周期管理（新建或复用已有 Tab、选择该 Tab 并切换到终端视图）。
 *
 * @param command 待执行的代码块命令原文
 * @param customTitle 可选的自定义终端 Tab 标题
 * @returns 是否成功派发事件
 */
export function runInTerminal(command: string, customTitle?: string): boolean {
	if (typeof window === "undefined") return false;
	const cleaned = normalizeTerminalCommand(command);
	if (!cleaned) return false;
	const title = customTitle || deriveTerminalTitle(cleaned);
	window.dispatchEvent(
		new CustomEvent("pi-web-ui:plugin-run-command", {
			detail: {
				title,
				command: cleaned,
			},
		}),
	);
	return true;
}
