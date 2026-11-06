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
			const zh = globalThis.document?.documentElement?.lang?.startsWith("zh") !== false;
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
				finish(
					new Error(
						zh
							? "识别超时。请检查网络后重试，首次使用需要下载字库。"
							: "OCR timed out. Check your connection; first use downloads language data.",
					),
				);
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
						else if (data.type === "error")
							finish(new Error(zh ? `识别失败：${data.message}` : `OCR failed: ${data.message}`));
					};
					worker.onerror = (event) => {
						event.preventDefault?.();
						finish(
							new Error(
								zh
									? "OCR 引擎加载失败，请检查网络后重试。"
									: "Failed to load the OCR engine. Check your connection and retry.",
							),
						);
					};
					worker.postMessage({ bytes }, [bytes]);
				} catch (error) {
					finish(
						signal.aborted
							? new DOMException("Cancelled", "AbortError")
							: new Error(
									zh
										? "图片读取或识别失败。远程图片需允许跨域访问，可先保存为本地附件后重试。"
										: "Unable to read the image. Remote images require CORS access; save and attach the image locally to retry.",
									{ cause: error },
								),
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
