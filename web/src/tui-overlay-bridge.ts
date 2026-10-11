/**
 * tui-overlay-bridge — Direct streaming bridge for TUI overlay ANSI frames.
 * Keeps high-frequency ANSI screen repaints outside React state.
 */

type TuiOverlayRenderListener = (id: number, ansi: string) => void;

const listeners = new Set<TuiOverlayRenderListener>();

export function subscribeTuiOverlayRender(listener: TuiOverlayRenderListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function emitTuiOverlayRender(id: number, ansi: string): void {
	for (const listener of listeners) {
		try {
			listener(id, ansi);
		} catch (err) {
			console.error("[tui-overlay-bridge] listener error:", err);
		}
	}
}
