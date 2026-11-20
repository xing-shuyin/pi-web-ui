import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 图片 OCR 的插件自有词典（renderer/识别失败等面向用户的文案）。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己读 document.documentElement.lang 做手写分支。
 *
 * 不进词典的东西：
 * - host.imageOcrProviders.register 的 id（`image-ocr`）：协议标识，不随界面语言变；
 * - label / labelEn（「本地中英文 OCR」/「Local Chinese / English OCR」）：宿主按全局语言选词的双语对，保留在注册处；
 * - worker.js 的识别进度数字与服务端返回的 error 文本：数据，原样透传。
 */
export const DICT = {
	zh: {
		timeout: "识别超时。请检查网络后重试，首次使用需要下载字库。",
		failed: "识别失败：{message}",
		engineLoadFailed: "OCR 引擎加载失败，请检查网络后重试。",
		readFailed: "图片读取或识别失败。远程图片需允许跨域访问，可先保存为本地附件后重试。",
	},
	"zh-TW": {
		timeout: "辨識超時。請檢查網路後重試，首次使用需要下載字庫。",
		failed: "辨識失敗：{message}",
		engineLoadFailed: "OCR 引擎載入失敗，請檢查網路後重試。",
		readFailed: "圖片讀取或辨識失敗。遠端圖片需允許跨域存取，可先儲存為本機附件後重試。",
	},
	en: {
		timeout: "OCR timed out. Check your connection; first use downloads language data.",
		failed: "OCR failed: {message}",
		engineLoadFailed: "Failed to load the OCR engine. Check your connection and retry.",
		readFailed:
			"Unable to read the image. Remote images require CORS access; save and attach the image locally to retry.",
	},
};

/** 当前界面语言（词典里存在的那一个）；解析与回退由 SDK 统一实现。 */
export function detectLang() {
	return createPluginI18n(DICT).locale;
}

/** 取文案函数；语言可以是字符串、undefined（跟随界面）或惰性 getter，每次调用时按当前语言解析。 */
export function makeT(lang) {
	return (key, params) => {
		const current = typeof lang === "function" ? lang() : lang;
		return createPluginI18n(DICT, { locale: current }).t(key, params);
	};
}
