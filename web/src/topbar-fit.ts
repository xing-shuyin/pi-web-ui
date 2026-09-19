/**
 * 顶栏「放不下的自动进 ⋯」的核心纯函数（方案 A：手机端与桌面端渲染同一份 slot 数据）。
 *
 * 为什么是纯函数：
 *   - 顶栏宽度是**实测**出来的（ResizeObserver + offsetWidth），逻辑放进组件里就没法
 *     穷举断言；这里只吃「每个条目的实测宽度 + 容器可用宽度」，同输入必同输出。
 *   - 桌面/手机只有宽度不同，没有第二套数据 —— 「设置里看到的顺序 == 界面上看到的顺序」
 *     这个 issue #146 的不变量在手机上同样成立（旧版手机端是 CSS `display:none` 硬藏
 *     一整组 + 另一个硬编码的「⋯」面板，那条不变量是断的，见本文件的历史注释于 TopBar）。
 *
 * 丢弃策略：按**视觉顺序从尾部**丢（右先于左）。理由：
 *   - 尾部丢弃不重排任何剩余条目 → 关掉宽度一档再打开，条目位置不会跳来跳去（单调）。
 *   - 用户明确要「全部入口都在」：被丢的条目不是消失，而是落到同一个「⋯」菜单里，
 *     并且能一键点回。想改变谁先被丢，就在设置面板「界面布局」里把它往前调 ——
 *     顺序是用户可控的，这里不需要第二套优先级概念。
 */

export interface TopbarFitItem {
	/** 条目的全局 id（`host:*` / `<pluginId>:*`）。 */
	id: string;
	/** 实测宽度（`offsetWidth`）。0 = 当前断点下被 CSS 藏起来的条目（见下）。 */
	width: number;
}

/**
 * 手机端钉在「⋯」右边的固定位（最右）：目前只有 📁 文件列表。
 * 它移出主直流渲染（见 TopBar 的 mobileAsideItems），不参与实测溢出、永远可见 ——
 * 这是手机端唯一的特殊入口；其余条目与桌面端同一套实测溢出（放不下才进「⋯」，
 * 不是按名单强制折叠，见 TopBar）。
 */
export const MOBILE_ASIDE_TOPBAR_IDS: ReadonlySet<string> = new Set(["host:files"]);

/**
 * 溢出菜单排序（折叠前后顺序一致的不变量）：先按对齐段（左→中→右），
 * 段内按 slot 顺序（= 布局页 ↑↓ 的顺序）。两个来源（用户隐藏的常驻项 +
 * 实测放不下的项）合并后统一排，而不是两截拼接（否则隐藏项永远插在最前，
 * 与顶栏视觉顺序对不上）。
 *
 * @param items  合并后的菜单项（ pinned 常驻 ＋ dropped 溢出）。
 * @param rankOf 条目在 slot 数据里的下标（布局页顺序）；未知 id 给大值沉底。
 */
export function sortOverflowMenuItems<T extends { id: string; align?: string }>(
	items: readonly T[],
	rankOf: (id: string) => number,
): T[] {
	const zone = (align?: string): number => (align === "center" ? 1 : align === "end" ? 2 : 0);
	return [...items].sort((a, b) => zone(a.align) - zone(b.align) || rankOf(a.id) - rankOf(b.id));
}

/**
 * 算出要退进溢出菜单的条目 id 集合（空集 = 全部放得下）。
 *
 * @param items     视觉顺序的条目（start 段 → center 段 → end 段），必须与界面上一致。
 * @param available 流容器的可用宽度（`clientWidth`）。
 * @param gap       条目间距（容器的 `columnGap`，px）。
 * @param reserve   「⋯」按钮自身宽度 + 它与前一个条目之间的间距（px）。
 */
export function fitTopbar(
	items: TopbarFitItem[],
	available: number,
	gap: number,
	reserve: number,
	keepIds: ReadonlySet<string> = new Set(),
): Set<string> {
	const drop = new Set<string>();
	// 没测到宽度（未挂载 / jsdom / display:none 的容器）时**全保留**：
	// 拿不到数据就把顶栏清空是最糟的降级（与 TopBar 里 uiPrimary 缺省时的口径一致）。
	if (!Number.isFinite(available) || available <= 0) return drop;
	// 常驻项先占预算；其它条目不够时退进 ⋯，常驻项自身永不被丢。
	const keptWidth = items
		.filter((it) => keepIds.has(it.id) && it.width > 0)
		.reduce((sum, it) => sum + it.width + gap, 0);
	const budget = Math.max(0, available - Math.max(0, reserve) - keptWidth);
	let acc = 0;
	// 一旦某个条目放不下，它后面的条目（有宽度的）一律跟着进溢出：
	// 跳过式的「抽空隙塞」会让剩余条目在宽度变化时反复换位。
	let overflowing = false;
	for (const it of items) {
		// 该断点下没有宽度 = CSS 藏起来的条目（桌面端的 ☰/📁 抽屉开关等）：
		// 既不占宽度、也不该被丢进溢出菜单（那会给落地页一个点了没用的入口）。
		if (!(it.width > 0)) continue;
		if (keepIds.has(it.id)) continue;
		const need = it.width + gap;
		if (overflowing || acc + need > budget) {
			overflowing = true;
			drop.add(it.id);
			continue;
		}
		acc += need;
	}
	return drop;
}
