export function getClientBase(importMetaUrl = import.meta.url) {
	try {
		const u = new URL(importMetaUrl);
		const m = u.pathname.match(/^(.*?)\/plugins\/live2d\b/);
		const root = m ? m[1] : "";
		return `${root}/plugins/live2d/client`;
	} catch {
		return "/plugins/live2d/client";
	}
}

export function getDefaultModels(clientBase) {
	return [
		{
			key: "shizuku",
			name: "🌸 雫 (Shizuku - Cubism 2)",
			nameEn: "🌸 Shizuku (Cubism 2)",
			url: `${clientBase}/models/shizuku/shizuku.model.json`,
			type: "cubism2",
			expressions: ["f01", "f02", "f03", "f04"],
			motions: ["idle", "tap_body", "pinch_in", "pinch_out", "shake", "flick_head"],
			hitAreas: { head: "flick_head", body: "tap_body" },
			scale: 1.0,
			offsetY: 0,
		},
		{
			key: "haru",
			name: "🌿 春 (Haru - Cubism 4)",
			nameEn: "🌿 Haru (Cubism 4)",
			url: `${clientBase}/models/haru/haru_greeter_t03.model3.json`,
			type: "cubism4",
			expressions: ["f00", "f01", "f02", "f03", "f04", "f05", "f06", "f07"],
			motions: ["Idle", "Tap"],
			hitAreas: { head: "Tap", body: "Tap" },
			scale: 0.85,
			offsetY: 10,
		},
		{
			key: "hiyori",
			name: "☀️ 日和 (Hiyori - Cubism 4)",
			nameEn: "☀️ Hiyori (Cubism 4)",
			url: `${clientBase}/models/hiyori/Hiyori.model3.json`,
			type: "cubism4",
			expressions: ["happy", "sad", "angry", "surprised"],
			motions: ["Idle", "TapBody"],
			hitAreas: { body: "TapBody" },
			scale: 0.85,
			offsetY: 10,
		},
		{
			key: "wanko",
			name: "🐶 萌柴 (Wanko - Cubism 4)",
			nameEn: "🐶 Wanko (Cubism 4)",
			url: `${clientBase}/models/wanko/Wanko.model3.json`,
			type: "cubism4",
			expressions: ["happy", "surprised"],
			motions: ["Idle", "TapBody"],
			hitAreas: { body: "TapBody" },
			scale: 0.9,
			offsetY: 0,
		},
	];
}

const STORAGE_KEY_CUSTOM_MODELS = "pi-web-ui:live2d-custom-models";

export function loadCustomModels() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY_CUSTOM_MODELS);
		if (raw) return JSON.parse(raw);
	} catch {}
	return [];
}

export function saveCustomModels(models) {
	try {
		localStorage.setItem(STORAGE_KEY_CUSTOM_MODELS, JSON.stringify(models));
	} catch {}
}

export function getAllModels(clientBase) {
	const defaults = getDefaultModels(clientBase);
	const customs = loadCustomModels();
	const list = [...defaults];
	for (const c of customs) {
		if (!list.some((m) => m.key === c.key)) {
			list.push(c);
		}
	}
	return list;
}

export const EMOTION_ALIAS_MAP = {
	happy: ["f01", "f00", "smile", "happy", "joy", "exp_01", "F01", "F02"],
	sad: ["f03", "sad", "sorrow", "tear", "cry", "exp_03", "F04", "F05"],
	angry: ["f02", "angry", "rage", "pout", "exp_02", "F03"],
	surprised: ["f04", "shock", "surprise", "wonder", "exp_04", "F06", "F07"],
	blush: ["f01", "blush", "shy", "embarrassed", "f02"],
	wink: ["f01", "wink", "f00"],
	neutral: ["neutral", "default", "normal", "f00"],
};
