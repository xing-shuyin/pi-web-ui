import { useSyncExternalStore } from "react";

export type BannerType = "info" | "warning" | "success" | "error" | "question";

export interface BannerNotice {
	id: string;
	type?: BannerType;
	title?: string;
	message: string;
	persistent?: boolean;
	timeoutMs?: number;
	dismissible?: boolean;
	onClick?: () => void;
	data?: Record<string, unknown>;
	onClose?: () => void;
}

type BannerInput = Omit<BannerNotice, "id"> & { id?: string };

let bannerSeq = 0;
let banners: readonly BannerNotice[] = [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch {}
	}
}

function clearTimer(id: string): void {
	const timer = timers.get(id);
	if (timer !== undefined) {
		clearTimeout(timer);
		timers.delete(id);
	}
}

export function showBanner(input: BannerInput): string {
	const id = input.id || `banner-${Date.now()}-${++bannerSeq}`;
	const banner: BannerNotice = {
		...input,
		id,
		type: input.type || "info",
		persistent: !!input.persistent,
		timeoutMs: input.timeoutMs ?? 5000,
		dismissible: input.dismissible !== false,
	};

	clearTimer(id);

	if (!banner.persistent && banner.timeoutMs && banner.timeoutMs > 0) {
		const timer = setTimeout(() => {
			dismissBanner(id);
		}, banner.timeoutMs);
		timers.set(id, timer);
	}

	const existingIndex = banners.findIndex((b) => b.id === id);
	if (existingIndex >= 0) {
		const next = [...banners];
		next[existingIndex] = banner;
		banners = next;
	} else {
		banners = [...banners, banner];
	}

	notifyListeners();
	return id;
}

interface DismissBannerOptions {
	silent?: boolean;
}

export function dismissBanner(id: string, opts?: DismissBannerOptions): void {
	clearTimer(id);
	const target = banners.find((b) => b.id === id);
	if (!target) return;

	banners = banners.filter((b) => b.id !== id);
	if (!opts?.silent) {
		try {
			target.onClose?.();
		} catch {}
	}
	notifyListeners();
}

export function dismissBannersWhere(predicate: (b: BannerNotice) => boolean, opts?: DismissBannerOptions): void {
	const toDismiss = banners.filter(predicate);
	if (toDismiss.length === 0) return;

	for (const b of toDismiss) {
		clearTimer(b.id);
		if (!opts?.silent) {
			try {
				b.onClose?.();
			} catch {}
		}
	}

	banners = banners.filter((b) => !predicate(b));
	notifyListeners();
}

export function clearAllBanners(): void {
	for (const timer of timers.values()) {
		clearTimeout(timer);
	}
	timers.clear();

	const oldBanners = banners;
	banners = [];
	for (const b of oldBanners) {
		try {
			b.onClose?.();
		} catch {}
	}
	notifyListeners();
}

export function getBanners(): readonly BannerNotice[] {
	return banners;
}

export function subscribeBanners(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useBanners(): readonly BannerNotice[] {
	return useSyncExternalStore(subscribeBanners, getBanners, getBanners);
}
