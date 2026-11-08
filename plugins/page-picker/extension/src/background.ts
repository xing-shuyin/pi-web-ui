/// <reference path="./chrome.d.ts" />
/// <reference lib="dom" />

import type { BindResult, PiProbe } from "./shared/bind.js";
import { getMessage } from "./shared/i18n.js";
import {
	BUILTIN_OPS,
	EVAL_OP,
	SHOT_PERMISSION_ORIGINS,
	MAX_RESULT_CHARS,
	decideAiRoute,
	decideRoute,
	isBuiltinOp,
	measureForTransport,
	normalizeOrigin,
	parseBridgeCall,
	peersOf,
	type AiPage,
	type BridgePair,
} from "./shared/bridge.js";
import { hasOriginPermission, loadAiPages, loadPairs, rememberOrigin } from "./shared/bridge-store.js";
import { installBridgePage, invokeBridgeHandler, uninstallBridgePage } from "./content/bridge-page.js";
export { installBridgePage, invokeBridgeHandler, uninstallBridgePage };
import type { PickPayload } from "./shared/contract.js";
import {
	normalizeServerUrl,
	normalizeSettings,
	originPattern,
	tabMatchesBase,
	type PickerSettings,
} from "./shared/settings.js";
import { planCrop, type CropPlan } from "./shared/shot-crop.js";
import { toPrompt } from "./shared/to-prompt.js";

export const PICKER_FILE = "dist/picker.js";
export const BIND_FILE = "dist/bind.js";

export interface ChromeLike {
	tabs: { captureVisibleTab(windowId: number | undefined, options: { format: "png" }): Promise<string> };
}

interface ComposeResult {
	ok: boolean;
	reason?: "no-host" | "refused";
}

interface ComposeAttachment {
	path: string;
	name: string;
	mode: "inline";
	imageData: string;
	key: string;
}

export function composeInPage(text: string, attachments: ComposeAttachment[]): ComposeResult {
	const host = (globalThis as unknown as Record<string, unknown>).__piWebUiHost as
		{ compose?: (o: { text: string; attachments?: ComposeAttachment[] }) => boolean } | undefined;
	if (!host || typeof host.compose !== "function") return { ok: false, reason: "no-host" };
	const ok = host.compose(attachments.length > 0 ? { text, attachments } : { text });
	return ok ? { ok: true } : { ok: false, reason: "refused" };
}

export async function detectPiWebUi(): Promise<PiProbe> {
	const g = globalThis as unknown as { __piWebUiHost?: { compose?: unknown } };
	const url = location.href;
	const title = document.title;
	const hasHost = typeof g.__piWebUiHost?.compose === "function";
	if (hasHost) return { isPiWebUi: true, hasHost: true, url, title };
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 1200);
		const res = await fetch("/api/health", { cache: "no-store", signal: ctrl.signal });
		clearTimeout(timer);
		if (res.ok) {
			const info = (await res.json()) as { ok?: unknown; piVersion?: unknown; engine?: unknown } | null;
			if (info && info.ok === true && (typeof info.piVersion === "string" || typeof info.engine === "string")) {
				return {
					isPiWebUi: true,
					hasHost: false,
					url,
					title,
					...(typeof info.piVersion === "string" ? { piVersion: info.piVersion } : {}),
				};
			}
		}
	} catch {}
	return { isPiWebUi: false, hasHost, url, title };
}

async function probeTab(tabId: number): Promise<PiProbe | undefined> {
	try {
		const [first] = await chrome.scripting.executeScript<PiProbe>({
			target: { tabId },
			world: "MAIN",
			func: detectPiWebUi,
		});
		return first?.result;
	} catch {
		return undefined;
	}
}

export async function handleAction(tab: { id?: number; url?: string; title?: string } | undefined): Promise<void> {
	const tabId = tab?.id;
	if (tabId == null) return;
	await rememberOrigin(tab?.url, tab?.title);
	const probe = await probeTab(tabId);
	if (probe?.isPiWebUi) {
		console.log("[page-picker] 本页是 pi-web-ui → 注入绑定浮条", tabId, probe.url);
		await injectBindBar(tabId);
		return;
	}
	if (probe === undefined) {
		console.log("[page-picker] MAIN 探测不可用 → 交给浮条自检", tabId);
		await injectBindBar(tabId);
		return;
	}
	console.log("[page-picker] 本页不是 pi-web-ui → 注入拾取器", tabId, probe.url);
	await startPicking(tab);
}

export async function injectBindBar(tabId: number): Promise<void> {
	try {
		await chrome.scripting.executeScript({ target: { tabId }, files: [BIND_FILE] });
		await chrome.action.setBadgeText({ text: "", tabId });
		await chrome.action
			.setTitle({
				title: getMessage(
					"background_piWebUiPageBadge",
					undefined,
					"这个页面是 pi-web-ui：页面上会问你要不要把它设为拾取服务地址",
				),
				tabId,
			})
			.catch(() => {});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await chrome.action.setBadgeText({ text: "!", tabId }).catch(() => {});
		await chrome.action.setTitle({ title: `这个页面无法注入：${message}`, tabId }).catch(() => {});
	}
}

