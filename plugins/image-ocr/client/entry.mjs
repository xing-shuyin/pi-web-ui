import { makeT } from "./i18n.mjs";

/** 识别失败等面向用户的文案走插件词典 t()，语言跟随宿主全局设置（SDK 内读 locale.current()）。 */
const t = makeT();

export function createRecognize({ WorkerClass = globalThis.Worker, fetchImage = globalThis.fetch } = {}) {
	return ({ src, signal, onProgress }) =>
		new Promise((resolve, reject) => {
			if (signal.aborted) {
				reject(new DOMException("Cancelled", "AbortError"));
				return;
			}
			let worker;
			let finished = false;
			const imageFetch = new AbortController();
			const finish = (error, result) => {
				if (finished) return;
				finished = true;
				clearTimeout(timeout);
				signal.removeEventListener("abort", abort);
				imageFetch.abort();
				worker?.terminate();
				if (error) reject(error);
				else resolve(result);
			};
			const abort = () => finish(new DOMException("Cancelled", "AbortError"));
			const timeout = setTimeout(() => {
				finish(new Error(t("timeout")));
			}, 120_000);
			signal.addEventListener("abort", abort, { once: true });
			void (async () => {
				try {
					const response = await fetchImage(src, { signal: imageFetch.signal, credentials: "same-origin" });
					if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
					const bytes = await response.arrayBuffer();
					if (finished) return;
					worker = new WorkerClass(new URL("./worker.js", import.meta.url));
					worker.onmessage = ({ data }) => {
						if (finished) return;
						if (data.type === "progress") onProgress(data.progress);
						else if (data.type === "result") finish(null, { text: data.text });
						else if (data.type === "error") finish(new Error(t("failed", { message: data.message })));
					};
					worker.onerror = (event) => {
						event.preventDefault?.();
						finish(new Error(t("engineLoadFailed")));
					};
					worker.postMessage({ bytes }, [bytes]);
				} catch (error) {
					finish(
						signal.aborted ? new DOMException("Cancelled", "AbortError") : new Error(t("readFailed"), { cause: error }),
					);
				}
			})();
		});
}

const host = globalThis.window?.__piWebUiHost;
if (host?.imageOcrProviders) {
	host.imageOcrProviders.register({
		id: "image-ocr",
		label: "本地中英文 OCR",
		labelEn: "Local Chinese / English OCR",
		recognize: createRecognize(),
	});
}
