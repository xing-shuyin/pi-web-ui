import { defineView, esc } from "./sdk/index.mjs";
import { makeT } from "./i18n.mjs";

/** 面板文案：语言解析 / 回退 / 插值都在 SDK 里，这里只按当前界面语言取词。 */
const t = makeT();

/** 硬件概览的「标签 + 值」一行：按视觉宽度补空格（中日韩字符占 2 列），中英文都能对齐。 */
function hwLine(label, value) {
	const width = [...label].reduce((n, ch) => n + (ch.charCodeAt(0) >= 0x2e80 ? 2 : 1), 0);
	return label + " ".repeat(Math.max(1, 10 - width)) + value;
}

const CSS = `
.tnl-wrap { font-family: -apple-system, "PingFang SC", sans-serif; font-size: 13px; line-height: 1.7; max-width: 720px; padding: 18px; color: var(--text, inherit); --green: #34c759; --green-soft: #34c75933; --green-text: #2e9e47; }
.tnl-card { border: 1px solid var(--border, var(--border-soft, #8884)); border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; background: var(--bg-elev, var(--bg, transparent)); box-shadow: 0 1px 3px #0001; }
.tnl-row { display: flex; align-items: center; gap: 10px; margin: 5px 0; flex-wrap: wrap; }
.tnl-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--text-faint, #999); flex: none; }
.tnl-dot.ok { background: var(--green, #34c759); box-shadow: 0 0 0 3px var(--green-soft, #34c75933); }
.tnl-dot.bad { background: var(--red, #ff3b30); box-shadow: 0 0 0 3px var(--red-soft, #ff3b3033); }
.tnl-state { font-size: 16px; font-weight: 700; color: var(--text-strong, var(--text, inherit)); }
.tnl-label { color: var(--text-dim, #999); min-width: 92px; flex: none; }
.tnl-mono { font-family: var(--mono, ui-monospace, Menlo, monospace); }
.tnl-token { font-family: var(--mono, ui-monospace, Menlo, monospace); color: var(--amber-text, var(--text)); background: var(--accent-soft, #8881); border: 1px solid var(--border-soft, #8883); border-radius: 5px; padding: 1px 8px; }
.tnl-btn { border: 1px solid var(--border, #8886); border-radius: 7px; padding: 3px 14px; cursor: pointer; background: transparent; color: var(--text, inherit); font-size: 12px; transition: background .12s, filter .12s; }
.tnl-btn:hover { background: var(--accent-soft, #8882); }
.tnl-btn:active { transform: translateY(1px); }
.tnl-btn.sm { padding: 2px 10px; font-size: 11px; border-radius: 6px; }
.tnl-btn.danger { color: var(--red-text, var(--red)); border-color: var(--red, #d33); }
.tnl-btn.danger:hover { background: var(--red-soft, #d3322); }
.tnl-btn.primary { color: var(--accent-contrast, #fff); background: var(--accent, #4a7dff); border-color: var(--accent, #4a7dff); }
.tnl-btn.primary:hover { filter: brightness(1.1); }
.tnl-btn.tab { border-radius: 7px; }
.tnl-btn.tab.on { background: var(--accent-soft, #8882); border-color: var(--accent, #4a7dff); color: var(--text-strong, var(--text)); }
.tnl-code { font-family: var(--mono, ui-monospace, Menlo, monospace); font-size: 11.5px; background: var(--bg-elev2, #8881); border: 1px solid var(--border-soft, #8883); border-radius: 8px; padding: 8px 10px; overflow-x: auto; white-space: pre; color: var(--text); }
.tnl-a { color: var(--link, var(--accent)); }
.tnl-a:hover { color: var(--link-hover, var(--accent)); }
.tnl-dim { color: var(--text-faint, #999); }
.tnl-copied { color: var(--green, #34c759); }
/* ─ 出口设备行：hover 整行高亮，OS 徽章化，当前出口绿标 ─ */
.tnl-dev { display: flex; align-items: center; gap: 9px; padding: 4px 8px; margin: 2px -8px; border-radius: 8px; flex-wrap: wrap; }
.tnl-dev:hover { background: var(--bg-elev2, #8882); }
.tnl-dev .tnl-name { font-family: var(--mono, ui-monospace, Menlo, monospace); font-size: 12.5px; }
.tnl-os { font-size: 11px; color: var(--text-dim, #999); background: var(--bg-elev2, #8881); border-radius: 4px; padding: 0 7px; line-height: 1.6; }
.tnl-cur { font-size: 11px; font-weight: 600; color: var(--green-text, var(--green, #34c759)); background: var(--green-soft, #34c75922); border-radius: 4px; padding: 0 8px; line-height: 1.7; }
.tnl-dev .tnl-btn { margin-left: auto; }
/* ─ 配置行：左竖线从属视觉，按钮组右靠 ─ */
.tnl-cfg { display: flex; align-items: center; gap: 8px; margin: 2px 0 6px 8px; padding: 4px 0 4px 12px; border-left: 2px solid var(--border-soft, #8883); flex-wrap: wrap; font-size: 12px; }
.tnl-cfg label { color: var(--text-dim, #999); display: flex; align-items: center; gap: 3px; }
.tnl-wl { flex: 1; min-width: 200px; background: var(--bg-elev2, #8881); color: var(--text, inherit); border: 1px solid var(--border, #8884); border-radius: 6px; padding: 3px 8px; font-family: var(--mono, monospace); font-size: 11px; }
.tnl-cfg .tnl-btnrow { display: flex; gap: 6px; margin-left: auto; }
/* ─ 审计行：时间戳淡色 + 设备名 token ─ */
.tnl-at { color: var(--text-faint, #888); }
.tnl-audit .tnl-token { font-size: 11px; padding: 0 6px; }
/* ─ 合并卡内小节标题 ─ */
.tnl-sec { font-weight: 700; margin: 2px 0 6px; }
.tnl-sep { border: none; border-top: 1px dashed var(--border-soft, #8883); margin: 12px 0; }
/* ─ P5 视觉梳理：仪表卡 kv 对齐 / 设备行版本徽章与离线弱化 / 按钮组分隔 / 任务结果徽章 / 键盘焦点 ─ */
.tnl-kv { display: flex; align-items: center; gap: 8px; }
.tnl-ver { font-size: 11px; font-family: var(--mono, ui-monospace, Menlo, monospace); color: var(--text-dim, #999); background: var(--bg-elev2, #8881); border: 1px solid var(--border-soft, #8883); border-radius: 4px; padding: 0 6px; line-height: 1.6; }
.tnl-dev.off { opacity: .55; }
.tnl-btnrow-sep { width: 1px; height: 16px; background: var(--border-soft, #8883); margin: 0 4px; flex: none; }
.tnl-btn:focus-visible { outline: 2px solid var(--accent, #4a7dff); outline-offset: 1px; }
.tnl-tk-meta { display: flex; align-items: center; gap: 8px; margin: 0 14px 6px; }
.tnl-tk-meta .tnl-cur { font-size: 11px; }
.tnl-tk-meta .tnl-dim { font-size: 11px; }
/* ─ 审计行 grid 对齐（时间固定宽 + 设备固定宽 + op/detail 流式） ─ */
.tnl-audit .tnl-al { display: flex; align-items: baseline; gap: 8px; padding: 1px 0; }
.tnl-audit .tnl-al .tnl-at { flex: none; min-width: 66px; font-variant-numeric: tabular-nums; }
.tnl-audit .tnl-al .tnl-token { flex: none; min-width: 118px; max-width: 118px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.tnl-audit .tnl-al .tnl-op { flex: none; font-family: var(--mono, ui-monospace, Menlo, monospace); font-size: 11px; }
.tnl-audit .tnl-al .tnl-dim { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* ─ 目录选择器 modal ─ */
.tnl-bm { position: fixed; inset: 0; background: #0009; backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; z-index: 999; }
.tnl-bm-card { width: 440px; max-height: 72vh; display: flex; flex-direction: column; background: var(--bg-elev, #1e1e1e); color: var(--text, #eee); border: 1px solid var(--border, #8884); border-radius: 12px; padding: 0; box-shadow: 0 12px 48px #000a; overflow: hidden; }
.tnl-bm-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border-bottom: 1px solid var(--border-soft, #8883); }
.tnl-bm-path { font-family: var(--mono, monospace); font-size: 11.5px; margin: 10px 14px; padding: 5px 9px; background: var(--bg-elev2, #8881); border-radius: 6px; color: var(--text-dim, #aaa); white-space: nowrap; overflow-x: auto; }
.tnl-bm-list { flex: 1; overflow-y: auto; border-top: 1px solid var(--border-soft, #8882); border-bottom: 1px solid var(--border-soft, #8882); min-height: 180px; }
.tnl-bm-item { padding: 7px 12px; cursor: pointer; font-size: 13px; }
.tnl-bm-item + .tnl-bm-item { border-top: 1px solid var(--border-soft, #8881); }
.tnl-bm-item:hover { background: var(--accent-soft, #8882); }
.tnl-bm-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 14px; }
/* ─ 模型通道：三输入行（v1.2） ─ */
.tnl-in { flex: 1; min-width: 120px; background: var(--bg-elev2, #8881); color: var(--text, inherit); border: 1px solid var(--border, #8884); border-radius: 6px; padding: 4px 8px; font-family: var(--mono, monospace); font-size: 11.5px; }
`;

