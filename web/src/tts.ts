import { getPluginTtsProvider } from "./tts-client";

export interface TtsSettings {
	enabled: boolean;
	announce: boolean;
	readReplies: boolean;
	streamReplies: boolean;
	rate: number;
	voiceURI: string;
	engine: string;
}

const STORAGE_KEY = "pi-web-tts";

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
	enabled: false,
	announce: true,
	readReplies: false,
	streamReplies: true,
	rate: 1,
	voiceURI: "",
	engine: "builtin",
};

export const MAX_TTS_CHARS = 600;

export function loadTtsSettings(): TtsSettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_TTS_SETTINGS };
		const { voiceCatalog, ...saved } = JSON.parse(raw) as Partial<TtsSettings> & { voiceCatalog?: string };
		const merged: TtsSettings = { ...DEFAULT_TTS_SETTINGS, ...saved };
		if (merged.engine === "builtin" && voiceCatalog !== "server") merged.voiceURI = "";
		for (const k of ["enabled", "announce", "readReplies", "streamReplies"] as const) {
			if (typeof merged[k] !== "boolean") merged[k] = DEFAULT_TTS_SETTINGS[k];
		}
		if (typeof merged.rate !== "number" || !Number.isFinite(merged.rate)) {
			merged.rate = DEFAULT_TTS_SETTINGS.rate;
		} else {
			merged.rate = Math.round(Math.max(0.5, Math.min(2, merged.rate)) * 10) / 10;
		}
		if (typeof merged.voiceURI !== "string") merged.voiceURI = DEFAULT_TTS_SETTINGS.voiceURI;
		if (typeof merged.engine !== "string") merged.engine = DEFAULT_TTS_SETTINGS.engine;
		return merged;
	} catch {
		return { ...DEFAULT_TTS_SETTINGS };
	}
}

export function saveTtsSettings(settings: TtsSettings): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, voiceCatalog: "server" }));
	} catch {}
}

export function isTtsAvailable(): boolean {
	return typeof Audio !== "undefined" && typeof fetch === "function";
}

