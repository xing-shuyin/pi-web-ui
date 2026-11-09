import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

/**
 * 第三方扩展兼容层（第二层）。
 *
 * 第一层是 `electron-chrome-extensions`（见 `desktop/browser-host.ts`）：它把 tabs/windows/
 * contextMenus/action/commands/permissions/notifications/cookies/webNavigation 这些语义接到
 * 宿主自己的标签与窗口上，所以大部分扩展不再需要打补丁。
 *
 * 但那一层也不碰 storage，Electron 又只实现了 15 个命名空间：`chrome.storage.sync` 没有同步后端
 * （set 直接报 "sync is not available in this instance of Chrome"），`chrome.fontSettings` 与
 * `tabs.captureVisibleTab/duplicate/move/highlight/discard` 也还是空的。依赖它们的扩展
 * （例如 Dark Reader 4.9.133 早先版本的 `chrome.windows.onRemoved`）一启动就在 background
 * service worker 里抛错：SW 死掉 → 界面永久 loading、内容脚本拿不到配置。
 *
 * 这份 shim 只补第一层也没盖的缺口，并且**不再假装成功**：调不通的接口回调 undefined 并打一条
 * 可检索的警告，而不是返回 []/true 让扩展以为成功。已有实现一律不动。只写
 * **我们自己的 crx 解包目录**，用户自己选「加载已解压扩展」的目录一个字节都不改。
 */

export const COMPAT_VERSION = 3;
export const COMPAT_SCRIPT_FILE = "__pi-compat.js";
export const COMPAT_SW_FILE = "__pi-sw.js";
export const COMPAT_MARKER_FILE = "__pi-compat.json";

const HTML_TAG = `\t\t<script src="/${COMPAT_SCRIPT_FILE}"></script>`;

/** 只补「Electron 没实现」的 API：存在的一律保留。 */
export const COMPAT_SCRIPT = String.raw`// pi-web-ui extension compatibility shim (auto-generated, do not edit)
// 分工：chrome.tabs/windows/contextMenus/action/commands/permissions/notifications/cookies/
// webNavigation 由 electron-chrome-extensions 真正实现（走宿主回调和网页标签），这里一律不碰；
// declarativeNetRequest 的静态规则由主进程 webRequest 执行（browser/runtime/dnr.ts），这里也不碰。
// 这份 shim 只补「两边都没有」的缺口（tabs 的 duplicate/move/highlight/discard、
// windows.getAll 的 populate、storage.sync），captureVisibleTab 走宿主窄桥真截图，
// 并且不再假装成功：回调 undefined + 一条可检索的警告。
// 注意：electron-chrome-extensions 的 preload 最后会 Object.freeze(chrome)，所以顶层**新增**命名空间
// 已经不可能（例如 fontSettings），只能往已有命名空间里补成员。
(() => {
	const api = globalThis.chrome;
	if (!api) return;
	const logged = new Set();
	const warn = (name) => {
		if (logged.has(name)) return;
		logged.add(name);
		try {
			console.warn("[pi] chrome." + name + " is not implemented in this Electron build");
		} catch {}
	};
	const callback = (cb, value) => {
		if (typeof cb === "function") {
			try {
				cb(value);
			} catch (error) {
				setTimeout(() => {
					throw error;
				}, 0);
			}
		}
		return Promise.resolve(value);
	};
	const gap = (name, value) => (first, second) => {
		warn(name);
		const cb = typeof first === "function" ? first : second;
		return callback(cb, value);
	};
	const fill = (target, defaults) => {
		for (const key of Object.keys(defaults)) {
			if (target[key] === undefined) target[key] = defaults[key];
		}
	};

	// tabs：库补齐了 create/remove/update/reload/query/get/goBack/goForward/insertCSS，
	// 剩下这几个仍然是空的（截图/移动标签这类能力要宿主另开接口）
	// captureVisibleTab 有真实现：走宿主注入的窄桥（主进程 WebContents.capturePage）
	const captureVisibleTab = (info, cb) => {
		const options = typeof info === "function" ? {} : info || {};
		const done = typeof info === "function" ? info : cb;
		const bridge = globalThis.__piExtensionBridge;
		if (!bridge || typeof bridge.captureVisibleTab !== "function") {
			warn("tabs.captureVisibleTab");
			return callback(done, "");
		}
		return Promise.resolve(bridge.captureVisibleTab(options)).then(
			(value) => callback(done, typeof value === "string" ? value : ""),
			() => {
				warn("tabs.captureVisibleTab");
				return callback(done, "");
			},
		);
	};

	if (api.tabs) {
		fill(api.tabs, {
			captureVisibleTab: captureVisibleTab,
			duplicate: gap("tabs.duplicate", undefined),
			move: gap("tabs.move", undefined),
			highlight: gap("tabs.highlight", undefined),
			discard: gap("tabs.discard", undefined),
		});
	}

	// 库的 windows.getAll 不实现 populate（Chromium 里它会把每个窗口的标签一起带回来）。
	// 用真实的 tabs.query 补上，扩展（会话管理器、标签工具）才拿得到窗口里的标签。
	// 原实现既可能回调、也可能只返回 Promise，这里两种都等。
	if (api.windows && api.tabs && typeof api.windows.getAll === "function" && typeof api.tabs.query === "function") {
		const getAll = api.windows.getAll;
		api.windows.getAll = (info, cb) => {
			const options = typeof info === "function" ? undefined : info || {};
			const done = typeof info === "function" ? info : cb;
			const pending = new Promise((resolve) => {
				let settled = false;
				const finish = (value) => {
					if (settled) return;
					settled = true;
					resolve(Array.isArray(value) ? value : []);
				};
				const returned = getAll.call(api.windows, options, finish);
				if (Array.isArray(returned)) finish(returned);
				else if (returned && typeof returned.then === "function") returned.then(finish, () => finish([]));
			});
			return pending.then((wins) => {
				if (!options || options.populate !== true) {
					if (typeof done === "function") done(wins);
					return wins;
				}
				return Promise.resolve(api.tabs.query({})).then((tabs) => {
					const all = Array.isArray(tabs) ? tabs : [];
					const filled = wins.map((win) =>
						Object.assign({}, win, { tabs: all.filter((tab) => tab && tab.windowId === win.id) }),
					);
					if (typeof done === "function") done(filled);
					return filled;
				});
			});
		};
	}

	// Electron 没有同步存储后端（storage.sync 会报 "sync is not available in this instance of Chrome"）：
	// 把 sync 换成落到 local 的同形实现，依赖 sync 的扩展才能存住设置。
	if (api.storage && api.storage.local) {
		const local = api.storage.local;
		const sync = { QUOTA_BYTES: 102400, onChanged: local.onChanged };
		for (const key of ["get", "set", "remove", "clear", "getBytesInUse", "getKeys"]) {
			if (typeof local[key] === "function") {
				sync[key] = (...args) => local[key](...args);
			}
		}
		api.storage.sync = sync;
	}
})();
`;

