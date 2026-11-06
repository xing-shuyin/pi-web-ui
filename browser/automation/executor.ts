import type { WebContents } from "electron";
import type { BrowserPageRequest, BrowserPageResult, BrowserTab } from "../contracts.js";
import { runPageOperation } from "./page-operation.js";

export interface BrowserExecutorManager {
	getTabs(): BrowserTab[];
	getActiveTabId(): string | null;
	getWebContents(id: string): WebContents | undefined;
	createTab(url?: string): string;
	navigate(url: string, id?: string): Promise<void>;
}

export interface BrowserExecutorOptions {
	aiControl?: boolean;
	allowEval?: boolean;
	allowShot?: boolean;
}

const MAX_RESULT_CHARS = 512 * 1024;
const MAX_ARGS_CHARS = 256 * 1024;

function originOf(url: string): string {
	try {
		const origin = new URL(url).origin;
		return origin === "null" ? url : origin;
	} catch {
		return url;
	}
}

function bounded(result: unknown): BrowserPageResult {
	const serialized = JSON.stringify(result);
	if (serialized && serialized.length > MAX_RESULT_CHARS)
		throw new Error("Browser result exceeds the 512KB transport limit; request less content or a smaller screenshot");
	return result === undefined ? { ok: true } : { ok: true, result };
}

