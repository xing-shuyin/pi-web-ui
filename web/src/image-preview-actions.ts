import { saveDownloadBlob } from "./download";

const imageExtensions: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/avif": "avif",
	"image/bmp": "bmp",
	"image/svg+xml": "svg",
	"image/tiff": "tiff",
	"image/x-icon": "ico",
};
const imageSuffix = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|tiff?|ico|heic|heif)$/i;

export function imagePreviewFilename(name: string | undefined, mimeType: string): string {
	const basename = (name?.split(/[\\/]/).pop() || "image").replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
	const extension = imageExtensions[mimeType];
	if (!extension) return basename || "image";
	if (basename.toLowerCase().endsWith(`.${extension}`) || (extension === "jpg" && /\.jpeg$/i.test(basename)))
		return basename;
	return `${basename.replace(imageSuffix, "").slice(0, 180) || "image"}.${extension}`;
}

export async function loadPreviewImage(src: string, name?: string, signal?: AbortSignal): Promise<File> {
	const response = await fetch(src, { credentials: "same-origin", signal });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const blob = await response.blob();
	signal?.throwIfAborted();
	if (!blob.size) throw new Error("Empty image");
	let mimeType = blob.type;
	if (!mimeType.startsWith("image/")) {
		const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
		const ascii = String.fromCharCode(...bytes);
		mimeType =
			bytes[0] === 0x89 && ascii.slice(1, 4) === "PNG"
				? "image/png"
				: bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
					? "image/jpeg"
					: ascii.startsWith("GIF8")
						? "image/gif"
						: ascii.startsWith("RIFF") && ascii.slice(8) === "WEBP"
							? "image/webp"
							: "image/unknown";
	}
	signal?.throwIfAborted();
	return new File([blob], imagePreviewFilename(name, mimeType), { type: mimeType });
}

async function clipboardPng(src: string, signal?: AbortSignal): Promise<Blob> {
	const file = await loadPreviewImage(src, undefined, signal);
	if (file.type === "image/png") return file;
	const url = URL.createObjectURL(file);
	try {
		const image = new Image();
		image.src = url;
		await image.decode();
		signal?.throwIfAborted();
		const canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Image conversion is unavailable");
		ctx.drawImage(image, 0, 0);
		const png = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Image conversion failed"))), "image/png");
		});
		signal?.throwIfAborted();
		return png;
	} finally {
		URL.revokeObjectURL(url);
	}
}

export async function copyPreviewImage(src: string, signal?: AbortSignal): Promise<void> {
	if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
		throw new DOMException("Image clipboard is unavailable", "NotSupportedError");
	}
	const png = clipboardPng(src, signal);
	void png.catch(() => {});
	await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export async function downloadPreviewImage(src: string, name?: string, signal?: AbortSignal): Promise<boolean> {
	const file = await loadPreviewImage(src, name, signal);
	const result = await saveDownloadBlob(file, file.name);
	if (result.ok) return true;
	if (result.cancelled) return false;
	throw new Error(result.error);
}
