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
