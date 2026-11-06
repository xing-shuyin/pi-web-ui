export type PluginSectionKey = `plugin:${string}`;

export type LpSectionKey = "projects" | "groups" | "convs" | "sessions" | PluginSectionKey;

export const LP_SECTION_ENTRY_ID: Readonly<Record<"projects" | "groups" | "convs" | "sessions", string>> = {
	projects: "host:lp-projects",
	groups: "host:lp-groups",
	convs: "host:lp-running",
	sessions: "host:lp-history",
};

export const LP_SECTION_DEFAULT_ORDER: readonly ("projects" | "convs" | "sessions")[] = [
	"projects",
	"convs",
	"sessions",
];

const HOST_KEY_BY_ENTRY_ID: ReadonlyMap<string, "projects" | "groups" | "convs" | "sessions"> = new Map(
	(Object.keys(LP_SECTION_ENTRY_ID) as ("projects" | "groups" | "convs" | "sessions")[]).map(
		(k) => [LP_SECTION_ENTRY_ID[k], k] as const,
	),
);

const PLUGIN_KEY_PREFIX = "plugin:";

export function isPluginSectionKey(key: string): key is PluginSectionKey {
	return key.startsWith(PLUGIN_KEY_PREFIX) && key.length > PLUGIN_KEY_PREFIX.length;
}

export interface LpSectionEntryLike {
	id: string;
	hidden?: boolean;
	source?: string;
	kind?: string;
}

export interface LpSectionPlanItem<E extends LpSectionEntryLike = LpSectionEntryLike> {
	key: LpSectionKey;
	shown: boolean;
	entry?: E;
}

export function planLeftSections<E extends LpSectionEntryLike>(
	entries: readonly E[] | undefined,
): LpSectionPlanItem<E>[] {
	const order: LpSectionPlanItem<E>[] = [];
	const seen = new Set<string>();
	for (const e of entries ?? []) {
		let key: LpSectionKey | null = null;
		let entry: E | undefined;
		const host = HOST_KEY_BY_ENTRY_ID.get(e.id);
		if (host) key = host;
		else if (e.source?.startsWith("plugin:") && e.kind === "view") {
			key = `${PLUGIN_KEY_PREFIX}${e.id}` as PluginSectionKey;
			entry = e;
		}
		if (!key || seen.has(key)) continue;
		seen.add(key);
		order.push({ key, shown: !e.hidden, ...(entry ? { entry } : {}) });
	}
	for (const key of LP_SECTION_DEFAULT_ORDER) {
		if (!seen.has(key)) order.push({ key, shown: true });
	}
	return order;
}

export function withDeviceGroupSection<E extends LpSectionEntryLike>(
	plan: readonly LpSectionPlanItem<E>[],
): LpSectionPlanItem<E>[] {
	if (plan.some((item) => item.key === "groups")) return [...plan];
	const result = [...plan];
	const projectIndex = result.findIndex((item) => item.key === "projects" && item.shown);
	result.splice(projectIndex + 1, 0, { key: "groups", shown: true });
	return result;
}

export function flexSectionKeys(
	plan: readonly LpSectionPlanItem[],
	hasContent: (key: LpSectionKey) => boolean,
): LpSectionKey[] {
	return plan.filter((p) => p.shown && hasContent(p.key)).map((p) => p.key);
}

export function sashPairs(
	flex: readonly LpSectionKey[],
	collapsed: (key: LpSectionKey) => boolean,
): [LpSectionKey, LpSectionKey][] {
	const out: [LpSectionKey, LpSectionKey][] = [];
	for (let i = 0; i + 1 < flex.length; i++) {
		const above = flex[i]!;
		const below = flex[i + 1]!;
		if (!collapsed(above) && !collapsed(below)) out.push([above, below]);
	}
	return out;
}

export function parseLpWeights(raw: string | null, defaults: Readonly<Record<string, number>>): Record<string, number> {
	const out: Record<string, number> = { ...defaults };
	if (!raw) return out;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (!(key in defaults) && !isPluginSectionKey(key)) continue;
			if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
		}
	} catch {}
	return out;
}