interface PermissionsLike {
	contains?: (p: { origins: string[] }) => Promise<boolean>;
	request?: (p: { origins: string[] }) => Promise<boolean>;
}

async function ensureOrigin(pattern: string): Promise<boolean> {
	const perms = chrome.permissions as PermissionsLike | undefined;
	if (!perms?.contains || !perms.request) return true;
	try {
		if (await perms.contains({ origins: [pattern] })) return true;
	} catch {
		return true;
	}
	try {
		return await perms.request({ origins: [pattern] });
	} catch {
		return false;
	}
}

export async function bindServer(pageUrl: string): Promise<BindResult> {
	const base = normalizeServerUrl(pageUrl);
	const pattern = originPattern(base);
	if (!(await ensureOrigin(pattern))) {
		return {
			ok: false,
			base,
			needAuth: true,
			message: getMessage(
				"bind_needAuth",
				[pattern],
				`还差一次授权（${pattern}）：浏览器要求这个动作在扩展自己的页面里点一下`,
			),
		};
	}
	try {
		await chrome.storage.sync.set({ serverUrl: base });
	} catch (err) {
		return {
			ok: false,
			base,
			message: getMessage(
				"bind_saveFailed",
				[err instanceof Error ? err.message : String(err)],
				`保存失败：${err instanceof Error ? err.message : String(err)}`,
			),
		};
	}
	return {
		ok: true,
		base,
		message: getMessage("bind_bound", [base], `已绑定 ${base} —— 以后拾取的内容都注入到这里`),
	};
}

export async function openOptionsFor(pageUrl: string): Promise<void> {
	const base = normalizeServerUrl(pageUrl);
	try {
		await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html?bind=${encodeURIComponent(base)}`) });
	} catch {}
}

export async function openOptionsForPair(pageUrl: string): Promise<boolean> {
	const origin = normalizeOrigin(pageUrl);
	if (!origin) return false;
	try {
		await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html?pair=${encodeURIComponent(origin)}`) });
		return true;
	} catch {
		return false;
	}
}

