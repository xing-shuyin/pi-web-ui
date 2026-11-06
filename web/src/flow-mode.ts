import { useEffect, useState } from "react";
import { THEME_CHANGE_EVENT } from "./theme";

const MARKER = "--flow-inline-stream";

export function isFlowStreamTheme(): boolean {
	if (typeof window === "undefined" || typeof document === "undefined") return false;
	const value = getComputedStyle(document.documentElement).getPropertyValue(MARKER).trim();
	return value === "1" || value === "true";
}

export function useFlowStreamMode(): boolean {
	const [on, setOn] = useState(isFlowStreamTheme);
	useEffect(() => {
		const sync = () => setOn(isFlowStreamTheme());
		sync();
		window.addEventListener(THEME_CHANGE_EVENT, sync);
		return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
	}, []);
	return on;
}
