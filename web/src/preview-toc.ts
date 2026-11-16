export interface TocHeading {
	level: number;
	id: string;
	label: string;
}

// Kept as the literal slug base so anchor ids never change with the UI language;
// the visible fallback label is translated at the call site (guard: reason data).
const FALLBACK_LABEL = "未命名章节";
export const TOC_FALLBACK_LABEL_KEY = "previewTocUntitled" as const;

export function slugifyHeading(label: string): string {
	const slug = String(label ?? "")
		.trim()
		.replace(/[\s\u3000]+/g, "-")
		.replace(/[^\p{L}\p{N}_-]+/gu, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || "section";
}

export function assignHeadingIds(
	headings: readonly { level: number; label: string }[],
	fallbackLabel: string = FALLBACK_LABEL,
): TocHeading[] {
	const used = new Map<string, number>();
	return headings.map(({ level, label }) => {
		const text = String(label ?? "")
			.replace(/\s+/g, " ")
			.trim();
		const base = slugifyHeading(text || FALLBACK_LABEL);
		const seen = (used.get(base) ?? 0) + 1;
		used.set(base, seen);
		// The id keeps the stable literal so anchors never change; only the visible label is translatable.
		return { level, id: seen === 1 ? base : `${base}-${seen}`, label: text || fallbackLabel };
	});
}

export function shouldShowToc(headings: readonly unknown[]): boolean {
	return headings.length >= 2;
}
