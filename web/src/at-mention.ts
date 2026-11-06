import { SKILL_NAMESPACE } from "./slash-filter.js";

interface AtToken {
	start: number;
	query: string;
}

interface AtAttachment {
	path: string;
	name?: string;
	mode?: "inline" | "reference" | "lines" | "page" | "canvas";
	isDir?: boolean;
	lines?: { start: number; end: number };
}

export interface AtHit {
	providerId: string;
	providerLabel: string;
	title: string;
	hint?: string;
	text?: string;
	attachments?: AtAttachment[];
}

export const ALL_PAGES_TRIGGERS: ReadonlySet<string> = new Set(["p", "page", "pages", "web", "网页", "页面"]);

export function mapPageHits(
	providerLabel: string,
	pages: { origin: string; title?: string; open?: boolean; tabId?: string; url?: string }[],
	query: string,
	limit = 10,
): AtHit[] {
	if (!Array.isArray(pages)) return [];
	const q = String(query ?? "").toLowerCase();
	const listAll = q === "" || ALL_PAGES_TRIGGERS.has(q);
	const out: AtHit[] = [];
	for (const p of pages) {
		if (!p || typeof p.origin !== "string" || !p.origin) continue;
		if (p.open !== true) continue;
		const rawTitle = typeof p.title === "string" && p.title.trim() ? p.title.trim() : p.origin;
		if (!listAll && !rawTitle.toLowerCase().includes(q) && !p.origin.toLowerCase().includes(q)) continue;
		const sep = rawTitle.indexOf(" · ");
		const title = sep === -1 ? `page · ${rawTitle}` : `page · ${rawTitle.slice(sep + 3)}`;
		out.push({
			providerId: "host:pages",
			providerLabel,
			title,
			hint: p.origin,
			text: rawTitle,
			attachments: [{ path: p.tabId ?? p.origin, name: rawTitle, mode: "page" }],
		});
		if (out.length >= Math.max(0, limit)) break;
	}
	return out;
}

export function mapFileHits(providerLabel: string, raw: unknown, limit = 10): AtHit[] {
	if (!Array.isArray(raw)) return [];
	const out: AtHit[] = [];
	for (const r of raw.slice(0, Math.max(0, limit))) {
		if (!r || typeof r !== "object") continue;
		const o = r as Record<string, unknown>;
		if (typeof o.path !== "string" || !o.path || typeof o.name !== "string" || !o.name) continue;
		out.push({
			providerId: "host:files",
			providerLabel,
			title: o.name,
			hint: o.path,
			text: `@${o.path}`,
			attachments: [
				{
					path: o.path,
					name: o.name,
					mode: "reference",
					...(o.type === "dir" ? { isDir: true } : {}),
				},
			],
		});
	}
	return out;
}

export function normalizeAtHits(providerId: string, providerLabel: string, raw: unknown, limit = 10): AtHit[] {
	if (!Array.isArray(raw)) return [];
	const out: AtHit[] = [];
	for (const h of raw.slice(0, Math.max(0, limit))) {
		if (!h || typeof h !== "object") continue;
		const o = h as Record<string, unknown>;
		if (typeof o.title !== "string" || !o.title.trim()) continue;
		const atts = Array.isArray(o.attachments)
			? (o.attachments as unknown[])
					.filter(
						(a): a is Record<string, unknown> =>
							!!a && typeof a === "object" && typeof (a as Record<string, unknown>).path === "string",
					)
					.slice(0, 4)
					.map((a): AtAttachment => {
						const mode = a.mode as unknown;
						return {
							path: a.path as string,
							...(typeof a.name === "string" ? { name: a.name } : {}),
							...(mode === "inline" || mode === "reference" || mode === "lines" || mode === "page" ? { mode } : {}),
							...(typeof a.isDir === "boolean" ? { isDir: a.isDir } : {}),
						};
					})
			: undefined;
		out.push({
			providerId,
			providerLabel,
			title: o.title.trim(),
			...(typeof o.hint === "string" && o.hint ? { hint: o.hint } : {}),
			...(typeof o.text === "string" && o.text ? { text: o.text } : {}),
			...(atts?.length ? { attachments: atts } : {}),
		});
	}
	return out;
}

