/// <reference lib="dom" />
/**
 * 图片预览灯箱桥 —— 全局大图灯箱预览通道。
 *
 * 遵循与 file-preview-bridge / composer-bridge 相同的单源模式：
 * 宿主在 App 挂载时注册 open/close，其他深层组件直接调用 openImageLightbox。
 */

export interface ImageLightboxTarget {
	src: string;
	alt?: string;
}

type OpenSink = (target: ImageLightboxTarget) => void;
type CloseSink = () => void;
type OpenChecker = () => boolean;

let openSink: OpenSink | null = null;
let closeSink: CloseSink | null = null;
let openChecker: OpenChecker | null = null;

/** App 挂载时注册（传 null 注销）。可重复调用，后注册的覆盖先前的。 */
export function registerImageLightboxHost(
	host: { open: OpenSink; close: CloseSink; isOpen?: OpenChecker } | null,
): void {
	openSink = host?.open ?? null;
	closeSink = host?.close ?? null;
	openChecker = host?.isOpen ?? null;
}

/** 有没有宿主在听（页面挂载完成 = true）。 */
export function isImageLightboxReady(): boolean {
	return openSink !== null;
}

/** 灯箱当前是否已经开着。 */
export function isImageLightboxOpen(): boolean {
	return openChecker ? openChecker() : false;
}

/** 打开图片大图预览灯箱，返回是否受理。 */
export function openImageLightbox(target: ImageLightboxTarget): boolean {
	if (!openSink || !target?.src) return false;
	openSink(target);
	return true;
}

/** 关闭图片预览灯箱。 */
export function closeImageLightbox(): void {
	closeSink?.();
}

/** 仅供单测：清掉注册表（避免用例之间互相串）。 */
export function resetImageLightboxHost(): void {
	openSink = null;
	closeSink = null;
	openChecker = null;
}
