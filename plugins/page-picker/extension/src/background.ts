/// <reference path="./chrome.d.ts" />
/// <reference lib="dom" />
/**
 * Service worker：扩展的大脑（唯一知道 pi-web-ui 在哪的一块）。
 *
 * 职责边界：
 * - content script 只管「在被调试页面上拾取 + 画 UI」，**不知道 pi-web-ui 的存在**；
 * - 这里负责读设置、把契约渲染成 Markdown、找到 pi-web-ui 标签页、注入内容；
 * - 投递用 `world: "MAIN"` 注入（隔离世界看不到页面上的 `window.__piWebUiHost`）；
 * - 点图标时**先认页面**：当前页就是 pi-web-ui 的话，注入绑定浮条问用户要不要把它
 *   设成服务地址（远程/局域网部署不用再手打地址），而不是往它上面注入拾取器。
 *
 * 兜底纪律：**投递失败也必须把 Markdown 交给用户**（回给 content script 复制到剪贴板），
 * 绝不出现「点了发送，什么都没发生」。
 */

import type { BindResult, PiProbe } from "./shared/bind.js";
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

/** 截图那条链上用到的最小 chrome 面（注入以便单测替换）。 */
export interface ChromeLike {
	tabs: { captureVisibleTab(windowId: number | undefined, options: { format: "png" }): Promise<string> };
}

/** 注入 MAIN world 的函数：调页面上的宿主动作桥，把内容塞进输入框草稿。 */
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

/** MAIN world 里执行：只做「找到桥 + 调用」，所有判断回传给 worker 做。 */
export function composeInPage(text: string, attachments: ComposeAttachment[]): ComposeResult {
	const host = (globalThis as unknown as Record<string, unknown>).__piWebUiHost as
		{ compose?: (o: { text: string; attachments?: ComposeAttachment[] }) => boolean } | undefined;
	if (!host || typeof host.compose !== "function") return { ok: false, reason: "no-host" };
	const ok = host.compose(attachments.length > 0 ? { text, attachments } : { text });
	return ok ? { ok: true } : { ok: false, reason: "refused" };
}

/**
 * MAIN world 里执行：判断当前这个页面是不是 pi-web-ui，以及页面上有没有宿主动作桥。
 *
 * 两个判据（**都要**，因为版本分布很杂）：
 * 1. `window.__piWebUiHost`（宿主 API v2 起有）—— 最硬，但仍要 `/api/health` 兜底，
 *    因为老版本没有这个桥；
 * 2. 同源探一次 `/api/health`（pi-web-ui 一直有这个路由，返回 `{ok, piVersion, engine}`）。
 *    这是**页面自己**发的同源请求，不需要扩展有该 origin 的权限（远程部署下正是缺这个）。
 *
 * 注意：这个函数会被序列化后注入页面，**不能引用模块作用域的任何东西**（只能用全局）。
 * 探测最长等 1.2s：点图标这件事绝不能被一个慢请求卡住。
 */
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
	} catch {
		/* 探不通（跨域/CSP/超时）→ 就当它不是 pi-web-ui，走原来的拾取流程 */
	}
	return { isPiWebUi: false, hasHost, url, title };
}

/** 在当前标签页里跑探测（注入不了就返回 undefined，交给调用方按老路走）。 */
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

/**
 * 点扩展图标 / 按快捷键的入口：**先认页面，再决定注入什么**。
 *
 * 在 pi-web-ui 自己的页面上注入拾取器是没有意义的（这里的元素不是用户要改的代码），
 * 而且远程部署的用户此刻正站在这页上 —— 正是问「要不要把它设成服务地址」的最佳时机。
 *
 * 三条分支都**不会静默**：
 * - 是 pi-web-ui → 注入绑定浮条；
 * - 不是 → 照旧注入拾取器；
 * - **探测本身不可用**（MAIN world 被 CSP/权限挡）→ 照样注入浮条，让它自己认页面
 *   （认不出会自己退场并请 worker 补注入拾取器）。路由决策也打进 SW 控制台，方便排障。
 */