export interface SkillCommandLike {
	name: string;
	source: "builtin" | "extension" | "prompt" | "skill" | "plugin";
	description?: string;
	descriptionEn?: string;
	argumentHint?: string;
}

export function mapSkillHits(
	providerLabel: string,
	slashCommands: readonly SkillCommandLike[],
	query: string,
	limit = 15,
	descResolver?: (cmd: SkillCommandLike) => string,
): AtHit[] {
	if (!Array.isArray(slashCommands) || limit <= 0) return [];
	const q = String(query ?? "").toLowerCase();
	const isPrefixed = q.startsWith(SKILL_NAMESPACE);
	const cleanQ = isPrefixed ? q.slice(SKILL_NAMESPACE.length) : q;

	const nameHits: AtHit[] = [];
	const descHits: AtHit[] = [];

	const searchDesc = isPrefixed || cleanQ.length >= 3;

	for (const cmd of slashCommands) {
		if (cmd.source !== "skill") continue;
		const bareName = cmd.name.startsWith(SKILL_NAMESPACE) ? cmd.name.slice(SKILL_NAMESPACE.length) : cmd.name;
		const nameLower = bareName.toLowerCase();
		const resolvedDesc = descResolver ? descResolver(cmd) : (cmd.description ?? "");
		const descLower = resolvedDesc.toLowerCase();
		const descEnLower = (cmd.descriptionEn ?? "").toLowerCase();

		const hit: AtHit = {
			providerId: "host:skills",
			providerLabel,
			title: bareName,
			hint: resolvedDesc || `Skill ${bareName}`,
			text: `@skill:${bareName}`,
		};

		if (!cleanQ) {
			nameHits.push(hit);
		} else if (nameLower.includes(cleanQ)) {
			nameHits.push(hit);
		} else if (searchDesc && (descLower.includes(cleanQ) || descEnLower.includes(cleanQ))) {
			descHits.push(hit);
		}
	}

	return [...nameHits, ...descHits].slice(0, Math.max(0, limit));
}

export function mergeAtHits(
	buckets: {
		pages?: AtHit[];
		canvases?: AtHit[];
		skills?: AtHit[];
		files?: AtHit[];
		plugins?: AtHit[];
	},
	query: string,
	totalCap = 30,
): AtHit[] {
	const q = String(query ?? "").toLowerCase();
	const pages = buckets.pages ?? [];
	const canvases = buckets.canvases ?? [];
	const skills = buckets.skills ?? [];
	const files = buckets.files ?? [];
	const plugins = buckets.plugins ?? [];

	let ordered: AtHit[];
	if (q.startsWith(SKILL_NAMESPACE)) {
		ordered = [...skills, ...canvases, ...pages, ...files, ...plugins];
	} else {
		ordered = [...canvases, ...pages, ...skills, ...files, ...plugins];
	}

	return ordered.slice(0, Math.max(0, totalCap));
}

function isAtBoundary(ch: string | undefined): boolean {
	if (ch === undefined) return true;
	if (ch === "@") return false;
	if (/[A-Za-z0-9_]/.test(ch)) return false;
	return true;
}

export function matchAtToken(text: string, cursor: number): AtToken | null {
	const src = typeof text === "string" ? text : "";
	const cur = Math.max(
		0,
		Math.min(typeof cursor === "number" && Number.isFinite(cursor) ? Math.floor(cursor) : 0, src.length),
	);
	const before = src.slice(0, cur);
	const at = before.lastIndexOf("@");
	if (at === -1) return null;
	if (!isAtBoundary(at > 0 ? before[at - 1] : undefined)) return null;
	const query = before.slice(at + 1);
	if (/[\s@]/.test(query)) return null;
	return { start: at, query };
}
