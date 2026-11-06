export type PresentKind =
	"image" | "video" | "audio" | "markdown" | "html" | "pdf" | "text" | "binary" | "dir" | "missing" | "unknown";

const KINDS: ReadonlySet<string> = new Set([
	"image",
	"video",
	"audio",
	"markdown",
	"html",
	"pdf",
	"text",
	"binary",
	"dir",
	"missing",
]);

interface PresentArgItem {
	path: string;
	caption?: string;
	focus?: boolean;
}

export interface PresentArgs {
	title?: string;
	note?: string;
	items: PresentArgItem[];
}

export interface PresentCardItem {
	path: string;
	target: string;
	name: string;
	kind: PresentKind;
	caption?: string;
	focus: boolean;
	size?: number;
	mtime?: number;
	excerpt?: string;
	excerptTruncated?: boolean;
}

function normPresentPath(p: string): string {
	const w = String(p ?? "")
		.trim()
		.replace(/\\/g, "/");
	return w.length > 1 ? w.replace(/\/+$/, "") : w;
}

export function presentBaseName(p: string): string {
	const segs = normPresentPath(p).split("/");
	const last = segs[segs.length - 1] ?? "";
	return last || String(p ?? "");
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function parsePresentArgs(argumentsText: string | undefined): PresentArgs | null {
	if (!argumentsText) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(argumentsText);
	} catch {
		return null;
	}
	const obj = asRecord(raw);
	if (!obj) return null;
	const rawItems = Array.isArray(obj.items) ? obj.items : [];
	const items: PresentArgItem[] = [];
	for (const entry of rawItems) {
		if (typeof entry === "string") {
			const path = entry.trim();
			if (path) items.push({ path });
			continue;
		}
		const rec = asRecord(entry);
		const path = rec ? str(rec.path) : undefined;
		if (!path) continue;
		const item: PresentArgItem = { path };
		const caption = str(rec?.caption);
		if (caption) item.caption = caption;
		if (rec?.focus === true) item.focus = true;
		items.push(item);
	}
	if (items.length === 0) return null;
	const out: PresentArgs = { items };
	const title = str(obj.title);
	if (title) out.title = title;
	const note = str(obj.note);
	if (note) out.note = note;
	return out;
}

export function presentCardItems(args: PresentArgs, details: unknown): PresentCardItem[] {
	const det = asRecord(details);
	const rows = Array.isArray(det?.items) ? det.items.map(asRecord) : [];
	const byPath = new Map<string, Record<string, unknown>>();
	for (const row of rows) {
		if (!row) continue;
		const key = normPresentPath(String(row.path ?? row.abs ?? ""));
		if (key && !byPath.has(key)) byPath.set(key, row);
	}
	return args.items.map((item, i) => {
		const row = byPath.get(normPresentPath(item.path)) ?? rows[i] ?? null;
		const kind = str(row?.kind);
		const card: PresentCardItem = {
			path: item.path,
			target: str(row?.abs) ?? item.path,
			name: presentBaseName(str(row?.name) ?? item.path),
			kind: kind && KINDS.has(kind) ? (kind as PresentKind) : "unknown",
			focus: item.focus === true,
		};
		if (item.caption) card.caption = item.caption;
		if (typeof row?.size === "number" && Number.isFinite(row.size)) card.size = row.size;
		if (typeof row?.mtime === "number" && Number.isFinite(row.mtime)) card.mtime = row.mtime;
		const excerpt = str(row?.excerpt);
		if (excerpt) card.excerpt = excerpt;
		if (row?.excerptTruncated === true) card.excerptTruncated = true;
		return card;
	});
}

export function presentTitle(args: PresentArgs, details: unknown): string | undefined {
	const det = asRecord(details);
	return str(det?.title) ?? args.title;
}

export function presentNote(args: PresentArgs, details: unknown): string | undefined {
	const det = asRecord(details);
	return str(det?.note) ?? args.note;
}

export function inlineMediaKind(kind: PresentKind): "image" | "video" | "audio" | null {
	return kind === "image" || kind === "video" || kind === "audio" ? kind : null;
}

export function previewablePresentKind(kind: PresentKind): boolean {
	return kind !== "dir" && kind !== "missing";
}

export function presentKindIcon(kind: PresentKind): string {
	switch (kind) {
		case "image":
			return "🖼";
		case "video":
			return "🎬";
		case "audio":
			return "🎵";
		case "markdown":
			return "📝";
		case "html":
			return "🌐";
		case "pdf":
			return "📕";
		case "text":
			return "📄";
		case "dir":
			return "📁";
		case "missing":
			return "⚠";
		default:
			return "📦";
	}
}

export function formatPresentSize(bytes: number | undefined): string | undefined {
	if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function focusPresentItem(items: PresentCardItem[]): PresentCardItem | undefined {
	return items.find((i) => i.focus && previewablePresentKind(i.kind));
}

export function primaryPreviewItem(items: PresentCardItem[]): PresentCardItem | undefined {
	return focusPresentItem(items) ?? items.find((i) => previewablePresentKind(i.kind));
}

export function shouldAutoOpenPresent(o: {
	enabled: boolean;
	seen: boolean;
	timestamp?: number;
	now: number;
	maxAgeMs: number;
}): boolean {
	if (!o.enabled || o.seen) return false;
	if (typeof o.timestamp !== "number" || !Number.isFinite(o.timestamp)) return false;
	const age = o.now - o.timestamp;
	return age >= 0 && age <= o.maxAgeMs;
}
