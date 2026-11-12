/** Shared by the native endpoints and the trusted browser bridge. */
export const CLIPBOARD_LIMITS = Object.freeze({
	bytes: 32 * 1024 * 1024,
	text: 1024 * 1024,
	image: 16 * 1024 * 1024,
	files: 32,
	chunk: 24 * 1024,
	message: 48 * 1024,
	timeout: 30_000,
});
export type ClipboardMode = "off" | "send" | "receive" | "both";
export type ClipboardKind = "text" | "image" | "files";
export type ClipboardItem = { name: string; size: number; sha256: string };
export type ClipboardOffer = { type: "offer"; id: string; kind: ClipboardKind; items: ClipboardItem[] };
export function clipboardName(name: unknown): name is string {
	return (
		typeof name === "string" &&
		name.length > 0 &&
		name.length <= 180 &&
		!/[\\/\x00-\x1f<>:"|?*]/.test(name) &&
		!/[. ]$/.test(name) &&
		name !== "." &&
		name !== ".." &&
		!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
	);
}
export function clipboardId(id: unknown): id is string {
	return typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
}
export function parseClipboardOffer(value: unknown): ClipboardOffer | undefined {
	if (!value || typeof value !== "object") return;
	const v = value as ClipboardOffer;
	if (
		v.type !== "offer" ||
		!clipboardId(v.id) ||
		!["text", "image", "files"].includes(v.kind) ||
		!Array.isArray(v.items) ||
		!v.items.length ||
		v.items.length > CLIPBOARD_LIMITS.files ||
		(v.kind !== "files" && v.items.length !== 1)
	)
		return;
	let bytes = 0;
	const names = new Set<string>();
	for (const item of v.items) {
		if (
			!item ||
			!clipboardName(item.name) ||
			!Number.isSafeInteger(item.size) ||
			item.size < 0 ||
			typeof item.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(item.sha256) ||
			names.has(item.name.toLowerCase())
		)
			return;
		bytes += item.size;
		names.add(item.name.toLowerCase());
	}
	if (
		bytes > CLIPBOARD_LIMITS.bytes ||
		(v.kind === "text" && bytes > CLIPBOARD_LIMITS.text) ||
		(v.kind === "image" && bytes > CLIPBOARD_LIMITS.image)
	)
		return;
	return {
		type: "offer",
		id: v.id,
		kind: v.kind,
		items: v.items.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
	};
}
