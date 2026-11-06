/// <reference lib="dom" />

import { closeToolInspector } from "./tool-inspector-state";

interface PreviewTarget {
	path: string;
	name: string;
}

type OpenSink = (file: PreviewTarget) => void;
type OpenChecker = () => boolean;

let openSink: OpenSink | null = null;
let openChecker: OpenChecker | null = null;

export function registerFilePreviewHost(host: { open: OpenSink; isOpen?: OpenChecker } | null): void {
	openSink = host?.open ?? null;
	openChecker = host?.isOpen ?? null;
}

export function isFilePreviewReady(): boolean {
	return openSink !== null;
}

export function isFilePreviewOpen(): boolean {
	return openChecker ? openChecker() : false;
}

export function resetFilePreviewHost(): void {
	openSink = null;
	openChecker = null;
}

export function openFilePreview(file: PreviewTarget): boolean {
	if (!openSink || !file?.path) return false;
	closeToolInspector();
	openSink(file);
	return true;
}
