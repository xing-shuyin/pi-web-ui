export const IME_COMPOSITION_END_GRACE_MS = 50;

export interface ImeKeyLike {
	isComposing?: boolean;
	keyCode?: number;
}

export function isImeComposingKey(e: ImeKeyLike, lastCompositionEndTs = 0, now = Date.now()): boolean {
	if (e.isComposing) return true;
	if (e.keyCode === 229) return true;
	if (lastCompositionEndTs > 0 && now - lastCompositionEndTs < IME_COMPOSITION_END_GRACE_MS) return true;
	return false;
}
