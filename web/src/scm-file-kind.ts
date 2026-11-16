/**
 * Git 面板的状态判定单源。
 *
 * `git status --porcelain` 的 x / y 两位只允许在这里解释：文件分组、提交摘要里的文件数与行数、
 * 批量按钮的 disabled 判定全部走这里，避免每个组件各写一份 `x !== " "` 的临时判断
 * （历史上 SCMPanel 里就散着好几处）。纯函数，无 React、无 IO，可直接单测。
 */

export interface ScmFileLike {
	path: string;
	x: string;
	y: string;
}

/** GitHub Desktop 的四个语义：未跟踪 / 仅暂存 / 仅工作区改动 / 两者都有。 */
export type ScmFileKind = "staged" | "unstaged" | "untracked" | "both";

export function scmFileKind(f: ScmFileLike): ScmFileKind {
	if (f.x === "?" && f.y === "?") return "untracked";
	const staged = f.x !== " " && f.x !== "?";
	const unstaged = f.y !== " " && f.y !== "?";
	if (staged && unstaged) return "both";
	if (staged) return "staged";
	return "unstaged";
}

/** 是否进「已暂存」列表：x 位有标记（staged + both，后者表示暂存后又被改过）。 */
export function scmInStagedList(f: ScmFileLike): boolean {
	const kind = scmFileKind(f);
	return kind === "staged" || kind === "both";
}

/** 是否进「更改」列表：工作区还有内容（unstaged / untracked / both）。 */
export function scmInChangesList(f: ScmFileLike): boolean {
	const kind = scmFileKind(f);
	return kind === "unstaged" || kind === "untracked" || kind === "both";
}

export interface ScmChangeLists<T> {
	staged: T[];
	unstaged: T[];
}

/** 同一个文件可能同时出现在两组（both），与 GitHub Desktop 一致：分组只表达"能不能点勾"。 */
export function splitScmFiles<T extends ScmFileLike>(files: readonly T[]): ScmChangeLists<T> {
	const staged: T[] = [];
	const unstaged: T[] = [];
	for (const f of files) {
		if (scmInStagedList(f)) staged.push(f);
		if (scmInChangesList(f)) unstaged.push(f);
	}
	return { staged, unstaged };
}

/** 行首那一个字母：合并成单字符状态位，优先显示暂存位。 */
export function scmStatusLetter(f: ScmFileLike): string {
	const code = f.x !== " " && f.x !== "?" ? f.x : f.y;
	if (!code || code === " " || code === "?") return "U";
	return code;
}

export interface ScmStatLike {
	add: number;
	del: number;
}

export interface ScmStatSummary {
	count: number;
	add: number;
	del: number;
}

/** 提交摘要用的统计：只累加传入的那批文件（通常就是"已暂存"那组）。 */
export function sumScmStats<T extends ScmFileLike>(
	files: readonly T[],
	stats: ReadonlyMap<string, ScmStatLike>,
): ScmStatSummary {
	let add = 0;
	let del = 0;
	for (const f of files) {
		const st = stats.get(f.path);
		if (!st) continue;
		add += st.add;
		del += st.del;
	}
	return { count: files.length, add, del };
}
