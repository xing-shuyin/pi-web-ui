export interface NoticeLike {
	id: number;
	level: "info" | "warning" | "error";
	text: string;
	textEn?: string;
}

export const MAX_VISIBLE_NOTICES = 2;

export function getNoticeDurationMs(level: NoticeLike["level"]): number {
	switch (level) {
		case "error":
			return 6500;
		case "warning":
			return 4200;
		case "info":
		default:
			return 2400;
	}
}

const SUPPRESSED_INFO_PATTERNS: readonly RegExp[] = [
	/^(已在工作目录|正在切换到工作目录|已切换到工作目录)[：:]/,
	/^(Already in directory|Switching to directory|Switched to directory):/i,
	/该项目最近的对话.*(为你停在了空白新对话|为你停在了新对话)/,
	/The most recent conversation .* landed on a (blank|new) chat/i,

	/^分层上下文预算裁剪生效/,
	/^Tiered context budget pruning/i,
	/^发现 \d+ 个内置插件有更新可用/,
	/^\d+ built-in plugin\(s\) have updates available/i,

	/^已(创建文件|创建文件夹|重命名|删除|移动|复制)[：:]/,
	/^(Created file|Created folder|Renamed|Deleted|Moved|Copied):/i,

	/^已重命名当前会话为/,
	/^Renamed current session to/i,
	/的消息正在投递，已为你保留该对话$/,
	/is still sending your message — kept in the running list$/i,

	/^(计划模式已开启|计划模式已关闭|已进入计划模式|已退出计划模式|审查者模式已开启|审查者模式已关闭)/,
	/^(Plan mode (enabled|disabled)|Entered plan mode|Exited plan mode|Delegate mode (enabled|disabled))/i,
	/^已切换(智能体预设|权限预设)/,
	/^Switched (agent|permission) preset/i,
];

export function shouldSuppressNotice(notice: Pick<NoticeLike, "level" | "text" | "textEn">): boolean {
	if (notice.level !== "info") return false;
	const zh = (notice.text ?? "").trim();
	const en = (notice.textEn ?? "").trim();
	return SUPPRESSED_INFO_PATTERNS.some((re) => (zh && re.test(zh)) || (en && re.test(en)));
}

export function enqueueNotice<T extends NoticeLike>(
	current: readonly T[],
	incoming: T,
	maxVisible: number = MAX_VISIBLE_NOTICES,
): T[] {
	if (shouldSuppressNotice(incoming)) {
		return current as T[];
	}
	const incomingKey = `${incoming.level}:${(incoming.text ?? "").trim()}`;
	const deduped = current.filter((n) => `${n.level}:${(n.text ?? "").trim()}` !== incomingKey);
	const next = [...deduped, incoming];
	while (next.length > maxVisible) {
		const nonErrorIdx = next.findIndex((n) => n.level !== "error");
		if (nonErrorIdx >= 0) {
			next.splice(nonErrorIdx, 1);
		} else {
			next.shift();
		}
	}
	return next;
}
