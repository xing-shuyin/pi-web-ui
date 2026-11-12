/**
 * 二维码解码（主进程专用）：整页/整图截图 → jsQR 找码。
 *
 * 为什么用截图而不是读 DOM：页面里的二维码可能是 `<img>`、`<canvas>`、内联 SVG、甚至是
 * CSS 背景图或 canvas 绘制的动态图，逐种抓法都要面对 CORS 与跨域画布污染；`capturePage()`
 * 拿到的就是用户眼前那块像素，一视同仁。代价是需要二维码可见于视口（提示见文案）。
 */
import type { NativeImage } from "electron";
import * as jsqr from "jsqr";

type JsQrOptions = { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" };
type JsQrDecode = (
	data: Uint8ClampedArray,
	width: number,
	height: number,
	options?: JsQrOptions,
) => {
	data: string;
} | null;

// jsqr 是 CJS 包（`module.exports` 就是那个函数，没有 `.default`），但它自带的类型声明写成
// `export default`。ESM 下 default == module.exports，这里两种形状都接住，不靠调用方的运行时猜测。
const decodeQrCode: JsQrDecode =
	(jsqr as unknown as { default?: JsQrDecode }).default ?? (jsqr as unknown as JsQrDecode);

/** Electron `NativeImage.toBitmap()` 是 **BGRA**（小端）序列，jsQR 要 RGBA。 */
export function bgraToRgba(bitmap: Buffer): Uint8ClampedArray {
	const out = new Uint8ClampedArray(new ArrayBuffer(bitmap.length));
	for (let i = 0; i + 3 < bitmap.length; i += 4) {
		out[i] = bitmap[i + 2];
		out[i + 1] = bitmap[i + 1];
		out[i + 2] = bitmap[i];
		out[i + 3] = bitmap[i + 3];
	}
	return out;
}

/** 解码一段位图；找不到码返回 null。`scale` 与 `inversionAttempts` 见 jsQR 文档。 */
export function decodeQrBitmap(bitmap: Buffer, width: number, height: number): string | null {
	if (!width || !height || bitmap.length < width * height * 4) return null;
	const result = decodeQrCode(bgraToRgba(bitmap), width, height, { inversionAttempts: "attemptBoth" });
	return result?.data?.trim() || null;
}

/** 从 NativeImage（`capturePage()` / `createFromDataURL()` 的结果）解出二维码文本。 */
export function decodeQrNativeImage(image: NativeImage): string | null {
	if (image.isEmpty()) return null;
	const { width, height } = image.getSize();
	return decodeQrBitmap(image.toBitmap(), width, height);
}
