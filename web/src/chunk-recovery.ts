export function isChunkLoadError(error: unknown): boolean {
	const message =
		typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
	return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS for|Loading (?:CSS )?chunk .+ failed/i.test(
		message,
	);
}

interface RecoveryEnvironment {
	storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
	reload: () => void;
	now: () => number;
}

export function createChunkRecovery(buildId: string, env: RecoveryEnvironment) {
	let reloading = false;
	return (error: unknown): boolean => {
		if (!isChunkLoadError(error)) return false;
		if (reloading) return true;
		try {
			const key = "pi-web:chunk-recovery";
			const raw = env.storage.getItem(key);
			const last = raw ? (JSON.parse(raw) as { buildId: string; time: number }) : null;
			const now = env.now();
			if (last && (last.buildId === buildId || now - last.time < 60_000)) return false;
			env.storage.setItem(key, JSON.stringify({ buildId, time: now }));
		} catch {
			return false;
		}
		reloading = true;
		env.reload();
		return true;
	};
}

export function installChunkRecovery(buildId: string): (error: unknown) => boolean {
	const recover = createChunkRecovery(buildId, {
		storage: {
			getItem: (key) => window.sessionStorage.getItem(key),
			setItem: (key, value) => window.sessionStorage.setItem(key, value),
		},
		reload: () => window.location.reload(),
		now: Date.now,
	});
	window.addEventListener("vite:preloadError", (event) => {
		if (recover((event as Event & { payload: unknown }).payload)) event.preventDefault();
	});
	return recover;
}
