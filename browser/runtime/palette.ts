/**
 * 主题底色：主进程侧的「画布颜色」。
 *
 * 每个 `WebContentsView` 在页面画出第一帧之前，露出来的只有视图自己的背景色——Electron 的默认值
 * 是**白色**。新建标签页时那块空白会先白闪一下、再变成新标签页的深色，观感上就是「新建标签页闪白屏」。
 * 这里给出与 `browser/renderer/browser.css` 的 `--pb-bg-main` 一一对应的值，让首帧之前那块区域
 * 直接就是主题底色（`tests/unit/browser-palette.test.ts` 守着这两处不许各说各话）。
 */
export const THEME_BACKGROUNDS = {
	dark: "#111215",
	midnight: "#0c1017",
	light: "#f4f6fa",
} as const;

/** 不认识的 / 缺失的主题一律按默认深色：宁可深一帧，也不要白一帧。 */
export const DEFAULT_THEME_BACKGROUND: string = THEME_BACKGROUNDS.dark;

/** 主题 id（`settings.theme`，可能来自旧数据或用户手改）→ 底色。 */
export function themeBackground(theme: unknown): string {
	if (typeof theme !== "string" || !Object.hasOwn(THEME_BACKGROUNDS, theme)) return DEFAULT_THEME_BACKGROUND;
	return THEME_BACKGROUNDS[theme as keyof typeof THEME_BACKGROUNDS];
}
