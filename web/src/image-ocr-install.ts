let installer: (() => void) | null = null;
let state: { busy: boolean; error: string } = { busy: false, error: "" };
const listeners = new Set<() => void>();
export function setImageOcrInstallState(busy: boolean, error = ""): void {
	if (state.busy === busy && state.error === error) return;
	state = { busy, error };
	for (const listener of listeners) listener();
}
export function getImageOcrInstallState() {
	return state;
}
export function subscribeImageOcrInstall(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
export function registerImageOcrInstaller(action: (() => void) | null): void {
	installer = action;
}
export function installImageOcr(): void {
	if (state.busy) return;
	setImageOcrInstallState(true);
	try {
		if (!installer) throw new Error("OCR installation is unavailable. Reconnect and retry.");
		installer();
	} catch (error) {
		setImageOcrInstallState(false, error instanceof Error ? error.message : String(error));
	}
}
