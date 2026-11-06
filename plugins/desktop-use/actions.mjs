export async function tapKeys(keyboard, keys) {
	try {
		await keyboard.pressKey(...keys);
	} finally {
		await keyboard.releaseKey(...keys.slice().reverse());
	}
}

export function finitePoint(x, y) {
	if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("坐标 x/y 必须是有限数字。");
	return { x, y };
}

export function screenshotPoint(shot, x, y) {
	finitePoint(x, y);
	if (
		![shot.winX, shot.winY, shot.winW, shot.winH, shot.imgW, shot.imgH].every(Number.isFinite) ||
		shot.winW <= 0 ||
		shot.winH <= 0 ||
		shot.imgW <= 0 ||
		shot.imgH <= 0
	) {
		throw new Error("截图尺寸无效，请重新截图。");
	}
	if (x < 0 || y < 0 || x >= shot.imgW || y >= shot.imgH) throw new Error("坐标超出截图范围，请重新定位。");
	return {
		x: Math.round(shot.winX + (x * shot.winW) / shot.imgW),
		y: Math.round(shot.winY + (y * shot.winH) / shot.imgH),
	};
}

export function matchOcr(items, query, occurrence) {
	const normalize = (s) =>
		String(s ?? "")
			.replace(/\s+/g, "")
			.toLowerCase();
	const q = normalize(query);
	if (!q) throw new Error("OCR 查询文字不能为空。");
	let hits = items.filter((it) => it.text === query);
	if (!hits.length) hits = items.filter((it) => normalize(it.text) === q);
	if (!hits.length) hits = items.filter((it) => normalize(it.text).includes(q));
	if (!hits.length) throw new Error(`OCR 未找到文字「${query}」，请换关键词或使用截图坐标。`);
	if (occurrence === undefined && hits.length > 1) {
		throw new Error(
			`OCR 文字「${query}」匹配 ${hits.length} 处，请传 occurrence（从 1 开始）或使用坐标：${hits
				.slice(0, 10)
				.map((it, i) => `${i + 1}:(${it.cx},${it.cy})`)
				.join("、")}`,
		);
	}
	const index = occurrence ?? 1;
	if (!Number.isInteger(index) || index < 1 || index > hits.length) throw new Error("occurrence 超出 OCR 匹配范围。");
	return hits[index - 1];
}

export function parseShortcut(input) {
	const parts = String(input ?? "")
		.split("+")
		.map((s) => s.trim().toLowerCase())
		.map((s) => (["cmd", "command", "meta"].includes(s) ? "win" : s === "option" ? "alt" : s));
	const modifiers = new Set(["ctrl", "alt", "shift", "win"]);
	const valid =
		/^(?:[a-z0-9]|f(?:[1-9]|1\d|2[0-4])|enter|tab|esc|escape|space|backspace|delete|up|down|left|right|home|end|pgup|pgdn|insert)$/;
	if (
		parts.some((p) => !modifiers.has(p) && !valid.test(p)) ||
		parts.filter((p) => !modifiers.has(p)).length > 1 ||
		new Set(parts).size !== parts.length
	) {
		throw new Error('快捷键无效，请使用单个按键或组合键，例如 "ctrl+c"。');
	}
	return parts.map((p) => (p === "escape" ? "esc" : p));
}

export function scrollInput(direction = "down", amount = 3) {
	if (!["up", "down", "left", "right"].includes(direction)) throw new Error("滚动方向必须是 up/down/left/right。");
	if (!Number.isInteger(amount) || amount < 1 || amount > 100) throw new Error("amount 必须是 1–100 的整数。");
	return {
		Horizontal: direction === "left" || direction === "right" ? 1 : 0,
		Delta: amount * 120 * (direction === "down" || direction === "left" ? -1 : 1),
	};
}
