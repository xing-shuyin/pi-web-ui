/**
 * SCM 提交树过滤 — 纯函数。
 *
 * 过滤框按空格拆关键字、AND 语义：每条提交的主题 / 作者 / 短短 hash /
 * 完整 hash / 装饰（分支·标签）里只要**逐个关键字**都有命中就保留；
 * 全部不区分大小写。空查询原样返回（不复制数组）。
 */

export interface ScmCommitLike {
	hash: string;
	shortHash: string;
	author: string;
	subject: string;
	decorations?: string;
}

/** 单条提交对一个关键字是否命中（大小写不敏感的子串匹配）。 */
function matchesToken(commit: ScmCommitLike, token: string): boolean {
	const lower = token.toLowerCase();
	return (
		commit.subject.toLowerCase().includes(lower) ||
		commit.author.toLowerCase().includes(lower) ||
		commit.shortHash.toLowerCase().includes(lower) ||
		commit.hash.toLowerCase().includes(lower) ||
		(commit.decorations !== undefined && commit.decorations.toLowerCase().includes(lower))
	);
}

/** 按查询过滤提交（空查询 / 纯空白 → 原数组）。多关键字空格分隔，AND 语义。 */
export function filterScmCommits<T extends ScmCommitLike>(commits: T[], query: string): T[] {
	const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return commits;
	return commits.filter((c) => tokens.every((t) => matchesToken(c, t)));
}