const COMPAT_SW_CLASSIC = `// pi-web-ui extension compatibility shim entry (auto-generated, do not edit)\nimportScripts("${COMPAT_SCRIPT_FILE}", "%SW%");\n`;
const COMPAT_SW_MODULE = `// pi-web-ui extension compatibility shim entry (auto-generated, do not edit)\nimport "./${COMPAT_SCRIPT_FILE}";\nimport "./%SW%";\n`;

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** manifest 里声明的扩展页面（弹窗/选项页），兼容层要能进这些页面。 */
export function compatPages(manifest: unknown): string[] {
	const record = object(manifest);
	const pages: string[] = [];
	for (const key of ["action", "browser_action", "page_action"]) {
		const popup = object(record[key]).default_popup;
		if (typeof popup === "string" && popup) pages.push(popup);
	}
	const optionsUi = object(record.options_ui).page;
	if (typeof optionsUi === "string" && optionsUi) pages.push(optionsUi);
	if (typeof record.options_page === "string" && record.options_page) pages.push(record.options_page);
	return [...new Set(pages.filter((page) => /\.html?$/i.test(page)))];
}

/** 纯函数：把兼容层挂到 manifest 上（返回新对象，不改入参）。 */
export function withCompatManifest(manifest: unknown): Record<string, unknown> {
	const patched = JSON.parse(JSON.stringify(object(manifest))) as Record<string, unknown>;
	const background = object(patched.background);
	if (typeof background.service_worker === "string" && background.service_worker !== COMPAT_SW_FILE) {
		patched.background = { ...background, service_worker: COMPAT_SW_FILE };
	} else if (Array.isArray(background.scripts)) {
		const scripts = background.scripts.filter((item): item is string => typeof item === "string");
		if (!scripts.includes(COMPAT_SCRIPT_FILE)) {
			patched.background = { ...background, scripts: [COMPAT_SCRIPT_FILE, ...scripts] };
		}
	}
	const contentScripts = Array.isArray(patched.content_scripts) ? patched.content_scripts : [];
	patched.content_scripts = contentScripts.map((entry) => {
		const script = object(entry);
		const files = Array.isArray(script.js) ? script.js.filter((item): item is string => typeof item === "string") : [];
		// world: "MAIN" 的脚本跑在页面主世界，那里本来就没有 chrome.*，不能塞进去
		if (!files.length || script.world === "MAIN" || files.includes(COMPAT_SCRIPT_FILE)) return entry;
		return { ...script, js: [COMPAT_SCRIPT_FILE, ...files] };
	});
	return patched;
}

