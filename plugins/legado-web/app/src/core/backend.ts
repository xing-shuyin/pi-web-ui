import { apiBase } from "./apiBase";

export interface StoreMeta {
	size: number;
	mtime: number;
}

function storeUrl(key?: string): string {
	const prefix = `${apiBase()}/store`;
	return key ? `${prefix}?key=${encodeURIComponent(key)}` : prefix;
}

function metaUrl(): string {
	return `${apiBase()}/store?meta=1`;
}

export async function backendAvailable(): Promise<boolean> {
	try {
		const res = await fetch(storeUrl(), { method: "GET" });
		return res.ok;
	} catch {
		return false;
	}
}

export async function storeGet<T>(key: string): Promise<T | null> {
	try {
		const res = await fetch(storeUrl(key), { method: "GET" });
		if (!res.ok) return null;
		const j = (await res.json()) as { value?: T };
		return (j?.value ?? null) as T | null;
	} catch {
		return null;
	}
}

export async function storePut(key: string, value: unknown): Promise<{ ok: boolean; meta?: StoreMeta | null }> {
	try {
		const res = await fetch(storeUrl(key), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value }),
		});
		if (!res.ok) return { ok: false };
		const j = (await res.json().catch(() => null)) as { meta?: StoreMeta | null } | null;
		return { ok: true, meta: j?.meta ?? null };
	} catch {
		return { ok: false };
	}
}

export async function storeMetas(): Promise<Record<string, StoreMeta> | null> {
	try {
		const res = await fetch(metaUrl(), { method: "GET" });
		if (!res.ok) return null;
		const j = (await res.json()) as { metas?: Record<string, StoreMeta> };
		return j?.metas ?? null;
	} catch {
		return null;
	}
}
