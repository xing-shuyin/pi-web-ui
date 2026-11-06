/// <reference lib="dom" />

export function normalizeTerminalCommand(code: string): string {
	const trimmed = code.trim();
	if (!trimmed) return "";
	const lines = trimmed.split(/\r?\n/);
	const cleaned = lines.map((line) => line.replace(/^\s*[$%>]\s+/, ""));
	return cleaned.join("\n").trim();
}

export function deriveTerminalTitle(cleanedCode: string): string {
	const lines = cleanedCode
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	if (lines.length === 0) return "";
	const commandLine = lines.find((l) => !l.startsWith("#") && !l.startsWith("//")) ?? lines[0];
	return commandLine.length > 28 ? commandLine.slice(0, 25).trimEnd() + "…" : commandLine;
}

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
