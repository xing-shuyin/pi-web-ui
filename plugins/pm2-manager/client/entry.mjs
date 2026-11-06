function resolveApiBase(importMetaUrl) {
	const base = String(importMetaUrl);
	const idx = base.indexOf("/plugins/");
	const root = idx >= 0 ? base.slice(0, idx) : base.replace(/\/[^/]*$/, "");
	return `${root}/plugins-api/pm2-manager`;
}

const API = resolveApiBase(import.meta.url);

const TEXT = {
	zh: {
		title: "进程管家",
		subtitle: "pm2 统一托管 AI 的后台任务",
		probing: "正在检测 pm2 环境…",
		refresh: "刷新",
		notInstalled: "未检测到 pm2 —— 长期任务无法托管，AI 起的后台实例会脱离管理面。",
		install: "安装 pm2",
		installing: "正在安装…",
		installHint: "等价于在终端执行 npm i -g pm2",
		appsTitle: "pm2 托管的应用",
		empty: "pm2 当前没有托管任何应用。让 AI 用 pm2 起服务后，这里会自动出现。",
		name: "名称",
		status: "状态",
		cpu: "CPU",
		mem: "内存",
		restarts: "重启",
		uptime: "时长",
		ops: "操作",
		stop: "停止",
		restart: "重启",
		del: "删除",
		logs: "日志",
		logsEmpty: "（无输出）",
		platform: "平台",
		busy: "执行中…",
	},
	en: {
		title: "Process Manager",
		subtitle: "All AI background tasks supervised by pm2",
		probing: "Checking the pm2 environment…",
		refresh: "Refresh",
		notInstalled: "pm2 not found — long-lived tasks cannot be supervised; AI background instances escape management.",
		install: "Install pm2",
		installing: "Installing…",
		installHint: "Same as running npm i -g pm2 in a terminal",
		appsTitle: "pm2-supervised apps",
		empty: "pm2 supervises no app right now. Apps appear here as soon as the AI starts them through pm2.",
		name: "Name",
		status: "Status",
		cpu: "CPU",
		mem: "Memory",
		restarts: "Restarts",
		uptime: "Uptime",
		ops: "Actions",
		stop: "Stop",
		restart: "Restart",
		del: "Delete",
		logs: "Logs",
		logsEmpty: "(no output)",
		platform: "Platform",
		busy: "working…",
	},
};

import { esc, formatBytes as bytes } from "@pi-web-ui/plugin-sdk/client";

function currentLang() {
	try {
		const lang = document.documentElement?.lang ?? navigator.language ?? "zh";
		return String(lang).toLowerCase().startsWith("zh") ? "zh" : "en";
	} catch {
		return "zh";
	}
}

