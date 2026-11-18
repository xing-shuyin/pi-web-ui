/**
 * PI Browser - 右上角下载悬浮圆钮（页面注入）
 *
 * 站内点下载时主进程会直接把文件存进系统下载目录，页面上一点提示都没有：用户既不知道
 * 下没下来，也不知道存哪去了。这颗圆钮补的就是这个缺口——有下载任务才出现，可以同时
 * 列出多个，跟着页面走（每次导航后由主进程重新注入并补推当前状态）。
 *
 * **能力边界**：这段脚本跑在网站的主世界里，网页的任何脚本都能调它，所以它只能是
 * 单向的显示面（`update(list)`），不提供任何宿主能力——不给打开文件、不给读目录、不给调桥。
 * 点击已完成项只把保存路径复制到剪贴板，真正的「打开」留在用户自己的文件管理器里做。
 *
 * 状态由主进程 `BrowserManager` 推送：`window.__PI_DOWNLOADS__.update([{ id, filename, state, receivedBytes, totalBytes, path }])`。
 */
(function () {
	if (location.pathname.includes("shell.html") || location.pathname.includes("newtab.html")) return;

	const existing = window.__PI_DOWNLOADS__;
	if (existing && typeof existing.update === "function") {
		// dom-ready / did-finish-load / 导航后补注入：只刷新，不重建第二个圆钮
		existing.update(existing.items);
		return;
	}

	const HOST_ID = "pi-download-host";
	const POS_KEY = "__pi_dl_pos";
	const AUTO_EXPAND_MS = 6000;
	const AUTO_HIDE_MS = 8000;

	let items = [];
	let expanded = false;
	let knownIds = new Set();
	let autoTimer = 0;

	// 站点 SPA（Gemini / X 之类）会清空 body，脚本只挂一次就会永久消失：host 掉了就重新挂回去
	let observedBody = null;
	const observer = typeof MutationObserver === "function" ? new MutationObserver(() => ensureMounted()) : null;
	function ensureMounted() {
		if (!document.body) return false;
		if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
		if (observer && observedBody !== document.body) {
			if (observedBody) observer.unobserve(observedBody);
			observedBody = document.body;
			observer.observe(observedBody, { childList: true });
		}
		return true;
	}

	const host = document.createElement("div");
	host.id = HOST_ID;
	host.style.cssText = [
		"position:fixed",
		"top:14px",
		"right:16px",
		"z-index:2147483647",
		"display:none",
		"font:500 12px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif",
		"color:#e8eaf2",
		"pointer-events:auto",
	].join(";");
	const shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;

	const style = document.createElement("style");
	style.textContent = `
:host, .pi-dl-root { all: initial; }
.pi-dl-root {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  font: 500 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #e8eaf2;
}
.pi-dl-fab {
  position: relative;
  width: 34px;
  height: 34px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 50%;
  background: rgba(24, 26, 34, 0.92);
  color: #e8eaf2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(8px);
  transition: transform 0.14s ease, background 0.14s ease;
}
.pi-dl-fab:hover { background: rgba(38, 42, 56, 0.96); transform: translateY(-1px); }
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
  width: 296px;
  max-height: 268px;
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
.pi-dl-row[data-open="1"] { cursor: pointer; }
.pi-dl-row[data-open="1"]:hover { background: rgba(255, 255, 255, 0.09); }
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
.pi-dl-meta { color: #9aa4bf; font-size: 11px; }
.pi-dl-meta[data-tone="done"] { color: #6ee7a8; }
.pi-dl-meta[data-tone="error"] { color: #ff8a8a; }
`;

	const root = document.createElement("div");
	root.className = "pi-dl-root";

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
	shadow.append(style, root);

	/** 把状态塞进 DOM 的图标：一律 createElement，不碰 innerHTML（站点可能开了 Trusted Types） */
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
		const hasItems = items.length > 0;
		host.style.display = hasItems ? "block" : "none";
		if (!hasItems) {
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
			const row = document.createElement("div");
			row.className = "pi-dl-row";
			row.dataset.open = item.state === "completed" ? "1" : "0";
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

			const meta = document.createElement("div");
			meta.className = "pi-dl-meta";
			meta.dataset.tone = item.state === "completed" ? "done" : item.state === "progressing" ? "" : "error";
			meta.textContent =
				item.state === "completed"
					? "已保存 · 点击复制路径"
					: item.state === "progressing"
						? `${formatBytes(item.receivedBytes)}${total > 0 ? ` / ${formatBytes(total)}` : ""}`
						: item.state === "cancelled"
							? "已取消，未保存"
							: "下载中断，未保存";

			row.append(name, bar, meta);
			if (item.state === "completed") {
				row.addEventListener("click", () => {
					copyPath(item.path || "", meta);
				});
			}
			panel.appendChild(row);
		}
	}

	/**
	 * 复制保存路径：网页不能替用户打开文件（那是宿主能力），能做的只是把路径给到他手上。
	 * 剪贴板被站点策略挡住时把路径原样摊在行里，不假装复制成功。
	 */
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
		} catch {
			failed();
		}
	}

	function schedule(fn, delay) {
		if (autoTimer) clearTimeout(autoTimer);
		autoTimer = setTimeout(() => {
			autoTimer = 0;
			fn();
		}, delay);
	}

	fab.addEventListener("click", () => {
		// 用户自己点了：这次展开/收起听他的，别让自动计时器又给收回去
		if (autoTimer) clearTimeout(autoTimer);
		autoTimer = 0;
		expanded = !expanded;
		render();
	});

	// 面板开着时点页面别处就收起（面板自己、圆钮上的点击不算）
	const onDocumentPointerDown = (event) => {
		if (!expanded) return;
		const target = event.target;
		if (target === host || (target instanceof Node && host.contains(target))) return;
		expanded = false;
		render();
	};

	document.addEventListener("pointerdown", onDocumentPointerDown, true);
	window.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && expanded) {
			expanded = false;
			render();
		}
	});

	// 拖动：右上角这块地方在不少站点上压着站点自己的按钮，用户能拖走才不算添麻烦
	let dragging = false;
	let moved = false;
	let startX = 0;
	let startY = 0;
	let startTop = 14;
	let startRight = 16;
	fab.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		dragging = true;
		moved = false;
		startX = event.clientX;
		startY = event.clientY;
		startTop = parseInt(host.style.top, 10) || 14;
		startRight = parseInt(host.style.right, 10) || 16;
		event.preventDefault();
	});
	window.addEventListener("pointermove", (event) => {
		if (!dragging) return;
		const dx = event.clientX - startX;
		const dy = event.clientY - startY;
		if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
		const top = Math.max(4, Math.min(window.innerHeight - 40, startTop + dy));
		const right = Math.max(4, Math.min(window.innerWidth - 40, startRight - dx));
		host.style.top = `${top}px`;
		host.style.right = `${right}px`;
		try {
			localStorage.setItem(POS_KEY, JSON.stringify({ top, right }));
		} catch {}
	});
	window.addEventListener("pointerup", () => {
		if (!dragging) return;
		dragging = false;
		// 拖动结束后紧接着的那次 click 不该被当成「展开/收起」
		if (moved) {
			const swallow = (event) => {
				event.stopPropagation();
				event.preventDefault();
			};
			fab.addEventListener("click", swallow, { capture: true, once: true });
			setTimeout(() => fab.removeEventListener("click", swallow, true), 0);
		}
	});

	try {
		const saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
		if (saved && Number.isFinite(saved.top) && Number.isFinite(saved.right)) {
			host.style.top = `${Math.max(4, Math.min(window.innerHeight - 40, saved.top))}px`;
			host.style.right = `${Math.max(4, Math.min(window.innerWidth - 40, saved.right))}px`;
		}
	} catch {}

	function mount() {
		if (ensureMounted()) return;
		// body 还没解析出来：等 DOM 就绪再挂（否则圆钮只能挂在 documentElement 上，被站点布局埋掉）
		window.addEventListener("DOMContentLoaded", mount, { once: true });
	}
	if (observer) observer.observe(document.documentElement, { childList: true });
	mount();

	window.__PI_DOWNLOADS__ = {
		/** 主进程推来的当前下载列表（最近在前）；这里只做显示，不接受任何反向请求。 */
		update(next) {
			const list = Array.isArray(next) ? next.filter((item) => item && typeof item === "object") : [];
			items = list.slice(0, 8);
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
				// 全部结束：留着让用户看一眼，然后自己消失
				schedule(() => {
					expanded = false;
					render();
					host.style.display = "none";
				}, AUTO_HIDE_MS);
			}
		},
		get items() {
			return items;
		},
	};
})();