export function stripMarkdownForSpeech(input: string, maxChars: number = MAX_TTS_CHARS): string {
	let text = input ?? "";
	text = text.replace(/```[\s\S]*?(?:```|$)/g, " ");
	text = text.replace(/`([^`]+)`/g, "$1");
	text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
	text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
	text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
	text = text.replace(/^\s{0,3}>\s?/gm, "");
	text = text.replace(/^\s*[-*+]\s+/gm, "");
	text = text.replace(/^\s*\|?[\s:|-]*\|[\s:|-]*$/gm, "");
	text = text.replace(/\|/g, " ");
	text = text.replace(/(\*\*\*|\*\*|__)(.*?)\1/g, "$2");
	text = text.replace(/(\*|_)([^*_\n]+)\1/g, "$2");
	text = text.replace(/<[^>]+>/g, " ");
	text = text.replace(/\r/g, "");
	text = text.replace(/[ \t]+/g, " ");
	text = text.replace(/\s*\n+\s*/g, " ");
	text = text.trim();
	if (maxChars > 0 && text.length > maxChars) text = `${text.slice(0, maxChars).trimEnd()}…`;
	return text;
}

export class StreamSentenceExtractor {
	private cursor = 0;
	private onSentence: (sentence: string) => void;

	constructor(onSentence: (sentence: string) => void) {
		this.onSentence = onSentence;
	}

	feed(fullText: string): void {
		if (fullText.length <= this.cursor) return;
		const unconsumed = fullText.slice(this.cursor);
		const match = unconsumed.match(/(?:[。！？!?；;\n]|(?<=.{25,})[，,])/);
		if (match && typeof match.index === "number") {
			const boundary = match.index + match[0].length;
			const sentenceRaw = unconsumed.slice(0, boundary);
			this.cursor += boundary;

			const clean = stripMarkdownForSpeech(sentenceRaw, 0);
			if (clean) {
				this.onSentence(clean);
			}
		}
	}

	flush(fullText: string): void {
		if (fullText.length > this.cursor) {
			const tail = fullText.slice(this.cursor);
			const clean = stripMarkdownForSpeech(tail, 0);
			if (clean) {
				this.onSentence(clean);
			}
			this.cursor = fullText.length;
		}
	}

	reset(): void {
		this.cursor = 0;
	}
}

interface SpeechLikeMessage {
	role: string;
	content: { type?: string; text?: string }[];
}

export function assistantPlainText(messages: SpeechLikeMessage[] | undefined | null): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		const text = (m.content ?? [])
			.filter((b) => (b as { type?: string })?.type === "text" && typeof b.text === "string")
			.map((b) => b.text ?? "")
			.join("\n");
		return stripMarkdownForSpeech(text);
	}
	return "";
}

let speakingActive = false;
let speakingSource: string | null = null;
let activeProviderStop: (() => void) | null = null;
let activeStreamQueue: StreamSpeechQueue | null = null;

const speakingListeners = new Set<(speaking: boolean) => void>();

function setSpeaking(active: boolean, source: string | null = null): void {
	const nextActive = Boolean(active);
	const nextSource = nextActive ? source : null;
	if (speakingActive === nextActive && speakingSource === nextSource) return;
	speakingActive = nextActive;
	speakingSource = nextSource;
	for (const cb of speakingListeners) {
		try {
			cb(nextActive);
		} catch {}
	}
}

export function isSpeaking(): boolean {
	return speakingActive;
}

export function speakingSourceId(): string | null {
	return speakingActive ? speakingSource : null;
}

export function onSpeakingChange(cb: (speaking: boolean) => void): () => void {
	speakingListeners.add(cb);
	return () => speakingListeners.delete(cb);
}

export function speak(text: string, settings: TtsSettings = loadTtsSettings(), sourceId?: string): void {
	if (!text) return;
	stopSpeaking();

	const engine = (settings.engine || "builtin").trim();
	const provider = getPluginTtsProvider(engine);

	if (provider && typeof provider.play === "function") {
		let cancelled = false;
		setSpeaking(true, sourceId ?? null);
		try {
			const cancelFn = provider.play({
				text,
				rate: settings.rate,
				voiceURI: settings.voiceURI,
				onStart: () => {
					if (!cancelled) setSpeaking(true, sourceId ?? null);
				},
				onEnd: () => {
					if (!cancelled) {
						cancelled = true;
						activeProviderStop = null;
						setSpeaking(false);
					}
				},
				onError: () => {
					if (!cancelled) {
						cancelled = true;
						activeProviderStop = null;
						setSpeaking(false);
					}
				},
			});
			activeProviderStop = () => {
				cancelled = true;
				try {
					cancelFn?.();
				} catch {}
			};
		} catch {
			setSpeaking(false);
		}
		return;
	}
}

export function stopSpeaking(): void {
	if (activeStreamQueue) {
		activeStreamQueue.stop();
		activeStreamQueue = null;
	}
	if (activeProviderStop) {
		try {
			activeProviderStop();
		} catch {}
		activeProviderStop = null;
	}
	setSpeaking(false);
}

export class StreamSpeechQueue {
	private queue: string[] = [];
	private playing = false;
	private stopped = false;
	private stopCurrentAudio: (() => void) | null = null;
	private settings: TtsSettings;
	private sourceId?: string;
	private finishedPushing = false;

	constructor(settings: TtsSettings, sourceId?: string) {
		this.settings = settings;
		this.sourceId = sourceId;
	}

	push(sentence: string): void {
		if (this.stopped) return;
		const trimmed = sentence.trim();
		if (!trimmed) return;
		this.queue.push(trimmed);
		if (!this.playing) {
			void this.playNext();
		}
	}

	finish(): void {
		this.finishedPushing = true;
		if (!this.playing && this.queue.length === 0) {
			this.stop();
		}
	}

	private async playNext(): Promise<void> {
		if (this.stopped) return;
		if (this.queue.length === 0) {
			this.playing = false;
			if (this.finishedPushing) {
				this.stop();
			}
			return;
		}

		this.playing = true;
		const sentence = this.queue.shift()!;
		setSpeaking(true, this.sourceId ?? null);

		await new Promise<void>((resolve) => {
			const engine = (this.settings.engine || "builtin").trim();
			const provider = getPluginTtsProvider(engine);

			if (provider && typeof provider.play === "function") {
				let done = false;
				const cancel = provider.play({
					text: sentence,
					rate: this.settings.rate,
					voiceURI: this.settings.voiceURI,
					onEnd: () => {
						if (!done) {
							done = true;
							resolve();
						}
					},
					onError: () => {
						if (!done) {
							done = true;
							resolve();
						}
					},
				});
				this.stopCurrentAudio = () => {
					if (!done) {
						done = true;
						try {
							cancel?.();
						} catch {}
						resolve();
					}
				};
			} else {
				resolve();
			}
		});

		this.stopCurrentAudio = null;
		if (!this.stopped) {
			void this.playNext();
		}
	}

	stop(): void {
		this.stopped = true;
		this.queue = [];
		if (this.stopCurrentAudio) {
			try {
				this.stopCurrentAudio();
			} catch {}
			this.stopCurrentAudio = null;
		}
		this.playing = false;
		if (activeStreamQueue === this) {
			activeStreamQueue = null;
		}
		setSpeaking(false);
	}
}

export function startStreamSpeech(settings: TtsSettings = loadTtsSettings(), sourceId?: string): StreamSpeechQueue {
	stopSpeaking();
	const q = new StreamSpeechQueue(settings, sourceId);
	activeStreamQueue = q;
	return q;
}

export function stopStreamSpeech(): void {
	if (activeStreamQueue) {
		activeStreamQueue.stop();
		activeStreamQueue = null;
	}
}
