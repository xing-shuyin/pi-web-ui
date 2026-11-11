/// <reference lib="dom" />

import { closeToolInspector } from "./tool-inspector-state";

interface PreviewTarget {
	path: string;
	name: string;
}

type OpenSink = (file: PreviewTarget) => void;
type OpenListSink = (files: PreviewTarget[], initialIndex?: number) => void;
type OpenChecker = () => boolean;

let openSink: OpenSink | null = null;
let openListSink: OpenListSink | null = null;
let openChecker: OpenChecker | null = null;

export function registerFilePreviewHost(
	host: { open: OpenSink; openList?: OpenListSink; isOpen?: OpenChecker } | null,
): void {
	openSink = host?.open ?? null;
	openListSink = host?.openList ?? null;
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
	openListSink = null;
	openChecker = null;
}

export function openFilePreview(file: PreviewTarget): boolean {
	if ((!openSink && !openListSink) || !file?.path) return false;
	closeToolInspector();
	if (openListSink) {
		openListSink([file], 0);
		return true;
	}
	openSink?.(file);
	return true;
}

export function openFilePreviewList(files: PreviewTarget[], initialIndex = 0): boolean {
	const list = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.path === "string" && f.path);
	if (list.length === 0 || (!openSink && !openListSink)) return false;
	const clamped = Math.min(Math.max(0, initialIndex | 0), list.length - 1);
	closeToolInspector();
	if (openListSink) {
		openListSink(list, clamped);
		return true;
	}
	openSink?.(list[clamped]);
	return true;
}