export function createBrowserExecutor(
	manager: BrowserExecutorManager,
	options: BrowserExecutorOptions = {},
): (req: BrowserPageRequest, callerWebContentsId?: number) => Promise<BrowserPageResult> {
	return async (req: BrowserPageRequest, callerWebContentsId?: number): Promise<BrowserPageResult> => {
		try {
			const op = typeof req.op === "string" ? req.op.trim() : "";
			if (!op || op.length > 64) throw new Error("A browser operation of 1-64 characters is required");
			if (
				![
					"status",
					"pages",
					"read",
					"click",
					"type",
					"scroll",
					"goto",
					"wait",
					"eval",
					"shot",
					"snapshot",
					"metrics",
				].includes(op)
			)
				throw new Error(`Unsupported browser operation: ${op}`);
			const args = req.args ?? {};
			if (JSON.stringify(args).length > MAX_ARGS_CHARS)
				throw new Error("Browser arguments exceed the 256KB transport limit");
			const tabs = manager.getTabs();
			const usable = (tab: BrowserTab): boolean => {
				const contents = manager.getWebContents(tab.id);
				return !tab.internal && !!contents && !contents.isDestroyed() && contents.id !== callerWebContentsId;
			};
			const available = tabs.filter(usable);
			const pages = available.map((tab) => ({
				origin: originOf(tab.url),
				title: tab.title || tab.url,
				open: true,
				tabId: tab.id,
				url: tab.url,
			}));
			if (op === "status")
				return bounded({
					installed: true,
					hasHost: true,
					version: "1",
					aiControl: options.aiControl !== false,
					allowEval: options.allowEval === true,
					allowShot: options.allowShot !== false,
					shotPermission: true,
					pages,
				});
			if (options.aiControl === false) throw new Error("Browser AI control is disabled in the native browser settings");
			if (op === "pages") return bounded({ pages });
			if (op === "shot" && options.allowShot === false)
				throw new Error("Browser screenshots are disabled in the native browser settings");
			if (op === "eval" && options.allowEval !== true)
				throw new Error("Browser eval is disabled; enable allowEval in the native browser options first");
			let navigationUrl = "";
			if (op === "goto") {
				navigationUrl = typeof args.url === "string" ? args.url.trim() : "";
				if (!navigationUrl) throw new Error("goto requires an absolute URL");
				const parsed = new URL(navigationUrl);
				if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("goto requires an http or https URL");
				if (req.target === undefined && available.length === 0) {
					const tabId = manager.createTab(navigationUrl);
					return bounded({ navigating: true, url: navigationUrl, tabId });
				}
			}

			let tab: BrowserTab | undefined;
			if (req.target !== undefined) {
				const target = req.target.trim();
				if (!target) throw new Error("Explicit browser target is empty");
				tab = tabs.find((item) => item.id === target);
				if (!tab) {
					const matches = available.filter((item) => originOf(item.url) === target);
					if (matches.length > 1)
						throw new Error(`Ambiguous browser origin ${target}; use a tabId from op:pages as target`);
					tab = matches[0];
				}
				if (!tab) throw new Error(`Browser target is unavailable: ${target}`);
			} else {
				if (available.length === 1) tab = available[0];
				else if (available.length > 1)
					throw new Error("Several browser tabs are available; select a target from op:pages");
				else throw new Error("No browser page is available; open a browser tab first");
			}
			if (!usable(tab))
				throw new Error("The target is internal, closed, or belongs to the caller; it cannot be operated");
			const contents = manager.getWebContents(tab.id)!;
			const timeoutMs =
				typeof req.timeoutMs === "number" && Number.isFinite(req.timeoutMs)
					? Math.min(120000, Math.max(1, req.timeoutMs))
					: 30000;
			const execute = async (pageOp: string, pageArgs: Record<string, unknown>): Promise<unknown> => {
				const code = `(${runPageOperation.toString()})(${JSON.stringify(pageOp)}, ${JSON.stringify(pageArgs)})`;
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					return await Promise.race([
						contents.executeJavaScript(code),
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(new Error(`Browser ${pageOp} timed out`)), timeoutMs + 250);
						}),
					]);
				} finally {
					clearTimeout(timer);
				}
			};
			if (op === "goto") {
				await manager.navigate(navigationUrl, tab.id);
				return bounded({ navigating: true, url: navigationUrl });
			}
			if (op === "eval") {
				const code = typeof args.code === "string" ? args.code : "";
				if (!code.trim()) throw new Error("eval requires code");
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const value = await Promise.race([
						contents.executeJavaScript(code),
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(new Error("Browser eval timed out")), timeoutMs);
						}),
					]);
					return bounded({ value });
				} finally {
					clearTimeout(timer);
				}
			}
			if (op === "shot") {
				const metrics = (await execute("metrics", args)) as {
					vw: number;
					vh: number;
					dpr: number;
					rect?: { x: number; y: number; w: number; h: number };
				};
				let image;
				if (metrics.rect) {
					const x = Math.max(0, Math.floor(metrics.rect.x));
					const y = Math.max(0, Math.floor(metrics.rect.y));
					const width = Math.min(metrics.vw, Math.ceil(metrics.rect.x + metrics.rect.w)) - x;
					const height = Math.min(metrics.vh, Math.ceil(metrics.rect.y + metrics.rect.h)) - y;
					if (width < 1 || height < 1) throw new Error("Screenshot element is outside the viewport");
					image = await contents.capturePage({ x, y, width, height });
				} else image = await contents.capturePage();
				if (image.isEmpty()) throw new Error("The browser page has no screenshot content");
				const maxEdge =
					typeof args.maxEdge === "number" && Number.isFinite(args.maxEdge)
						? Math.min(1568, Math.max(320, Math.round(args.maxEdge)))
						: 1280;
				const size = image.getSize();
				const scale = Math.min(1, maxEdge / Math.max(size.width, size.height));
				const width = Math.max(1, Math.round(size.width * scale));
				const height = Math.max(1, Math.round(size.height * scale));
				image = image.resize({ width, height });
				return bounded({
					image: {
						dataUrl: `data:image/jpeg;base64,${image.toJPEG(72).toString("base64")}`,
						mimeType: "image/jpeg",
						width,
						height,
					},
					...(typeof args.selector === "string" && args.selector.trim() ? { selector: args.selector.trim() } : {}),
					...(metrics.rect ? { rect: metrics.rect } : {}),
					viewport: { dpr: metrics.dpr },
				});
			}
			return bounded(
				await execute(op, op === "wait" ? { ...args, timeoutMs: req.timeoutMs ?? args.timeoutMs ?? 5000 } : args),
			);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	};
}