export async function openOptionsForGrant(pageUrl: string): Promise<boolean> {
	const origin = normalizeOrigin(pageUrl);
	if (!origin) return false;
	try {
		await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html?grant=${encodeURIComponent(origin)}`) });
		return true;
	} catch {
		return false;
	}
}

export async function loadSettings(): Promise<PickerSettings> {
	try {
		const raw = await chrome.storage.sync.get(null);
		return normalizeSettings(raw);
	} catch {
		return normalizeSettings(null);
	}
}

export async function startPicking(tab: { id?: number } | undefined): Promise<void> {
	const tabId = tab?.id;
	if (tabId == null) return;
	try {
		await chrome.scripting.executeScript({ target: { tabId }, files: [PICKER_FILE] });
		await chrome.action.setBadgeText({ text: "", tabId });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await chrome.action.setBadgeText({ text: "!", tabId }).catch(() => {});
		await chrome.action.setTitle({ title: `这个页面无法拾取：${message}`, tabId }).catch(() => {});
	}
}

export type TargetMiss = "no-permission" | "no-tab";

async function findTargetTab(settings: PickerSettings): Promise<{ tab?: chrome.tabs.Tab; miss?: TargetMiss }> {
	const base = normalizeServerUrl(settings.serverUrl);
	try {
		const granted = await chrome.permissions.contains({ origins: [originPattern(base)] });
		if (!granted) return { miss: "no-permission" };
	} catch {}
	let tabs: chrome.tabs.Tab[] = [];
	try {
		tabs = await chrome.tabs.query({ url: [originPattern(base)] });
	} catch {
		return { miss: "no-tab" };
	}
	const tab = tabs.find((t) => t.id != null && tabMatchesBase(t.url, base));
	return tab ? { tab } : { miss: "no-tab" };
}

export async function attachShots(
	payload: PickPayload,
	settings: PickerSettings,
	tab: { id?: number; windowId?: number } | undefined,
	chromeApi: ChromeLike = chrome,
): Promise<PickPayload> {
	if (!settings.screenshots) return payload;
	const tabId = tab?.id;
	if (tabId == null || !tab) return payload;
	let dataUrl: string;
	try {
		dataUrl = await chromeApi.tabs.captureVisibleTab(tab.windowId, { format: "png" });
	} catch {
		return payload;
	}
	if (!dataUrl) return payload;
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
	} catch {
		return payload;
	}
	const dpr = payload.page?.viewport?.dpr ?? 1;
	const elements = [...payload.elements];
	let changed = false;
	for (let i = 0; i < elements.length; i++) {
		const el = elements[i];
		if (el.shot) continue;
		const plan = planCrop(el.snapshot.rect, { dpr, imageW: bitmap.width, imageH: bitmap.height });
		if (!plan) continue;
		try {
			const shot = await cropToPng(bitmap, plan);
			if (shot) {
				elements[i] = { ...el, shot };
				changed = true;
			}
		} catch {}
	}
	bitmap.close();
	return changed ? { ...payload, elements } : payload;
}

async function cropToPng(bitmap: ImageBitmap, plan: CropPlan): Promise<string | undefined> {
	const canvas = new OffscreenCanvas(plan.dstW, plan.dstH);
	const ctx = canvas.getContext("2d");
	if (!ctx) return undefined;
	ctx.drawImage(bitmap, plan.srcX, plan.srcY, plan.srcW, plan.srcH, 0, 0, plan.dstW, plan.dstH);
	const blob = await canvas.convertToBlob({ type: "image/png" });
	const bytes = new Uint8Array(await blob.arrayBuffer());
	return `data:image/png;base64,${toBase64(bytes)}`;
}

export function toBase64(bytes: Uint8Array): string {
	const TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i];
		const b1 = bytes[i + 1];
		const b2 = bytes[i + 2];
		out += TABLE[b0 >> 2];
		out += TABLE[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
		out += b1 === undefined ? "=" : TABLE[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
		out += b2 === undefined ? "=" : TABLE[b2 & 63];
	}
	return out;
}

export function attachmentsOf(payload: PickPayload): ComposeAttachment[] {
	const out: ComposeAttachment[] = [];
	payload.elements.forEach((el, i) => {
		if (!el.shot) return;
		out.push({
			path: "",
			name: `元素${i + 1}-${el.snapshot.tag}.png`,
			mode: "inline",
			imageData: el.shot,
			key: `${payload.id}-${i + 1}`,
		});
	});
	return out;
}

export async function deliver(
	payload: PickPayload,
	markdown: string,
	settings: PickerSettings,
): Promise<{ ok: boolean; message: string; copy?: string }> {
	const copy = settings.copyToClipboard ? markdown : undefined;
	const { tab, miss } = await findTargetTab(settings);
	if (!tab?.id) {
		const base = normalizeServerUrl(settings.serverUrl);
		const suffix = copy ? getMessage("deliver_copiedFallback", undefined, "，Markdown 已复制到剪贴板") : "";
		if (miss === "no-permission") {
			return {
				ok: false,
				copy,
				message: getMessage(
					"deliver_noPermission",
					[originPattern(base), suffix],
					`还没授权 ${originPattern(base)} —— 到扩展选项页点「授权该地址」${suffix}`,
				),
			};
		}
		return {
			ok: false,
			copy,
			message: getMessage("deliver_noTab", [base, suffix], `没找到打开的 pi-web-ui 页面（${base}）${suffix}`),
		};
	}
	let result: ComposeResult | undefined;
	try {
		const [first] = await chrome.scripting.executeScript<ComposeResult>({
			target: { tabId: tab.id },
			world: "MAIN",
			func: composeInPage,
			args: [markdown, attachmentsOf(payload)],
		});
		result = first?.result;
	} catch (err) {
		return {
			ok: false,
			copy,
			message: getMessage(
				"deliver_injectFailed",
				[err instanceof Error ? err.message : String(err)],
				`注入 pi-web-ui 失败：${err instanceof Error ? err.message : String(err)}`,
			),
		};
	}
	if (result?.ok) {
		if (settings.focusTarget) await focusTab(tab);
		const n = payload.elements.length;
		return {
			ok: true,
			copy,
			message: getMessage("deliver_injected", [String(n)], `已添加到 pi-web-ui 输入框（${n} 个元素），补充说明后发送`),
		};
	}
	if (result?.reason === "no-host") {
		return {
			ok: false,
			copy,
			message: getMessage(
				"deliver_noHost",
				undefined,
				"这个 pi-web-ui 页面还不支持输入框注入（版本过旧），请更新 pi-web-ui 后刷新页面",
			),
		};
	}
	return {
		ok: false,
		copy,
		message: getMessage("deliver_notReady", undefined, "pi-web-ui 输入框还没就绪，刷新页面后再试"),
	};
}

async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
	try {
		if (tab.id != null) await chrome.tabs.update(tab.id, { active: true });
		if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
	} catch {}
}

export const BRIDGE_FILE = "dist/bridge.js";

export interface PeerCallResult {
	ok: boolean;
	value?: unknown;
	error?: string;
	code?: string;
}

export interface BridgeContext {
	pairs: BridgePair[];
	aiPages: AiPage[];
	settings: PickerSettings;
}

export async function loadBridgeContext(): Promise<BridgeContext> {
	const [pairs, aiPages, settings] = await Promise.all([loadPairs(), loadAiPages(), loadSettings()]);
	return { pairs, aiPages, settings };
}

export function roleOf(tabUrl: string | undefined, ctx: BridgeContext): "host" | "target" | "peer" | "none" {
	if (!tabUrl) return "none";
	const origin = normalizeOrigin(tabUrl);
	if (!origin) return "none";
	if (tabMatchesBase(tabUrl, ctx.settings.serverUrl)) return "host";
	if (ctx.aiPages.some((page) => page.origin === origin)) return "target";
	if (peersOf(ctx.pairs, origin).length > 0) return "peer";
	return "none";
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

export async function armBridge(tab: { id?: number; url?: string }, ctx?: BridgeContext): Promise<boolean> {
	const tabId = tab?.id;
	const origin = normalizeOrigin(tab?.url);
	if (tabId == null || !origin) return false;
	const context = ctx ?? (await loadBridgeContext());
	const role = roleOf(tab?.url, context);
	if (role === "none") return false;
	try {
		await chrome.scripting.executeScript({ target: { tabId }, files: [BRIDGE_FILE] });
	} catch (err) {
		console.log("[page-picker] 页面桥注入失败：", tabId, err instanceof Error ? err.message : err);
		return false;
	}
	try {
		const res = await chrome.tabs.sendMessage<{ ok?: boolean; token?: string }>(tabId, {
			type: "page-picker:bridge-arm",
		});
		if (!res?.token) return false;
	} catch {
		return false;
	}
	const peers = role === "host" ? context.aiPages.map((page) => page.origin) : peersOf(context.pairs, origin);
	try {
		await chrome.scripting.executeScript({
			target: { tabId },
			world: "MAIN",
			func: installBridgePage,
			args: [{ peers, self: origin, control: role === "target" }],
		});
	} catch {
		return false;
	}
	return true;
}

export async function syncBridges(ctx?: BridgeContext): Promise<number> {
	const context = ctx ?? (await loadBridgeContext());
	const origins = new Set<string>();
	for (const page of context.aiPages) origins.add(page.origin);
	for (const pair of context.pairs) {
		if (!pair.enabled) continue;
		origins.add(pair.a);
		origins.add(pair.b);
	}
	const hostPattern = originPattern(context.settings.serverUrl);
	let count = 0;
	for (const origin of [...origins, context.settings.serverUrl]) {
		const pattern = originPattern(origin);
		if (!(await hasOriginPermission(pattern))) continue;
		let tabs: chrome.tabs.Tab[] = [];
		try {
			tabs = await chrome.tabs.query({ url: [pattern] });
		} catch {
			continue;
		}
		for (const tab of tabs) {
			if (tab.id == null) continue;
			const same =
				tabMatchesBase(tab.url, context.settings.serverUrl) || normalizeOrigin(tab.url) === normalizeOrigin(origin);
			if (!same) continue;
			if (await armBridge({ id: tab.id, url: tab.url }, context)) count++;
		}
	}
	void hostPattern;
	return count;
}

export async function removeBridgeFromOrigin(origin: unknown): Promise<number> {
	const self = normalizeOrigin(origin);
	if (!self) return 0;
	const pattern = originPattern(self);
	if (!(await hasOriginPermission(pattern))) return 0;
	let tabs: chrome.tabs.Tab[] = [];
	try {
		tabs = await chrome.tabs.query({ url: [pattern] });
	} catch {
		return 0;
	}
	let count = 0;
	for (const tab of tabs) {
		if (tab.id == null || normalizeOrigin(tab.url) !== self) continue;
		try {
			await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: uninstallBridgePage });
			count++;
		} catch {}
	}
	return count;
}

/**
 * 同 origin 可能开着好几个标签：优先用户当前打开（active）的那个，否则取第一个。
 * 不这样选，"操作这个页面"就会落到后台标签上，“用户看不见页面在动”的那类怪事就从这里来。
 */
async function findPeerTab(origin: string): Promise<chrome.tabs.Tab | undefined> {
	let tabs: chrome.tabs.Tab[] = [];
	try {
		tabs = await chrome.tabs.query({ url: [originPattern(origin)] });
	} catch {
		return undefined;
	}
	const matches = tabs.filter((t) => t.id != null && normalizeOrigin(t.url) === origin);
	return matches.find((t) => t.active === true) ?? matches[0];
}

async function callPeerTab(
	tabId: number,
	req: { op: string; args?: unknown; from: string; builtin?: boolean },
	timeoutMs: number,
): Promise<PeerCallResult> {
	let res: PeerCallResult | undefined;
	try {
		const [first] = await withTimeout(
			chrome.scripting.executeScript<PeerCallResult>({
				target: { tabId },
				world: "MAIN",
				func: invokeBridgeHandler,
				args: [req],
			}),
			timeoutMs + 2000,
			getMessage("bridge_peerTimeout", [String(timeoutMs)], `对端在 ${timeoutMs}ms 内没回`),
		);
		res = first?.result;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, code: "inject-failed", error: /没回/.test(message) ? message : `调用对端失败：${message}` };
	}
	if (!res || typeof res !== "object") {
		return {
			ok: false,
			code: "empty",
			error: getMessage("bridge_peerNoResult", undefined, "对端没有返回结果"),
		};
	}
	if (res.ok === true) {
		const size = measureForTransport(
			res.value,
			getMessage("bridge_peerResultLabel", undefined, "对端返回的结果"),
			MAX_RESULT_CHARS,
		);
		if (!size.ok) return { ok: false, code: "too-large", error: size.message };
		return res.value === undefined ? { ok: true } : { ok: true, value: res.value };
	}
	return {
		ok: false,
		...(res.code ? { code: res.code } : {}),
		error: res.error ?? getMessage("bridge_peerCallFailed", undefined, "对端调用失败"),
	};
}

export async function handleBridgeCall(raw: unknown, sender: chrome.runtime.MessageSender): Promise<PeerCallResult> {
	const from = normalizeOrigin(sender.tab?.url);
	if (!from) {
		return {
			ok: false,
			error: getMessage(
				"bridge_noHttpOrigin",
				undefined,
				"页面桥只能从 http/https 页面上发起（或者该地址还没授权，读不到标签页地址）",
			),
		};
	}
	const parsed = parseBridgeCall(raw);
	if (!parsed.ok) return { ok: false, code: "bad-op", error: parsed.message };
	const { op, args, to, timeoutMs } = parsed.call;

	const context = await loadBridgeContext();
	if (tabMatchesBase(sender.tab?.url, context.settings.serverUrl)) {
		return await handleAiCall({ op, args, to, timeoutMs, from }, context);
	}

	const route = decideRoute(context.pairs, from, to);
	if (!route.ok) return { ok: false, code: route.code, error: route.message };

	const pattern = originPattern(route.peer);
	if (!(await hasOriginPermission(pattern))) {
		return {
			ok: false,
			error: getMessage("bridge_noPermission", [pattern], `还没授权 ${pattern} —— 到扩展选项页「页面桥」里点一次授权`),
		};
	}
	const target = await findPeerTab(route.peer);
	if (!target?.id) {
		return {
			ok: false,
			code: "no-peer",
			error: getMessage(
				"bridge_peerNotOpen",
				[route.peer],
				`对端页面（${route.peer}）没打开 —— 先把它开在一个标签页里`,
			),
		};
	}

	const req = { op, ...(args === undefined ? {} : { args }), from };
	const tabId = target.id;
	let result = await callPeerTab(tabId, req, timeoutMs);
	if (!result.ok && result.code === "no-bridge") {
		if (await armBridge({ id: tabId, url: target.url }, context)) {
			result = await callPeerTab(tabId, req, timeoutMs);
		}
	}
	return result;
}

async function openOrigins(origins: string[]): Promise<Set<string>> {
	const open = new Set<string>();
	for (const origin of origins) {
		const pattern = originPattern(origin);
		if (!(await hasOriginPermission(pattern))) continue;
		try {
			const tabs = await chrome.tabs.query({ url: [pattern] });
			if (tabs.some((t) => t.id != null && normalizeOrigin(t.url) === origin)) open.add(origin);
		} catch {}
	}
	return open;
}

/**
 * 用户正在看的已授权页面：只看最后一个聚焦窗口里 active 的那个标签。
 * 不加 `tabs` 权限，只对已授 host 权限的 origin 查询——未授权页面连 url 都读不到，也就不该被报给模型。
 */
async function activeOrigins(origins: string[]): Promise<Set<string>> {
	const active = new Set<string>();
	for (const origin of origins) {
		const pattern = originPattern(origin);
		if (!(await hasOriginPermission(pattern))) continue;
		try {
			const tabs = await chrome.tabs.query({ url: [pattern], active: true, lastFocusedWindow: true });
			if (tabs.some((t) => t.id != null && normalizeOrigin(t.url) === origin)) active.add(origin);
		} catch {}
	}
	return active;
}

async function describeAiPages(
	ctx: BridgeContext,
): Promise<{ pages: { origin: string; title: string; open: boolean; active: boolean }[]; activeOrigin?: string }> {
	const origins = ctx.aiPages.map((page) => page.origin);
	const [open, active] = await Promise.all([openOrigins(origins), activeOrigins(origins)]);
	const activeOrigin = origins.find((origin) => active.has(origin));
	return {
		pages: ctx.aiPages.map((page) => ({
			origin: page.origin,
			title: page.title ?? page.origin,
			open: open.has(page.origin),
			active: page.origin === activeOrigin,
		})),
		...(activeOrigin ? { activeOrigin } : {}),
	};
}

/** 没指定 target 且有多个授权页面时，把"用户正在看的那一个"带给路由裁决，好在报错里直接点明。 */
async function activeOriginHint(ctx: BridgeContext, to: string | undefined): Promise<string | undefined> {
	const want = typeof to === "string" ? to.trim() : "";
	if (want || ctx.aiPages.length < 2) return undefined;
	const active = await activeOrigins(ctx.aiPages.map((page) => page.origin));
	return ctx.aiPages.map((page) => page.origin).find((origin) => active.has(origin));
}

async function handleAiCall(
	req: { op: string; args?: unknown; to?: string; timeoutMs: number; from: string },
	ctx: BridgeContext,
): Promise<PeerCallResult> {
	const { op, args, to, timeoutMs, from } = req;
	if (op === "status") {
		const listing = await describeAiPages(ctx);
		return {
			ok: true,
			value: {
				installed: true,
				hasHost: true,
				version: chrome.runtime.getManifest?.().version ?? "",
				aiControl: ctx.settings.aiControl,
				allowEval: ctx.settings.allowEval,
				allowShot: ctx.settings.allowShot,
				shotPermission: await hasShotPermission(),
				...listing,
				optionsUrl: chrome.runtime.getURL("options.html"),
			},
		};
	}
	if (op === "openOptions") {
		try {
			await chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
			return { ok: true, value: { opened: true } };
		} catch (err) {
			return {
				ok: false,
				error: getMessage(
					"ai_optionsOpenFailed",
					[err instanceof Error ? err.message : String(err)],
					`打不开扩展设置页：${err instanceof Error ? err.message : String(err)}`,
				),
			};
		}
	}
	if (!ctx.settings.aiControl) {
		return {
			ok: false,
			code: "disabled",
			error: getMessage("ai_statusDisabled", undefined, "「AI 操作页面」已在扩展设置里关闭 —— 到选项页打开后再试"),
		};
	}
	if (!isBuiltinOp(op)) {
		return {
			ok: false,
			code: "bad-op",
			error: getMessage(
				"ai_badOp",
				[op, BUILTIN_OPS.join("、")],
				`不支持的动作 "${op}"（支持：${BUILTIN_OPS.join("、")}）`,
			),
		};
	}
	if (op === EVAL_OP && !ctx.settings.allowEval) {
		return {
			ok: false,
			code: "eval-disabled",
			error: getMessage(
				"ai_evalDisabled",
				undefined,
				"「在页面里执行任意 JS」默认关闭 —— 到扩展选项页「AI 操作页面」里打开它再用 eval",
			),
		};
	}
	if (op === "shot" && !ctx.settings.allowShot) {
		return {
			ok: false,
			code: "shot-disabled",
			error: getMessage(
				"ai_shotDisabled",
				undefined,
				"「允许截图」已在扩展设置里关闭 —— 到选项页打开后再试（关掉时模型只能靠 read 读 DOM）",
			),
		};
	}
	if (op === "pages") return { ok: true, value: await describeAiPages(ctx) };
	const target = await resolveAiTarget(ctx, to);
	if (!target.ok) return target.result;
	if (op === "shot") return await captureShot(target.tab, (args ?? {}) as Record<string, unknown>);
	const peerReq = { op, ...(args === undefined ? {} : { args }), from, builtin: true };
	let result = await callPeerTab(target.tab.id as number, peerReq, timeoutMs);
	if (!result.ok && (result.code === "no-bridge" || result.code === "no-control")) {
		if (await armBridge({ id: target.tab.id, url: target.tab.url }, ctx)) {
			result = await callPeerTab(target.tab.id as number, peerReq, timeoutMs);
		}
	}
	return result;
}

async function resolveAiTarget(
	ctx: BridgeContext,
	to: string | undefined,
): Promise<{ ok: true; tab: chrome.tabs.Tab } | { ok: false; result: PeerCallResult }> {
	const route = decideAiRoute(ctx.aiPages, to, await activeOriginHint(ctx, to));
	if (!route.ok) return { ok: false, result: { ok: false, code: route.code, error: route.message } };
	const pattern = originPattern(route.peer);
	if (!(await hasOriginPermission(pattern))) {
		return {
			ok: false,
			result: {
				ok: false,
				error: getMessage(
					"ai_noPermission",
					[pattern],
					`还没授权 ${pattern} —— 到扩展选项页「AI 操作页面」里授权该地址`,
				),
			},
		};
	}
	const tab = await findPeerTab(route.peer);
	if (!tab?.id) {
		return {
			ok: false,
			result: {
				ok: false,
				code: "no-peer",
				error: getMessage("ai_pageNotOpen", [route.peer], `页面（${route.peer}）没打开 —— 先把它开在一个标签页里`),
			},
		};
	}
	return { ok: true, tab };
}

const SHOT_DEFAULT_EDGE = 1280;
const SHOT_MAX_EDGE = 1568;
const SHOT_CAPTURE_QUALITY = 72;
const SHOT_ENCODE_QUALITY = 0.72;
const SHOT_SETTLE_MS = 220;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function hasShotPermission(): Promise<boolean> {
	const perms = chrome.permissions;
	if (!perms?.contains) return true;
	try {
		return await perms.contains({ origins: [...SHOT_PERMISSION_ORIGINS] });
	} catch {
		return true;
	}
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
	const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : dflt;
	return Math.min(max, Math.max(min, n));
}

function fullPlan(w: number, h: number, maxEdge: number): CropPlan | null {
	if (!(w > 0) || !(h > 0)) return null;
	const scale = Math.min(1, maxEdge / Math.max(w, h));
	return {
		srcX: 0,
		srcY: 0,
		srcW: w,
		srcH: h,
		dstW: Math.max(1, Math.round(w * scale)),
		dstH: Math.max(1, Math.round(h * scale)),
	};
}

async function encodeShot(
	dataUrl: string,
	rect: { x: number; y: number; w: number; h: number } | undefined,
	dpr: number,
	maxEdge: number,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
	} catch {
		return null;
	}
	const plan = rect
		? planCrop({ ...rect, vwPct: 0, vhPct: 0 }, { dpr, imageW: bitmap.width, imageH: bitmap.height, maxEdge })
		: fullPlan(bitmap.width, bitmap.height, maxEdge);
	if (!plan) {
		bitmap.close();
		return null;
	}
	try {
		const canvas = new OffscreenCanvas(plan.dstW, plan.dstH);
		const ctx2d = canvas.getContext("2d");
		if (!ctx2d) return null;
		ctx2d.drawImage(bitmap, plan.srcX, plan.srcY, plan.srcW, plan.srcH, 0, 0, plan.dstW, plan.dstH);
		const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: SHOT_ENCODE_QUALITY });
		const bytes = new Uint8Array(await blob.arrayBuffer());
		return { dataUrl: `data:image/jpeg;base64,${toBase64(bytes)}`, width: plan.dstW, height: plan.dstH };
	} catch {
		return null;
	} finally {
		bitmap.close();
	}
}

async function captureShot(tab: chrome.tabs.Tab, args: Record<string, unknown>): Promise<PeerCallResult> {
	const tabId = tab.id;
	if (tabId == null) {
		return {
			ok: false,
			code: "no-peer",
			error: getMessage("ai_targetNoId", undefined, "目标标签页没有 id"),
		};
	}
	if (!(await hasShotPermission())) {
		return {
			ok: false,
			code: "shot-permission",
			error: getMessage(
				"ai_shotPermissionNeeded",
				undefined,
				"截图需要额外权限（读取所有网站数据）：到扩展选项页「AI 操作页面」里打开「允许截图」并授权；不想给这个权限就保持关闭（模型只能靠 read 读 DOM）",
			),
		};
	}
	const selector = typeof args.selector === "string" ? args.selector.trim() : "";
	const maxEdge = clampInt(args.maxEdge, SHOT_DEFAULT_EDGE, 320, SHOT_MAX_EDGE);

	const metrics = await callPeerTab(tabId, { op: "metrics", args: {}, from: "", builtin: true }, 5000);
	if (!metrics.ok) return metrics;
	const dpr = Number((metrics.value as { dpr?: unknown } | undefined)?.dpr ?? 1) || 1;

	let rect: { x: number; y: number; w: number; h: number } | undefined;
	if (selector) {
		const probe = await callPeerTab(
			tabId,
			{ op: "read", args: { what: "query", selector, limit: 1 }, from: "", builtin: true },
			5000,
		);
		if (!probe.ok) return probe;
		const first = (probe.value as { items?: { rect?: { x: number; y: number; w: number; h: number } }[] } | undefined)
			?.items?.[0];
		if (!first?.rect) {
			return {
				ok: false,
				code: "op-failed",
				error: getMessage("ai_selectorNoMatch", [selector], `选择器没匹上：${selector}`),
			};
		}
		rect = first.rect;
	}

	let restoreTabId: number | undefined;
	try {
		const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
		if (active?.id != null && active.id !== tabId) restoreTabId = active.id;
	} catch {}
	const switched = restoreTabId != null;
	try {
		if (switched) {
			await chrome.tabs.update(tabId, { active: true });
			if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
			await sleep(SHOT_SETTLE_MS);
		}
		let dataUrl: string;
		try {
			dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: SHOT_CAPTURE_QUALITY });
		} catch (err) {
			return {
				ok: false,
				code: "inject-failed",
				error: getMessage(
					"ai_screenshotFailed",
					[err instanceof Error ? err.message : String(err)],
					`截不到这个页面：${err instanceof Error ? err.message : String(err)}`,
				),
			};
		}
		const encoded = await encodeShot(dataUrl, rect, dpr, maxEdge);
		if (!encoded) {
			return {
				ok: false,
				code: "op-failed",
				error: selector
					? getMessage("ai_elementNotInViewport", [selector], `元素几乎不在视口里，截出来是碎图：${selector}`)
					: getMessage("ai_screenshotFailedEmpty", undefined, "截图失败（页面没有可截内容）"),
			};
		}
		return {
			ok: true,
			value: {
				image: { dataUrl: encoded.dataUrl, mimeType: "image/jpeg", width: encoded.width, height: encoded.height },
				...(selector ? { selector } : {}),
				...(rect ? { rect } : {}),
				viewport: { dpr },
			},
		};
	} finally {
		if (switched && restoreTabId != null) {
			try {
				await chrome.tabs.update(restoreTabId, { active: true });
			} catch {}
		}
	}
}

export function handleMessage(
	raw: unknown,
	sender: chrome.runtime.MessageSender,
	respond: (response?: unknown) => void,
): boolean | undefined {
	const msg = (raw ?? {}) as {
		type?: string;
		payload?: PickPayload;
		url?: string;
		detail?: unknown;
		sections?: unknown;
		removedOrigins?: unknown;
	};
	if (msg.type === "page-picker:settings") {
		void loadSettings().then((s) => respond({ detail: s.detail, sections: s.sections, serverUrl: s.serverUrl }));
		return true;
	}
	if (msg.type === "page-picker:page-state") {
		void (async () => {
			const url = typeof msg.url === "string" && msg.url ? msg.url : (sender.tab?.url ?? "");
			const origin = normalizeOrigin(url) ?? "";
			const [pages, settings] = await Promise.all([loadAiPages(), loadSettings()]);
			const page = pages.find((item) => item.origin === origin);
			respond({
				origin,
				authorized: Boolean(page),
				...(page?.title ? { title: page.title } : {}),
				aiControl: settings.aiControl,
			});
		})();
		return true;
	}
	if (msg.type === "page-picker:set-sections") {
		void (async () => {
			try {
				const current = await loadSettings();
				const next = normalizeSettings({
					...current,
					...(msg.detail === undefined ? {} : { detail: msg.detail }),
					...(msg.sections === undefined ? {} : { sections: msg.sections }),
				});
				await chrome.storage.sync.set({ detail: next.detail, sections: next.sections });
				respond({ ok: true, detail: next.detail, sections: next.sections });
			} catch (err) {
				respond({
					ok: false,
					message: getMessage(
						"bind_saveFailed",
						[err instanceof Error ? err.message : String(err)],
						`保存失败：${err instanceof Error ? err.message : String(err)}`,
					),
				});
			}
		})();
		return true;
	}
	if (msg.type === "page-picker:bind") {
		void (async () => {
			const url = typeof msg.url === "string" && msg.url ? msg.url : (sender.tab?.url ?? "");
			try {
				respond(await bindServer(url));
			} catch (err) {
				respond({
					ok: false,
					base: "",
					message: getMessage(
						"bridge_bindFailed",
						[err instanceof Error ? err.message : String(err)],
						`绑定失败：${err instanceof Error ? err.message : String(err)}`,
					),
				});
			}
		})();
		return true;
	}
	if (msg.type === "page-picker:open-options") {
		void openOptionsFor(typeof msg.url === "string" ? msg.url : "");
		respond({ ok: true });
		return true;
	}
	if (msg.type === "page-picker:pick-anyway") {
		void startPicking(sender.tab);
		respond({ ok: true });
		return true;
	}
	if (msg.type === "page-picker:picked") {
		void (async () => {
			const settings = await loadSettings();
			const original = msg.payload;
			if (!original?.elements?.length) {
				respond({ ok: false, message: getMessage("deliver_noElements", undefined, "没有可发送的元素") });
				return;
			}
			const payload = await attachShots(original, settings, sender.tab).catch(() => original);
			const markdown = toPrompt(payload);
			if (!markdown) {
				respond({ ok: false, message: getMessage("deliver_noElements", undefined, "没有可发送的元素") });
				return;
			}
			try {
				respond(await deliver(payload, markdown, settings));
			} catch (err) {
				respond({
					ok: false,
					copy: markdown,
					message: getMessage(
						"deliver_sendFailed",
						[err instanceof Error ? err.message : String(err)],
						`发送失败：${err instanceof Error ? err.message : String(err)}`,
					),
				});
			}
		})();
		return true;
	}
	if (msg.type === "page-picker:pair-here") {
		void (async () => {
			const url = typeof msg.url === "string" && msg.url ? msg.url : (sender.tab?.url ?? "");
			await rememberOrigin(url, sender.tab?.title);
			respond({ ok: await openOptionsForPair(url) });
		})();
		return true;
	}
	if (msg.type === "page-picker:grant-here") {
		void (async () => {
			const url = typeof msg.url === "string" && msg.url ? msg.url : (sender.tab?.url ?? "");
			await rememberOrigin(url, sender.tab?.title);
			respond({ ok: await openOptionsForGrant(url) });
		})();
		return true;
	}
	if (msg.type === "page-picker:bridge-call") {
		void handleBridgeCall(raw, sender)
			.then((res) => respond(res))
			.catch((err) =>
				respond({
					ok: false,
					error: getMessage(
						"bridge_callFailed3",
						[err instanceof Error ? err.message : String(err)],
						`页面桥失败：${err instanceof Error ? err.message : String(err)}`,
					),
				}),
			);
		return true;
	}
	if (msg.type === "page-picker:pairs-changed" || msg.type === "page-picker:bridges-changed") {
		void (async () => {
			try {
				const context = await loadBridgeContext();
				const installed = await syncBridges(context);
				const removed = Array.isArray(msg.removedOrigins) ? msg.removedOrigins : [];
				let uninstalled = 0;
				for (const origin of removed) uninstalled += await removeBridgeFromOrigin(origin);
				respond({ ok: true, installed, uninstalled });
			} catch (err) {
				respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
			}
		})();
		return true;
	}
	void sender;
	return undefined;
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
	chrome.action?.onClicked?.addListener((tab) => {
		void handleAction(tab);
	});
	chrome.commands?.onCommand?.addListener((command, tab) => {
		if (command !== "toggle-picking") return;
		void handleAction(tab);
	});
	chrome.runtime.onMessage.addListener(handleMessage);
	chrome.tabs?.onUpdated?.addListener((tabId, info, tab) => {
		if (!info.url && info.status !== "complete") return;
		void armBridge({ id: tabId, url: tab?.url });
	});
	void syncBridges();
}