let lastLanIp = "";
let lastPort = 8765;
let lastToken = "";
let lastDevices = [];

function persistCmd(os) {
	const host = lastLanIp || t("fallbackHost");
	const port = lastPort || 8765;
	const tk = lastToken || t("fallbackToken");
	if (os === "Windows") {
		return [
			'curl.exe -o $env:USERPROFILE\\pi-tunnel-cli.mjs "http://' + host + ":" + port + "/cli?token=" + tk + '"',
			"npm i -g @earendil-works/pi-coding-agent",
			'schtasks /create /tn "pi-tunnel" /tr "node $env:USERPROFILE\\pi-tunnel-cli.mjs" /sc onlogon /f',
			'schtasks /run /tn "pi-tunnel"',
			'echo "' + t("echoWindows") + '"',
		].join("\n");
	}
	if (os === "Linux") {
		return [
			'curl -o ~/pi-tunnel-cli.mjs "http://' + host + ":" + port + "/cli?token=" + tk + '"',
			"npm i -g @earendil-works/pi-coding-agent",
			"mkdir -p ~/.config/systemd/user",
			"cat > ~/.config/systemd/user/pi-tunnel.service <<UNIT",
			"[Unit]",
			"Description=pi-tunnel CLI",
			"[Service]",
			"ExecStart=/usr/bin/env node %h/pi-tunnel-cli.mjs",
			"Restart=always",
			"RestartSec=5",
			"[Install]",
			"WantedBy=default.target",
			"UNIT",
			"systemctl --user daemon-reload",
			"systemctl --user enable --now pi-tunnel",
			'echo "' + t("echoUnix") + '"',
		].join("\n");
	}
	return [
		'curl -o ~/pi-tunnel-cli.mjs "http://' + host + ":" + port + "/cli?token=" + tk + '"',
		"NODE_BIN=$(command -v node)",
		'curl -o ~/pi-agent.tgz "http://' + host + ":" + port + "/pi-pkg?token=" + tk + '"',
		"mkdir -p ~/pi-agent/node_modules && tar xzf ~/pi-agent.tgz -C ~/pi-agent/node_modules && rm -f ~/pi-agent.tgz",
		"mkdir -p ~/Library/LaunchAgents",
		"launchctl bootout gui/$(id -u)/com.pi-tunnel.cli 2>/dev/null",
		"launchctl bootout gui/$(id -u)/com.gxg.pi-tunnel 2>/dev/null",
		"cat > ~/Library/LaunchAgents/com.pi-tunnel.cli.plist <<PLIST",
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		"  <key>Label</key><string>com.pi-tunnel.cli</string>",
		"  <key>ProgramArguments</key>",
		"  <array>",
		"    <string>$NODE_BIN</string>",
		"    <string>$HOME/pi-tunnel-cli.mjs</string>",
		"  </array>",
		"  <key>RunAtLoad</key><true/>",
		"  <key>KeepAlive</key><true/>",
		"  <key>StandardOutPath</key><string>$HOME/pi-tunnel-cli.log</string>",
		"  <key>StandardErrorPath</key><string>$HOME/pi-tunnel-cli.log</string>",
		"</dict>",
		"</plist>",
		"PLIST",
		"launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pi-tunnel.cli.plist",
		'echo "' + t("echoUnix") + '"',
	].join("\n");
}

