// frp-manager 面板：穿透列表 / 客户端 / 本地 frps / 远端部署 / 日志
import { esc } from "@pi-web-ui/plugin-sdk/client";
import { makeT } from "./i18n.mjs";

function resolveApiBase(importMetaUrl) {
	const base = String(importMetaUrl);
	const idx = base.indexOf("/plugins/");
	const root = idx >= 0 ? base.slice(0, idx) : base.replace(/\/[^/]*$/, "");
	return `${root}/plugins-api/frp-manager`;
}
const API = resolveApiBase(import.meta.url);

const CSS = `
.frp-wrap{font-family:-apple-system,"PingFang SC",sans-serif;font-size:13px;line-height:1.7;max-width:860px;padding:16px;color:var(--text,inherit)}
.frp-card{border:1px solid var(--border,var(--border-soft,#8884));border-radius:12px;padding:12px 14px;margin-bottom:12px;background:var(--bg-elev,var(--bg,transparent))}
.frp-row{display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap}
.frp-tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.frp-tab{border:1px solid var(--border,#8886);border-radius:8px;padding:3px 14px;cursor:pointer;background:transparent;color:var(--text,inherit);font-size:12.5px}
.frp-tab.on{background:var(--accent-soft,#8882);border-color:var(--accent,#4a7dff)}
.frp-btn{border:1px solid var(--border,#8886);border-radius:7px;padding:3px 14px;cursor:pointer;background:transparent;color:var(--text,inherit);font-size:12px}
.frp-btn:hover{background:var(--accent-soft,#8882)}
.frp-btn.primary{color:var(--accent-contrast,#fff);background:var(--accent,#4a7dff);border-color:var(--accent,#4a7dff)}
.frp-btn.danger{color:var(--red-text,var(--red));border-color:var(--red,#d33)}
.frp-btn:disabled{opacity:.5;cursor:default}
.frp-dot{width:10px;height:10px;border-radius:50%;background:var(--text-faint,#999);flex:none}
.frp-dot.ok{background:#34c759;box-shadow:0 0 0 3px #34c75933}
.frp-in{flex:1;min-width:110px;background:var(--bg-elev2,#8881);color:var(--text,inherit);border:1px solid var(--border,#8884);border-radius:6px;padding:4px 8px;font-size:12px;font-family:var(--mono,ui-monospace,monospace)}
.frp-in.sm{max-width:110px;flex:none}
select.frp-in{flex:none}
.frp-table{width:100%;border-collapse:collapse;font-size:12.5px}
.frp-table th{text-align:left;color:var(--text-dim,#999);font-weight:600;padding:4px 8px;border-bottom:1px solid var(--border-soft,#8883);white-space:nowrap}
.frp-table td{padding:5px 8px;border-bottom:1px solid var(--border-soft,#8882);word-break:break-all}
.frp-mono{font-family:var(--mono,ui-monospace,Menlo,monospace)}
.frp-dim{color:var(--text-dim,#999);font-size:12px}
.frp-code{font-family:var(--mono,ui-monospace,Menlo,monospace);font-size:11.5px;background:var(--bg-elev2,#8881);border:1px solid var(--border-soft,#8883);border-radius:8px;padding:8px 10px;overflow-x:auto;white-space:pre;max-height:300px;overflow-y:auto}
.frp-grid{display:grid;grid-template-columns:130px 1fr;gap:6px 10px;align-items:center}
.frp-grid label{color:var(--text-dim,#999)}
`;

let styleEl = null;
function ensureStyles() {
	if (styleEl || !document?.head) return;
	styleEl = document.createElement("style");
	styleEl.textContent = CSS;
	document.head.appendChild(styleEl);
}

async function api(path, opts = {}) {
	const r = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...opts });
	return r.json();
}