export async function handleAction(tab: { id?: number; url?: string } | undefined): Promise<void> {
	const tabId = tab?.id;
	if (tabId == null) return;
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

/** 注入绑定浮条（它自己会找 background 要设置、按 location.href 算文案）。 */
export async function injectBindBar(tabId: number): Promise<void> {
	try {
		await chrome.scripting.executeScript({ target: { tabId }, files: [BIND_FILE] });
		await chrome.action.setBadgeText({ text: "", tabId });
		await chrome.action
			.setTitle({ title: "这个页面是 pi-web-ui：页面上会问你要不要把它设为拾取服务地址", tabId })
			.catch(() => {});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await chrome.action.setBadgeText({ text: "!", tabId }).catch(() => {});
		await chrome.action.setTitle({ title: `这个页面无法注入：${message}`, tabId }).catch(() => {});
	}
}

/** permissions API 的最小面（老环境可能整个没有 → 按可选处理）。 */
interface PermissionsLike {
	contains?: (p: { origins: string[] }) => Promise<boolean>;
	request?: (p: { origins: string[] }) => Promise<boolean>;
}

/**
 * 该 origin 的 host 权限有没有（没有就申请一次）。
 *
 * 申请必须在**用户手势**里发出，而绑定按钮点在页面上（content script 的 UI），
 * 浏览器不认这个手势 → `request` 会返回 false，于是回 needAuth，让用户去选项页点
 * （那里的点击一定带手势）。老环境没有 permissions API 时不阻断（后面按 URL 复核兜底）。
 */
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

/**
 * 把某个 pi-web-ui 页面绑成服务地址（浮条上点了「设为服务地址」）。
 *
 * 地址一律按页面**归一后**再存：`http://host:8787/?token=x` → `http://host:8787`。
 * 授权拿不到就不写存储 —— 没授权时连「找到那个标签页」都做不到，绑了也是白绑。
 */
export async function bindServer(pageUrl: string): Promise<BindResult> {
	const base = normalizeServerUrl(pageUrl);
	const pattern = originPattern(base);
	if (!(await ensureOrigin(pattern))) {
		return {
			ok: false,
			base,
			needAuth: true,
			message: `还差一次授权（${pattern}）：浏览器要求这个动作在扩展自己的页面里点一下`,
		};
	}
	try {
		await chrome.storage.sync.set({ serverUrl: base });
	} catch (err) {
		return { ok: false, base, message: `保存失败：${err instanceof Error ? err.message : String(err)}` };
	}
	return { ok: true, base, message: `已绑定 ${base} —— 以后拾取的内容都注入到这里` };
}

/** 打开选项页并带上 `?bind=`（那边有真正的用户手势，能授权、能测试连接）。 */
export async function openOptionsFor(pageUrl: string): Promise<void> {
	const base = normalizeServerUrl(pageUrl);
	try {
		await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html?bind=${encodeURIComponent(base)}`) });
	} catch {
		/* 打不开就只是没打开：用户还能自己去 chrome://extensions → 选项页 */
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

/** 点扩展图标 / 按快捷键：往当前标签页注入拾取器。 */
export async function startPicking(tab: { id?: number } | undefined): Promise<void> {
	const tabId = tab?.id;
	if (tabId == null) return;
	try {
		await chrome.scripting.executeScript({ target: { tabId }, files: [PICKER_FILE] });
		await chrome.action.setBadgeText({ text: "", tabId });
	} catch (err) {
		// 浏览器内部页 / 商店页 / PDF 等注入不了：明确告诉用户，别静默失败
		const message = err instanceof Error ? err.message : String(err);
		await chrome.action.setBadgeText({ text: "!", tabId }).catch(() => {});
		await chrome.action.setTitle({ title: `这个页面无法拾取：${message}`, tabId }).catch(() => {});
	}
}

/** 找不到目标页面的原因（要能区分，否则远程用户会被误导着去查错地方）。 */
export type TargetMiss = "no-permission" | "no-tab";

async function findTargetTab(settings: PickerSettings): Promise<{ tab?: chrome.tabs.Tab; miss?: TargetMiss }> {
	const base = normalizeServerUrl(settings.serverUrl);
	// 权限先查：没授权时 tabs.query 的 url 过滤会被静默忽略（返回全部标签页），
	// 再往下走就可能把内容注入到无关页面，还会报一个「找不到页面」的错诊。
	try {
		const granted = await chrome.permissions.contains({ origins: [originPattern(base)] });
		if (!granted) return { miss: "no-permission" };
	} catch {
		/* 老版本/测试环境没有 permissions API → 不阻断，继续往下（后面还有 URL 复核兜底） */
	}
	let tabs: chrome.tabs.Tab[] = [];
	try {
		// 只按 **origin 模式** 过滤（`http://localhost:8787/*`）：
		// 裸 origin（`http://localhost:8787`）不是合法 match pattern，Chrome/Edge 会直接抛
		// `Invalid url pattern` —— 一旦被 catch 成「没找到页面」，就变成「页开着但投不进去」。
		// 路径前缀的精确认定交给下面的 tabMatchesBase（它才认子路径反代）。
		tabs = await chrome.tabs.query({ url: [originPattern(base)] });
	} catch {
		return { miss: "no-tab" };
	}
	// 复核 URL：远程/子路径部署下绝不靠「有 id 就算」挑第一个
	const tab = tabs.find((t) => t.id != null && tabMatchesBase(t.url, base));
	return tab ? { tab } : { miss: "no-tab" };
}

/**
 * 给每个元素补截图（可选，设置里开）。
 *
 * 整屏截一次（`captureVisibleTab` 只给可见区域），然后按每个元素的 rect × dpr 抠出来、
 * 缩到长边 ≤1568。**任何一步失败都只是「没有截图」**，绝不因此让整次拾取失败 ——
 * 用户点的是「添加到对话」，不是「截图」。
 */
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
		return payload; // 没有 activeTab/权限、页面正在滚动……都不是致命错
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
		} catch {
			/* 单个元素截图失败不影响其它的 */
		}
	}
	bitmap.close();
	return changed ? { ...payload, elements } : payload;
}

