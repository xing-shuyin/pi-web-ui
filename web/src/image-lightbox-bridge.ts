/// <reference lib="dom" />

export interface ImageLightboxTarget {
	src: string;
	alt?: string;
	onSaveAnnotation?: (dataUrl: string) => void | Promise<void>;
	actions?: { id: string; label: string; onSelect: () => unknown; closeOnSelect?: boolean }[];
}

type OpenSink = (target: ImageLightboxTarget) => void;
type CloseSink = () => void;
type OpenChecker = () => boolean;

let openSink: OpenSink | null = null;
let closeSink: CloseSink | null = null;
let openChecker: OpenChecker | null = null;

export function registerImageLightboxHost(
	host: { open: OpenSink; close: CloseSink; isOpen?: OpenChecker } | null,
): void {
	openSink = host?.open ?? null;
	closeSink = host?.close ?? null;
	openChecker = host?.isOpen ?? null;
}

export function isImageLightboxReady(): boolean {
	return openSink !== null;
}

export function isImageLightboxOpen(): boolean {
	return openChecker ? openChecker() : false;
}

export function openImageLightbox(target: ImageLightboxTarget): boolean {
	if (!openSink || !target?.src) return false;
	openSink(target);
	return true;
}

export function closeImageLightbox(): void {
	closeSink?.();
}

export function resetImageLightboxHost(): void {
	openSink = null;
	closeSink = null;
	openChecker = null;
}
