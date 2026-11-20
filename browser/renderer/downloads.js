/**
 * PI Browser - 下载圆钮（页面注入）
 *
 * 站内点下载时主进程会直接把文件存进系统下载目录，页面上一点提示都没有：用户既不知道
 * 下没下来，也不知道存哪去了。这颗圆钮补的就是这个缺口。
 *
 * **摆在哪**：并进右下角的悬浮球（`browser/renderer/dock.js`）那一列——没有下载任务时整颗
 * 收起，有任务时和刷新钮一起出现、一起拖动、一起换位置。dock 的插槽由
 * `window.__AIB_DOCK__.slot("downloads")` 给；`smartDock` 被关掉时退回自建宿主（仍然在右下角），
 * 功能不受影响。
 *
 * **能力边界**：这段脚本跑在网站的主世界里，网页的任何脚本都能调它，所以它只做两件有界的事：
 * 显示主进程推来的列表，以及「按 id 请宿主在文件管理器里显示这个下载」——后者走 preload 暴露的
 * 窄桥 `window.__piDownloads.reveal(id)`，**路径和命令一个字都不从页面过**：主进程按自己的下载
 * 记录解析，只认已完成项，页面既拿不到任意路径也没有打开文件的能力。
 *
 * 状态由主进程 `BrowserManager` 推送：`window.__PI_DOWNLOADS__.update([{ id, filename, state, receivedBytes, totalBytes, path }])`。
 */
