import { useCallback, useEffect, useRef, useState } from "react";

interface UseCopyFeedbackOptions {
	duration?: number;
	onSuccess?: (text: string) => void;
	onError?: (error: unknown) => void;
}

interface UseCopyFeedbackResult {
	copied: boolean;
	copy: (text: string) => Promise<boolean>;
	reset: () => void;
}

export function fallbackCopyText(text: string): boolean {
	if (typeof document === "undefined") return false;
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.left = "-9999px";
		ta.style.top = "-9999px";
		ta.setAttribute("readonly", "");
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(ta);
		return ok;
	} catch {
		return false;
	}
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
	if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			return fallbackCopyText(text);
		}
	}
	return fallbackCopyText(text);
}

export function useCopyFeedback(options: UseCopyFeedbackOptions = {}): UseCopyFeedbackResult {
	const { duration = 2000, onSuccess, onError } = options;
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearTimer = useCallback(() => {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	const reset = useCallback(() => {
		clearTimer();
		setCopied(false);
	}, [clearTimer]);

	useEffect(() => {
		return () => {
			clearTimer();
		};
	}, [clearTimer]);

	const copy = useCallback(
		async (text: string): Promise<boolean> => {
			let ok = false;
			try {
				ok = await copyTextToClipboard(text);
			} catch (err) {
				ok = false;
				if (onError) onError(err);
			}

			if (ok) {
				setCopied(true);
				clearTimer();
				timerRef.current = setTimeout(() => {
					setCopied(false);
					timerRef.current = null;
				}, duration);
				onSuccess?.(text);
			} else if (onError && !ok) {
				onError(new Error("Copy failed"));
			}

			return ok;
		},
		[duration, onSuccess, onError, clearTimer],
	);

	return { copied, copy, reset };
}
