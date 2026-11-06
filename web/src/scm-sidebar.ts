export const SCM_SIDEBAR_DEFAULT = 300;
export const SCM_SIDEBAR_MIN = 200;
export const SCM_SIDEBAR_MAX = 720;
export const SCM_DIFF_MIN = 220;
export const SCM_SIDEBAR_WIDTH_KEY = "pi-web-ui:scm-sidebar-width";

export function clampScmSidebarWidth(width: number, containerPx = 0): number {
	if (!Number.isFinite(width)) return SCM_SIDEBAR_DEFAULT;
	const upper = Math.max(
		SCM_SIDEBAR_MIN,
		Math.min(SCM_SIDEBAR_MAX, containerPx > 0 ? containerPx - SCM_DIFF_MIN : SCM_SIDEBAR_MAX),
	);
	return Math.min(upper, Math.max(SCM_SIDEBAR_MIN, Math.round(width)));
}

export function parseScmSidebarWidth(raw: string | null): number {
	if (raw === null || raw.trim() === "") return SCM_SIDEBAR_DEFAULT;
	return clampScmSidebarWidth(Number(raw));
}