function uptime(startedAt) {
	const ms = Date.now() - Number(startedAt || 0);
	if (!Number.isFinite(ms) || ms <= 0) return "—";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return h < 24 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

const STYLE_ID = "pm2-manager-style";
function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
.pm2m-view{min-height:0;display:flex;flex-direction:column;gap:10px;padding:10px 12px;
 color:var(--text);font:12.5px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;box-sizing:border-box}
.pm2m-head{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}
.pm2m-head b{font-size:14px}
.pm2m-sub{color:var(--text-faint);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
.pm2m-sp{flex:1}
.pm2m-btn{cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--text);
 border-radius:7px;padding:3px 9px;font-size:12px;font-family:inherit}
.pm2m-btn:hover{background:var(--bg-elev2)}
.pm2m-btn[disabled]{opacity:.5;cursor:default}
.pm2m-btn.primary{background:var(--accent);border-color:transparent;color: var(--accent-contrast, #fff)}
.pm2m-btn.danger{color:var(--red);border-color:var(--red-soft)}
.pm2m-banner{flex:none;padding:9px 11px;border:1px solid var(--amber);border-radius:9px;
 background:rgba(251,191,36,.08);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pm2m-banner .pm2m-hint{color:var(--text-faint);font-size:11.5px}
.pm2m-sec{display:flex;align-items:center;gap:8px;color:var(--text-dim);font-size:12px;flex:none}
.pm2m-body{min-height:0;overscroll-behavior:contain}
.pm2m-table{width:100%;border-collapse:collapse;table-layout:fixed}
.pm2m-table th,.pm2m-table td{text-align:left;padding:5px 7px;border-bottom:1px solid var(--border-soft);
 overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm2m-table th{color:var(--text-faint);font-weight:500}
.pm2m-ops{display:flex;gap:5px;flex-wrap:wrap}
.pm2m-ops .pm2m-btn{padding:2px 7px;font-size:11.5px}
.pm2m-logs{margin:6px 0 12px;padding:9px;background:var(--term-bg);border:1px solid var(--border-soft);
 border-radius:9px;max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;
 overflow-wrap:anywhere;font:11.5px/1.45 var(--mono);color:var(--term-fg)}
.pm2m-empty{color:var(--text-faint);padding:6px 0}
.pm2m-tag{display:inline-block;padding:0 6px;border-radius:6px;font-size:11px;border:1px solid var(--border)}
.pm2m-tag.online{color:var(--green);border-color:var(--green-soft)}
.pm2m-tag.stopped,.pm2m-tag.errored,.pm2m-tag.launching{color:var(--amber);border-color:rgba(251,191,36,.35)}
.pm2m-tag.offline{color:var(--text-faint)}
`;
	document.head.appendChild(style);
}

/**
 * 模块级已知状态缓存：在同一页面会话内记住 pm2 环境检测结论。
 * 用户关闭弹窗再打开时，首帧直接沿用已知结论呈现真实内容，绝不闪烁。
 * 后台静默发起 refresh 同步最新指标与列表。
 * @type {{ installed: boolean, version: string, platform: string, apps: any[] } | null}
 */
let lastKnownState = null;

/**
 * 视图主体：一个容器内自管状态 + 3 秒轮询，切走时由返回的 cleanup 收摊。
 * @param {HTMLElement} container
 */
function createApp(container) {
	const t = (key) => (TEXT[currentLang()] ?? TEXT.zh)[key] ?? key;
	const root = document.createElement("div");
	root.className = "pm2m-view";
	container.appendChild(root);

	let state = lastKnownState
		? { ...lastKnownState, loaded: true, error: "" }
		: { installed: false, version: "", apps: [], error: "", platform: "", loaded: false };
	let logsFor = "";
	let logsText = "";
	let busy = false;
	let timer = null;
	let destroyed = false;

	async function api(path, init) {
		const res = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...init });
		return await res.json();
	}

	function statusTag(app) {
		const known = ["online", "stopped", "errored", "offline", "launching"];
		const cls = known.includes(app.status) ? app.status : "offline";
		return `<span class="pm2m-tag ${cls}">${esc(app.status)}</span>`;
	}

	function render() {
		if (destroyed) return;
		const parts = [];
		parts.push(`<div class="pm2m-head">
			<span>🚀</span><b>${esc(t("title"))}</b>
			<span class="pm2m-sub">${esc(
				state.installed ? `pm2 ${state.version} · ${t("platform")} ${state.platform || "-"}` : t("subtitle"),
			)}</span>
			<span class="pm2m-sp"></span>
			<button class="pm2m-btn" data-act="refresh" ${busy ? "disabled" : ""}>${esc(busy ? t("busy") : t("refresh"))}</button>
		</div>`);
		if (state.loaded && !state.installed) {
			parts.push(`<div class="pm2m-banner">
				<span>${esc(t("notInstalled"))}</span>
				<button class="pm2m-btn primary" data-act="install" ${busy ? "disabled" : ""}>${esc(
					busy ? t("installing") : t("install"),
				)}</button>
				<span class="pm2m-hint">${esc(t("installHint"))}</span>
			</div>`);
		}
		parts.push(`<div class="pm2m-sec">${esc(t("appsTitle"))}</div>`);
		if (!state.loaded) {
			parts.push(`<div class="pm2m-empty">${esc(t("probing"))}</div>`);
		} else if (!state.apps.length) {
			parts.push(`<div class="pm2m-empty">${esc(t("empty"))}</div>`);
		} else {
			parts.push(`<table class="pm2m-table"><colgroup><col style="width:24%"><col style="width:11%"><col style="width:8%">
				<col style="width:11%"><col style="width:8%"><col style="width:11%"><col></colgroup><thead><tr>
				<th>${esc(t("name"))}</th><th>${esc(t("status"))}</th><th>${esc(t("cpu"))}</th><th>${esc(t("mem"))}</th>
				<th>${esc(t("restarts"))}</th><th>${esc(t("uptime"))}</th><th>${esc(t("ops"))}</th></tr></thead><tbody>`);
			for (const app of state.apps) {
				const on = app.status === "online";
				parts.push(`<tr>
					<td title="${esc(app.script || app.cwd)}">${esc(app.name)}</td>
					<td>${statusTag(app)}</td>
					<td>${on ? `${Number(app.cpu) || 0}%` : "—"}</td>
					<td>${on ? bytes(app.memory) : "—"}</td>
					<td>${Number(app.restarts) || 0}</td>
					<td>${on ? uptime(app.startedAt) : "—"}</td>
					<td><span class="pm2m-ops">
						<button class="pm2m-btn" data-act="stop" data-name="${esc(app.name)}">${esc(t("stop"))}</button>
						<button class="pm2m-btn" data-act="restart" data-name="${esc(app.name)}">${esc(t("restart"))}</button>
						<button class="pm2m-btn" data-act="logs" data-name="${esc(app.name)}">${esc(t("logs"))}</button>
						<button class="pm2m-btn danger" data-act="delete" data-name="${esc(app.name)}">${esc(t("del"))}</button>
					</span></td></tr>`);
			}
			parts.push("</tbody></table>");
		}
		if (logsFor) {
			parts.push(`<div class="pm2m-sec">${esc(t("logs"))}: ${esc(logsFor)}</div>`);
			parts.push(`<div class="pm2m-logs">${esc(logsText || t("logsEmpty"))}</div>`);
		}
		if (state.error) parts.push(`<div class="pm2m-empty">${esc(state.error)}</div>`);
		root.innerHTML = parts.join("");
	}

	async function refresh() {
		try {
			const res = await api("/status");
			if (res && typeof res === "object") {
				state = { ...state, ...res, loaded: true, error: res.error || "" };
				lastKnownState = {
					installed: !!res.installed,
					version: String(res.version || ""),
					platform: String(res.platform || ""),
					apps: Array.isArray(res.apps) ? res.apps : [],
				};
			}
		} catch (err) {
			state = { ...state, error: String(err?.message ?? err) };
		}
		render();
	}

	async function act(kind, data = {}) {
		busy = true;
		render();
		try {
			const out = await api(`/${kind}`, { method: "POST", body: JSON.stringify(data) });
			if (out && typeof out === "object") {
				state = { ...state, ...out, loaded: true };
				if (typeof out.installed === "boolean") {
					lastKnownState = {
						installed: out.installed,
						version: String(out.version || lastKnownState?.version || ""),
						platform: String(out.platform || lastKnownState?.platform || ""),
						apps: Array.isArray(out.apps) ? out.apps : lastKnownState?.apps || [],
					};
				}
			}
			if (kind === "action" && data.action === "logs") {
				logsFor = data.name;
				logsText = String(out.output ?? out.error ?? "");
			} else if (kind === "action" && data.action === "delete" && logsFor === data.name) {
				logsFor = "";
				logsText = "";
			}
		} catch (err) {
			state = { ...state, error: String(err?.message ?? err) };
		}
		busy = false;
		render();
	}

	const onClick = (ev) => {
		const btn = ev.target?.closest?.("button[data-act]");
		if (!btn) return;
		const kind = btn.getAttribute("data-act");
		if (kind === "refresh") {
			void refresh();
			return;
		}
		if (kind === "install") {
			void act("install");
			return;
		}
		void act("action", { action: kind, name: btn.getAttribute("data-name") ?? "", lines: 80 });
	};
	root.addEventListener("click", onClick);

	return {
		start() {
			render();
			void refresh();
			timer = setInterval(() => void refresh(), 3000);
		},
		destroy() {
			destroyed = true;
			if (timer) clearInterval(timer);
			timer = null;
			root.removeEventListener("click", onClick);
			root.remove();
		},
	};
}

export default {
	mount(container) {
		ensureStyles();
		const app = createApp(container);
		app.start();
		return () => app.destroy();
	},
	_resetCache() {
		lastKnownState = null;
	},
};
