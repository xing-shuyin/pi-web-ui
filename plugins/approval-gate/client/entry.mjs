import { defineView } from "./sdk/index.mjs";

const I18N = {
	zh: {
		title: "拍板",
		pendingCount: (n) => `待拍板 ${n}`,
		done: "全部处理完毕",
		doneHint: "定时任务有新拍板请求时会自动出现在这里。",
		jump: "点击跳转会话拍板",
		noConv: "无关联会话（登记时未提供 conversationId）",
		dismiss: "忽略",
		onlyPending: "只看待拍板",
		resolved: "已拍板",
		dismissed: "已忽略",
		emptyFiltered: "没有待拍板项",
		failure: "加载失败，请稍后刷新重试。",
		time: {
			now: "刚刚",
			min: (n) => `${n} 分钟前`,
			hour: (n) => `${n} 小时前`,
			yesterday: "昨天",
			day: (n) => `${n} 天前`,
		},
	},
	en: {
		title: "Approvals",
		pendingCount: (n) => `${n} pending`,
		done: "All clear",
		doneHint: "New approval requests from scheduled tasks will appear here automatically.",
		jump: "Click to open the conversation",
		noConv: "No linked conversation (registered without conversationId)",
		dismiss: "Dismiss",
		onlyPending: "Pending only",
		resolved: "Resolved",
		dismissed: "Dismissed",
		emptyFiltered: "No pending items",
		failure: "Failed to load. Please refresh and retry.",
		time: {
			now: "just now",
			min: (n) => `${n}m ago`,
			hour: (n) => `${n}h ago`,
			yesterday: "yesterday",
			day: (n) => `${n}d ago`,
		},
	},
};

const ZH = (navigator.language || "").toLowerCase().startsWith("zh");
const t = ZH ? I18N.zh : I18N.en;

function relTime(iso) {
	const ms = Date.now() - (Date.parse(iso) || 0);
	if (ms < 60e3) return t.time.now;
	if (ms < 3600e3) return t.time.min(Math.floor(ms / 60e3));
	if (ms < 86400e3) return t.time.hour(Math.floor(ms / 3600e3));
	const days = Math.floor(ms / 86400e3);
	return days === 1 ? t.time.yesterday : t.time.day(days);
}

function registerOpenAction() {
	try {
		const bridge = globalThis.window?.__piWebUiHost;
		if (bridge && typeof bridge.onUiAction === "function") {
			bridge.onUiAction("approval-gate:open", () => {
				try {
					bridge.setView("plugin:approval-gate");
				} catch {}
			});
		}
	} catch {}
}

function registerBadge() {
	if (globalThis.__agBadgeTimer) return;
	let lastN = -1;
	const applyDot = (n) => {
		if (n === lastN) return;
		lastN = n;
		const btn = document.querySelector('[data-bar-item="approval-gate:__view"]');
		if (!btn) return;
		btn.style.position = "relative";
		let dot = btn.querySelector(".ag-red-dot");
		if (n > 0) {
			if (!dot) {
				dot = document.createElement("span");
				dot.className = "ag-red-dot";
				dot.style.cssText =
					"position:absolute;top:-4px;right:-4px;min-width:15px;height:15px;border-radius:8px;background:#ff3b30;color:#fff;font-size:10px;line-height:15px;text-align:center;padding:0 3px;font-weight:600;pointer-events:none;z-index:10;";
				btn.append(dot);
			}
			dot.textContent = String(n);
			dot.style.display = "";
		} else if (dot) {
			dot.remove();
		}
	};
	const refresh = async () => {
		try {
			const r = await fetch("/plugins-api/approval-gate/list", { headers: { accept: "application/json" } });
			if (!r.ok) return;
			const d = await r.json();
			applyDot((d.items ?? []).filter((x) => x.status === "pending").length);
		} catch {}
	};
	globalThis.__agBadgeTimer = setInterval(refresh, 30000);
	globalThis.__agBadgeObserver?.disconnect();
	globalThis.__agBadgeObserver = new MutationObserver(() => {
		if (lastN >= 0) applyDot(lastN);
	});
	globalThis.__agBadgeObserver.observe(document.body, { childList: true, subtree: true });
	refresh();
}
registerOpenAction();
registerBadge();

