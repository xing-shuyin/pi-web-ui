export const PREFS_KEY = "pi-web-ui:hongguo:prefs:v1";
export const HISTORY_KEY = "pi-web-ui:hongguo:history:v1";
const clamp = (value, low, high) => Math.min(Math.max(low, value), Math.max(low, high));
const number = (raw, fallback) => (typeof raw === "number" && Number.isFinite(raw) ? raw : fallback);

export function readStored(storage, key, fallback) {
	try {
		const value = JSON.parse(storage.getItem(key));
		return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
	} catch {
		return fallback;
	}
}
export function writeStored(storage, key, value) {
	try {
		storage.setItem(key, JSON.stringify(value));
	} catch {
		/* Private browsing/storage quotas must not interrupt playback. */
	}
}

export function layoutFor(mode, width, height, prefs = {}) {
	if (mode === "split") {
		if (width >= 800) {
			const w = clamp(number(prefs.splitWidth, 400), 300, Math.min(600, width * 0.48));
			return { x: width - w, y: 0, w, h: height, reserveRight: w, reserveBottom: 0, axis: "x" };
		}
		const h = clamp(number(prefs.splitHeight, height * 0.48), Math.min(200, height * 0.45), height * 0.55);
		return { x: 0, y: height - h, w: width, h, reserveRight: 0, reserveBottom: h, axis: "y" };
	}
	const gap = Math.min(12, width / 20, height / 20);
	const compact = prefs.compact === true;
	const w = clamp(
		number(prefs.w, compact ? 320 : 390),
		Math.min(compact ? 240 : 300, width - gap * 2),
		width - gap * 2,
	);
	const h = clamp(
		number(prefs.h, compact ? 260 : 640),
		Math.min(compact ? 160 : 340, height - gap * 2),
		height - gap * 2,
	);
	return {
		x: clamp(number(prefs.x, width - w - gap), gap, width - w - gap),
		y: clamp(number(prefs.y, Math.min(72, height - h - gap)), gap, height - h - gap),
		w,
		h,
		reserveRight: 0,
		reserveBottom: 0,
		axis: "both",
	};
}

export function resizeFloating(box, edge, dx, dy, width, height, compact = false) {
	const gap = Math.min(12, width / 20, height / 20);
	const minW = Math.min(compact ? 240 : 300, width - gap * 2);
	const minH = Math.min(compact ? 160 : 340, height - gap * 2);
	let left = box.x,
		top = box.y,
		right = box.x + box.w,
		bottom = box.y + box.h;
	if (edge.includes("w")) left = clamp(left + dx, gap, right - minW);
	if (edge.includes("e")) right = clamp(right + dx, left + minW, width - gap);
	if (edge.includes("n")) top = clamp(top + dy, gap, bottom - minH);
	if (edge.includes("s")) bottom = clamp(bottom + dy, top + minH, height - gap);
	return { x: left, y: top, w: right - left, h: bottom - top };
}

export function saveRecord(records, series, episode, position, duration, now = Date.now()) {
	if (!series?.id || !episode?.id) return records;
	const value = {
		id: String(series.id),
		title: String(series.title ?? ""),
		cover: series.cover ?? "",
		episodeId: String(episode.id),
		number: episode.number,
		position: Math.max(0, number(position, 0)),
		duration: Math.max(0, number(duration, 0)),
		at: now,
	};
	return Object.fromEntries(
		Object.entries({ ...records, [series.id]: value })
			.filter(([, record]) => record && typeof record === "object" && typeof record.id === "string")
			.sort((a, b) => number(b[1].at, 0) - number(a[1].at, 0))
			.slice(0, 30),
	);
}
export function resumePosition(record) {
	const position = Math.max(0, number(record?.position, 0));
	return record?.duration > 0 && position >= record.duration - 3 ? 0 : position;
}
export function mergedRows(previous, added) {
	const map = new Map(previous.map((item) => [String(item.id), item]));
	for (const item of added) if (item?.id) map.set(String(item.id), { ...map.get(String(item.id)), ...item });
	return [...map.values()];
}
