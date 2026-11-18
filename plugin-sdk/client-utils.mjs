/**
 * 安全 HTML 实体转义。
 * @param {unknown} s 待转义内容
 * @returns {string} 转义后的 HTML 字符串
 */
export function esc(s) {
	return String(s ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

/**
 * 安全取用 window.__piWebUiHost 宿主桥接 API。
 * @returns {any} 宿主 API 对象或 null
 */
export function hostApi() {
	return typeof window !== "undefined" ? (window.__piWebUiHost ?? null) : null;
}

/**
 * 获取插件服务端路由的统一根路径。
 * @param {string} pluginId 插件 id
 * @returns {string} 路由根路径，如 "/plugins-api/my-plugin"
 */
export function apiBase(pluginId) {
	return `/plugins-api/${pluginId}`;
}

/**
 * 格式化字节大小为人类可读字符串（B / KB / MB / GB）。
 * @param {number|unknown} bytes 字节大小
 * @param {number} [decimals=1] 小数位数
 * @returns {string}
 */
export function formatBytes(bytes, decimals = 1) {
	const n = Number(bytes);
	if (!Number.isFinite(n) || n < 0) return "";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(decimals)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(decimals)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(decimals)} GB`;
}

/**
 * 为异步操作施加超时限制。
 * @template T
 * @param {Promise<T>} promise 目标 Promise
 * @param {number} timeoutMs 超时时间（毫秒）
 * @param {string} [errorMsg="Operation timed out"] 超时提示文案
 * @returns {Promise<T>}
 */
export function withTimeout(promise, timeoutMs, errorMsg = "Operation timed out") {
	return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), timeoutMs))]);
}

/**
 * 生成随机 UUID（浏览器优先使用 crypto.randomUUID，提供纯 JS 降级）。
 * @returns {string}
 */
export function uuid() {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

/**
 * 归一化相对路径（反斜杠转斜杠、去除首尾多余斜杠与 "./"）。
 * @param {string} p
 * @returns {string}
 */
export function normalizeRel(p) {
	return String(p ?? "")
		.replace(/\\/g, "/")
		.replace(/^\.?\/+/, "")
		.replace(/\/+$/, "");
}

/**
 * 为容器创建 Shadow DOM 并注入基础主题继承样式。
 * @param {HTMLElement} hostEl 宿主容器元素
 * @param {string} [customCss] 额外注入该组件的隔离样式
 * @returns {ShadowRoot} 创建或已存在的 open 模式 ShadowRoot
 */
export function attachShadowRoot(hostEl, customCss = "") {
	let shadow = hostEl.shadowRoot;
	if (!shadow) {
		try {
			shadow = hostEl.attachShadow({ mode: "open" });
		} catch {
			shadow = hostEl.shadowRoot;
		}
	}
	if (!shadow) return hostEl;

	shadow.replaceChildren();
	const style = document.createElement("style");
	style.textContent = `
		:host {
			display: block;
			width: 100%;
			height: 100%;
			box-sizing: border-box;
			color: var(--text, inherit);
			font-family: inherit;
			font-size: var(--text-base, 13.5px);
			line-height: 1.5;
		}
		*, *::before, *::after {
			box-sizing: inherit;
		}
		${customCss}
	`;
	shadow.appendChild(style);
	return shadow;
}

/**
 * 带有 Shadow DOM 样式隔离的视图挂载辅助器。
 * @param {HTMLElement} container 挂载目标容器
 * @param {(root: HTMLElement) => void | (() => void)} mountFn 实际挂载函数
 * @param {string} [customCss] 隔离样式
 * @returns {() => void} 清理函数
 */
export function mountIsolated(container, mountFn, customCss = "") {
	const shadow = attachShadowRoot(container, customCss);
	const inner = document.createElement("div");
	inner.className = "plugin-isolated-body";
	inner.style.cssText = "width:100%;height:100%;display:flex;flex-direction:column;";
	shadow.appendChild(inner);

	const cleanup = mountFn(inner);
	return () => {
		if (typeof cleanup === "function") {
			try {
				cleanup();
			} catch {}
		}
		inner.replaceChildren();
		shadow.replaceChildren();
	};
}

const DEFAULT_CHUNK_LIMIT = 3800;
const CODE_FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * 计算安全的截断位置，避免割裂 UTF-16 代理对（Surrogate Pair Emoji/特异字符）。
 * @param {string} value
 * @param {number} limit
 * @returns {number}
 */
export function safeSliceIndex(value, limit) {
	let index = Math.min(limit, value.length);
	if (index <= 0) return 0;
	const before = value.charCodeAt(index - 1);
	const after = value.charCodeAt(index);
	if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
		index -= 1;
	}
	return Math.max(1, index);
}

function openingFence(line) {
	const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
	const match = CODE_FENCE_OPEN.exec(normalized);
	if (!match) return null;
	if (match[2][0] === "`" && match[3].includes("`")) return null;
	return { delimiter: match[2], info: match[3], indent: match[1].length };
}

function closesFence(line, opening) {
	const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
	return Boolean(match && match[1][0] === opening.delimiter[0] && match[1].length >= opening.delimiter.length);
}

function splitRawText(text, limit) {
	if (text.length <= limit) return [text];
	const parts = [];
	let remaining = text;
	while (remaining.length > limit) {
		let index = safeSliceIndex(remaining, limit);
		const newline = remaining.lastIndexOf("\n", index - 1);
		if (newline >= 0 && newline >= Math.floor(limit * 0.4)) {
			index = newline + 1;
		}
		parts.push(remaining.slice(0, index));
		remaining = remaining.slice(index);
	}
	if (remaining || parts.length === 0) parts.push(remaining);
	return parts;
}

/**
 * 结构感知 Markdown 分块工具（专为 IM 机器人、通知卡片与受限文本通道设计）。
 * 跨分块边界保护代码围栏（``` 或 ~~~），自动在上一块末尾闭合并在下一块开头重新打开，
 * 确保代码高亮不破损、超长行不断字。
 *
 * @param {string} text 待分块 Markdown 文本
 * @param {number} [limit=3800] 单块最大字符数（必须 > 20）
 * @returns {string[]} 分块数组
 */
export function chunkMarkdownText(text, limit = DEFAULT_CHUNK_LIMIT) {
	const raw = String(text ?? "").trim();
	if (!raw) return [];
	const bound = Math.max(50, Number(limit) || DEFAULT_CHUNK_LIMIT);
	if (raw.length <= bound) return [raw];

	const lines = raw.split("\n");
	const chunks = [];
	let currentLines = [];
	let currentLen = 0;
	let activeFence = null;

	function flushChunk() {
		if (currentLines.length === 0) return;
		if (activeFence) {
			currentLines.push(activeFence.delimiter);
			chunks.push(currentLines.join("\n"));
			currentLines = [`${activeFence.delimiter}${activeFence.info}`];
			currentLen = currentLines[0].length + 1;
		} else {
			chunks.push(currentLines.join("\n"));
			currentLines = [];
			currentLen = 0;
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineLen = line.length + 1;

		if (activeFence) {
			if (closesFence(line, activeFence)) {
				activeFence = null;
			}
		} else {
			const open = openingFence(line);
			if (open) {
				activeFence = open;
			}
		}

		if (currentLen + lineLen > bound) {
			if (currentLines.length === 0) {
				const parts = splitRawText(line, bound - (activeFence ? 20 : 0));
				for (let p = 0; p < parts.length; p++) {
					currentLines.push(parts[p]);
					if (p < parts.length - 1) flushChunk();
				}
				currentLen = currentLines.join("\n").length + 1;
				continue;
			}

			flushChunk();
		}

		currentLines.push(line);
		currentLen += lineLen;
	}

	if (currentLines.length > 0) {
		chunks.push(currentLines.join("\n"));
	}

	return chunks;
}

/**
 * 把 `createPluginI18n` 的第一、二个参数收敛成「locale tag → 字典」的表。
 *
 * 社区插件里两种写法都在用：`{ zh, en }` / `{ "zh-CN": …, "en-US": … }`，以及
 * `createPluginI18n(zhDict, enDict)` 这种位置参数。认不出形状就抛错——静默当成空字典
 * 只会让插件整片界面显示成 key，比直接报错更难查。
 * @param {unknown} dicts 字典或 zh 字典
 * @param {unknown} [options] 选项或 en 字典
 * @returns {{ tables: Record<string, Record<string, string>>, locale: string }}
 */
function pluginI18nTables(dicts, options) {
	const isTable = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
	const looksPositional =
		isTable(dicts) && isTable(options) && !("zh" in dicts) && !("en" in dicts) && !isTable(options.zh);
	const source = looksPositional ? { zh: dicts, en: options } : dicts;
	if (!isTable(source)) throw new Error("[sdk] createPluginI18n 需要 { zh: {...}, en: {...} } 字典对象");
	const tables = Object.create(null);
	for (const [tag, table] of Object.entries(source)) {
		if (!isTable(table)) continue;
		const key = String(tag).trim().toLowerCase();
		if (!key || /[^\w-]/.test(key)) continue;
		tables[key] = table;
	}
	if (Object.keys(tables).length === 0)
		throw new Error("[sdk] createPluginI18n 至少需要一个 { zh: {...} } 或 { en: {...} } 字典");
	const extra = looksPositional ? {} : isTable(options) ? options : {};
	return { tables, locale: typeof extra.locale === "string" ? extra.locale.trim() : "" };
}

/**
 * 宿主当前语言 tag：显式 override → 宿主桥 `locale.current()` → 上次收到的切换通知 → 浏览器语言。
 * 宿主桥还没装好（插件在宿主 API 之前加载）、或宿主没提供 `locale` 而只发了同页事件时，
 * 都不能用空串当结论，否则首帧会误判成英文、或者切完语言界面不跟着变。
 * @param {string} override 显式覆盖
 * @param {() => string} [lastSeen] 读到上次收到的 locale（由 `createPluginI18n` 维护）
 * @returns {string}
 */
function pluginI18nHostLocale(override, lastSeen) {
	if (override) return override;
	try {
		const raw = hostApi()?.locale?.current?.();
		if (typeof raw === "string" && raw.trim()) return raw.trim();
	} catch {}
	const remembered = lastSeen?.();
	if (remembered) return remembered;
	try {
		if (typeof navigator !== "undefined") {
			const raw = navigator.languages?.[0] ?? navigator.language;
			if (typeof raw === "string" && raw.trim()) return raw.trim();
		}
	} catch {}
	return "en";
}

/**
 * 字典里选词条时命中的表名：`zh-CN` → `zh`（插件的字典只有中英两种，不做第三种分叉）。
 * @param {Record<string, Record<string, string>>} tables
 * @param {string} tag
 * @returns {Record<string, string> | undefined}
 */
function pluginI18nPickTable(tables, tag) {
	const lower = String(tag ?? "")
		.trim()
		.toLowerCase();
	const base = lower.split(/[-_]/)[0] ?? "";
	return tables[lower] ?? tables[base] ?? (base === "zh" ? tables.zh : undefined) ?? tables.en ?? tables.zh;
}

/**
 * 插件界面文案：一份 ZH/EN 字典，语言跟随宿主全局设置。
 *
 * 为什么要有它：插件界面语言只有一份事实源（宿主 locale，见 `docs/architecture-plugins.md`
 * 「插件界面语言」）。每个插件都自己抄一遍「读 `host.locale.current()` + 订阅 `onChange` +
 * 按 tag 选词 + 插值」很容易漏掉订阅或写错回落，切语言后界面就不跟着变了。
 *
 * ```js
 * const i18n = createPluginI18n({ zh: { title: "笔记" }, en: { title: "Notes" } });
 * i18n.t("title");                          // 当前语言
 * i18n.t("hint", { count: 3 });             // 插值：{count} / {{count}} / ${count}
 * const off = i18n.onChange(() => render()); // 宿主切语言后重画
 * i18n.lang;                                // "zh" | "en"
 * i18n.destroy();                           // 视图卸载时解除订阅
 * ```
 *
 * 语言只认中文/英文：宿主是 `zh` / `zh-CN` / `zh-TW` 都取 `zh`，其余（de / ja / ru…）取 `en`。
 * 缺失的 key 依次回落到另一种语言的同名词条，再回落到 key 本身——界面不会出现空白。
 * @param {Record<string, Record<string, string>> | Record<string, string>} dicts 字典（或位置参数下的 zh 字典）
 * @param {Record<string, unknown> | Record<string, string>} [options] `{ locale }` 显式覆盖（或位置参数下的 en 字典）
 * @returns {{
 *   readonly lang: "zh" | "en",
 *   readonly locale: string,
 *   current(): string,
 *   t(key: string, vars?: Record<string, string | number>): string,
 *   onChange(handler: (locale: string, lang: "zh" | "en") => void): () => void,
 *   destroy(): void,
 * }}
 */
export function createPluginI18n(dicts, options) {
	const { tables, locale: override } = pluginI18nTables(dicts, options);
	const listeners = new Set();
	let detach;
	// 宿主没提供 `locale.current()`（旧宿主 / 同页事件）时，切语言只靠事件，得自己记住最后收到的 tag。
	let seen = "";
	const localeNow = () => pluginI18nHostLocale(override, () => seen);
	const langOfLocale = (locale) => (String(locale).toLowerCase().startsWith("zh") ? "zh" : "en");

	const tableOf = () => pluginI18nPickTable(tables, localeNow()) ?? {};
	const langOf = () => langOfLocale(localeNow());

	const t = (key, vars) => {
		const name = String(key ?? "");
		const table = tableOf();
		const raw = table[name] ?? tables.en?.[name] ?? tables.zh?.[name];
		if (raw === undefined) return name;
		const text = String(raw);
		if (!vars) return text;
		return text.replace(/\$\{(\w+)\}|\{\{(\w+)\}\}|\{\$?(\w+)\}/g, (match, a, b, c) => {
			const slot = a ?? b ?? c;
			return slot && Object.prototype.hasOwnProperty.call(vars, slot) ? String(vars[slot]) : match;
		});
	};

	const emit = (tag) => {
		const locale = typeof tag === "string" && tag.trim() ? tag.trim() : localeNow();
		if (typeof tag === "string" && tag.trim()) seen = locale;
		const lang = langOfLocale(locale);
		// 快照后再遍历：handler 里重新订阅（每次切语言新建闭包）会把新函数加入集合，直接迭代 Set 会死循环。
		for (const handler of [...listeners]) {
			try {
				handler(locale, lang);
			} catch {}
		}
	};

	// 订阅一次给全部 handler 复用：桥只在第一次 onChange 时才接，视图没订阅就不留监听。
	const ensureSubscribed = () => {
		if (detach) return;
		const offs = [];
		try {
			const bridge = hostApi();
			const off = bridge?.locale?.onChange?.(emit) ?? bridge?.onLocale?.(emit);
			if (typeof off === "function") offs.push(off);
		} catch {}
		try {
			if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
				const onWindow = (event) => emit(event?.detail);
				window.addEventListener("pi-web-ui:locale", onWindow);
				offs.push(() => window.removeEventListener("pi-web-ui:locale", onWindow));
			}
		} catch {}
		detach = () => {
			for (const off of offs) {
				try {
					off();
				} catch {}
			}
		};
	};

	return {
		get lang() {
			return langOf();
		},
		get locale() {
			return localeNow();
		},
		current() {
			return localeNow();
		},
		t,
		onChange(handler) {
			if (typeof handler !== "function") return () => {};
			listeners.add(handler);
			ensureSubscribed();
			return () => {
				listeners.delete(handler);
			};
		},
		destroy() {
			listeners.clear();
			try {
				detach?.();
			} catch {}
			detach = undefined;
		},
	};
}