function createApp(root) {
	const t = makeT();
	let st = null;
	let tab = "list";
	let msg = "";
	let destroyed = false;
	let timer = null;
	let editing = null; // 正在编辑的穿透名（null=新增态隐藏，""=新增）
	let logRole = "frpc";
	let logLines = [];

	async function refresh(quiet) {
		try {
			st = await api("/status");
			if (!quiet) render();
		} catch (e) {
			msg = t("connectingFailed", { error: e.message });
			render();
		}
	}
	async function loadLogs() {
		try {
			const r = await api(`/logs?role=${logRole}`);
			logLines = r.lines || [];
			render();
		} catch {}
	}
	async function act(action, extra = {}) {
		msg = t("working");
		render();
		try {
			const r = await api("/action", { method: "POST", body: JSON.stringify({ action, ...extra }) });
			if (!r.ok) msg = t("failed", { error: esc(r.error || t("unknownError")) });
			else {
				st = r.st || st;
				msg = r.out ? esc(String(r.out).slice(-800)) : t("done");
			}
		} catch (e) {
			msg = t("failed", { error: esc(e.message) });
		}
		render();
	}

	function proxyForm(p = {}) {
		const v = {
			type: "tcp",
			localIP: "127.0.0.1",
			localPort: "",
			remotePort: "",
			customDomains: "",
			subdomain: "",
			...p,
		};
		return `
		<div class="frp-card"><div class="frp-row"><b>${p.name ? t("editProxy", { name: esc(p.name) }) : t("addProxy")}</b></div>
		<div class="frp-grid">
			<label>${t("fName")}</label><input class="frp-in" data-f="name" value="${esc(v.name || "")}" placeholder="${t("namePlaceholder")}" ${p.name ? "disabled" : ""}>
			<label>${t("fType")}</label><select class="frp-in" data-f="type">
				${["tcp", "udp", "http", "https", "stcp", "xtcp"].map((type) => `<option ${v.type === type ? "selected" : ""}>${type}</option>`).join("")}
			</select>
			<label>${t("fLocalIp")}</label><input class="frp-in" data-f="localIP" value="${esc(v.localIP)}">
			<label>${t("fLocalPort")}</label><input class="frp-in" data-f="localPort" value="${esc(v.localPort)}" placeholder="${t("localPortPlaceholder")}">
			<label>${t("fRemotePort")}</label><input class="frp-in" data-f="remotePort" value="${esc(v.remotePort || "")}" placeholder="${t("remotePortPlaceholder")}">
			<label>${t("fDomains")}</label><input class="frp-in" data-f="customDomains" value="${esc(v.customDomains || "")}" placeholder="${t("domainsPlaceholder")}">
			<label>${t("fSubdomain")}</label><input class="frp-in" data-f="subdomain" value="${esc(v.subdomain || "")}" placeholder="${t("subdomainPlaceholder")}">
		</div>
		<div class="frp-row" style="margin-top:8px">
			<button class="frp-btn primary" data-op="save">${t("save")}</button>
			<button class="frp-btn" data-op="cancel">${t("cancel")}</button>
		</div></div>`;
	}

	function render() {
		if (destroyed) return;
		if (!st) {
			root.innerHTML = `<div class="frp-wrap">${t("probing")}</div>`;
			return;
		}
		const frpcRun = st.frpc?.running;
		const frpsRun = st.frpsLocal?.running;
		const tabs = [
			["list", t("tabList")],
			["client", t("tabClient")],
			["frps", t("tabFrps")],
			["remote", t("tabRemote")],
			["logs", t("tabLogs")],
		];
		let body = "";
		if (tab === "list") {
			const rows = (st.proxies || [])
				.map((p) => {
					const off = p.enabled === false;
					const target =
						p.type === "http" || p.type === "https"
							? esc(p.customDomains || p.subdomain || "-")
							: `:${esc(p.remotePort || "-")}`;
					return `<tr style="${off ? "opacity:.55" : ""}"><td class="frp-mono"><b>${esc(p.name)}</b>${off ? ` <span class="frp-dim">${t("disabled")}</span>` : ""}</td>
				<td>${esc(p.type)}</td><td class="frp-mono">${esc(p.localIP || "127.0.0.1")}:${esc(p.localPort)} → ${target}</td>
				<td style="white-space:nowrap"><button class="frp-btn" data-op="toggle" data-name="${esc(p.name)}">${off ? t("enable") : t("disable")}</button>
				<button class="frp-btn" data-op="edit" data-name="${esc(p.name)}">${t("edit")}</button>
				<button class="frp-btn danger" data-op="del" data-name="${esc(p.name)}">${t("remove")}</button></td></tr>`;
				})
				.join("");
			body = `
			<div class="frp-card"><div class="frp-row">
				<span class="frp-dot ${frpcRun ? "ok" : ""}"></span><b>frpc ${frpcRun ? t("runningWithPid", { pid: st.frpc.pid }) : t("notRunning")}</b>
				<span class="frp-dim">${t("serverSummary", {
					addr: esc(st.common.serverAddr || t("notFilled")),
					port: esc(st.common.serverPort),
					count: st.proxies.filter((p) => p.enabled !== false).length,
				})}</span>
				<span style="flex:1"></span>
				${st.frpcBin ? "" : `<button class="frp-btn primary" data-op="install">${t("installFrp")}</button>`}
				<button class="frp-btn ${frpcRun ? "" : "primary"}" data-op="frpc_start">${frpcRun ? t("restart") : t("start")}</button>
				${frpcRun ? `<button class="frp-btn" data-op="frpc_stop">${t("stop")}</button>` : ""}
			</div>${st.frpcBin ? "" : `<div class="frp-dim">${t("frpcMissing", { dir: esc(st.binDir) })}</div>`}</div>
			${editing !== null && editing !== undefined ? proxyForm(editing === "" ? {} : st.proxies.find((p) => p.name === editing) || {}) : `<div class="frp-row"><button class="frp-btn" data-op="new">${t("newProxy")}</button><span class="frp-dim">${t("applyHint")}</span></div>`}
			<div class="frp-card"><table class="frp-table"><tr><th>${t("colName")}</th><th>${t("colType")}</th><th>${t("colMapping")}</th><th>${t("colOps")}</th></tr>${rows || `<tr><td colspan="4" class="frp-dim">${t("emptyProxies")}</td></tr>`}</table></div>`;
		} else if (tab === "client") {
			const c = st.common;
			body = `<div class="frp-card"><div class="frp-row"><b>${t("clientSection")}</b></div>
			<div class="frp-grid">
				<label>serverAddr</label><input class="frp-in" data-c="serverAddr" value="${esc(c.serverAddr || "")}" placeholder="${t("addrPlaceholder")}">
				<label>serverPort</label><input class="frp-in" data-c="serverPort" value="${esc(c.serverPort ?? 7000)}">
				<label>token</label><input class="frp-in" data-c="token" value="${esc(c.token || "")}" placeholder="${t("tokenPlaceholder")}">
				<label>TLS</label><select class="frp-in" data-c="tlsEnable"><option value="0">${t("tlsOff")}</option><option value="1" ${c.tlsEnable ? "selected" : ""}>${t("tlsOn")}</option></select>
			</div>
			<div class="frp-row" style="margin-top:8px"><button class="frp-btn primary" data-op="save_client">${t("save")}</button>
			<span class="frp-dim">${t("clientSavedHint")}</span></div></div>`;
		} else if (tab === "frps") {
			const f = st.frps;
			body = `<div class="frp-card"><div class="frp-row"><span class="frp-dot ${frpsRun ? "ok" : ""}"></span>
				<b>${t("localFrps")} ${frpsRun ? t("runningWithPid", { pid: st.frpsLocal.pid }) : t("notRunning")}</b>
				<span class="frp-dim">${t("frpsSummary")}</span><span style="flex:1"></span>
				${frpsRun ? `<button class="frp-btn" data-op="frps_stop">${t("stop")}</button>` : `<button class="frp-btn primary" data-op="frps_start">${t("start")}</button>`}</div>
			<div class="frp-grid">
				<label>bindPort</label><input class="frp-in" data-s="bindPort" value="${esc(f.bindPort ?? 7000)}">
				<label>token</label><input class="frp-in" data-s="token" value="${esc(f.token || "")}">
				<label>${t("fHttpPort")}</label><input class="frp-in" data-s="httpPort" value="${esc(f.httpPort ?? "")}" placeholder="${t("httpPortPlaceholder")}">
				<label>${t("fDashboardPort")}</label><input class="frp-in" data-s="dashboardPort" value="${esc(f.dashboardPort ?? "")}" placeholder="${t("dashboardPortPlaceholder")}">
				<label>${t("fDashboardUser")}</label><input class="frp-in" data-s="dashboardUser" value="${esc(f.dashboardUser || "admin")}">
				<label>${t("fDashboardPwd")}</label><input class="frp-in" data-s="dashboardPwd" value="${esc(f.dashboardPwd || "admin")}">
				<label>subdomainHost</label><input class="frp-in" data-s="subdomainHost" value="${esc(f.subdomainHost || "")}" placeholder="${t("subdomainHostPlaceholder")}">
			</div>
			<div class="frp-row" style="margin-top:8px"><button class="frp-btn primary" data-op="save_frps">${t("save")}</button></div></div>`;
		} else if (tab === "remote") {
			const r = st.remote,
				f = st.frps;
			const opts = (r.profiles || [])
				.map(
					(h) =>
						`<option value="${esc(h.name)}" ${r.profile === h.name ? "selected" : ""}>${t("hostOption", { name: esc(h.name), user: esc(h.username), host: esc(h.host), port: esc(h.port) })}</option>`,
				)
				.join("");
			body = `<div class="frp-card"><div class="frp-row"><b>${t("remoteSection")}</b></div>
			<div class="frp-dim">${t("remoteDesc")}</div>
			<div class="frp-row" style="margin-top:8px">
				<label class="frp-dim">${t("remoteHost")}</label>
				<select class="frp-in" data-r="profile">${opts || `<option value="">${t("hostLibEmpty")}</option>`}</select>
				<button class="frp-btn" data-op="save_remote">${t("useThisHost")}</button>
			</div>
			<div class="frp-row" style="margin-top:8px">
				<button class="frp-btn" data-op="probe">${t("probe")}</button>
				<button class="frp-btn" data-op="copy_script">${t("copyScript")}</button>
				<button class="frp-btn primary" data-op="deploy">${t("deploy")}</button>
			</div>
			<div class="frp-dim">${t("remoteDeployHint")}${t("remoteCurrent", { bindPort: esc(f.bindPort) })}${f.token ? t("tokenSet") : t("tokenUnset")}</div></div>`;
		} else {
			body = `<div class="frp-card"><div class="frp-row">
				<button class="frp-tab ${logRole === "frpc" ? "on" : ""}" data-op="log_frpc">${t("logsFrpc")}</button>
				<button class="frp-tab ${logRole === "frps" ? "on" : ""}" data-op="log_frps">${t("logsFrps")}</button>
				<span style="flex:1"></span><button class="frp-btn" data-op="log_refresh">${t("refresh")}</button></div>
				<div class="frp-code">${esc(logLines.join("\n") || t("logsEmpty"))}</div></div>`;
		}
		root.innerHTML = `<div class="frp-wrap">
			<div class="frp-row"><b style="font-size:15px">${t("title")}</b><span class="frp-dim">${t("subtitle")}</span>
			<span style="flex:1"></span><button class="frp-btn" data-op="refresh">${t("refresh")}</button></div>
			<div class="frp-tabs">${tabs.map(([k, l]) => `<button class="frp-tab ${tab === k ? "on" : ""}" data-op="tab" data-k="${k}">${l}</button>`).join("")}</div>
			${msg ? `<div class="frp-dim">${msg}</div>` : ""}
			${body}</div>`;
	}

	function val(sel, key) {
		const el = root.querySelector(`${sel}[data-${key.startsWith("data-") ? key.slice(5) : key}]`);
		return el ? el.value : "";
	}
	function collect(prefix) {
		const o = {};
		root.querySelectorAll(`[data-${prefix}]`).forEach((el) => (o[el.dataset[prefix]] = el.value));
		return o;
	}

	async function onClick(e) {
		const b = e.target.closest("[data-op]");
		if (!b) return;
		const op = b.dataset.op;
		if (op === "tab") {
			tab = b.dataset.k;
			msg = "";
			if (tab === "logs") void loadLogs();
			else render();
		} else if (op === "refresh") {
			msg = "";
			await refresh();
			if (tab === "logs") await loadLogs();
		} else if (op === "install") {
			msg = t("installing");
			render();
			try {
				const r = await api("/install", { method: "POST", body: "{}" });
				st = r.st || st;
				msg = r.ok ? t("installed", { version: r.version || "" }) : t("failed", { error: esc(r.error) });
			} catch (err) {
				msg = t("failed", { error: esc(err.message) });
			}
			render();
		} else if (op === "new") {
			editing = "";
			msg = "";
			render();
		} else if (op === "edit") {
			editing = b.dataset.name;
			msg = "";
			render();
		} else if (op === "cancel") {
			editing = null;
			msg = "";
			render();
		} else if (op === "save") {
			const o = collect("f");
			o.localPort = Number(o.localPort);
			if (o.remotePort) o.remotePort = Number(o.remotePort);
			await act("proxy_save", {
				proxy: { ...o, enabled: editing ? (st.proxies.find((p) => p.name === editing)?.enabled ?? true) : true },
				editName: editing || undefined,
			});
			editing = null;
			render();
		} else if (op === "del") {
			if (!confirm(t("deleteProxyAsk", { name: b.dataset.name }))) return;
			await act("proxy_delete", { name: b.dataset.name });
		} else if (op === "toggle") {
			await act("proxy_toggle", { name: b.dataset.name });
		} else if (op === "save_client") {
			const o = collect("c");
			await act("server_save", {
				common: {
					serverAddr: o.serverAddr,
					serverPort: Number(o.serverPort) || 7000,
					token: o.token,
					tlsEnable: o.tlsEnable === "1",
				},
			});
		} else if (op === "save_frps") {
			const o = collect("s");
			await act("frps_save", {
				frps: {
					bindPort: Number(o.bindPort) || 7000,
					token: o.token,
					httpPort: Number(o.httpPort) || 0,
					dashboardPort: Number(o.dashboardPort) || 0,
					dashboardUser: o.dashboardUser,
					dashboardPwd: o.dashboardPwd,
					subdomainHost: o.subdomainHost,
				},
			});
		} else if (op === "save_remote") {
			const o = collect("r");
			await act("remote_use", { profile: o.profile });
		} else if (op === "probe") {
			await act("remote_probe", {});
		} else if (op === "copy_script") {
			try {
				const r = await api("/remote-script");
				await navigator.clipboard.writeText(r.script || "");
				msg = t("scriptCopied");
			} catch {
				msg = t("copyFailed");
			}
			render();
		} else if (op === "deploy") {
			await act("remote_deploy", {});
		} else if (op === "frpc_start") {
			await act(st.frpc?.running ? "frpc_restart" : "frpc_start", {});
		} else if (op === "frpc_stop") {
			await act("frpc_stop", {});
		} else if (op === "frps_start") {
			await act("frps_start", {});
		} else if (op === "frps_stop") {
			await act("frps_stop", {});
		} else if (op === "log_frpc") {
			logRole = "frpc";
			await loadLogs();
		} else if (op === "log_frps") {
			logRole = "frps";
			await loadLogs();
		} else if (op === "log_refresh") {
			await loadLogs();
		}
	}

	return {
		start() {
			render();
			void refresh();
			timer = setInterval(() => {
				if (!destroyed && tab !== "logs") void refresh(true);
			}, 5000);
			root.addEventListener("click", onClick);
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
};
