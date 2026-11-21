import { apiFetch, readApiFailure, requestJson } from "./api-client";
import type { PluginHostTtsProvider, PluginHostTtsProviderInfo } from "./plugin-host";

// Built-in provider ships the same label/labelEn pair as plugin providers; consumers pick one (data).
let engines: PluginHostTtsProviderInfo[] = [{ id: "builtin", label: "系统语音", labelEn: "System speech" }];
const listeners = new Set<() => void>();
let refreshInFlight: Promise<void> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

export function refreshTtsEngines(): Promise<void> {
	if (!refreshInFlight)
		refreshInFlight = (async () => {
			const data = await requestJson<{ engines: PluginHostTtsProviderInfo[] }>("/api/tts/engines");
			engines = data.engines;
			for (const listener of listeners) listener();
		})().finally(() => {
			refreshInFlight = undefined;
		});
	return refreshInFlight;
}

export function listPluginTtsProviders(): PluginHostTtsProviderInfo[] {
	return [...engines];
}

export function getPluginTtsProvider(id: string): PluginHostTtsProvider | undefined {
	if (!id) return undefined;
	return {
		...(engines.find((engine) => engine.id === id) || { id, label: id }),
		getVoices: async () => {
			const data = await requestJson<{ voices: { id: string; label: string; lang?: string }[] }>(
				`/api/tts/voices?engine=${encodeURIComponent(id)}`,
			);
			return data.voices.map((voice: { id: string; label: string; lang?: string }) => ({
				voiceURI: voice.id,
				name: voice.label,
				lang: voice.lang,
			}));
		},
		play: ({ text, rate, voiceURI, onStart, onEnd, onError }) => {
			const controller = new AbortController();
			let audio: HTMLAudioElement | undefined;
			let url: string | undefined;
			let stopped = false;
			const cleanup = () => {
				controller.abort();
				if (audio) {
					audio.pause();
					audio.removeAttribute("src");
					audio.load();
				}
				if (url) {
					URL.revokeObjectURL(url);
					url = undefined;
				}
			};
			const finish = (error?: Error) => {
				if (stopped) return;
				stopped = true;
				cleanup();
				if (error) onError?.(error);
				else onEnd?.();
			};
			void (async () => {
				try {
					const response = await apiFetch("/api/tts/synthesize", {
						body: { text, engine: id, voice: voiceURI || "", rate },
						signal: controller.signal,
					});
					if (!response.ok) throw new Error((await readApiFailure(response)).error);
					const blob = await response.blob();
					if (stopped) return;
					url = URL.createObjectURL(blob);
					audio = new Audio(url);
					audio.onplay = () => {
						if (!stopped) onStart?.();
					};
					audio.onended = () => finish();
					// Synthetic error: both call sites discard the message, so it never reaches the UI (data).
					audio.onerror = () => finish(new Error("语音播放失败"));
					await audio.play();
				} catch (error) {
					if (!stopped) finish(error as Error);
				}
			})();
			return () => {
				if (!stopped) {
					stopped = true;
					cleanup();
				}
			};
		},
	};
}

export function onTtsProvidersChange(callback: () => void): () => void {
	listeners.add(callback);
	void refreshTtsEngines().catch(() => {});
	if (!refreshTimer)
		refreshTimer = setInterval(() => {
			void refreshTtsEngines().catch(() => {});
		}, 15000);
	return () => {
		listeners.delete(callback);
		if (!listeners.size && refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
	};
}
