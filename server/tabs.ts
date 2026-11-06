export const ALL_TABS = ["chat", "terminal", "git", "search", "tasks", "settings", "plugins"] as const;

export type Tab = (typeof ALL_TABS)[number];

const OWNED: Partial<Record<Tab, readonly string[]>> = {
	terminal: [
		"new_cli_chat",
		"terminal_attach",
		"terminal_create",
		"terminal_input",
		"terminal_cli_paste",
		"terminal_cli_control",
		"terminal_resize",
		"terminal_kill",
		"rename_terminal",
		"run_command",
	],
	git: ["scm_status", "scm_history", "scm_filediff", "scm_commit"],
	tasks: ["list_bg_servers", "kill_background_server", "kill_background_servers"],
	search: ["search_files", "search_sessions"],
};

export function parseTabs(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
	const raw = (env.PI_WEB_TABS ?? "").trim();
	if (!raw) return null;
	const tabs = new Set(
		raw
			.split(",")
			.map((t) => t.trim().toLowerCase())
			.filter(Boolean),
	);
	if (tabs.size === 0) return null;
	tabs.add("chat");
	return tabs;
}

export function isTabAllowed(tab: string, tabs: Set<string> | null): boolean {
	if (!tabs) return true;
	if (tab === "chat") return true;
	return tabs.has(tab.toLowerCase());
}

export function tabsRefusal(type: string, tabs: Set<string> | null): string | null {
	if (!tabs) return null;
	for (const [tab, messages] of Object.entries(OWNED) as [Tab, readonly string[]][]) {
		if (!messages.includes(type)) continue;
		if (isTabAllowed(tab, tabs)) return null;
		return `The ${tab} tab is not enabled on this instance (PI_WEB_TABS).`;
	}
	return null;
}
