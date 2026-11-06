export interface TouchEnv {
	query?: (media: string) => boolean;
	userAgent?: string;
	maxTouchPoints?: number;
}

export function isTouchFirstDevice(env: TouchEnv): boolean {
	const q = env.query;
	if (!q) return false;
	if (!q("(pointer: coarse)")) return false;
	if (!q("(hover: none)")) return false;
	const ua = env.userAgent ?? "";
	if (/Windows|CrOS/i.test(ua)) return false;
	if (/Linux/i.test(ua) && !/Android/i.test(ua)) return false;
	if (/Macintosh/i.test(ua) && (env.maxTouchPoints ?? 0) <= 1) return false;
	return true;
}

export function detectTouchFirstDevice(): boolean {
	if (typeof window === "undefined" || typeof navigator === "undefined") return false;
	if (typeof window.matchMedia !== "function") return false;
	return isTouchFirstDevice({
		query: (media) => window.matchMedia(media).matches,
		userAgent: navigator.userAgent,
		maxTouchPoints: navigator.maxTouchPoints,
	});
}
