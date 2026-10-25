/**
 * Local text-to-speech announcements for pi-web-ui.
 *
 * Uses the browser's built-in SpeechSynthesis API only — no cloud keys, no
 * bundled models, nothing to install. Same persistence and opt-in philosophy
 * as sounds.ts: settings live in localStorage and the whole feature is off
 * until the user enables it in Settings → Sound & Voice.
 *
 * Two independent knobs (see TtsSettings):
 *  - announce:     speak a short canned line for cue events (turn finished /
 *                  waiting for input / error / tool approval), mirroring the
 *                  sound + desktop-notification channels.
 *  - readReplies:  when a turn finishes, speak the assistant's final reply
 *                  (markdown stripped, length-capped) instead of the canned
 *                  "finished" line.
 *
 * Like notify(), speech only fires while the user is NOT watching the page —
 * callers gate on shouldSuppressNotify() so the three channels (cue sound,
 * desktop toast, voice) never all fire at once while someone is reading.
 */

import { getPluginTtsProvider } from "./plugin-host";

export interface TtsSettings {
	/** Master switch for AUTOMATIC announcements (opt-in, default off). The
	 * message toolbar's manual read-aloud button ignores this on purpose:
	 * an explicit click is its own intent. */
	enabled: boolean;
	/** Speak short canned lines for cue events (finished / input / error / approval). */
	announce: boolean;
	/** On turn finish, read the assistant's final reply instead of the canned line. */
	readReplies: boolean;
	/** Stream speech as sentences arrive (speak while typing), default true when readReplies is on. */
	streamReplies: boolean;
	/** Speech rate 0.5–2 (1 = normal). */
	rate: number;
	/** Preferred voice URI; empty = auto-pick a voice matching the page language. */
	voiceURI: string;
	/** TTS engine: "builtin" (browser SpeechSynthesis) or custom provider ID. */
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

/** Upper bound for spoken replies — nobody wants a 5-minute monologue. */
export const MAX_TTS_CHARS = 600;

/** Read persisted settings, falling back to defaults on any failure. */
export function loadTtsSettings(): TtsSettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_TTS_SETTINGS };
		const merged: TtsSettings = { ...DEFAULT_TTS_SETTINGS, ...(JSON.parse(raw) as Partial<TtsSettings>) };
		// Sanitize stored values so a corrupted or out-of-range entry can't
		// break the slider or make speech unintelligible.
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
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// storage unavailable (private mode etc.) — settings just won't persist
	}
}

