import type { PromptAttachment } from "./protocol.js";

const MAX_COUNT = 8;
const MAX_ITEM_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function normalizePluginChatAttachments(value: unknown): PromptAttachment[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_COUNT)
		throw new Error("chat: attachments must contain at most 8 items");
	let totalBytes = 0;
	return value.map((raw): PromptAttachment => {
		if (!raw || typeof raw !== "object") throw new Error("chat: invalid attachment");
		const item = raw as Record<string, unknown>;
		const path = typeof item.path === "string" ? item.path : "";
		if (path.length > 4096 || path.includes("\0")) throw new Error("chat: invalid attachment path");
		const name = typeof item.name === "string" ? item.name.slice(0, 255) : undefined;
		const mimeType = typeof item.mimeType === "string" ? item.mimeType.toLowerCase() : undefined;
		if (mimeType && (mimeType.length > 128 || /[\r\n]/.test(mimeType)))
			throw new Error("chat: invalid attachment MIME type");
		const image = item.imageData !== undefined;
		const file = item.fileData !== undefined;
		if (image && file) throw new Error("chat: attachment cannot contain both imageData and fileData");
		if (image || file) {
			const data = image ? item.imageData : item.fileData;
			if (
				typeof data !== "string" ||
				!data ||
				data.length > Math.ceil(MAX_ITEM_BYTES / 3) * 4 ||
				data.length % 4 !== 0 ||
				!/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
				Buffer.from(data, "base64").toString("base64") !== data
			) {
				throw new Error("chat: invalid or oversized base64 attachment (maximum 10 MiB)");
			}
			const bytes = Buffer.byteLength(data, "base64");
			if (bytes > MAX_ITEM_BYTES || (totalBytes += bytes) > MAX_TOTAL_BYTES)
				throw new Error("chat: attachment byte budget exceeded (10 MiB each, 20 MiB total)");
			if (image && !IMAGE_MIMES.has(mimeType ?? ""))
				throw new Error("chat: image MIME must be image/png, image/jpeg, image/gif or image/webp");
			return { path: "", name, mimeType, size: bytes, ...(image ? { imageData: data } : { fileData: data }) };
		}
		if (!path.trim() || (item.mode !== undefined && item.mode !== "reference" && item.mode !== "inline"))
			throw new Error("chat: file attachments require a path and reference mode");
		return { path, mode: "reference", name, mimeType };
	});
}
