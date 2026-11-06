import { listSystemSpeechVoices, synthesizeSystemSpeech } from "./tts-system.js";

export interface TtsVoice {
	id: string;
	label: string;
	lang?: string;
}

export interface TtsRequest {
	text: string;
	engine?: string;
	voice?: string;
	rate?: number;
	signal?: AbortSignal;
}

export interface TtsAudio {
	buffer: Uint8Array;
	format: "wav" | "mp3" | "aac" | "ogg" | "pcm" | "silk";
	sampleRate?: number;
	durationMs?: number;
}

export interface TtsEngine {
	supportsRate?: boolean;
	id: string;
	label: string;
	labelEn?: string;
	getVoices(options: { signal: AbortSignal }): Promise<TtsVoice[]> | TtsVoice[];
	synthesize(request: TtsRequest & { signal: AbortSignal }): Promise<TtsAudio>;
}

export interface TtsEngineInfo {
	supportsRate?: boolean;
	id: string;
	label: string;
	labelEn?: string;
}

export interface TtsClient {
	listEngines(): TtsEngineInfo[];
	listVoices(engine: string, options?: { signal?: AbortSignal }): Promise<TtsVoice[]>;
	synthesize(request: TtsRequest): Promise<TtsAudio>;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export class TtsService implements TtsClient {
	private engines = new Map<
		string,
		{ owner: string; engine: TtsEngine; lifetime: AbortController; tail: Promise<unknown> }
	>();

	registerEngine(owner: string, engine: TtsEngine): () => void {
		if (
			!engine.id?.trim() ||
			!engine.label?.trim() ||
			typeof engine.synthesize !== "function" ||
			typeof engine.getVoices !== "function"
		) {
			throw new Error("TTS engine requires id, label, getVoices and synthesize");
		}
		const id = engine.id;
		if (this.engines.has(id)) throw new Error(`TTS engine already registered: ${id}`);
		const entry = {
			owner,
			engine: {
				...engine,
				id,
				label: engine.label,
				labelEn: engine.labelEn,
				supportsRate: engine.supportsRate,
				getVoices: engine.getVoices.bind(engine),
				synthesize: engine.synthesize.bind(engine),
			},
			lifetime: new AbortController(),
			tail: Promise.resolve() as Promise<unknown>,
		};
		this.engines.set(id, entry);
		return () => {
			if (this.engines.get(id) !== entry) return;
			this.engines.delete(id);
			entry.lifetime.abort(new Error(`TTS engine unregistered: ${id}`));
		};
	}

	listEngines(): TtsEngineInfo[] {
		return [...this.engines.values()].map(({ engine: { id, label, labelEn, supportsRate } }) => ({
			id,
			label,
			...(labelEn ? { labelEn } : {}),
			...(supportsRate === false ? { supportsRate: false } : {}),
		}));
	}

	async listVoices(engine: string, { signal }: { signal?: AbortSignal } = {}): Promise<TtsVoice[]> {
		const entry = this.getEngine(engine);
		const combined = AbortSignal.any([entry.lifetime.signal, AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
		combined.throwIfAborted();
		const voices = await abortable(
			Promise.resolve().then(() => entry.engine.getVoices({ signal: combined })),
			combined,
		);
		return voices.map(({ id, label, lang }) => ({
			id: String(id),
			label: String(label),
			...(lang ? { lang: String(lang) } : {}),
		}));
	}

	async synthesize(request: TtsRequest): Promise<TtsAudio> {
		const text = String(request.text ?? "").trim();
		if (!text) throw new Error("TTS text is empty");
		if (text.length > 6000) throw new Error("TTS text exceeds 6000 characters");
		const entry = this.getEngine(request.engine || "builtin");
		const signal = AbortSignal.any([
			entry.lifetime.signal,
			AbortSignal.timeout(90000),
			...(request.signal ? [request.signal] : []),
		]);
		const rate = entry.engine.supportsRate === false ? 1 : Math.max(0.5, Math.min(2, Number(request.rate) || 1));
		const operation = entry.tail.then(async () => {
			signal.throwIfAborted();
			const audio = await abortable(
				Promise.resolve().then(() =>
					entry.engine.synthesize({ text, engine: entry.engine.id, voice: String(request.voice || ""), rate, signal }),
				),
				signal,
			);
			if (!(audio?.buffer instanceof Uint8Array) || !audio.buffer.byteLength)
				throw new Error("TTS engine returned empty audio");
			if (audio.buffer.byteLength > 16 * 1024 * 1024) throw new Error("TTS audio exceeds 16 MiB");
			if (!["wav", "mp3", "aac", "ogg", "pcm", "silk"].includes(audio.format))
				throw new Error("Unsupported TTS audio format");
			if (audio.format === "pcm" && (!Number.isInteger(audio.sampleRate) || Number(audio.sampleRate) <= 0))
				throw new Error("PCM audio requires a sample rate");
			return { ...audio, buffer: Buffer.from(audio.buffer) };
		});
		entry.tail = operation.catch(() => {});
		return abortable(operation, signal);
	}

	private getEngine(id: string) {
		const entry = this.engines.get(id);
		if (!entry) throw new Error(`TTS engine unavailable: ${id}`);
		return entry;
	}
}

export const ttsService = new TtsService();
ttsService.registerEngine("builtin", {
	id: "builtin",
	label: "系统语音",
	labelEn: "System speech",
	getVoices: listSystemSpeechVoices,
	synthesize: ({ text, voice, rate, signal }) => synthesizeSystemSpeech(text, { voice, rate, signal }),
});
