export interface ProcessedImage {
	data: string;
	mimeType: string;
	name: string;
	size: number;
}

const MAX_DIMENSION = 1568;
const MAX_BYTES = 2 * 1024 * 1024;

export function isRasterImage(mime: string): boolean {
	return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/svg";
}

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
			const m = dataUrl.match(/^data:([^;]+);base64,/);
			const actualMime = m ? m[1] : mime;
			const data = dataUrl.replace(/^data:[^;]*;base64,/, "");
			const size = Math.floor((data.length * 3) / 4);
			last = { data, mimeType: actualMime, name: file.name, size };
			if (size <= MAX_BYTES) return last;
		}
		return last;
	} finally {
		bitmap.close();
	}
}