/** True when the browser exposes SpeechSynthesis at all. */
export function isTtsAvailable(): boolean {
	return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * Pick the utterance voice: exact URI match first, then first voice whose
 * lang matches the page language prefix, else null (browser default voice).
 * Pure so settings UI and tests can reuse it; `voices` may be empty — Chrome
 * populates getVoices() asynchronously and an empty list just means default.
 */
export function resolveVoice(
	voiceURI: string,
	voices: { voiceURI: string; lang: string }[],
	pageLang: string,
): { voiceURI: string; lang: string } | null {
	if (voiceURI) {
		const exact = voices.find((v) => v.voiceURI === voiceURI);
		if (exact) return exact;
	}
	const prefix = pageLang.split("-")[0]?.toLowerCase();
	if (!prefix) return null;
	return voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ?? null;
}

/**
 * Strip markdown down to something pleasant to listen to: code blocks and
 * images are dropped entirely, links collapse to their text, and heading /
 * emphasis / table / quote syntax is removed. Pure.
 */
export function stripMarkdownForSpeech(input: string, maxChars: number = MAX_TTS_CHARS): string {
	let text = input ?? "";
	text = text.replace(/```[\s\S]*?(?:```|$)/g, " "); // fenced code (also unterminated)
	text = text.replace(/`([^`]+)`/g, "$1"); // inline code → its content
	text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // images
	text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links → text
	text = text.replace(/^\s{0,3}#{1,6}\s+/gm, ""); // headings
	text = text.replace(/^\s{0,3}>\s?/gm, ""); // blockquotes
	text = text.replace(/^\s*[-*+]\s+/gm, ""); // unordered bullets
	text = text.replace(/^\s*\|?[\s:|-]*\|[\s:|-]*$/gm, ""); // table separator rows
	text = text.replace(/\|/g, " "); // remaining table pipes
	text = text.replace(/(\*\*\*|\*\*|__)(.*?)\1/g, "$2"); // bold
	text = text.replace(/(\*|_)([^*_\n]+)\1/g, "$2"); // italic
	text = text.replace(/<[^>]+>/g, " "); // stray html tags
	text = text.replace(/\r/g, "");
	text = text.replace(/[ \t]+/g, " ");
	text = text.replace(/\s*\n+\s*/g, " "); // spoken text is one breath flow — newlines become spaces
	text = text.trim();
	if (maxChars > 0 && text.length > maxChars) text = `${text.slice(0, maxChars).trimEnd()}…`;
	return text;
}

/**
 * 响应式流式断句管道（Token-to-Speech Streaming Pipeline）：
 * 解耦 React 组件渲染周期，实现增量 O(1) 状态机断句与轻量 Markdown 清理。
 */
export class StreamSentenceExtractor {
	private cursor = 0;
	private onSentence: (sentence: string) => void;

	constructor(onSentence: (sentence: string) => void) {
		this.onSentence = onSentence;
	}

	/** 增量推送最新累计文本，自动断句并回调。 */
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

	/** 冲刷末尾尚未以标点结尾的残余句子（流式生成结束时触发）。 */
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

	/** 重置管道游标（新一轮流式开始时调用）。 */
	reset(): void {
		this.cursor = 0;
	}
}

/** Minimal message shape (subset of UiMessage) so tests stay framework-free. */
interface SpeechLikeMessage {
	role: string;
	content: { type?: string; text?: string }[];
}

/**
 * Plain text of the LAST assistant message: concatenated text blocks with
 * markdown stripped. Thinking/tool blocks and other roles are skipped.
 * Returns "" when there is nothing speakable. Pure.
 */
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

/**
 * Global speaking state with a tiny subscription — the message toolbar's
 * per-message "read aloud / stop" button toggles on it. speechSynthesis is a
 * browser-wide singleton, so the state lives here, not per component.
 */
let speakingActive = false;
let speakingSource: string | null = null;
let activeProviderStop: (() => void) | null = null;
let activeStreamQueue: StreamSpeechQueue | null = null;
// 最近一次真正提交给 synth.speak 的词条。被 cancel 的旧词条其 onend/onerror 在多数
// 浏览器是异步触发的，可能晚于新词条开播 —— 用引用比对守卫，避免旧词条的回调把
// 新词条的 speaking 标志误清（按钮态错乱、isSpeaking 失真）。
let speakingUtter: SpeechSynthesisUtterance | null = null;
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
		} catch {
			// a broken listener must not break the others
		}
	}
}

/** True while an utterance started by this module is (probably) still playing. */
export function isSpeaking(): boolean {
	return speakingActive;
}

/** Caller-chosen id of the utterance in flight (message id on the toolbar), else null. */
export function speakingSourceId(): string | null {
	return speakingActive ? speakingSource : null;
}

/** Subscribe to speaking-state changes; returns an unsubscribe function. */
export function onSpeakingChange(cb: (speaking: boolean) => void): () => void {
	speakingListeners.add(cb);
	return () => speakingListeners.delete(cb);
}

/**
 * Speak `text` (any settings/availability failures silently no-op, mirroring
 * playSound's pre-gesture behaviour). Cancels any in-flight utterance first
 * so overlapping cues can't stack into an unintelligible queue. `sourceId`
 * tags the utterance so per-message buttons know whether THEY are speaking.
 */
export function speak(text: string, settings: TtsSettings = loadTtsSettings(), sourceId?: string): void {
	if (!text) return;
	stopSpeaking();

	const engine = (settings.engine || "builtin").trim();
	const provider = engine !== "builtin" ? getPluginTtsProvider(engine) : undefined;

	// 如果配置了插件级通用 TTS 提供者（如豆包语音、Edge-TTS 等），优先由提供者执行
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

	if (!isTtsAvailable()) return;
	try {
		const synth = window.speechSynthesis;
		const utter = new SpeechSynthesisUtterance(text);
		utter.rate = settings.rate;
		const voice = resolveVoice(settings.voiceURI, synth.getVoices(), navigator.language);
		if (voice) utter.voice = voice as SpeechSynthesisVoice;
		utter.onend = () => {
			if (speakingUtter === utter) setSpeaking(false);
		};
		utter.onerror = () => {
			if (speakingUtter === utter) setSpeaking(false);
		};
		speakingUtter = utter;
		setSpeaking(true, sourceId ?? null);
		synth.speak(utter);
	} catch {
		speakingUtter = null;
		setSpeaking(false);
	}
}

/** Stop any in-flight speech (tab switch, dialog open, …). */
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
	if (isTtsAvailable()) {
		try {
			window.speechSynthesis.cancel();
		} catch {}
	}
	speakingUtter = null;
	setSpeaking(false);
}

/**
 * 流式边打字边开口说话音频队列管理器（StreamSpeechQueue）
 * 接收分句流，流水线式顺序播放，后台无缝预取下一句
 */
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
			const provider = engine !== "builtin" ? getPluginTtsProvider(engine) : undefined;

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
			} else if (isTtsAvailable()) {
				const synth = window.speechSynthesis;
				const utter = new SpeechSynthesisUtterance(sentence);
				utter.rate = this.settings.rate;
				const voice = resolveVoice(this.settings.voiceURI, synth.getVoices(), navigator.language);
				if (voice) utter.voice = voice as SpeechSynthesisVoice;
				utter.onend = () => resolve();
				utter.onerror = () => resolve();
				this.stopCurrentAudio = () => {
					try {
						synth.cancel();
					} catch {}
					resolve();
				};
				synth.speak(utter);
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

/** 开启一个新的流式朗读音频队列 */
export function startStreamSpeech(settings: TtsSettings = loadTtsSettings(), sourceId?: string): StreamSpeechQueue {
	stopSpeaking();
	const q = new StreamSpeechQueue(settings, sourceId);
	activeStreamQueue = q;
	return q;
}

/** 停止当前的流式朗读队列 */
export function stopStreamSpeech(): void {
	if (activeStreamQueue) {
		activeStreamQueue.stop();
		activeStreamQueue = null;
	}
}
