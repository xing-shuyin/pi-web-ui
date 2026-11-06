export type ChapterNavState = {
	canPrev: boolean;
	canNext: boolean;
	note: string;
};

export function chapterNavState(idx: number, total: number, bookName: string): ChapterNavState {
	if (!(total > 0)) return { canPrev: false, canNext: false, note: "目录为空 —— 用顶部「刷新」重拉目录" };
	const canPrev = idx > 0;
	const canNext = idx < total - 1;
	const note = `《${bookName}》· 第 ${idx + 1}/${total} 章${canNext ? "" : " · 已是最后一章"}`;
	return { canPrev, canNext, note };
}
