import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveDownloadBlob = vi.hoisted(() => vi.fn());
vi.mock("../../web/src/download", () => ({ saveDownloadBlob }));
import {
	copyPreviewImage,
	downloadPreviewImage,
	imagePreviewFilename,
	loadPreviewImage,
} from "../../web/src/image-preview-actions";

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe("image preview actions", () => {
	it("keeps names consistent with annotated PNGs and original JPEGs", () => {
		expect(imagePreviewFilename("C:\\shots\\截图.jpg", "image/png")).toBe("截图.png");
		expect(imagePreviewFilename("photo.jpeg", "image/jpeg")).toBe("photo.jpeg");
		expect(imagePreviewFilename("截图", "image/png")).toBe("截图.png");
		expect(imagePreviewFilename(undefined, "image/webp")).toBe("image.webp");
	});

	it("preserves original image bytes and MIME for downloads", async () => {
		const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(blob)));
		const file = await loadPreviewImage("/image", "photo.png");
		expect(file.name).toBe("photo.jpg");
		expect(file.type).toBe("image/jpeg");
		expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2, 3]);
	});

	it("recognizes JPEG bytes served as octet-stream instead of mislabeling them as PNG", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "application/octet-stream" })),
				),
		);
		const file = await loadPreviewImage("/image", "photo.png");
		expect(file.type).toBe("image/jpeg");
		expect(file.name).toBe("photo.jpg");
	});

	it("does not offer a failed or empty image as a successful download", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
		await expect(downloadPreviewImage("/missing")).rejects.toThrow("HTTP 404");
		expect(saveDownloadBlob).not.toHaveBeenCalled();
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob([]))));
		await expect(downloadPreviewImage("/empty")).rejects.toThrow("Empty image");
	});

	it("treats save-dialog cancellation separately from a successful or failed download", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => new Response(new Blob(["png"], { type: "image/png" }))),
		);
		saveDownloadBlob.mockResolvedValueOnce({ ok: false, cancelled: true });
		await expect(downloadPreviewImage("/image")).resolves.toBe(false);
		saveDownloadBlob.mockResolvedValueOnce({ ok: true });
		await expect(downloadPreviewImage("/image")).resolves.toBe(true);
		saveDownloadBlob.mockResolvedValueOnce({ ok: false, cancelled: false, error: "Disk full" });
		await expect(downloadPreviewImage("/image")).rejects.toThrow("Disk full");
	});

	it("does not save an image after its preview has been closed", async () => {
		const controller = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => {
				controller.abort();
				return new Response(new Blob(["png"], { type: "image/png" }));
			}),
		);
		await expect(downloadPreviewImage("/image", "image.png", controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(saveDownloadBlob).not.toHaveBeenCalled();
	});

	it("starts the clipboard write before image fetching completes, preserving user activation", async () => {
		let finishFetch!: (response: Response) => void;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(
				() =>
					new Promise<Response>((resolve) => {
						finishFetch = resolve;
					}),
			),
		);
		let png!: Promise<Blob>;
		vi.stubGlobal(
			"ClipboardItem",
			class {
				constructor(items: Record<string, Promise<Blob>>) {
					png = items["image/png"];
				}
			},
		);
		const write = vi.fn().mockImplementation(async () => {
			await png;
		});
		vi.stubGlobal("navigator", { clipboard: { write } });
		const copied = copyPreviewImage("/image");
		expect(write).toHaveBeenCalledTimes(1);
		finishFetch(new Response(new Blob(["original PNG bytes"], { type: "image/png" })));
		await copied;
		expect(await (await png).text()).toBe("original PNG bytes");
	});

	it("reports missing clipboard support before fetching image bytes", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		vi.stubGlobal("navigator", {});
		await expect(copyPreviewImage("/image")).rejects.toMatchObject({ name: "NotSupportedError" });
		expect(fetch).not.toHaveBeenCalled();
	});
});
