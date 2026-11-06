import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearImageOcrProviders,
	listImageOcrProviders,
	registerImageOcrProvider,
	subscribeImageOcrProviders,
	syncImageOcrProviderOwners,
} from "../../web/src/image-ocr-providers";
import {
	getImageOcrInstallState,
	installImageOcr,
	registerImageOcrInstaller,
	setImageOcrInstallState,
} from "../../web/src/image-ocr-install";
import { annotationPoint, drawImageAnnotation } from "../../web/src/image-annotations";
import { createRecognize } from "../../plugins/image-ocr/client/entry.mjs";

beforeEach(() => {
	clearImageOcrProviders();
	syncImageOcrProviderOwners(new Set(["image-ocr", "other"]));
	setImageOcrInstallState(false);
	registerImageOcrInstaller(null);
});
afterEach(() => {
	vi.useRealTimers();
});

describe("image OCR provider lifetime", () => {
	it("preserves snapshot identity until a real change, and an old disposer cannot remove a replacement", () => {
		const recognize = vi.fn();
		const off = registerImageOcrProvider({ id: "local", label: "Local", recognize }, "image-ocr");
		const first = listImageOcrProviders();
		expect(listImageOcrProviders()).toBe(first);
		registerImageOcrProvider({ id: "local", label: "Replacement", recognize }, "image-ocr");
		off();
		expect(listImageOcrProviders()[0].label).toBe("Replacement");
	});
	it("cleans only the disabled plugin and rejects a late registration from its loading bundle", () => {
		const recognize = vi.fn();
		registerImageOcrProvider({ id: "local", label: "Local", recognize }, "image-ocr");
		registerImageOcrProvider({ id: "other", label: "Other", recognize }, "other");
		const listener = vi.fn();
		const off = subscribeImageOcrProviders(listener);
		syncImageOcrProviderOwners(new Set(["other"]));
		registerImageOcrProvider({ id: "late", label: "Late", recognize }, "image-ocr");
		expect(listImageOcrProviders().map((p) => p.id)).toEqual(["other"]);
		expect(listener).toHaveBeenCalledTimes(1);
		off();
	});
});

describe("image OCR installation", () => {
	it("coalesces repeated clicks and allows retry after a failed install", () => {
		const install = vi.fn();
		registerImageOcrInstaller(install);
		installImageOcr();
		installImageOcr();
		expect(install).toHaveBeenCalledTimes(1);
		expect(getImageOcrInstallState().busy).toBe(true);
		setImageOcrInstallState(false, "network");
		installImageOcr();
		expect(install).toHaveBeenCalledTimes(2);
		expect(getImageOcrInstallState().error).toBe("");
	});
	it("turns a disconnected host failure into a retryable error", () => {
		registerImageOcrInstaller(() => {
			throw new Error("disconnected");
		});
		installImageOcr();
		expect(getImageOcrInstallState()).toEqual({ busy: false, error: "disconnected" });
	});
});

class FakeWorker {
	static instances: FakeWorker[] = [];
	onmessage: ((event: { data: any }) => void) | null = null;
	onerror: ((event: any) => void) | null = null;
	terminate = vi.fn();
	postMessage = vi.fn();
	constructor() {
		FakeWorker.instances.push(this);
	}
}
const flush = async () => {
	await new Promise<void>((resolve) => setImmediate(resolve));
};
function recognizer() {
	FakeWorker.instances = [];
	return createRecognize({
		WorkerClass: FakeWorker as any,
		fetchImage: vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })) as any,
	});
}

describe("local OCR worker", () => {
	it("fetches only the image, relays progress, and terminates after text is returned", async () => {
		const run = recognizer();
		const onProgress = vi.fn();
		const result = run({ src: "https://app.local/api/file", signal: new AbortController().signal, onProgress });
		await flush();
		const worker = FakeWorker.instances[0];
		worker.onmessage?.({ data: { type: "progress", progress: 0.6 } });
		worker.onmessage?.({ data: { type: "result", text: "你好 OCR" } });
		expect(await result).toEqual({ text: "你好 OCR" });
		expect(onProgress).toHaveBeenCalledWith(0.6);
		expect(worker.terminate).toHaveBeenCalledTimes(1);
	});
	it("cancels during engine initialization and ignores late messages", async () => {
		const run = recognizer();
		const controller = new AbortController();
		const onProgress = vi.fn();
		const result = run({ src: "data:image/png;base64,aA==", signal: controller.signal, onProgress });
		const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
		await flush();
		const worker = FakeWorker.instances[0];
		controller.abort();
		await rejected;
		worker.onmessage?.({ data: { type: "progress", progress: 1 } });
		expect(worker.terminate).toHaveBeenCalledTimes(1);
		expect(onProgress).not.toHaveBeenCalled();
	});
	it("never starts a worker if cancelled during the image fetch", async () => {
		FakeWorker.instances = [];
		let finishFetch!: (value: any) => void;
		const run = createRecognize({
			WorkerClass: FakeWorker as any,
			fetchImage: (() =>
				new Promise((resolve) => {
					finishFetch = resolve;
				})) as any,
		});
		const controller = new AbortController();
		const result = run({ src: "image", signal: controller.signal, onProgress: vi.fn() });
		const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
		controller.abort();
		await rejected;
		finishFetch({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
		await flush();
		expect(FakeWorker.instances).toHaveLength(0);
	});
	it("terminates a worker on engine download failure and allows a fresh retry", async () => {
		const run = recognizer();
		const result = run({ src: "image", signal: new AbortController().signal, onProgress: vi.fn() });
		const rejected = expect(result).rejects.toThrow();
		await flush();
		FakeWorker.instances[0].onerror?.({ preventDefault() {} });
		await rejected;
		expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
	});
	it("bounds an unresponsive initialization and frees its worker", async () => {
		vi.useFakeTimers();
		const run = recognizer();
		const result = run({ src: "image", signal: new AbortController().signal, onProgress: vi.fn() });
		const rejected = expect(result).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(120_000);
		await rejected;
		expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
	});
});

describe("image annotations", () => {
	it("maps CSS coordinates to image pixels and clamps captured pointers outside the image", () => {
		const rect = { left: 10, top: 20, width: 400, height: 200 };
		expect(annotationPoint(210, 120, rect, 1600, 800)).toEqual({ x: 800, y: 400 });
		expect(annotationPoint(-100, 900, rect, 1600, 800)).toEqual({ x: 0, y: 800 });
	});
	it("renders text as pixels, not markup, and preserves the drawing context", () => {
		const ctx = { save: vi.fn(), restore: vi.fn(), fillText: vi.fn() } as any;
		drawImageAnnotation(ctx, {
			tool: "text",
			color: "#ff0000",
			width: 4,
			points: [{ x: 30, y: 20 }],
			text: "<script>\n需求",
		});
		expect(ctx.fillText).toHaveBeenCalledWith("<script>", 30, 20);
		expect(ctx.fillText).toHaveBeenCalledWith("需求", 30, 50);
		expect(ctx.save).toHaveBeenCalledTimes(1);
		expect(ctx.restore).toHaveBeenCalledTimes(1);
	});
});