/** 纯函数：往扩展页面的 HTML 里插一行 shim（已插过就原样返回）。 */
export function withCompatHtml(html: string): string {
	if (html.includes(`/${COMPAT_SCRIPT_FILE}`)) return html;
	const head = html.match(/<head[^>]*>/i);
	if (head?.index !== undefined) {
		const insertAt = head.index + head[0].length;
		return `${html.slice(0, insertAt)}\n${HTML_TAG}\n${html.slice(insertAt)}`;
	}
	const htmlTag = html.match(/<html[^>]*>/i);
	if (htmlTag?.index !== undefined) {
		const insertAt = htmlTag.index + htmlTag[0].length;
		return `${html.slice(0, insertAt)}\n${HTML_TAG}\n${html.slice(insertAt)}`;
	}
	// 极简页面（没有 <html>/<head>，浏览器会自己补）：插在 doctype 之后、文档最前面，落在隐式 head 里
	const doctype = html.match(/<!doctype[^>]*>/i);
	const insertAt = doctype?.index !== undefined ? doctype.index + doctype[0].length : 0;
	return `${html.slice(0, insertAt)}\n${HTML_TAG}\n${html.slice(insertAt)}`;
}

const exists = async (path: string): Promise<boolean> =>
	readFile(path).then(
		() => true,
		() => false,
	);

/**
 * 给一个扩展目录挂兼容层（幂等）。返回是否改动过磁盘文件。
 * 只在「我们自己解包的 crx 目录」上调用：用户手动选的解压目录属于用户，不能改。
 */
export async function applyExtensionCompat(dir: string): Promise<boolean> {
	const root = resolve(dir);
	const manifestPath = join(root, "manifest.json");
	let manifest: unknown;
	try {
		manifest = JSON.parse((await readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""));
	} catch {
		return false;
	}
	const background = object(object(manifest).background);
	const originalSw = typeof background.service_worker === "string" ? background.service_worker : "";
	const patched = withCompatManifest(manifest);

	await mkdir(root, { recursive: true });
	await writeFile(join(root, COMPAT_SCRIPT_FILE), COMPAT_SCRIPT, "utf8");
	if (originalSw && originalSw !== COMPAT_SW_FILE) {
		const template = background.type === "module" ? COMPAT_SW_MODULE : COMPAT_SW_CLASSIC;
		await writeFile(join(root, COMPAT_SW_FILE), template.replace("%SW%", originalSw), "utf8");
	}
	const manifestFile = join(root, "manifest.json");
	if (!(await exists(join(root, "manifest.original.json")))) {
		await writeFile(join(root, "manifest.original.json"), JSON.stringify(manifest, null, 1), "utf8");
	}
	await writeFile(manifestFile, JSON.stringify(patched, null, 1), "utf8");

	for (const page of compatPages(patched)) {
		const pagePath = resolve(root, page);
		const inside = relative(root, pagePath);
		if (!inside || inside.startsWith("..") || inside.startsWith("/") || inside.startsWith("\\")) continue;
		const html = await readFile(pagePath, "utf8").catch(() => "");
		if (!html) continue;
		const next = withCompatHtml(html);
		if (next !== html) await writeFile(pagePath, next, "utf8");
	}

	await writeFile(
		join(root, COMPAT_MARKER_FILE),
		JSON.stringify({ version: COMPAT_VERSION, shim: COMPAT_SCRIPT_FILE }, null, 1),
		"utf8",
	);
	// manifest.original.json 的存在只是给人看；目录里是否已有兼容层按 marker 判断
	await mkdir(dirname(join(root, COMPAT_SCRIPT_FILE)), { recursive: true });
	return true;
}

/** 目录里标记的兼容层版本（缺失或读不动就是 0）。 */
export async function compatVersionOf(dir: string): Promise<number> {
	const raw = await readFile(join(resolve(dir), COMPAT_MARKER_FILE), "utf8").catch(() => "");
	if (!raw) return 0;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return Number(parsed.version) || 0;
	} catch {
		return 0;
	}
}

/** 目录是不是在给定根目录里（用于区分「我们的 crx 目录」和用户自己的解压目录）。 */
export function isInside(root: string, dir: string): boolean {
	const inside = relative(resolve(root), resolve(dir));
	return !!inside && !inside.startsWith("..") && !inside.startsWith("/") && !inside.startsWith("\\");
}
