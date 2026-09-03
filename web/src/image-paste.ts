/**
 * Client-side image normalization for paste / drag-drop / upload:
 * downscale to a vision-friendly size and re-encode so the payload stays
 * well under the server's 2MB cap for pasted images (MAX_PASTED_IMAGE_BYTES
 * in agent-service.ts). Keeps EXIF orientation and transparency where
 * possible.
 */

export interface ProcessedImage {
	/** Pure base64 (no data: prefix). */
	data: string;
	mimeType: string;
	name: string;
	/** Decoded byte size. */
	size: number;
}

/** Largest edge (px) we send to the model — covers ~1.5K vision crops. */
const MAX_DIMENSION = 1568;
/** Must match server MAX_PASTED_IMAGE_BYTES (agent-service.ts). */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Whether a MIME type goes through the raster image pipeline (downscale +
 * re-encode + image content). Vector/odd formats (SVG and anything else
 * under image/* that the canvas pipeline can't handle reliably) are attached
 * as plain files instead — the model reads their source, which is far more
 * useful than a rasterized blob.
 */
export function isRasterImage(mime: string): boolean {
	return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/svg";
}

/**
 * Read + downscale + encode an image File. Returns null when the browser
 * can't decode it (e.g. unsupported format) or it isn't an image.
 */
export async function fileToProcessedImage(file: File): Promise<ProcessedImage | null> {
	if (!file.type.startsWith("image/")) return null;
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
	} catch {
		return null;
	}
	try {
		const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
		const w = Math.max(1, Math.round(bitmap.width * scale));
		const h = Math.max(1, Math.round(bitmap.height * scale));

		// Lossy sources (photos) go straight to JPEG; lossless ones (screenshots,
		// PNG exports) try PNG first and only flatten onto white + JPEG when PNG
		// is too big. Each attempt re-draws from the bitmap so we never bake the
		// white fill into a PNG attempt.
		const candidates: [string, number][] =
			file.type === "image/jpeg" || file.type === "image/jpg"
				? [
						["image/jpeg", 0.85],
						["image/jpeg", 0.6],
						["image/webp", 0.8],
					]
				: [
						["image/png", 1],
						["image/jpeg", 0.85],
						["image/jpeg", 0.6],
					];

		let last: ProcessedImage | null = null;
		for (const [mime, quality] of candidates) {
			const canvas = document.createElement("canvas");
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext("2d");
			if (!ctx) continue;
			if (mime !== "image/png") {
				ctx.fillStyle = "#ffffff";
				ctx.fillRect(0, 0, w, h);
			}
			ctx.drawImage(bitmap, 0, 0, w, h);
			const dataUrl = canvas.toDataURL(mime, quality);
			// Trust the actual output mime (browsers silently fall back to PNG
			// when an encoder is missing, e.g. webp on older Safari).
			const m = dataUrl.match(/^data:([^;]+);base64,/);
			const actualMime = m ? m[1] : mime;
			const data = dataUrl.replace(/^data:[^;]*;base64,/, "");
			const size = Math.floor((data.length * 3) / 4);
			last = { data, mimeType: actualMime, name: file.name, size };
			if (size <= MAX_BYTES) return last;
		}
		// Nothing fit under the cap — return the smallest attempt anyway; the
		// server will reject it with a readable notice.
		return last;
	} finally {
		bitmap.close();
	}
}
