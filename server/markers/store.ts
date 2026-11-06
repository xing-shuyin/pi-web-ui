export const STORE_CUSTOM_TYPE = "marker-tools/store";

export interface StoreSnapshot {
	namespace: string;
	version: number;
	state: unknown;
	ts: number;
}

const SNAPSHOT_VERSION = 1;

export function loadStateFromBranch(branch: unknown[], namespace: string): unknown | undefined {
	let latest: StoreSnapshot | undefined;
	for (const entry of branch as Array<{ type?: string; customType?: string; data?: unknown }>) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== STORE_CUSTOM_TYPE) continue;
		const snap = entry.data as StoreSnapshot | undefined;
		if (!snap || snap.namespace !== namespace || snap.state === undefined) continue;
		if (!latest || snap.ts >= latest.ts) latest = snap;
	}
	return latest?.state;
}

export function appendSnapshot(
	mgr: { appendCustomEntry?: (t: string, d: unknown) => unknown; getBranch?: () => unknown[] } | undefined,
	namespace: string,
	state: unknown,
	fallbackSave?: (snap: StoreSnapshot) => void,
): void {
	const snapshot: StoreSnapshot = {
		namespace,
		version: SNAPSHOT_VERSION,
		state,
		ts: Date.now(),
	};
	if (mgr?.appendCustomEntry) {
		try {
			(mgr as { appendCustomEntry: (t: string, d: unknown) => unknown }).appendCustomEntry(STORE_CUSTOM_TYPE, snapshot);
			return;
		} catch {}
	}
	fallbackSave?.(snapshot);
}
