// frp-manager 面板：穿透列表 / 客户端 / 本地 frps / 远端部署 / 日志
import { esc } from "../../plugin-sdk/client-utils.mjs";

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
			msg = `连接失败：${e.message}`;
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
		msg = "执行中…";
		render();
		try {
			const r = await api("/action", { method: "POST", body: JSON.stringify({ action, ...extra }) });
			if (!r.ok) msg = `失败：${esc(r.error || "未知错误")}`;
			else {
				st = r.st || st;
				msg = r.out ? esc(String(r.out).slice(-800)) : "已完成";
			}
		} catch (e) {
			msg = `失败：${esc(e.message)}`;
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
		<div class="frp-card"><div class="frp-row"><b>${p.name ? `编辑 ${esc(p.name)}` : "新增穿透"}</b></div>
		<div class="frp-grid">
			<label>名称</label><input class="frp-in" data-f="name" value="${esc(v.name || "")}" placeholder="如 web-admin" ${p.name ? "disabled" : ""}>
			<label>类型</label><select class="frp-in" data-f="type">
				${["tcp", "udp", "http", "https", "stcp", "xtcp"].map((t) => `<option ${v.type === t ? "selected" : ""}>${t}</option>`).join("")}
			</select>
			<label>本地 IP</label><input class="frp-in" data-f="localIP" value="${esc(v.localIP)}">
			<label>本地端口</label><input class="frp-in" data-f="localPort" value="${esc(v.localPort)}" placeholder="如 3000">
			<label>远程端口</label><input class="frp-in" data-f="remotePort" value="${esc(v.remotePort || "")}" placeholder="tcp/udp 用，如 6000">
			<label>域名</label><input class="frp-in" data-f="customDomains" value="${esc(v.customDomains || "")}" placeholder="http/https 用，逗号分隔">
			<label>subdomain</label><input class="frp-in" data-f="subdomain" value="${esc(v.subdomain || "")}" placeholder="可选，需服务端 subdomainHost">
		</div>
		<div class="frp-row" style="margin-top:8px">
			<button class="frp-btn primary" data-op="save">保存</button>
			<button class="frp-btn" data-op="cancel">取消</button>
		</div></div>`;
	}

	function render() {
		if (destroyed) return;
		if (!st) {
			root.innerHTML = `<div class="frp-wrap">正在检测 frp 环境…</div>`;
			return;
		}
		const frpcRun = st.frpc?.running;
		const frpsRun = st.frpsLocal?.running;
		const tabs = [
			["list", "穿透列表"],
			["client", "客户端 frpc"],
			["frps", "本地 frps"],
			["remote", "远端部署"],
			["logs", "日志"],
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
					return `<tr style="${off ? "opacity:.55" : ""}"><td class="frp-mono"><b>${esc(p.name)}</b>${off ? ' <span class="frp-dim">已禁用</span>' : ""}</td>
				<td>${esc(p.type)}</td><td class="frp-mono">${esc(p.localIP || "127.0.0.1")}:${esc(p.localPort)} → ${target}</td>
				<td style="white-space:nowrap"><button class="frp-btn" data-op="toggle" data-name="${esc(p.name)}">${off ? "启用" : "禁用"}</button>
				<button class="frp-btn" data-op="edit" data-name="${esc(p.name)}">编辑</button>
				<button class="frp-btn danger" data-op="del" data-name="${esc(p.name)}">删</button></td></tr>`;
				})
				.join("");
			body = `
			<div class="frp-card"><div class="frp-row">
				<span class="frp-dot ${frpcRun ? "ok" : ""}"></span><b>frpc ${frpcRun ? `运行中 (pid ${st.frpc.pid})` : "未运行"}</b>
				<span class="frp-dim">服务端 ${esc(st.common.serverAddr || "(未填)")}:${esc(st.common.serverPort)} · ${st.proxies.filter((p) => p.enabled !== false).length} 条启用</span>
				<span style="flex:1"></span>
				${st.frpcBin ? "" : `<button class="frp-btn primary" data-op="install">一键安装 frp</button>`}
				<button class="frp-btn ${frpcRun ? "" : "primary"}" data-op="frpc_start">${frpcRun ? "重启" : "启动"}</button>
				${frpcRun ? `<button class="frp-btn" data-op="frpc_stop">停止</button>` : ""}
			</div>${st.frpcBin ? "" : `<div class="frp-dim">未检测到 frpc（${esc(st.binDir)}），点一键安装从 GitHub 下载官方版；离线机器可手动放二进制到该目录。</div>`}</div>
			${editing !== null && editing !== undefined ? proxyForm(editing === "" ? {} : st.proxies.find((p) => p.name === editing) || {}) : `<div class="frp-row"><button class="frp-btn" data-op="new">+ 新增穿透</button><span class="frp-dim">改完点「启动/重启」生效</span></div>`}
			<div class="frp-card"><table class="frp-table"><tr><th>名称</th><th>类型</th><th>映射</th><th>操作</th></tr>${rows || `<tr><td colspan="4" class="frp-dim">还没有穿透规则，点「新增穿透」把本机服务（如 127.0.0.1:3000）暴露出去。</td></tr>`}</table></div>`;
		} else if (tab === "client") {
			const c = st.common;
			body = `<div class="frp-card"><div class="frp-row"><b>服务端连接（frpc.toml [common]）</b></div>
			<div class="frp-grid">
				<label>serverAddr</label><input class="frp-in" data-c="serverAddr" value="${esc(c.serverAddr || "")}" placeholder="公网服务器 IP/域名">
				<label>serverPort</label><input class="frp-in" data-c="serverPort" value="${esc(c.serverPort ?? 7000)}">
				<label>token</label><input class="frp-in" data-c="token" value="${esc(c.token || "")}" placeholder="与 frps 一致">
				<label>TLS</label><select class="frp-in" data-c="tlsEnable"><option value="0">关闭</option><option value="1" ${c.tlsEnable ? "selected" : ""}>开启</option></select>
			</div>
			<div class="frp-row" style="margin-top:8px"><button class="frp-btn primary" data-op="save_client">保存</button>
			<span class="frp-dim">保存后重启 frpc 生效 · 配置文件 frpc.toml 在数据目录</span></div></div>`;
		} else if (tab === "frps") {
			const f = st.frps;
			body = `<div class="frp-card"><div class="frp-row"><span class="frp-dot ${frpsRun ? "ok" : ""}"></span>
				<b>本地 frps ${frpsRun ? `运行中 (pid ${st.frpsLocal.pid})` : "未运行"}</b>
				<span class="frp-dim">联调用：本机同时起 frps + frpc 自测</span><span style="flex:1"></span>
				${frpsRun ? `<button class="frp-btn" data-op="frps_stop">停止</button>` : `<button class="frp-btn primary" data-op="frps_start">启动</button>`}</div>
			<div class="frp-grid">
				<label>bindPort</label><input class="frp-in" data-s="bindPort" value="${esc(f.bindPort ?? 7000)}">
				<label>token</label><input class="frp-in" data-s="token" value="${esc(f.token || "")}">
				<label>http 穿透端口</label><input class="frp-in" data-s="httpPort" value="${esc(f.httpPort ?? "")}" placeholder="如 8080，空=关闭">
				<label>dashboard 端口</label><input class="frp-in" data-s="dashboardPort" value="${esc(f.dashboardPort ?? "")}" placeholder="如 7500">
				<label>dashboard 账号</label><input class="frp-in" data-s="dashboardUser" value="${esc(f.dashboardUser || "admin")}">
				<label>dashboard 密码</label><input class="frp-in" data-s="dashboardPwd" value="${esc(f.dashboardPwd || "admin")}">
				<label>subdomainHost</label><input class="frp-in" data-s="subdomainHost" value="${esc(f.subdomainHost || "")}" placeholder="如 frp.example.com">
			</div>
			<div class="frp-row" style="margin-top:8px"><button class="frp-btn primary" data-op="save_frps">保存</button></div></div>`;
		} else if (tab === "remote") {
			const r = st.remote,
				f = st.frps;
			const opts = (r.profiles || [])
				.map(
					(h) =>
						`<option value="${esc(h.name)}" ${r.profile === h.name ? "selected" : ""}>${esc(h.name)}（${esc(h.username)}@${esc(h.host)}:${esc(h.port)}）</option>`,
				)
				.join("");
			body = `<div class="frp-card"><div class="frp-row"><b>远端公网 frps 一键部署</b></div>
			<div class="frp-dim">用本机<b>共享 SSH 主机库</b>（与远程工作台/SFTP 同一份：截图里那些已保存连接直接选，不用再填 IP 密码）。主机先去远程工作台加好，回来点刷新。远端需放行 bindPort/tcp（如 7000）+ http/dashboard 端口。</div>
			<div class="frp-row" style="margin-top:8px">
				<label class="frp-dim">远端主机</label>
				<select class="frp-in" data-r="profile">${opts || `<option value="">（主机库为空，先去远程工作台添加）</option>`}</select>
				<button class="frp-btn" data-op="save_remote">选用该主机</button>
			</div>
			<div class="frp-row" style="margin-top:8px">
				<button class="frp-btn" data-op="probe">测试连通</button>
				<button class="frp-btn" data-op="copy_script">复制一键脚本</button>
				<button class="frp-btn primary" data-op="deploy">SSH 直装远端</button>
			</div>
			<div class="frp-dim">直装成功后 frpc 服务端地址自动同步为所选主机 IP，token 与本地 frps 页一致，重启 frpc 即通。当前远端配置：bindPort ${esc(f.bindPort)} / token ${f.token ? "已设" : "<b>未设（先去本地 frps 页设置）</b>"}。</div></div>`;
		} else {
			body = `<div class="frp-card"><div class="frp-row">
				<button class="frp-tab ${logRole === "frpc" ? "on" : ""}" data-op="log_frpc">frpc 日志</button>
				<button class="frp-tab ${logRole === "frps" ? "on" : ""}" data-op="log_frps">frps 日志</button>
				<span style="flex:1"></span><button class="frp-btn" data-op="log_refresh">刷新</button></div>
				<div class="frp-code">${esc(logLines.join("\n") || "(暂无日志)")}</div></div>`;
		}
		root.innerHTML = `<div class="frp-wrap">
			<div class="frp-row"><b style="font-size:15px">🚇 内网穿透</b><span class="frp-dim">frpc 穿透列表 · 本地 frps 联调 · 远端一键部署</span>
			<span style="flex:1"></span><button class="frp-btn" data-op="refresh">刷新</button></div>
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
			msg = "下载安装中（GitHub release，约 10-20MB）…";
			render();
			try {
				const r = await api("/install", { method: "POST", body: "{}" });
				st = r.st || st;
				msg = r.ok ? `安装完成 ${r.version || ""}` : `失败：${esc(r.error)}`;
			} catch (err) {
				msg = `失败：${esc(err.message)}`;
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
			if (!confirm(`删除穿透 ${b.dataset.name}？`)) return;
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
				msg = "一键脚本已复制，到远端 root 下 bash 粘贴执行即可";
			} catch {
				msg = "复制失败，点 SSH 直装或稍后重试";
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
