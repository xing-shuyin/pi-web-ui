import { useCallback, useEffect, useRef, useState } from "react";

import type { BrowserHostBridge } from "../../browser/contracts";
import type { DraftAttachment } from "./composer-draft";
import { isDesktopShell } from "./desktop";

export const PAGE_PICKER_ZIP_URL =
	"https://github.com/xing-shuyin/pi-web-ui/releases/latest/download/page-picker-extension.zip";

export interface BrowserControlPage {
	origin: string;
	title: string;
	open: boolean;
	tabId?: string;
	url?: string;
}

export interface BrowserControlStatus {
	available: boolean;
	native?: boolean;
	desktop?: boolean;
	aiControl?: boolean;
	allowEval?: boolean;
	pages: BrowserControlPage[];
	error?: string;
}

interface HostBridge {
	pageCall?: (opts: {
		op: string;
		args?: Record<string, unknown>;
		target?: string;
		timeoutMs?: number;
	}) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

function nativeHost(): BrowserHostBridge | undefined {
	const bridge = (window as unknown as { __piBrowser?: BrowserHostBridge }).__piBrowser;
	return bridge?.version === 1 && typeof bridge.pageCall === "function" ? bridge : undefined;
}

const host = (): HostBridge["pageCall"] | undefined => {
	const native = nativeHost();
	if (native) return (opts) => native.pageCall({ ...opts, timeoutMs: opts.timeoutMs ?? 30000 });
	const bridge = (window as unknown as { __piWebUiHost?: HostBridge }).__piWebUiHost;
	return bridge?.pageCall?.bind(bridge);
};

let lastBrowserControl: BrowserControlStatus | null = null;
let lastBrowserControlAt = 0;

export function getLastBrowserControlPages(): BrowserControlPage[] {
	return lastBrowserControl?.available === true ? (lastBrowserControl.pages ?? []) : [];
}

export function pokeBrowserControl(): void {
	if (Date.now() - lastBrowserControlAt < 5000) return;
	void queryBrowserControl().catch(() => {});
}

export async function queryBrowserControl(): Promise<BrowserControlStatus> {
	if (isDesktopShell() && !nativeHost()) {
		return {
			available: false,
			pages: [],
			desktop: true,
			error: "此桌面版尚未提供原生浏览器桥：请升级到支持 AI Browser 的桌面版，或在系统浏览器中使用 page-picker 扩展",
		};
	}
	const pageCall = host();
	if (!pageCall) {
		return {
			available: false,
			pages: [],
			error: "宿主页面桥不可用：这个 pi-web-ui 页面还没装上扩展桥（装/启用 page-picker 后刷新本页）",
		};
	}
	try {
		const res = await pageCall({ op: "status", timeoutMs: 5000 });
		if (!res.ok) return { available: false, pages: [], error: res.error ?? "扩展没有返回状态" };
		const value = (res.result ?? {}) as Record<string, unknown>;
		const next: BrowserControlStatus = {
			available: value.installed === true,
			...(nativeHost() ? { native: true } : {}),
			aiControl: value.aiControl === true,
			allowEval: value.allowEval === true,
			pages: Array.isArray(value.pages) ? (value.pages as BrowserControlPage[]) : [],
		};
		if (next.available) {
			lastBrowserControl = next;
			lastBrowserControlAt = Date.now();
		}
		return next;
	} catch (err) {
		return { available: false, pages: [], error: err instanceof Error ? err.message : String(err) };
	}
}

export function compactPage(pages: BrowserControlPage[]): BrowserControlPage | null {
	return pages.length === 1 ? pages[0] : null;
}

export function pageCitation(page: { origin: string; title?: string; tabId?: string }): DraftAttachment {
	const target = page.tabId ?? page.origin;
	return {
		path: target,
		name: page.title?.trim() || page.origin,
		mode: "page",
		key: `page:${target}`,
	};
}

export async function openExtensionOptions(): Promise<boolean> {
	const pageCall = host();
	if (!pageCall) return false;
	try {
		const res = await pageCall({ op: "openOptions", timeoutMs: 5000 });
		return res.ok === true;
	} catch {
		return false;
	}
}

export function useBrowserControl(pollMs = 45000): {
	status: BrowserControlStatus | null;
	refresh: () => void;
} {
	const [status, setStatus] = useState<BrowserControlStatus | null>(null);
	const alive = useRef(true);

	const run = useCallback(async (retryIfOffline: boolean) => {
		const next = await queryBrowserControl();
		if (!alive.current) return;
		setStatus(next);
		if (retryIfOffline && !next.available) {
			setTimeout(() => {
				if (alive.current) void run(false);
			}, 1500);
		}
	}, []);

	useEffect(() => {
		alive.current = true;
		void run(true);
		const timer = setInterval(() => void run(false), Math.max(5000, pollMs));
		return () => {
			alive.current = false;
			clearInterval(timer);
		};
	}, [run, pollMs]);

	return { status, refresh: () => void run(true) };
}
