export interface TocHeading {
	level: number;
	id: string;
	label: string;
}

const FALLBACK_LABEL = "未命名章节";

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

export function assignHeadingIds(headings: readonly { level: number; label: string }[]): TocHeading[] {
	const used = new Map<string, number>();
	return headings.map(({ level, label }) => {
		const text = String(label ?? "")
			.replace(/\s+/g, " ")
			.trim();
		const base = slugifyHeading(text || FALLBACK_LABEL);
		const seen = (used.get(base) ?? 0) + 1;
		used.set(base, seen);
		return { level, id: seen === 1 ? base : `${base}-${seen}`, label: text || FALLBACK_LABEL };
	});
}

export function shouldShowToc(headings: readonly unknown[]): boolean {
	return headings.length >= 2;
}
