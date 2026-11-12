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
		p.fps > 30
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
		p.fps > 30
	)
		return;
	return { mode: p.mode, maxEdge: p.maxEdge, viewportEdge: p.viewportEdge, fps: p.fps };
}

/** Adapt only on fresh display acknowledgements, with separate slow/fast hysteresis. */
export class DesktopQuality {
	private preferences: DesktopPreferences = { mode: "auto", maxEdge: 0, viewportEdge: 1920, fps: 30 };
	private scale = 1;
	private bad = 0;
	private good = 0;
	set(preferences: DesktopPreferences) {
		if (preferences.mode !== this.preferences.mode) {
			this.scale = 1;
			this.bad = this.good = 0;
		}
		this.preferences = preferences;
		return this.profile;
	}
	get profile(): DesktopProfile {
		const p = this.preferences;
		const quality = { auto: 70, smooth: 50, balanced: 65, sharp: 85 }[p.mode];
		const edge = p.maxEdge || p.viewportEdge;
		return {
			maxEdge: Math.max(640, Math.round((edge * (p.mode === "auto" ? this.scale : 1)) / 2) * 2),
			quality: p.mode === "auto" ? Math.max(40, Math.round(quality - (1 - this.scale) * 40)) : quality,
			fps: p.mode === "auto" ? Math.max(5, Math.round(p.fps * this.scale)) : p.fps,
		};
	}
	sample(ackMs: number) {
		if (this.preferences.mode !== "auto" || !Number.isFinite(ackMs) || ackMs < 0) return this.profile;
		this.bad = ackMs > 150 ? this.bad + 1 : 0;
		this.good = ackMs < 80 ? this.good + 1 : 0;
		if (this.bad >= 2 || ackMs > 600) {
			this.scale = Math.max(0.35, this.scale * 0.8);
			this.bad = this.good = 0;
		} else if (this.good >= 4) {
			this.scale = Math.min(1, this.scale + 0.1);
			this.good = 0;
		}
		return this.profile;
	}
}
