import { useRef } from "react";
import { isImeComposingKey, type ImeKeyLike } from "./ime-guard.js";

export function useImeCompositionGuard() {
	const compositionEndTsRef = useRef(0);
	return {
		onCompositionEnd: () => {
			compositionEndTsRef.current = Date.now();
		},
		isImeKey: (e: ImeKeyLike) => isImeComposingKey(e, compositionEndTsRef.current),
	};
}