export default defineView({
	mount(container, ctx) {
		registerOpenAction();
		registerBadge();
		let items = [];
		let onlyPending = false;
		let loaded = false;
		const offData = ctx.onData((payload) => {
			if (!payload || typeof payload !== "object") return;
			if (payload.type === "approval:state" && Array.isArray(payload.items)) {
				items = payload.items;
				loaded = true;
				render();
			} else if (payload.ok && Array.isArray(payload.items)) {
				items = payload.items;
				loaded = true;
				render();
			}
		});
		ctx.send({ type: "approval:list" });

		const el = (tag, cls, text) => {
			const node = document.createElement(tag);
			if (cls) node.className = cls;
			if (text !== undefined && text !== null) node.textContent = text;
			return node;
		};

		function jump(item) {
			const host = window.__piWebUiHost;
			if (item.conversationId) {
				try {
					host?.setView?.("chat");
				} catch {}
				window.location.hash = `#s=${encodeURIComponent(item.conversationId)}`;
			}
		}

		function resolve(id, status) {
			ctx.send({ type: "approval:resolve", id, status });
		}

		function card(it, isPending) {
			const el2 = el("div", `ag-card ${isPending ? "is-pending" : "is-done"}`);
			el2.dataset.jump = it.id;
			const main = el("div", "ag-card-main");
			const row1 = el("div", "ag-row1");
			row1.append(el("span", "ag-task", it.task), el("span", "ag-time", relTime(it.createdAt)));
			main.append(row1, el("div", "ag-row2", it.title));
			if (it.summary) main.append(el("div", "ag-row3", it.summary));
			const row4 = el("div", "ag-row4");
			if (it.project) {
				const proj = el("span", "ag-proj", it.project.split("/").filter(Boolean).slice(-2).join("/"));
				proj.title = it.project;
				row4.append(proj);
			}
			if (isPending) {
				const canJump = Boolean(it.conversationId);
				row4.append(el("span", canJump ? "ag-jump" : "ag-jump noconv", canJump ? t.jump : t.noConv));
				const btn = el("button", "ag-btn", t.dismiss);
				btn.dataset.dismiss = it.id;
				row4.append(btn);
			} else {
				row4.append(el("span", "ag-status", it.status === "dismissed" ? t.dismissed : t.resolved));
			}
			main.append(row4);
			el2.append(main);
			return el2;
		}

		function render() {
			container.textContent = "";
			const root = document.createElement("div");
			const style = document.createElement("style");
			style.textContent = CSS_TEXT;
			root.append(style);

			const wrap = el("div", "ag-root");
			root.append(wrap);

			const pending = items.filter((x) => x.status === "pending");
			const done = items.filter((x) => x.status !== "pending");

			const head = el("div", "ag-head");
			head.append(el("div", "ag-title", `🪧 ${t.title}`));
			const right = el("div", "ag-head-right");
			const toggleLabel = el("label", "ag-toggle");
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.id = "ag-only";
			cb.checked = onlyPending;
			toggleLabel.append(cb, el("span", "", t.onlyPending));
			right.append(
				toggleLabel,
				el("span", `ag-badge ${pending.length ? "hot" : "calm"}`, t.pendingCount(pending.length)),
			);
			head.append(right);
			wrap.append(head);

			if (!loaded) {
				wrap.append(el("div", "ag-empty", "…"));
				container.append(root);
				return;
			}

			const list = el("div", "ag-list");
			if (pending.length === 0 && (onlyPending || done.length === 0)) {
				const empty = el("div", "ag-empty");
				empty.append(
					el("div", "ag-empty-icon", "✅"),
					el("div", "ag-empty-title", onlyPending ? t.emptyFiltered : t.done),
					el("div", "ag-empty-hint", t.doneHint),
				);
				list.append(empty);
			}
			for (const it of pending) list.append(card(it, true));
			if (!onlyPending) {
				for (const it of done) list.append(card(it, false));
			}
			wrap.append(list);

			container.append(root);
			wrap.querySelector("#ag-only")?.addEventListener("change", (e) => {
				onlyPending = e.target.checked;
				render();
			});
			for (const jumpEl of wrap.querySelectorAll("[data-jump]")) {
				jumpEl.addEventListener("click", (e) => {
					if (e.target.closest("[data-dismiss]")) return;
					const it = items.find((x) => x.id === jumpEl.dataset.jump);
					if (it) jump(it);
				});
			}
			for (const dismissEl of wrap.querySelectorAll("[data-dismiss]")) {
				dismissEl.addEventListener("click", (e) => {
					e.stopPropagation();
					resolve(dismissEl.dataset.dismiss, "dismissed");
				});
			}
		}

		render();
		return () => {
			offData();
			container.textContent = "";
		};
	},
});

