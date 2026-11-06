export interface ScmCommitLike {
	hash: string;
	shortHash: string;
	author: string;
	subject: string;
	decorations?: string;
}

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

export function filterScmCommits<T extends ScmCommitLike>(commits: T[], query: string): T[] {
	const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return commits;
	return commits.filter((c) => tokens.every((t) => matchesToken(c, t)));
}
