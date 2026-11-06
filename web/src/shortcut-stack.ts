import { useEffect, useLayoutEffect, useRef } from "react";

type EscapeHandler = () => boolean | void;

const escapeStack: EscapeHandler[] = [];
let listenerAttached = false;

function onKeyDown(e: KeyboardEvent) {
	if (e.key !== "Escape") return;
	if (escapeStack.length === 0) return;

	for (let i = escapeStack.length - 1; i >= 0; i--) {
		const handler = escapeStack[i];
		const consumed = handler();
		if (consumed !== false) {
			e.preventDefault();
			e.stopPropagation();
			break;
		}
	}
}

function ensureListener() {
	if (!listenerAttached && typeof document !== "undefined") {
		document.addEventListener("keydown", onKeyDown, true);
		listenerAttached = true;
	}
}

function cleanupListener() {
	if (listenerAttached && escapeStack.length === 0 && typeof document !== "undefined") {
		document.removeEventListener("keydown", onKeyDown, true);
		listenerAttached = false;
	}
}

export function pushEscapeHandler(handler: EscapeHandler): () => void {
	escapeStack.push(handler);
	ensureListener();

	return () => {
		const idx = escapeStack.lastIndexOf(handler);
		if (idx >= 0) {
			escapeStack.splice(idx, 1);
		}
		cleanupListener();
	};
}

export function resetEscapeStack(): void {
	escapeStack.length = 0;
	cleanupListener();
}

export function useEscapeKey(onEscape: EscapeHandler, enabled = true): void {
	const handlerRef = useRef(onEscape);
	useLayoutEffect(() => {
		handlerRef.current = onEscape;
	});

	useEffect(() => {
		if (!enabled) return;
		return pushEscapeHandler(() => handlerRef.current());
	}, [enabled]);
}