const CSS_TEXT = `
.ag-root { font: 13px/1.5 -apple-system, "PingFang SC", "Segoe UI", sans-serif; color: var(--ag-fg, #d8d8dc); padding: 14px 16px 32px; max-width: 860px; margin: 0 auto; }
@media (prefers-color-scheme: light) { .ag-root { --ag-fg: #26262b; } }
.ag-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.ag-title { font-size: 16px; font-weight: 600; }
.ag-head-right { display: flex; align-items: center; gap: 12px; }
.ag-toggle { display: inline-flex; align-items: center; gap: 5px; opacity: .85; cursor: pointer; user-select: none; }
.ag-badge { padding: 2px 10px; border-radius: 999px; font-size: 12px; }
.ag-badge.hot { background: rgba(255, 159, 10, .18); color: #ff9f0a; }
.ag-badge.calm { background: rgba(120, 120, 128, .16); opacity: .75; }
.ag-list { display: flex; flex-direction: column; gap: 8px; }
.ag-card { border: 1px solid rgba(128,128,134,.22); border-radius: 10px; padding: 10px 12px; background: rgba(128,128,134,.06); transition: background .15s, border-color .15s; }
.ag-card.is-pending { cursor: pointer; }
.ag-card.is-pending:hover { background: rgba(128,128,134,.13); border-color: rgba(128,128,134,.4); }
.ag-card.is-done { opacity: .55; }
.ag-row1 { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.ag-task { font-weight: 600; font-size: 12px; letter-spacing: .02em; }
.ag-time { font-size: 11px; opacity: .6; white-space: nowrap; }
.ag-row2 { margin-top: 3px; font-size: 13.5px; font-weight: 500; }
.ag-row3 { margin-top: 2px; font-size: 12px; opacity: .72; white-space: pre-wrap; word-break: break-word; }
.ag-row4 { margin-top: 6px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 11.5px; }
.ag-proj { opacity: .6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }
.ag-jump { opacity: .55; }
.ag-jump.noconv { opacity: .35; }
.ag-status { opacity: .7; }
.ag-btn { border: 1px solid rgba(128,128,134,.35); background: transparent; color: inherit; border-radius: 6px; font-size: 11px; padding: 1px 8px; cursor: pointer; margin-left: auto; }
.ag-btn:hover { background: rgba(128,128,134,.18); }
.ag-empty { text-align: center; padding: 48px 0 24px; }
.ag-empty-icon { font-size: 34px; }
.ag-empty-title { margin-top: 8px; font-size: 15px; font-weight: 600; }
.ag-empty-hint { margin-top: 4px; font-size: 12px; opacity: .6; }
`;
