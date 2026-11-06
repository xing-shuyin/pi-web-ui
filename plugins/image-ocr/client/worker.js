self.onmessage = async ({ data: { bytes } }) => {
	let engine;
	try {
		importScripts("https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js");
		let progress = 0;
		engine = await Tesseract.createWorker(["chi_sim", "eng"], 1, {
			workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js",
			corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0",
			logger(message) {
				const value =
					message.status === "recognizing text" ? 0.5 + (message.progress || 0) * 0.5 : (message.progress || 0) * 0.45;
				progress = Math.max(progress, value);
				self.postMessage({ type: "progress", progress });
			},
		});
		const { data } = await engine.recognize(bytes);
		self.postMessage({ type: "result", text: data.text });
	} catch (error) {
		self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
	} finally {
		await engine?.terminate();
	}
};
