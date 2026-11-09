import { resolve } from "node:path";

/**
 * 扩展清单的状态单源。
 *
 * Electron 的 `loadExtension` 不随重启保留，`userData/extensions/installed.json` 才是「下次启动加载哪些目录、
 * 哪些被用户停用」的唯一依据；会话里真正加载了什么由 `session.extensions.getAllExtensions()` 回答。
 * 两者合并后才是扩展管理面板要显示的一行，所以合并规则放在这里（纯函数，便于单测），不散在主进程里。
 */

export interface InstalledExtension {
	/** 扩展目录（用户选的解压目录，或已解包的 crx-<hash> 目录）。 */
	path: string;
	/** 用户意图：true = 下次启动要加载。停用只是不加载，目录与扩展存储都保留。 */
	enabled: boolean;
}

export interface LoadedExtension {
	id: string;
	name: string;
	version: string;
	path: string;
	/** 工具栏弹窗相对路径（`action.default_popup`）；没弹窗就是空串。 */
	popup?: string;
	/** 选项页相对路径（`options_ui.page` 或旧式 `options_page`）；没有就是空串。 */
	options?: string;
}

export interface ExtensionEntry extends LoadedExtension {
	enabled: boolean;
}

/** 扩展声明了工具栏弹窗时返回弹窗页相对路径（manifest 里的 `action`/`browser_action`/`page_action`）。 */
export function extensionPopupPath(manifest: unknown): string {
	const record = manifest && typeof manifest === "object" ? (manifest as Record<string, unknown>) : {};
	for (const key of ["action", "browser_action", "page_action"]) {
		const action = record[key];
		if (!action || typeof action !== "object") continue;
		const popup = (action as Record<string, unknown>).default_popup;
		const cleaned = typeof popup === "string" ? cleanExtensionPath(popup) : "";
		if (cleaned) return cleaned;
	}
	return "";
}

/**
 * 扩展的选项页：MV3/MV2 的 `options_ui.page` 优先，其次旧式 `options_page`；都没有就返回空串。
 * `open_in_tab` 不参与建模——Chrome 的「标签页 / 嵌在 chrome://extensions 里」两种展示在这里统一成一个普通窗口。
 */
export function extensionOptionsPath(manifest: unknown): string {
	const record = manifest && typeof manifest === "object" ? (manifest as Record<string, unknown>) : {};
	const ui = record.options_ui;
	const embedded = ui && typeof ui === "object" ? (ui as Record<string, unknown>).page : undefined;
	const legacy = record.options_page;
	for (const candidate of [embedded, legacy]) {
		const cleaned = typeof candidate === "string" ? cleanExtensionPath(candidate) : "";
		if (cleaned) return cleaned;
	}
	return "";
}

/** 扩展页 URL：id 与相对路径都限定在「已加载扩展自己的目录」内，不接受任意 chrome-extension:// 地址。 */
export function extensionPageUrl(id: string, page: string): string {
	const cleaned = cleanExtensionPath(page);
	// Chromium/Electron 的扩展 id 都是 a-p 字母组成（路径哈希映射）
	if (!/^[a-p]{16,64}$/.test(id) || !cleaned) throw new Error("Invalid extension page address");
	return `chrome-extension://${id}/${cleaned}`;
}

/** 弹窗路径只能是扩展目录内的相对路径：不要协议、不要绝对路径、不要 `..`。 */
function cleanExtensionPath(value: string): string {
	const cleaned = value.trim().replace(/^\.\//, "").replace(/^\/+/, "");
	if (!cleaned || cleaned.includes("..") || /^[a-z][a-z\d+.-]*:/i.test(cleaned)) return "";
	return cleaned;
}

/** 同一目录可能以大小写不同的写法出现（Windows），比较前统一。 */
function pathKey(path: string): string {
	const absolute = resolve(path);
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/**
 * installed.json 兼容两种形态：旧版本的 `string[]`（等于全部启用）与新版本的 `{ path, enabled }[]`。
 * 坏条目直接丢弃——扩展清单坏一条不该让整个管理面板打不开。
 */
export function parseInstalledExtensions(raw: unknown): InstalledExtension[] {
	const list: InstalledExtension[] = [];
	const seen = new Set<string>();
	for (const item of Array.isArray(raw) ? raw : []) {
		const record: Record<string, unknown> | undefined =
			typeof item === "string"
				? { path: item }
				: item && typeof item === "object"
					? (item as Record<string, unknown>)
					: undefined;
		const path = typeof record?.path === "string" ? record.path.trim() : "";
		if (!path) continue;
		const key = pathKey(path);
		if (seen.has(key)) continue;
		seen.add(key);
		list.push({ path: resolve(path), enabled: record?.enabled !== false });
	}
	return list;
}

/** 记一条已装目录；重复安装同一目录只刷新 enabled，不产生第二行。 */
export function upsertInstalledExtension(
	list: InstalledExtension[],
	path: string,
	enabled: boolean,
): InstalledExtension[] {
	const key = pathKey(path);
	const absolute = resolve(path);
	if (!list.some((item) => pathKey(item.path) === key)) return [...list, { path: absolute, enabled }];
	return list.map((item) => (pathKey(item.path) === key ? { path: absolute, enabled } : item));
}

/** 从清单里移除（只删记录，不动磁盘目录）。 */
export function removeInstalledExtension(list: InstalledExtension[], path: string): InstalledExtension[] {
	const key = pathKey(path);
	return list.filter((item) => pathKey(item.path) !== key);
}

/**
 * 合并「会话里加载的」与「清单里记住的」：加载中的排前面且 enabled 恒为 true
 * （记录说停用却还在会话里属于脏状态，以会话为准），记住但没加载的排后面并报告停用。
 * 未加载的条目没有 id/name/version，由调用方回磁盘读 manifest 补。
 */
export function mergeExtensionList(installed: InstalledExtension[], loaded: LoadedExtension[]): ExtensionEntry[] {
	const entries: ExtensionEntry[] = [];
	const seen = new Set<string>();
	for (const extension of loaded) {
		const key = pathKey(extension.path);
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({ ...extension, enabled: true });
	}
	for (const record of installed) {
		const key = pathKey(record.path);
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({
			id: "",
			name: "",
			version: "",
			path: record.path,
			enabled: record.enabled,
			popup: "",
			options: "",
		});
	}
	return entries;
}