/** 按计划抠图 → PNG data URL（service worker 里用 OffscreenCanvas，无 DOM 依赖）。 */
async function cropToPng(bitmap: ImageBitmap, plan: CropPlan): Promise<string | undefined> {
	const canvas = new OffscreenCanvas(plan.dstW, plan.dstH);
	const ctx = canvas.getContext("2d");
	if (!ctx) return undefined;
	ctx.drawImage(bitmap, plan.srcX, plan.srcY, plan.srcW, plan.srcH, 0, 0, plan.dstW, plan.dstH);
	const blob = await canvas.convertToBlob({ type: "image/png" });
	const bytes = new Uint8Array(await blob.arrayBuffer());
	return `data:image/png;base64,${toBase64(bytes)}`;
}

/** 手写 base64（SW 里没有 FileReader/btoa 的那套 DOM 便利）——分块避免超长参数栈溢出。 */
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

/** 卡片 → 对话附件（截图）。
 *  无路径无 key 的裸数据在宿主侧不会去重，所以 key 必须带上拾取 id（重试时不叠加）。 */
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

/** 把 Markdown（+ 截图附件）投进已打开的 pi-web-ui 页面输入框。 */
export async function deliver(
	payload: PickPayload,
	markdown: string,
	settings: PickerSettings,
): Promise<{ ok: boolean; message: string; copy?: string }> {
	const copy = settings.copyToClipboard ? markdown : undefined;
	const { tab, miss } = await findTargetTab(settings);
	if (!tab?.id) {
		const base = normalizeServerUrl(settings.serverUrl);
		const suffix = copy ? "，Markdown 已复制到剪贴板" : "";
		if (miss === "no-permission") {
			return {
				ok: false,
				copy,
				message: `还没授权 ${originPattern(base)} —— 到扩展选项页点「授权该地址」${suffix}`,
			};
		}
		return { ok: false, copy, message: `没找到打开的 pi-web-ui 页面（${base}）${suffix}` };
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
			message: `注入 pi-web-ui 失败：${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (result?.ok) {
		if (settings.focusTarget) await focusTab(tab);
		const n = payload.elements.length;
		return { ok: true, copy, message: `已添加到 pi-web-ui 输入框（${n} 个元素），补充说明后发送` };
	}
	if (result?.reason === "no-host") {
		return {
			ok: false,
			copy,
			message: "这个 pi-web-ui 页面还不支持输入框注入（版本过旧），请更新 pi-web-ui 后刷新页面",
		};
	}
	return { ok: false, copy, message: "pi-web-ui 输入框还没就绪，刷新页面后再试" };
}

async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
	try {
		if (tab.id != null) await chrome.tabs.update(tab.id, { active: true });
		if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
	} catch {
		/* 切不过去不影响已注入的内容 */
	}
}

/**
 * 消息路由（导出以便单测直接用假 chrome 驱动）。
 * @returns true = 会异步 respond（Chrome 要求回调返回 true 才保持通道）
 */
export function handleMessage(
	raw: unknown,
	sender: chrome.runtime.MessageSender,
	respond: (response?: unknown) => void,
): boolean | undefined {
	const msg = (raw ?? {}) as { type?: string; payload?: PickPayload; url?: string };
	if (msg.type === "page-picker:settings") {
		// serverUrl 不是秘密（和 token 不同），绑定浮条要拿它对比「本页是不是就是已绑定的那个」；
		// detail + sections 是拾取器要的「采多深 + 采哪几类」
		void loadSettings().then((s) => respond({ detail: s.detail, sections: s.sections, serverUrl: s.serverUrl }));
		return true;
	}
	if (msg.type === "page-picker:bind") {
		void (async () => {
			const url = typeof msg.url === "string" && msg.url ? msg.url : (sender.tab?.url ?? "");
			try {
				respond(await bindServer(url));
			} catch (err) {
				respond({ ok: false, base: "", message: `绑定失败：${err instanceof Error ? err.message : String(err)}` });
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
		// 绑定浮条上的「仍然在本页拾取」：内容脚本自己收掉浮条，这里补注入拾取器
		void startPicking(sender.tab);
		respond({ ok: true });
		return true;
	}
	if (msg.type === "page-picker:picked") {
		void (async () => {
			const settings = await loadSettings();
			const original = msg.payload;
			if (!original?.elements?.length) {
				respond({ ok: false, message: "没有可发送的元素" });
				return;
			}
			// 截图先补上（失败就只是没图），再渲染 —— 渲染要按最终的元素集合写「见本轮附图」
			const payload = await attachShots(original, settings, sender.tab).catch(() => original);
			const markdown = toPrompt(payload);
			if (!markdown) {
				respond({ ok: false, message: "没有可发送的元素" });
				return;
			}
			try {
				respond(await deliver(payload, markdown, settings));
			} catch (err) {
				respond({
					ok: false,
					copy: markdown,
					message: `发送失败：${err instanceof Error ? err.message : String(err)}`,
				});
			}
		})();
		return true; // 异步 respond
	}
	void sender;
	return undefined;
}

// 事件接线（在单测里 import 本模块时没有 chrome 全局，所以得过一道护栏）
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
	chrome.action?.onClicked?.addListener((tab) => {
		void handleAction(tab);
	});
	chrome.commands?.onCommand?.addListener((command, tab) => {
		if (command !== "toggle-picking") return;
		void handleAction(tab);
	});
	chrome.runtime.onMessage.addListener(handleMessage);
}
