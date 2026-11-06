import { normalizePathKey } from "./client-state.js";

export interface OrphanCandidate {
	id: string;
	live: boolean;
	pseudo: boolean;
	streaming: number;
	adoptable: boolean;
	activity: number;
}

export function pickAdoptableOrphan(cands: OrphanCandidate[]): string | null {
	if (cands.some((c) => !c.pseudo && c.live)) return null;
	let best: OrphanCandidate | null = null;
	for (const c of cands) {
		if (c.pseudo || c.live || !c.adoptable) continue;
		if (!best || c.streaming > best.streaming || (c.streaming === best.streaming && c.activity > best.activity)) {
			best = c;
		}
	}
	return best?.id ?? null;
}

export function sameCwd(a: string, b: string): boolean {
	const x = String(a ?? "").trim();
	const y = String(b ?? "").trim();
	if (!x || !y) return false;
	try {
		return normalizePathKey(x) === normalizePathKey(y);
	} catch {
		return false;
	}
}
