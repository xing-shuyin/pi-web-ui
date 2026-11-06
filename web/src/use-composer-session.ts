import { useEffect, useRef } from "react";
import { advanceComposerSession } from "./composer-draft.js";

export function useComposerSessionReset(sessionId: string, onSessionChange: () => void): void {
	const prevRef = useRef("");
	useEffect(() => {
		const step = advanceComposerSession(prevRef.current, sessionId);
		prevRef.current = step.key;
		if (step.clear) onSessionChange();
	}, [sessionId, onSessionChange]);
}
