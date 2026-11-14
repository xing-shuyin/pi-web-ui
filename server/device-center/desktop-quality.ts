export type DesktopProfile = { maxEdge: number; quality: number; fps: number };
export type DesktopPreferences = {
	mode: "auto" | "smooth" | "balanced" | "sharp";
	maxEdge: number;
	viewportEdge: number;
	fps: number;
};

export function parseDesktopProfile(value: unknown): DesktopProfile | undefined {
	if (!value || typeof value !== "object") return;
	const p = value as DesktopProfile;
	if (
		!Number.isInteger(p.maxEdge) ||
		p.maxEdge < 640 ||
		p.maxEdge > 2560 ||
		!Number.isInteger(p.quality) ||
		p.quality < 35 ||
		p.quality > 85 ||
		!Number.isInteger(p.fps) ||
		p.fps < 5 ||
		p.fps > 240
	)
		return;
	return { maxEdge: p.maxEdge, quality: p.quality, fps: p.fps };
}

export function parseDesktopPreferences(value: unknown): DesktopPreferences | undefined {
	if (!value || typeof value !== "object") return;
	const p = value as DesktopPreferences;
	if (
		!["auto", "smooth", "balanced", "sharp"].includes(p.mode) ||
		!Number.isInteger(p.maxEdge) ||
		(p.maxEdge !== 0 && (p.maxEdge < 640 || p.maxEdge > 2560)) ||
		!Number.isInteger(p.viewportEdge) ||
		p.viewportEdge < 640 ||
		p.viewportEdge > 2560 ||
		!Number.isInteger(p.fps) ||
		p.fps < 5 ||
		p.fps > 240
	)
		return;
	return { mode: p.mode, maxEdge: p.maxEdge, viewportEdge: p.viewportEdge, fps: p.fps };
}

export class DesktopQuality {
	private preferences: DesktopPreferences = { mode: "auto", maxEdge: 0, viewportEdge: 1920, fps: 60 };
	set(preferences: DesktopPreferences) {
		this.preferences = preferences;
		return this.profile;
	}
	get profile(): DesktopProfile {
		const p = this.preferences;
		const quality = { auto: 70, smooth: 50, balanced: 65, sharp: 85 }[p.mode];
		const edge = p.maxEdge || p.viewportEdge;
		return {
			maxEdge: Math.max(640, Math.round(edge / 2) * 2),
			quality,
			fps: p.fps,
		};
	}
}
