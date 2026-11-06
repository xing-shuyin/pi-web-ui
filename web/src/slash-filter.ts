export const SKILL_NAMESPACE = "skill:";

export const WORD_BOUNDARY_CHARS = /[\s\-_./:]/;

export const enum MatchTier {
	Exact = 0,
	StartsWith = 1,
	WordBoundary = 2,
	Subsequence = 3,
}

export interface FuzzyScoreResult {
	tier: MatchTier;
	score: number;
}

export function slashCandidates(name: string, source: string): string[] {
	const full = name.toLowerCase();
	if (source === "skill" && full.startsWith(SKILL_NAMESPACE)) {
		return [full, full.slice(SKILL_NAMESPACE.length)];
	}
	return [full];
}

function findWordBoundaryPrefixIndex(query: string, candidate: string): number {
	let idx = 0;
	while (idx < candidate.length) {
		const next = candidate.indexOf(query, idx);
		if (next === -1) return -1;
		if (next > 0 && WORD_BOUNDARY_CHARS.test(candidate[next - 1])) {
			return next;
		}
		idx = next + 1;
	}
	return -1;
}

export function fuzzyScore(query: string, candidate: string): FuzzyScoreResult | null {
	const q = query.toLowerCase();
	const c = candidate.toLowerCase();
	if (!q) {
		return { tier: MatchTier.Exact, score: 0 };
	}
	if (q.length > c.length) {
		return null;
	}

	let tier: MatchTier = MatchTier.Subsequence;
	let prefixStart = -1;

	if (c === q) {
		tier = MatchTier.Exact;
		prefixStart = 0;
	} else if (c.startsWith(q)) {
		tier = MatchTier.StartsWith;
		prefixStart = 0;
	} else {
		const wb = findWordBoundaryPrefixIndex(q, c);
		if (wb !== -1) {
			tier = MatchTier.WordBoundary;
			prefixStart = wb;
		}
	}

	if (prefixStart !== -1) {
		let score = 0;
		let consecutiveMatches = 0;
		for (let j = 0; j < q.length; j++) {
			const pos = prefixStart + j;
			const isWordBoundary = pos === 0 || WORD_BOUNDARY_CHARS.test(c[pos - 1]);
			if (j > 0) {
				consecutiveMatches++;
				score -= consecutiveMatches * 5;
			}
			if (isWordBoundary) {
				score -= 10;
			}
			score += pos * 0.1;
		}
		if (tier === MatchTier.Exact) {
			score -= 100;
		}
		return { tier, score };
	}

	let queryIndex = 0;
	let score = 0;
	let lastMatchIndex = -1;
	let consecutiveMatches = 0;

	while (queryIndex < q.length) {
		const i = c.indexOf(q[queryIndex], lastMatchIndex + 1);
		if (i === -1) {
			return null;
		}

		const isWordBoundary = i === 0 || WORD_BOUNDARY_CHARS.test(c[i - 1]);

		if (lastMatchIndex === i - 1) {
			consecutiveMatches++;
			score -= consecutiveMatches * 5;
		} else {
			consecutiveMatches = 0;
			if (lastMatchIndex >= 0) {
				score += (i - lastMatchIndex - 1) * 2;
			}
		}

		if (isWordBoundary) {
			score -= 10;
		}

		score += i * 0.1;
		lastMatchIndex = i;
		queryIndex++;
	}

	return { tier: MatchTier.Subsequence, score };
}

export function filterSlashCommands<T extends { name: string; source: string }>(
	commands: readonly T[],
	prefix: string,
): T[] {
	const query = prefix.toLowerCase();
	if (!query) return [...commands];

	type ScoredCommand = {
		cmd: T;
		tier: MatchTier;
		score: number;
		index: number;
	};

	const matches: ScoredCommand[] = [];

	for (let i = 0; i < commands.length; i++) {
		const cmd = commands[i];
		const candidates = slashCandidates(cmd.name, cmd.source);
		let best: FuzzyScoreResult | null = null;

		for (const cand of candidates) {
			const res = fuzzyScore(query, cand);
			if (!res) continue;
			if (!best || res.tier < best.tier || (res.tier === best.tier && res.score < best.score)) {
				best = res;
			}
		}

		if (best) {
			matches.push({
				cmd,
				tier: best.tier,
				score: best.score,
				index: i,
			});
		}
	}

	matches.sort((a, b) => {
		if (a.tier !== b.tier) {
			return a.tier - b.tier;
		}
		if (a.tier < MatchTier.Subsequence) {
			return a.index - b.index;
		}
		if (Math.abs(a.score - b.score) > 1e-6) {
			return a.score - b.score;
		}
		return a.index - b.index;
	});

	return matches.map((m) => m.cmd);
}
