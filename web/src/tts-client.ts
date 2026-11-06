import { appUrl } from "./base-url";
import type { PluginHostTtsProvider, PluginHostTtsProviderInfo } from "./plugin-host";

let engines: PluginHostTtsProviderInfo[] = [{ id: "builtin", label: "系统语音", labelEn: "System speech" }];
const listeners = new Set<() => void>();
let refreshInFlight: Promise<void> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

async function responseError(response: Response): Promise<Error> {
	const data = await response.json().catch(() => ({}));
	return new Error(data.error || `TTS HTTP ${response.status}`);
}

export function refreshTtsEngines(): Promise<void> {
	if (!refreshInFlight)
		refreshInFlight = (async () => {
			const response = await fetch(appUrl("/api/tts/engines"));
			if (!response.ok) throw await responseError(response);
			const data = await response.json();
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
			const response = await fetch(appUrl(`/api/tts/voices?engine=${encodeURIComponent(id)}`));
			if (!response.ok) throw await responseError(response);
			const data = await response.json();
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
					const response = await fetch(appUrl("/api/tts/synthesize"), {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ text, engine: id, voice: voiceURI || "", rate }),
						signal: controller.signal,
					});
					if (!response.ok) throw await responseError(response);
					const blob = await response.blob();
					if (stopped) return;
					url = URL.createObjectURL(blob);
					audio = new Audio(url);
					audio.onplay = () => {
						if (!stopped) onStart?.();
					};
					audio.onended = () => finish();
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
