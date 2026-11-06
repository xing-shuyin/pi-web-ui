interface ClipboardItemLike {
	kind: string;
	type?: string;
	getAsFile(): File | null;
}

export function collectClipboardFiles(
	items: ArrayLike<ClipboardItemLike> | null | undefined,
	files: ArrayLike<File> | null | undefined,
): File[] {
	const out: File[] = [];
	const n = items?.length ?? 0;
	for (let i = 0; i < n; i++) {
		const item = items?.[i];
		if (!item || item.kind !== "file") continue;
		const f = item.getAsFile();
		if (f) out.push(f);
	}
	if (out.length === 0 && files) {
		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			if (f) out.push(f);
		}
	}
	return out;
}
