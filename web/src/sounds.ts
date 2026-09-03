/**
 * Sound notifications for pi-web-ui.
 *
 * All cues are synthesized with the Web Audio API (no asset files), so the
 * whole feature is ~1KB and works offline. Settings are persisted to
 * localStorage; the TopBar exposes a configuration dropdown.
 */

export interface SoundSettings {
	/** Master switch — kills every cue. */
	enabled: boolean;
	/** A questionnaire dialog appeared (ask_user_question). */
	question: boolean;
	/** The agent finished a run (streaming ended). */
	done: boolean;
	/** A run started (first streamed token of a new run). */
	start: boolean;
	/** An error notice was raised. */
	error: boolean;
	/** Master volume 0–100. */
	volume: number;
}

export type SoundKind = "question" | "done" | "start" | "error";

const STORAGE_KEY = "pi-web-sounds";

export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
	enabled: true,
	question: true,
	done: true,
	start: false,
	error: true,
	volume: 100,
};

/** Read persisted settings, falling back to defaults on any failure. */
export function loadSoundSettings(): SoundSettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_SOUND_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<SoundSettings>;
		const merged: SoundSettings = { ...DEFAULT_SOUND_SETTINGS, ...parsed };
		// Sanitize stored values so a corrupted or out-of-range entry can't
		// break the slider or the volume math.
		for (const k of ["enabled", "question", "done", "start", "error"] as const) {
			if (typeof merged[k] !== "boolean") merged[k] = DEFAULT_SOUND_SETTINGS[k];
		}
		if (typeof merged.volume !== "number" || !Number.isFinite(merged.volume)) {
			merged.volume = DEFAULT_SOUND_SETTINGS.volume;
		} else {
			// Clamp 0–100 and snap to the slider step (5) so the label and the
			// thumb always agree.
			merged.volume = Math.round(Math.max(0, Math.min(100, merged.volume)) / 5) * 5;
		}
		return merged;
	} catch {
		return { ...DEFAULT_SOUND_SETTINGS };
	}
}

export function saveSoundSettings(settings: SoundSettings): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// storage unavailable (private mode etc.) — sounds just won't persist
	}
}

// ---------------------------------------------------------------------------
// Audio engine
// ---------------------------------------------------------------------------

let ctx: AudioContext | null = null;

/** Lazily create/resume the shared AudioContext (first call needs a user gesture). */
function audio(): AudioContext | null {
	try {
		if (!ctx) {
			const AC =
				window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
			if (!AC) return null;
			ctx = new AC();
		}
		if (ctx.state === "suspended") void ctx.resume();
		return ctx;
	} catch {
		return null;
	}
}

interface Note {
	type: OscillatorType;
	freq: number;
	/** Seconds from the cue start. */
	start: number;
	dur: number;
	/** Peak gain 0–1 (scaled by the master volume). */
	peak: number;
}

/** Two ascending notes — an incoming-question prompt. */
const QUESTION: Note[] = [
	{ type: "sine", freq: 587.33, start: 0, dur: 0.13, peak: 0.5 },
	{ type: "sine", freq: 880, start: 0.11, dur: 0.24, peak: 0.5 },
];
/** Two soft descending notes — work finished. */
const DONE: Note[] = [
	{ type: "sine", freq: 880, start: 0, dur: 0.15, peak: 0.35 },
	{ type: "sine", freq: 587.33, start: 0.15, dur: 0.32, peak: 0.35 },
];
/** One short tick — a run started. */
const START: Note[] = [{ type: "triangle", freq: 660, start: 0, dur: 0.08, peak: 0.22 }];
/** Low double buzz — something went wrong. */
const ERROR: Note[] = [
	{ type: "square", freq: 220, start: 0, dur: 0.16, peak: 0.18 },
	{ type: "square", freq: 174.61, start: 0.18, dur: 0.26, peak: 0.18 },
];

const PATTERNS: Record<SoundKind, Note[]> = {
	question: QUESTION,
	done: DONE,
	start: START,
	error: ERROR,
};

function tone(c: AudioContext, note: Note, volume: number): void {
	const osc = c.createOscillator();
	const gain = c.createGain();
	osc.type = note.type;
	osc.frequency.value = note.freq;
	const t0 = c.currentTime + note.start;
	const peak = Math.max(0.0001, note.peak * volume);
	gain.gain.setValueAtTime(0.0001, t0);
	gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
	gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.dur);
	osc.connect(gain);
	gain.connect(c.destination);
	osc.start(t0);
	osc.stop(t0 + note.dur + 0.05);
}

/**
 * Play a notification cue if the current settings enable it. Safe to call
 * before any user interaction — if the browser blocks audio it silently
 * no-ops until a later call after a gesture.
 */
export function playSound(kind: SoundKind, settings: SoundSettings = loadSoundSettings()): void {
	if (!settings.enabled || !settings[kind]) return;
	const c = audio();
	if (!c) return;
	const volume = Math.max(0, Math.min(1, settings.volume / 100));
	for (const note of PATTERNS[kind]) tone(c, note, volume);
}
