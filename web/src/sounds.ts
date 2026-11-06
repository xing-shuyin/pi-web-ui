import { isMobileRuntime, type MobileNotifyKind } from "./mobile-runtime";

export interface SoundSettings {
	enabled: boolean;
	question: boolean;
	done: boolean;
	subagentDone: boolean;
	start: boolean;
	error: boolean;
	approval: boolean;
	volume: number;
}

export type SoundKind = MobileNotifyKind;

const STORAGE_KEY = "pi-web-sounds";

const DEFAULT_SOUND_SETTINGS: SoundSettings = {
	enabled: true,
	question: true,
	done: true,
	subagentDone: true,
	start: false,
	error: true,
	approval: true,
	volume: 100,
};

export function loadSoundSettings(): SoundSettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_SOUND_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<SoundSettings>;
		const merged: SoundSettings = { ...DEFAULT_SOUND_SETTINGS, ...parsed };
		if (parsed.subagentDone === undefined && typeof parsed.done === "boolean") {
			merged.subagentDone = parsed.done;
		}
		for (const k of ["enabled", "question", "done", "subagentDone", "start", "error", "approval"] as const) {
			if (typeof merged[k] !== "boolean") merged[k] = DEFAULT_SOUND_SETTINGS[k];
		}
		if (typeof merged.volume !== "number" || !Number.isFinite(merged.volume)) {
			merged.volume = DEFAULT_SOUND_SETTINGS.volume;
		} else {
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
	} catch {}
	if (isMobileRuntime() && typeof window !== "undefined") window.dispatchEvent(new Event("pi-web-ui:sound-settings"));
}

let ctx: AudioContext | null = null;

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
	start: number;
	dur: number;
	peak: number;
}

const QUESTION: Note[] = [
	{ type: "sine", freq: 587.33, start: 0, dur: 0.13, peak: 0.5 },
	{ type: "sine", freq: 880, start: 0.11, dur: 0.24, peak: 0.5 },
];
const DONE: Note[] = [
	{ type: "sine", freq: 880, start: 0, dur: 0.15, peak: 0.35 },
	{ type: "sine", freq: 587.33, start: 0.15, dur: 0.32, peak: 0.35 },
];
const START: Note[] = [{ type: "triangle", freq: 660, start: 0, dur: 0.08, peak: 0.22 }];
const ERROR: Note[] = [
	{ type: "square", freq: 220, start: 0, dur: 0.16, peak: 0.18 },
	{ type: "square", freq: 174.61, start: 0.18, dur: 0.26, peak: 0.18 },
];
const APPROVAL: Note[] = [
	{ type: "sine", freq: 659.25, start: 0, dur: 0.11, peak: 0.45 },
	{ type: "sine", freq: 659.25, start: 0.14, dur: 0.11, peak: 0.45 },
	{ type: "sine", freq: 880, start: 0.28, dur: 0.26, peak: 0.5 },
];

const PATTERNS: Record<SoundKind, Note[]> = {
	question: QUESTION,
	done: DONE,
	subagentDone: DONE,
	start: START,
	error: ERROR,
	approval: APPROVAL,
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

export function playSound(kind: SoundKind, settings: SoundSettings = loadSoundSettings()): void {
	if (!settings.enabled || !settings[kind]) return;
	const c = audio();
	if (!c) return;
	const volume = Math.max(0, Math.min(1, settings.volume / 100));
	for (const note of PATTERNS[kind]) tone(c, note, volume);
}