export default defineView({
	mount(el) {
		const style = document.createElement("style");
		style.textContent = CSS;
		el.appendChild(style);
		const H = [
			'<div class="tnl-wrap">',
			'<div class="tnl-card">',
			`<div class="tnl-row"><span class="tnl-dot" id="tnl-dot"></span><span class="tnl-state" id="tnl-state">${t("reading")}</span>`,
			`<button class="tnl-btn danger" id="tnl-toggle" style="margin-left:auto">${t("stopService")}</button></div>`,
			`<div class="tnl-row" style="margin-top:10px"><span class="tnl-label">${t("conns")}</span><span id="tnl-conns">—</span>`,
			`<span class="tnl-kv" style="margin-left:18px"><span class="tnl-label">${t("ports")}</span><span class="tnl-mono" id="tnl-ports">—</span></span></div>`,
			"</div>",
			'<div class="tnl-card">',
			`<div class="tnl-row"><b>${t("modelChannel")}</b><span class="tnl-dim">${t("modelChannelDesc")}</span>`,
			`<span class="tnl-dim" id="tnl-me-state" style="margin-left:auto;font-size:11.5px">${t("reading")}</span></div>`,
			'<div class="tnl-row" style="margin-top:8px">',
			`<input class="tnl-in" id="tnl-me-base" placeholder="${t("meBasePlaceholder")}" style="flex:2">`,
			'<input class="tnl-in" id="tnl-me-key" type="password" placeholder="apiKey">',
			`<input class="tnl-in" id="tnl-me-model" placeholder="${t("meModelPlaceholder")}" style="flex:1.4">`,
			"</div>",
			'<div class="tnl-row" style="margin-top:6px">',
			`<button class="tnl-btn primary sm" id="tnl-me-save">${t("meSave")}</button>`,
			`<button class="tnl-btn sm" id="tnl-me-clear">${t("meClear")}</button>`,
			'<span class="tnl-dim" style="font-size:11px" id="tnl-me-cands"></span>',
			"</div>",
			"</div>",
			'<div class="tnl-card">',
			`<div class="tnl-row"><b>${t("meshBridge")}</b><span class="tnl-dim">${t("meshDesc")}</span>`,
			`<span class="tnl-dim" id="tnl-mesh-state" style="margin-left:auto;font-size:11.5px">${t("reading")}</span></div>`,
			'<div class="tnl-row" style="margin-top:6px">',
			`<button class="tnl-btn primary sm" id="tnl-mesh-toggle">${t("meshEnable")}</button>`,
			`<button class="tnl-btn sm" id="tnl-mesh-session">${t("meshSession")}</button>`,
			`<button class="tnl-btn sm" id="tnl-mesh-reset" style="color:var(--red-text,var(--red,#ff3b30))">${t("meshReset")}</button>`,
			'<span class="tnl-dim" style="font-size:11px" id="tnl-mesh-info"></span>',
			"</div>",
			"</div>",
			'<div class="tnl-card">',
			`<div class="tnl-row"><b>${t("devices")}</b><span class="tnl-dim">${t("devicesDesc")}</span></div>`,
			`<div id="tnl-devs"><div class="tnl-row tnl-dim">${t("loading")}</div></div>`,
			"</div>",
			'<div class="tnl-card">',
			`<div class="tnl-row"><b>${t("audit")}</b><span class="tnl-dim">${t("auditDesc")}</span></div>`,
			`<div id="tnl-audit" class="tnl-code tnl-audit" style="max-height:190px;overflow-y:auto">${t("loading")}</div>`,
			"</div>",
			'<div class="tnl-card">',
			`<div class="tnl-sec">${t("tokenSection")}</div>`,
			'<div class="tnl-row"><span class="tnl-token" id="tnl-token">—</span>',
			`<button class="tnl-btn danger sm" id="tnl-rotate">${t("rotate")}</button>`,
			`<span class="tnl-dim" style="font-size:11px">${t("rotateHint")}</span></div>`,
			'<hr class="tnl-sep">',
			`<div class="tnl-sec">${t("persistSection")} <span class="tnl-dim" style="font-weight:400;font-size:12px">${t("persistDesc")}</span></div>`,
			'<div class="tnl-row" id="tnl-tabs">',
			'<button class="tnl-btn tab on" data-os="macOS">macOS</button>',
			'<button class="tnl-btn tab" data-os="Windows">Windows</button>',
			'<button class="tnl-btn tab" data-os="Linux">Linux</button>',
			"</div>",
			'<div class="tnl-code" id="tnl-persist"></div>',
			'<div class="tnl-row" style="margin-top:8px">',
			`<button class="tnl-btn primary sm" id="tnl-copy">${t("copyTab")}</button>`,
			`<span class="tnl-copied" id="tnl-copy-ok" style="display:none">${t("copied")}</span>`,
			`<a class="tnl-a" id="tnl-dl" href="/plugins-api/tunnel/cli" download="pi-tunnel-cli.mjs">${t("downloadCli")}</a>`,
			"</div>",
			`<div class="tnl-row tnl-dim" style="font-size:11px;margin-top:8px">${t("aiProbe")}</div>`,
			"</div>",
			'<div class="tnl-bm" id="tnl-bm" style="display:none">',
			'<div class="tnl-bm-card">',
			`<div class="tnl-bm-head"><b>${t("bmTitle")}</b><button class="tnl-btn sm" id="tnl-bm-x">${t("close")}</button></div>`,
			'<div class="tnl-bm-path" id="tnl-bm-path">—</div>',
			`<div class="tnl-bm-list" id="tnl-bm-list">${t("loading")}</div>`,
			'<div class="tnl-bm-foot">',
			`<button class="tnl-btn primary" id="tnl-bm-pick">${t("bmPick")}</button>`,
			"</div>",
			"</div>",
			"</div>",
			'<div class="tnl-bm" id="tnl-hw" style="display:none">',
			'<div class="tnl-bm-card">',
			`<div class="tnl-bm-head"><b>${t("hwTitle")}</b><button class="tnl-btn sm" id="tnl-hw-x">${t("close")}</button></div>`,
			`<pre id="tnl-hw-body" class="tnl-bm-path" style="margin:14px;white-space:pre-wrap;font-size:12.5px;line-height:1.9">${t("loading")}</pre>`,
			"</div>",
			"</div>",
			'<div class="tnl-bm" id="tnl-tk" style="display:none">',
			'<div class="tnl-bm-card" style="width:520px">',
			`<div class="tnl-bm-head"><b>${t("tkTitle")}</b><button class="tnl-btn sm" id="tnl-tk-x">${t("close")}</button></div>`,
			`<textarea id="tnl-tk-prompt" placeholder="${t("tkPlaceholder")}" style="margin:10px 14px 6px;width:calc(100% - 28px);height:64px;background:var(--bg-elev2,#8881);color:var(--text,inherit);border:1px solid var(--border,#8884);border-radius:8px;padding:8px;font-size:12.5px;resize:vertical"></textarea>`,
			`<div class="tnl-row" style="margin:0 14px"><label style="font-size:12px;color:var(--text-dim,#999)"><input type="checkbox" id="tnl-tk-full"> ${t("tkAllowWrite")}</label>`,
			`<button class="tnl-btn primary sm" id="tnl-tk-run" style="margin-left:auto">${t("tkRun")}</button></div>`,
			'<div class="tnl-tk-meta" id="tnl-tk-meta" style="display:none"></div>',
			`<pre id="tnl-tk-out" class="tnl-bm-path" style="margin:0 14px 14px;max-height:260px;overflow-y:auto;white-space:pre-wrap;font-size:11.5px;line-height:1.7">${t("tkResultPlaceholder")}</pre>`,
			"</div>",
			"</div>",
			"</div>",
		].join("\n");
		el.insertAdjacentHTML("beforeend", H);
		const $ = (s) => el.querySelector(s);
		let running = null;
		let curOs = "macOS";

		$("#tnl-tabs").addEventListener("click", (e) => {
			const b = e.target.closest("button.tab");
			if (!b) return;
			curOs = b.dataset.os;
			const tabs = $("#tnl-tabs").querySelectorAll("button.tab");
			for (const x of tabs) x.classList.toggle("on", x === b);
			$("#tnl-persist").textContent = persistCmd(curOs);
		});
		$("#tnl-persist").textContent = persistCmd(curOs);

		$("#tnl-devs").addEventListener("click", async (e) => {
			const b = e.target.closest("button[data-id]");
			if (!b) return;
			if (b.classList.contains("tnl-cfg-save")) {
				const wrap = b.closest(".tnl-cfg");
				const wl = (wrap.querySelector(".tnl-wl").value || "")
					.split(/[\n,，]+/)
					.map((s) => s.trim())
					.filter(Boolean);
				try {
					await fetch("/plugins-api/tunnel/agent/config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id: b.dataset.id, whitelist: wl }),
					});
				} catch {}
				return;
			}
			if (b.classList.contains("tnl-cfg-uninst")) {
				if (!confirm(t("uninstallConfirm"))) return;
				try {
					await fetch("/plugins-api/tunnel/device/uninstall", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id: b.dataset.id }),
					});
				} catch {}
				setTimeout(refresh, 2500);
				return;
			}
			if (b.classList.contains("tnl-cfg-browse")) {
				openBrowse(b.dataset.id);
				return;
			}
			if (b.classList.contains("tnl-cfg-hw")) {
				openHw(b.dataset.id);
				return;
			}
			if (b.classList.contains("tnl-cfg-task")) {
				const dev = (lastDevices || []).find((d) => d.id === b.dataset.id);
				$("#tnl-tk").style.display = "flex";
				$("#tnl-tk-prompt").dataset.id = b.dataset.id;
				const canWrite = !!dev?.caps?.fsWrite;
				const fullBox = $("#tnl-tk-full");
				if (fullBox) {
					fullBox.disabled = !canWrite;
					if (!canWrite) fullBox.checked = false;
					fullBox.title = canWrite ? "" : t("devWriteOff");
				}
				return;
			}
			try {
				await fetch("/plugins-api/tunnel/agent/select", { method: "POST", body: JSON.stringify({ id: b.dataset.id }) });
			} catch {}
			refresh();
		});
		$("#tnl-devs").addEventListener("change", async (e) => {
			const cb = e.target.closest("input[type=checkbox]");
			if (!cb) return;
			const wrap = cb.closest(".tnl-cfg");
			if (!wrap) return;
			const patch = { id: wrap.dataset.id };
			if (cb.classList.contains("tnl-cfg-fsr")) patch.fsRead = cb.checked;
			if (cb.classList.contains("tnl-cfg-fsw")) patch.fsWrite = cb.checked;
			try {
				await fetch("/plugins-api/tunnel/agent/config", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(patch),
				});
			} catch {}
		});

		let browseId = null,
			browseAbs = null,
			browseHome = "/";
		const rel = (p) => (browseHome && p.startsWith(browseHome) ? "~" + p.slice(browseHome.length) : p);
		async function browseTo(p) {
			$("#tnl-bm-list").textContent = t("loading");
			try {
				const r = await fetch("/plugins-api/tunnel/device/fs", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: browseId, path: p }),
				});
				const d = await r.json();
				if (d.error) {
					$("#tnl-bm-list").textContent = d.error;
					return;
				}
				browseAbs = d.path;
				browseHome = d.home || "/";
				$("#tnl-bm-path").textContent = rel(d.path);
				const up = d.path !== d.parent ? ['<div class="tnl-bm-item" data-go="' + esc(d.parent) + '">📁 ..</div>'] : [];
				$("#tnl-bm-list").innerHTML = up
					.concat(
						d.dirs.map(
							(n) =>
								'<div class="tnl-bm-item" data-go="' +
								esc(d.path.replace(/\/$/, "") + "/" + n) +
								'">📁 ' +
								esc(n) +
								"</div>",
						),
					)
					.join("");
				if (!d.dirs.length)
					$("#tnl-bm-list").innerHTML +=
						'<div class="tnl-bm-item" style="color:var(--text-faint,#777)">' + t("bmEmpty") + "</div>";
			} catch {
				$("#tnl-bm-list").textContent = t("browseFailed");
			}
		}
		function openBrowse(id) {
			browseId = id;
			browseAbs = null;
			$("#tnl-bm").style.display = "flex";
			browseTo("~");
		}
		async function openHw(id) {
			$("#tnl-hw").style.display = "flex";
			$("#tnl-hw-body").textContent = t("loading");
			try {
				const r = await fetch("/plugins-api/tunnel/device/hw", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id }),
				});
				const d = await r.json();
				if (d.error) {
					$("#tnl-hw-body").textContent = d.error;
					return;
				}
				$("#tnl-hw-body").textContent = [
					hwLine(t("hwModel"), d.model || "—"),
					hwLine(t("hwOs"), (d.osv || "—") + " (" + d.arch + ")"),
					hwLine(t("hwCpu"), (d.cpu || "—") + " × " + d.cores),
					hwLine(t("hwMem"), d.memGB + " GB"),
					hwLine(t("hwDisk"), d.disk || "—"),
					hwLine(t("hwUptime"), t("hwHours", { n: d.uptimeH })),
					hwLine(t("hwLoad"), (d.load || []).join(" / ")),
				].join("\n");
			} catch {
				$("#tnl-hw-body").textContent = t("hwFailed");
			}
		}
		$("#tnl-hw-x").onclick = () => {
			$("#tnl-hw").style.display = "none";
		};
		$("#tnl-hw").addEventListener("click", (e) => {
			if (e.target.id === "tnl-hw") $("#tnl-hw").style.display = "none";
		});
		$("#tnl-tk-x").onclick = () => {
			$("#tnl-tk").style.display = "none";
		};
		$("#tnl-tk").addEventListener("click", (e) => {
			if (e.target.id === "tnl-tk") $("#tnl-tk").style.display = "none";
		});
		$("#tnl-tk-run").onclick = async () => {
			const id = $("#tnl-tk-prompt").dataset.id;
			const prompt = $("#tnl-tk-prompt").value.trim();
			if (!id || !prompt) {
				$("#tnl-tk-out").textContent = t("tkNoPrompt");
				return;
			}
			const full = $("#tnl-tk-full").checked;
			$("#tnl-tk-run").disabled = true;
			$("#tnl-tk-out").textContent = t("tkRunning");
			try {
				const r = await fetch("/plugins-api/tunnel/device/task", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id, prompt, tools: full ? "read,grep,glob,bash,edit,write" : "read,grep,glob" }),
				});
				const d = await r.json();
				if (d.error) {
					$("#tnl-tk-meta").style.display = "none";
					$("#tnl-tk-out").textContent = "✗ " + d.error;
				} else {
					let text = "";
					try {
						for (const line of String(d.output || "").split("\n")) {
							if (!line.trim()) continue;
							const ev = JSON.parse(line);
							const msg = ev.message ?? ev;
							if ((msg.role === "assistant" || ev.type === "message_end") && msg.content) {
								const c = Array.isArray(msg.content)
									? msg.content.map((p) => p.text || "").join("")
									: String(msg.content);
								if (c.trim()) text = c;
							}
						}
					} catch {}
					const secs = Math.round((d.ms || 0) / 1000);
					$("#tnl-tk-meta").style.display = "flex";
					$("#tnl-tk-meta").innerHTML =
						'<span class="tnl-cur">' +
						t("tkDone") +
						'</span><span class="tnl-dim">' +
						t("tkMeta", { secs }) +
						"</span>";
					$("#tnl-tk-out").textContent = text || String(d.output || "").slice(-3000) || t("tkNoOutput");
				}
			} catch {
				$("#tnl-tk-out").textContent = t("tkRequestFailed");
			}
			$("#tnl-tk-run").disabled = false;
		};
		$("#tnl-bm-x").onclick = () => {
			$("#tnl-bm").style.display = "none";
		};
		$("#tnl-bm").addEventListener("click", (e) => {
			if (e.target.id === "tnl-bm") $("#tnl-bm").style.display = "none";
		});
		$("#tnl-bm-list").addEventListener("click", (e) => {
			const it = e.target.closest(".tnl-bm-item[data-go]");
			if (it) browseTo(it.dataset.go);
		});
		$("#tnl-bm-pick").onclick = () => {
			if (!browseAbs) return;
			const row = document.querySelector('.tnl-cfg[data-id="' + browseId + '"]');
			if (!row) return;
			const inp = row.querySelector(".tnl-wl");
			const cur = (inp.value || "")
				.split(/[\n,，]+/)
				.map((s) => s.trim())
				.filter(Boolean);
			const p = rel(browseAbs) || "~";
			if (!cur.includes(p)) cur.push(p);
			inp.value = cur.join(", ");
			$("#tnl-bm").style.display = "none";
		};

		async function loadAudit() {
			try {
				const r = await fetch("/plugins-api/tunnel/audit");
				const d = await r.json();
				const items = d.items ?? [];
				$("#tnl-audit").innerHTML = items.length
					? items
							.map(
								(it) =>
									'<div class="tnl-al"><span class="tnl-at">' +
									new Date(it.ts).toLocaleTimeString() +
									'</span><span class="tnl-token">' +
									esc(it.device) +
									'</span><span class="tnl-op">' +
									esc(it.op) +
									"</span>" +
									(it.detail ? '<span class="tnl-dim">' + esc(String(it.detail).slice(0, 80)) + "</span>" : "") +
									"</div>",
							)
							.join("")
					: t("auditEmpty");
			} catch {}
		}
		loadAudit();
		const auditTimer = setInterval(loadAudit, 10000);

		function renderDevs(d) {
			const dv = $("#tnl-devs");
			const list = d.devices ?? [];
			if (!list.length) {
				dv.innerHTML = '<div class="tnl-dim" style="padding:10px 8px;font-size:12px">' + t("devicesEmpty") + "</div>";
				return;
			}
			dv.innerHTML = list
				.map((x) => {
					const dot = '<span class="tnl-dot ' + (x.online ? "ok" : "") + '"></span>';
					const nm = '<span class="tnl-name">' + esc(x.name) + "</span>";
					const osf = '<span class="tnl-os">' + esc(x.os || "—") + "</span>";
					const ver = x.ver ? '<span class="tnl-ver">v ' + esc(x.ver) + "</span>" : "";
					const stale =
						x.online && !x.ver
							? '<span class="tnl-os" style="color:var(--red-text,var(--red,#d33))">' + t("devCliOutdated") + "</span>"
							: "";
					let tag;
					if (x.id === d.activeAgentId) tag = '<span class="tnl-cur">' + t("devCurrent") + "</span>";
					else if (x.online)
						tag = '<button class="tnl-btn sm" data-id="' + esc(x.id) + '">' + t("devSetCurrent") + "</button>";
					else tag = '<span class="tnl-dim" style="font-size:11px">' + t("devReconnecting") + "</span>";
					const caps = x.caps ?? {};
					const cfgRow = x.online
						? [
								'<div class="tnl-cfg" data-id="' + esc(x.id) + '">',
								'<label><input type="checkbox" class="tnl-cfg-fsr" ' +
									(caps.fsRead ? "checked" : "") +
									"> " +
									t("devFsRead") +
									"</label>",
								'<label><input type="checkbox" class="tnl-cfg-fsw" ' +
									(caps.fsWrite ? "checked" : "") +
									"> " +
									t("devFsWrite") +
									"</label>",
								'<input class="tnl-wl" value="' +
									esc((caps.whitelist ?? []).join(", ")) +
									'" placeholder="' +
									t("devWhitelist") +
									'">',
								'<span class="tnl-btnrow">',
								'<button class="tnl-btn sm tnl-cfg-task" data-id="' + esc(x.id) + '">' + t("devTask") + "</button>",
								'<button class="tnl-btn sm tnl-cfg-hw" data-id="' + esc(x.id) + '">' + t("devHw") + "</button>",
								'<button class="tnl-btn sm tnl-cfg-browse" data-id="' + esc(x.id) + '">' + t("devBrowse") + "</button>",
								'<span class="tnl-btnrow-sep"></span>',
								'<button class="tnl-btn sm primary tnl-cfg-save" data-id="' +
									esc(x.id) +
									'">' +
									t("devSave") +
									"</button>",
								'<button class="tnl-btn sm danger tnl-cfg-uninst" data-id="' +
									esc(x.id) +
									'">' +
									t("devUninstall") +
									"</button>",
								"</span>",
								"</div>",
							].join("")
						: "";
					return (
						'<div class="tnl-dev' +
						(x.online ? "" : " off") +
						'">' +
						dot +
						nm +
						osf +
						ver +
						stale +
						tag +
						"</div>" +
						cfgRow
					);
				})
				.join("");
		}

		async function refresh() {
			try {
				const r = await fetch("/plugins-api/tunnel/status");
				const d = await r.json();
				running = d.running;
				const dot = $("#tnl-dot"),
					st = $("#tnl-state"),
					btn = $("#tnl-toggle");
				const act = (d.devices ?? []).find((x) => x.id === d.activeAgentId);
				dot.className = "tnl-dot " + (d.agentOnline ? "ok" : d.running ? "bad" : "");
				st.textContent = d.agentOnline
					? t("tunnelOnline", { name: act ? act.name : "" })
					: d.running
						? t("serviceWaiting")
						: t("serviceStopped");
				btn.textContent = d.running ? t("stopService") : t("startService");
				btn.className = "tnl-btn " + (d.running ? "danger" : "primary");
				$("#tnl-conns").textContent = t("connsSummary", { active: d.activeConns, total: d.totalServed });
				if (d.tokenRedacted) {
					$("#tnl-token").textContent = d.tokenPrefix + t("tokenRedactedSuffix");
					$("#tnl-token").title = t("tokenRedactedHint");
				} else {
					$("#tnl-token").textContent = d.tokenPrefix;
					$("#tnl-token").title = "";
				}
				$("#tnl-ports").textContent = "WS :" + d.wsPort + " · SOCKS5 127.0.0.1:" + d.socksPort;
				lastLanIp = d.lanIp || "";
				lastPort = d.wsPort || 8765;
				lastToken = d.token || "";
				lastDevices = d.devices || [];
				$("#tnl-persist").textContent = persistCmd(curOs);
				renderDevs(d);
			} catch {
				$("#tnl-state").textContent = t("statusReadFailedInactive");
			}
		}
		async function refreshMe() {
			try {
				const r = await fetch("/plugins-api/tunnel/modelenv");
				const d = await r.json();
				const st = $("#tnl-me-state");
				if (d.resolved) {
					const src =
						d.resolved.source === "manual"
							? t("meSourceManual")
							: d.resolved.source === "override"
								? t("meSourceOverride")
								: t("meSourceAuto");
					st.textContent = t("meResolved", {
						source: src,
						model: d.resolved.model,
						tail: d.resolved.keyTail || "—",
					});
					st.style.color = "";
				} else {
					st.textContent = d.resolveError ? t("meUnresolvedWithReason", { reason: d.resolveError }) : t("meUnresolved");
					st.style.color = "var(--red-text,var(--red,#ff3b30))";
				}
				if (d.manual) {
					$("#tnl-me-base").value = d.manual.baseUrl;
					$("#tnl-me-model").value = d.manual.model;
				}
				const cands = (d.candidates || [])
					.filter((c) => c.api === "openai-completions" && c.hasKey)
					.map((c) => t("meCandidateItem", { provider: c.provider, model: c.models[0] || "" }))
					.join(" · ");
				$("#tnl-me-cands").textContent = cands ? t("meCandidates", { list: cands }) : t("meCandidatesNone");
			} catch {
				$("#tnl-me-state").textContent = t("statusReadFailed");
			}
		}
		$("#tnl-me-save").onclick = async () => {
			const body = {
				baseUrl: $("#tnl-me-base").value.trim(),
				apiKey: $("#tnl-me-key").value.trim(),
				model: $("#tnl-me-model").value.trim(),
			};
			try {
				const r = await fetch("/plugins-api/tunnel/modelenv", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
				const d = await r.json();
				if (!d.ok) {
					alert(t("saveFailed", { error: d.error || t("unknownError") }));
					return;
				}
				$("#tnl-me-key").value = "";
				refreshMe();
			} catch {
				alert(t("saveFailedNetwork"));
			}
		};
		$("#tnl-me-clear").onclick = async () => {
			try {
				await fetch("/plugins-api/tunnel/modelenv", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ clear: true }),
				});
				refreshMe();
			} catch {}
		};
		async function refreshMesh() {
			try {
				const r = await fetch("/plugins-api/tunnel/mesh");
				const d = await r.json();
				const st = $("#tnl-mesh-state");
				const btn = $("#tnl-mesh-toggle");
				if (d.enabled) {
					const agent = d.agentName || "—";
					const note = d.running ? "" : t("meshNotRunning");
					st.textContent = d.device
						? t("meshOnDevice", { agent, device: d.device, note })
						: t("meshOn", { agent, note });
					st.style.color = d.running ? "" : "var(--red-text,var(--red,#ff3b30))";
					btn.textContent = t("meshDisable");
				} else {
					st.textContent = t("meshOff");
					st.style.color = "";
					btn.textContent = t("meshEnable");
				}
				$("#tnl-mesh-info").textContent =
					d.queue || d.pending ? t("meshQueue", { queue: d.queue, pending: d.pending }) : "";
			} catch {
				$("#tnl-mesh-state").textContent = t("statusReadFailed");
			}
		}
		$("#tnl-mesh-toggle").onclick = async () => {
			try {
				const r = await fetch("/plugins-api/tunnel/mesh");
				const cur = (await r.json()).enabled;
				await fetch("/plugins-api/tunnel/mesh", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ enabled: !cur }),
				});
				refreshMesh();
			} catch {
				alert(t("meshToggleFailed"));
			}
		};
		$("#tnl-mesh-session").onclick = async () => {
			try {
				const r = await fetch("/plugins-api/tunnel/mesh/session");
				const d = await r.json();
				if (d.ok) {
					const s = d.session;
					const detail = s.exists
						? t("meshSessionDetail", {
								id: s.sessionId,
								updated: s.updatedAt,
								size: (s.size / 1024).toFixed(1),
							})
						: t("meshSessionNone");
					alert(t("meshSessionInfo", { detail }));
				} else alert(t("readFailed", { error: d.error || t("unknownError") }));
			} catch {
				alert(t("readFailedNetwork"));
			}
		};
		$("#tnl-mesh-reset").onclick = async () => {
			if (!confirm(t("meshResetConfirm"))) return;
			try {
				const r = await fetch("/plugins-api/tunnel/mesh/reset", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
				const d = await r.json();
				alert(
					d.ok
						? t("meshResetDone", { id: d.removed || t("none") })
						: t("meshResetFailed", { error: d.error || t("unknownError") }),
				);
			} catch {
				alert(t("meshResetFailedNetwork"));
			}
		};
		refreshMesh();
		refreshMe();
		refresh();
		const timer = setInterval(refresh, 3000);
		// 宿主全局语言单源：首帧 t() 已按 locale.current() 取词，切语言后重渲染
		let offLocale = null;
		let onLocaleEvent = null;
		try {
			offLocale =
				window.__piWebUiHost?.locale?.onChange?.(() => {
					try {
						refresh();
					} catch {}
				}) ?? null;
		} catch {
			offLocale = null;
		}
		try {
			onLocaleEvent = () => {
				try {
					refresh();
				} catch {}
			};
			window.addEventListener("pi-web-ui:locale", onLocaleEvent);
		} catch {
			onLocaleEvent = null;
		}

		$("#tnl-toggle").onclick = async () => {
			const ep = running ? "/plugins-api/tunnel/stop" : "/plugins-api/tunnel/start";
			try {
				await fetch(ep, { method: "POST" });
			} catch {}
			refresh();
		};
		$("#tnl-rotate").onclick = async () => {
			if (!confirm(t("rotateConfirm"))) return;
			try {
				await fetch("/plugins-api/tunnel/rotate", { method: "POST" });
			} catch {}
			refresh();
		};
		$("#tnl-copy").onclick = async () => {
			try {
				await navigator.clipboard.writeText(persistCmd(curOs));
				const ok = $("#tnl-copy-ok");
				ok.style.display = "inline";
				setTimeout(() => {
					ok.style.display = "none";
				}, 2000);
			} catch {
				const ok = $("#tnl-copy-ok");
				ok.textContent = t("copyFailed");
				ok.style.color = "var(--red-text, var(--red, #ff3b30))";
				ok.style.display = "inline";
				setTimeout(() => {
					ok.style.display = "none";
					ok.textContent = t("copied");
					ok.style.color = "";
				}, 2600);
			}
		};

		return () => {
			clearInterval(timer);
			clearInterval(auditTimer);
			try {
				offLocale?.();
			} catch {}
			try {
				if (onLocaleEvent) window.removeEventListener("pi-web-ui:locale", onLocaleEvent);
			} catch {}
		};
	},
});
