export interface ImageOcrRequest {
	src: string;
	signal: AbortSignal;
	onProgress: (progress: number) => void;
}

export interface ImageOcrProvider {
	id: string;
	label: string;
	labelEn?: string;
	recognize(request: ImageOcrRequest): Promise<{ text: string }>;
}

interface Entry {
	provider: ImageOcrProvider;
	owner: string | null;
}
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let snapshot: readonly ImageOcrProvider[] = [];
let activeOwners: ReadonlySet<string> | null = null;

function notify() {
	snapshot = [...entries.values()].map((entry) => entry.provider);
	for (const listener of listeners) listener();
}

export function registerImageOcrProvider(provider: ImageOcrProvider, owner: string | null = null): () => void {
	const id = String(provider?.id ?? "").trim();
	if (!id || typeof provider?.recognize !== "function" || (owner && activeOwners && !activeOwners.has(owner)))
		return () => {};
	const entry = { provider: { ...provider, id }, owner };
	entries.set(id, entry);
	notify();
	return () => {
		if (entries.get(id) !== entry) return;
		entries.delete(id);
		notify();
	};
}

export function listImageOcrProviders(): readonly ImageOcrProvider[] {
	return snapshot;
}

export function subscribeImageOcrProviders(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function syncImageOcrProviderOwners(owners: ReadonlySet<string>): void {
	activeOwners = owners;
	for (const entry of entries.values()) {
		if (entry.owner && !owners.has(entry.owner)) clearImageOcrProviders(entry.owner);
	}
}

export function clearImageOcrProviders(owner?: string): void {
	let changed = false;
	for (const [id, entry] of entries) {
		if (owner === undefined || entry.owner === owner) {
			entries.delete(id);
			changed = true;
		}
	}
	if (changed) notify();
}