(function () {
	// 本地文档 / 内部页（file:// 的 shell.html、newtab.html）不注入，和 dock 同一口径
	if (location.protocol === "file:") return;

	const existing = window.__PI_DOWNLOADS__;
	if (existing && typeof existing.update === "function") {
		// dom-ready / did-finish-load / 导航后补注入：只刷新，不建出第二个圆钮
		existing.update(existing.items);
		return;
	}

	const AUTO_EXPAND_MS = 6000;
	const MAX_ROWS = 8;

	let items = [];
	let expanded = false;
	let knownIds = new Set();

	/** 样式：构造式样式表不吃页面的 CSP `style-src`（dock 同一套做法），拿不到才退回 `<style>`。 */
	function styleInto(root) {
		const sheet = (() => {
			try {
				if (typeof CSSStyleSheet !== "function" || !("adoptedStyleSheets" in root)) return null;
				const created = new CSSStyleSheet();
				created.replaceSync(CSS);
				return created;
			} catch (_) {
				return null;
			}
		})();
		if (sheet) {
			try {
				root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
				return;
			} catch (_) {}
		}
		const style = document.createElement("style");
		style.textContent = CSS;
		root.appendChild(style);
	}

	const CSS = `
.pi-dl-root {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  font: 500 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #e8eaf2;
}
.pi-dl-root[hidden] { display: none; }
.pi-dl-fab {
  position: relative;
  width: 32px;
  height: 32px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 50%;
  background: #2a2d36;
  color: #e6e8ee;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  transition: background 0.15s ease;
}
.pi-dl-fab:hover { background: #353945; }
.pi-dl-fab[data-done="1"] { color: #6ee7a8; border-color: rgba(110, 231, 168, 0.45); }
.pi-dl-badge {
  position: absolute;
  top: -3px;
  right: -3px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: #5b8cff;
  color: #fff;
  font-size: 10px;
  line-height: 15px;
  text-align: center;
  box-shadow: 0 0 0 2px rgba(24, 26, 34, 0.92);
}
.pi-dl-badge[hidden] { display: none; }
.pi-dl-panel {
  position: absolute;
  right: calc(100% + 10px);
  bottom: 0;
  width: 296px;
  max-height: 272px;
  overflow: auto;
  padding: 8px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(22, 24, 32, 0.96);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(12px);
}
.pi-dl-panel[hidden] { display: none; }
.pi-dl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px 6px;
  opacity: 0.72;
}
.pi-dl-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
}
.pi-dl-row + .pi-dl-row { margin-top: 6px; }
.pi-dl-name {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pi-dl-state { flex: none; color: #9aa4bf; }
.pi-dl-name-text { overflow: hidden; text-overflow: ellipsis; }
.pi-dl-bar {
  height: 3px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
}
.pi-dl-bar > i {
  display: block;
  height: 100%;
  width: 0;
  border-radius: 999px;
  background: linear-gradient(90deg, #5b8cff, #7fd4ff);
  transition: width 0.2s ease;
}
.pi-dl-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  flex-wrap: wrap;
}
.pi-dl-meta { color: #9aa4bf; font-size: 11px; }
.pi-dl-meta[data-tone="done"] { color: #6ee7a8; }
.pi-dl-meta[data-tone="error"] { color: #ff8a8a; }
.pi-dl-actions { display: flex; gap: 6px; margin-left: auto; }
.pi-dl-btn {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: #e6e8ee;
  font: inherit;
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease;
}
.pi-dl-btn:hover { background: rgba(91, 140, 255, 0.9); border-color: rgba(91, 140, 255, 0.9); color: #fff; }
`;

	const root = document.createElement("div");
	root.className = "pi-dl-root";
	root.hidden = true;

	const fab = document.createElement("button");
	fab.type = "button";
	fab.className = "pi-dl-fab";
	fab.title = "下载任务";
	fab.setAttribute("aria-label", "下载任务");
	fab.appendChild(downloadIcon());
	const badge = document.createElement("span");
	badge.className = "pi-dl-badge";
	badge.hidden = true;
	fab.appendChild(badge);

	const panel = document.createElement("div");
	panel.className = "pi-dl-panel";
	panel.hidden = true;

	root.append(fab, panel);

	/** 把状态塞进 DOM 的图标：一律 createElementNS，不碰 innerHTML（站点可能开了 Trusted Types） */
	function downloadIcon() {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("width", "15");
		svg.setAttribute("height", "15");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "2");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		for (const [tag, attrs] of [
			["path", { d: "M12 3v12" }],
			["path", { d: "m7 11 5 5 5-5" }],
			["path", { d: "M4 20h16" }],
		]) {
			const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
			for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
			svg.appendChild(node);
		}
		return svg;
	}

	function chip(label, onClick) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "pi-dl-btn";
		button.textContent = label;
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			onClick();
		});
		return button;
	}

	function formatBytes(value) {
		const bytes = Number(value);
		if (!Number.isFinite(bytes) || bytes <= 0) return "";
		const units = ["B", "KB", "MB", "GB"];
		let size = bytes;
		let unit = 0;
		while (size >= 1024 && unit < units.length - 1) {
			size /= 1024;
			unit += 1;
		}
		return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)}${units[unit]}`;
	}

	function stateLabel(item) {
		if (item.state === "progressing") {
			const total = Number(item.totalBytes) || 0;
			if (total > 0) return `${Math.min(100, Math.floor(((Number(item.receivedBytes) || 0) / total) * 100))}%`;
			const got = formatBytes(item.receivedBytes);
			return got ? `已下载 ${got}` : "下载中";
		}
		if (item.state === "completed") return "已完成";
		if (item.state === "cancelled") return "已取消";
		return "失败";
	}

	function render() {
		const active = items.filter((item) => item.state === "progressing");
		// 没有任务就整颗收起：它和刷新钮住在同一列，平时不该占着站点的右下角
		root.hidden = items.length === 0;
		if (root.hidden) {
			panel.hidden = true;
			expanded = false;
			return;
		}
		badge.hidden = active.length === 0;
		badge.textContent = String(active.length);
		fab.dataset.done = active.length === 0 ? "1" : "0";
		fab.title = active.length ? `${active.length} 个下载进行中` : "下载任务";
		panel.hidden = !expanded;
		if (!expanded) return;
		// 面板开在圆钮左侧：分栏 / 窄窗口里按当前视口收一收，别让它跑到屏幕外
		panel.style.width = `${Math.max(200, Math.min(296, window.innerWidth - 96))}px`;
		panel.style.maxHeight = `${Math.max(120, Math.min(272, window.innerHeight - 140))}px`;

		panel.replaceChildren();
		const head = document.createElement("div");
		head.className = "pi-dl-head";
		const heading = document.createElement("span");
		heading.textContent = `下载（${items.length}）`;
		const summary = document.createElement("span");
		summary.textContent = active.length ? `${active.length} 个进行中` : "全部结束";
		head.append(heading, summary);
		panel.appendChild(head);

		for (const item of items) {
			panel.appendChild(renderRow(item));
		}
	}

	function renderRow(item) {
		const row = document.createElement("div");
		row.className = "pi-dl-row";
		row.title = item.path || item.filename || "";

		const name = document.createElement("div");
		name.className = "pi-dl-name";
		const filename = document.createElement("span");
		filename.className = "pi-dl-name-text";
		filename.textContent = item.filename || "下载";
		const state = document.createElement("span");
		state.className = "pi-dl-state";
		state.textContent = stateLabel(item);
		name.append(filename, state);

		const bar = document.createElement("div");
		bar.className = "pi-dl-bar";
		const fill = document.createElement("i");
		const total = Number(item.totalBytes) || 0;
		const ratio = total > 0 ? Math.min(1, (Number(item.receivedBytes) || 0) / total) : 0;
		fill.style.width = item.state === "completed" ? "100%" : `${Math.round(ratio * 100)}%`;
		bar.appendChild(fill);

		const foot = document.createElement("div");
		foot.className = "pi-dl-foot";
		const meta = document.createElement("div");
		meta.className = "pi-dl-meta";
		meta.dataset.tone = item.state === "completed" ? "done" : item.state === "progressing" ? "" : "error";
		meta.textContent =
			item.state === "completed"
				? "已保存"
				: item.state === "progressing"
					? `${formatBytes(item.receivedBytes)}${total > 0 ? ` / ${formatBytes(total)}` : ""}`
					: item.state === "cancelled"
						? "已取消，未保存"
						: "下载中断，未保存";
		foot.appendChild(meta);

		if (item.state === "completed") {
			const actions = document.createElement("div");
			actions.className = "pi-dl-actions";
			actions.append(
				chip("打开文件夹", () => revealFolder(item, meta)),
				chip("复制路径", () => copyPath(item.path || "", meta)),
			);
			foot.appendChild(actions);
		}

		row.append(name, bar, foot);
		return row;
	}

	/**
	 * 在文件管理器里定位这个下载：只把 id 交给宿主，路径由主进程自己的下载记录解析。
	 * 桥不在（老宿主 / 内部页）或主进程拒绝时把真相摊在行里，不假装成功。
	 */
	function revealFolder(item, meta) {
		const bridge = window.__piDownloads;
		if (!bridge || typeof bridge.reveal !== "function") {
			meta.dataset.tone = "error";
			meta.textContent = "无法打开：浏览器桥未就绪";
			return;
		}
		const done = () => {
			meta.dataset.tone = "done";
			meta.textContent = "已在文件管理器中显示";
		};
		const failed = () => {
			meta.dataset.tone = "error";
			meta.textContent = "打不开，改用「复制路径」";
		};
		try {
			const result = bridge.reveal(item.id);
			if (result && typeof result.then === "function") result.then((ok) => (ok ? done() : failed()), failed);
			else failed();
		} catch (_) {
			failed();
		}
	}

	/** 复制保存路径：站点策略挡住时把路径原样摊在行里，不假装复制成功。 */
	function copyPath(value, meta) {
		if (!value) return;
		const done = () => {
			meta.dataset.tone = "done";
			meta.textContent = "路径已复制";
		};
		const failed = () => {
			meta.dataset.tone = "";
			meta.textContent = value;
		};
		try {
			const result = navigator.clipboard && navigator.clipboard.writeText(value);
			if (result && typeof result.then === "function") result.then(done, failed);
			else failed();
		} catch (_) {
			failed();
		}
	}

	let autoTimer = 0;
	function schedule(fn, delay) {
		if (autoTimer) clearTimeout(autoTimer);
		autoTimer = setTimeout(() => {
			autoTimer = 0;
			fn();
		}, delay);
	}

	fab.addEventListener("click", (event) => {
		// 用户自己点了：这次展开/收起听他的，别让自动计时器又给收回去
		event.preventDefault();
		event.stopPropagation();
		if (autoTimer) clearTimeout(autoTimer);
		autoTimer = 0;
		expanded = !expanded;
		render();
	});

	// 面板开着时点页面别处就收起（面板自己、圆钮上的点击不算）
	const onDocumentPointerDown = (event) => {
		if (!expanded) return;
		const target = event.target;
		if (target instanceof Node && (root === target || root.contains(target))) return;
		const path = typeof event.composedPath === "function" ? event.composedPath() : [];
		if (path.includes(root)) return;
		expanded = false;
		render();
	};

	function onKeyDown(event) {
		if (event.key === "Escape" && expanded) {
			expanded = false;
			render();
		}
	}

	document.addEventListener("pointerdown", onDocumentPointerDown, true);
	window.addEventListener("keydown", onKeyDown);

	// ── 摆位：优先住进悬浮球（和刷新钮同一列、一起拖动），没有 dock 就自建右下角宿主 ──
	function dockSlot() {
		const dock = window.__AIB_DOCK__;
		if (!dock || !dock.ready || typeof dock.slot !== "function") return null;
		try {
			return dock.slot("downloads");
		} catch (_) {
			return null;
		}
	}

	function ownHost() {
		const host = document.createElement("div");
		host.id = "pi-download-host";
		host.style.cssText = [
			"position:fixed",
			"right:28px",
			"bottom:28px",
			"z-index:2147483647",
			"pointer-events:auto",
		].join(";");
		const shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
		return { host, shadow };
	}

	function mount() {
		const slot = dockSlot();
		if (slot) {
			slot.appendChild(root);
			styleInto(slot.getRootNode());
			return;
		}
		const { host, shadow } = ownHost();
		shadow.append(root);
		styleInto(shadow);
		(document.body || document.documentElement).appendChild(host);
		// 站点 SPA 会清空甚至换掉整个 body：宿主掉了就挂回去（只在没有 dock 的兜底路径上跑）
		setInterval(() => {
			if (host.isConnected) return;
			const parent = document.body || document.documentElement;
			if (parent) parent.appendChild(host);
		}, 1500);
	}

	if (document.body) mount();
	else window.addEventListener("DOMContentLoaded", mount, { once: true });

	window.__PI_DOWNLOADS__ = {
		/** 主进程推来的当前下载列表（最近在前）；这里只做显示，不接受任何反向请求。 */
		update(next) {
			const list = Array.isArray(next) ? next.filter((item) => item && typeof item === "object") : [];
			items = list.slice(0, MAX_ROWS);
			render();
			// 新任务出现时把面板亮出来：这就是「有下载」的那声提示，几秒后自己收起
			const fresh = items.some((item) => item.id && !knownIds.has(item.id));
			knownIds = new Set(items.map((item) => item.id).filter(Boolean));
			if (!items.length) return;
			const active = items.some((item) => item.state === "progressing");
			if (fresh) {
				expanded = true;
				render();
				schedule(() => {
					expanded = false;
					render();
				}, AUTO_EXPAND_MS);
			} else if (!active) {
				// 全部结束：留着让用户看一眼，然后收起面板（圆钮继续留在悬浮球里，直到列表过期）
				schedule(() => {
					expanded = false;
					render();
				}, AUTO_EXPAND_MS);
			}
		},
		get items() {
			return items;
		},
	};
})();
