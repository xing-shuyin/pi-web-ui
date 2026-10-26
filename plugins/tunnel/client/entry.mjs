/**
 * pi-tunnel 插件面板 —— 隧道状态(三态) / 出口设备管理(多设备) / 服务启停 / 令牌 / 三平台常驻化。
 * 数据源：GET /plugins-api/tunnel/status（3s 轮询）；操作：POST start/stop/rotate/agent/select。
 * 可重入：mount 返回清理函数，plugins_reload 后由宿主重新 mount。
 * HTML 拼接用字符串相加而非嵌套模板串（20261019 嵌套模板曾触发 V8 解析错，规避）。
 */
import { defineView, esc } from "./sdk/index.mjs";

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

let lastLanIp = ""; // 由 status 轮询填充；无内网 IP 时命令里用占位符提示替换
let lastPort = 8765;
let lastToken = ""; // tunnel 令牌（snapshot 完整下发）：persistCmd 下载 /cli 时作鉴权参数
let lastDevices = [];

/** 三平台常驻安装命令（CLI 已在用户主目录：~/pi-tunnel-cli.mjs / %USERPROFILE%\pi-tunnel-cli.mjs）。 */
function persistCmd(os) {
	const host = lastLanIp || "<mini内网IP>";
	const port = lastPort || 8765;
	const tk = lastToken || "<tunnel令牌>"; // /cli 已鉴权（tnlAuthed），下载必须带 token
	if (os === "Windows") {
		return [
			'curl.exe -o $env:USERPROFILE\\pi-tunnel-cli.mjs "http://' + host + ":" + port + "/cli?token=" + tk + '"',
			"npm i -g @earendil-works/pi-coding-agent",
			'schtasks /create /tn "pi-tunnel" /tr "node $env:USERPROFILE\\pi-tunnel-cli.mjs" /sc onlogon /f',
			'schtasks /run /tn "pi-tunnel"',
			"echo 常驻已装：登录自启，CLI 内置 5s 掉线重连；pi agent 已就绪（首次用需 pi auth 配模型）",
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
			"echo 常驻已装：开机自启+掉线自愈",
		].join("\n");
	}
	// macOS（默认）
	return [
		'curl -o ~/pi-tunnel-cli.mjs "http://' + host + ":" + port + "/cli?token=" + tk + '"',
		"NODE_BIN=$(command -v node)",
		'curl -o ~/pi-agent.tgz "http://' + host + ":" + port + "/pi-pkg?token=" + tk + '"',
		"mkdir -p ~/pi-agent/node_modules && tar xzf ~/pi-agent.tgz -C ~/pi-agent/node_modules && rm -f ~/pi-agent.tgz",
		"mkdir -p ~/Library/LaunchAgents",
		"launchctl bootout gui/$(id -u)/com.pi-tunnel.cli 2>/dev/null",
		"launchctl bootout gui/$(id -u)/com.gxg.pi-tunnel 2>/dev/null", // 历史版本 label，重装时一并卸掉防双服务并存
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
		"  <key>StandardErrorPath</key><string>$HOME/pi-tunnel-cli.log</string>", // launchd 不展开 %h（78 EX_CONFIG 实锤），heredoc 里 $HOME 会展开成绝对路径
		"</dict>",
		"</plist>",
		"PLIST",
		"launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pi-tunnel.cli.plist",
		"echo 常驻已装：开机自启+掉线自愈",
	].join("\n");
}

export default defineView({
	mount(el) {
		const style = document.createElement("style");
		style.textContent = CSS;
		el.appendChild(style);
		const H = [
			'<div class="tnl-wrap">',
			// 状态仪表卡
			'<div class="tnl-card">',
			'<div class="tnl-row"><span class="tnl-dot" id="tnl-dot"></span><span class="tnl-state" id="tnl-state">读取中…</span>',
			'<button class="tnl-btn danger" id="tnl-toggle" style="margin-left:auto">停止服务</button></div>',
			'<div class="tnl-row" style="margin-top:10px"><span class="tnl-label">连接数</span><span id="tnl-conns">—</span>',
			'<span class="tnl-kv" style="margin-left:18px"><span class="tnl-label">端口</span><span class="tnl-mono" id="tnl-ports">—</span></span></div>',
			"</div>",
			// 模型通道（v1.2：指挥设备 pi agent 用哪条模型通道）
			'<div class="tnl-card">',
			'<div class="tnl-row"><b>模型通道</b><span class="tnl-dim">指挥设备 pi agent 用的模型；手动指定优先于自动挑选</span>',
			'<span class="tnl-dim" id="tnl-me-state" style="margin-left:auto;font-size:11.5px">读取中…</span></div>',
			'<div class="tnl-row" style="margin-top:8px">',
			'<input class="tnl-in" id="tnl-me-base" placeholder="baseUrl（http://…/v1）" style="flex:2">',
			'<input class="tnl-in" id="tnl-me-key" type="password" placeholder="apiKey">',
			'<input class="tnl-in" id="tnl-me-model" placeholder="model（provider/模型ID）" style="flex:1.4">',
			"</div>",
			'<div class="tnl-row" style="margin-top:6px">',
			'<button class="tnl-btn primary sm" id="tnl-me-save">保存手动指定</button>',
			'<button class="tnl-btn sm" id="tnl-me-clear">恢复自动</button>',
			'<span class="tnl-dim" style="font-size:11px" id="tnl-me-cands"></span>',
			"</div>",
			"</div>",
			// Mesh 桥（P3a：设备 pi agent 接入 pi_messenger）
			'<div class="tnl-card">',
			'<div class="tnl-row"><b>Mesh 桥</b><span class="tnl-dim">把设备 pi agent 接入 pi_messenger，任意会话可 send 直达</span>',
			'<span class="tnl-dim" id="tnl-mesh-state" style="margin-left:auto;font-size:11.5px">读取中…</span></div>',
			'<div class="tnl-row" style="margin-top:6px">',
			'<button class="tnl-btn primary sm" id="tnl-mesh-toggle">开启 Mesh 桥</button>',
			'<button class="tnl-btn sm" id="tnl-mesh-session">会话</button>',
			'<button class="tnl-btn sm" id="tnl-mesh-reset" style="color:var(--red-text,var(--red,#ff3b30))">重置会话</button>',
			'<span class="tnl-dim" style="font-size:11px" id="tnl-mesh-info"></span>',
			"</div>",
			"</div>",
			// 出口设备
			'<div class="tnl-card">',
			'<div class="tnl-row"><b>出口设备</b><span class="tnl-dim">SOCKS 流量走选中的设备；出口掉线自动切换</span></div>',
			'<div id="tnl-devs"><div class="tnl-row tnl-dim">加载中…</div></div>',
			"</div>",
			// 审计
			'<div class="tnl-card">',
			'<div class="tnl-row"><b>操作审计（最近 100 条）</b><span class="tnl-dim">设备侧文件/目录枚举操作记录</span></div>',
			'<div id="tnl-audit" class="tnl-code tnl-audit" style="max-height:190px;overflow-y:auto">加载中…</div>',
			"</div>",
			// 接入与部署（令牌 + 常驻化合并）
			'<div class="tnl-card">',
			'<div class="tnl-sec">接入令牌</div>',
			'<div class="tnl-row"><span class="tnl-token" id="tnl-token">—</span>',
			'<button class="tnl-btn danger sm" id="tnl-rotate">重置令牌</button>',
			'<span class="tnl-dim" style="font-size:11px">重置后所有已分发 CLI 将无法重连，需重新下载</span></div>',
			'<hr class="tnl-sep">',
			'<div class="tnl-sec">设备常驻化 <span class="tnl-dim" style="font-weight:400;font-size:12px">一次性安装，装完不开终端；按设备系统选页签</span></div>',
			'<div class="tnl-row" id="tnl-tabs">',
			'<button class="tnl-btn tab on" data-os="macOS">macOS</button>',
			'<button class="tnl-btn tab" data-os="Windows">Windows</button>',
			'<button class="tnl-btn tab" data-os="Linux">Linux</button>',
			"</div>",
			'<div class="tnl-code" id="tnl-persist"></div>',
			'<div class="tnl-row" style="margin-top:8px">',
			'<button class="tnl-btn primary sm" id="tnl-copy">复制当前页签命令</button>',
			'<span class="tnl-copied" id="tnl-copy-ok" style="display:none">已复制</span>',
			'<a class="tnl-a" id="tnl-dl" href="/plugins-api/tunnel/cli" download="pi-tunnel-cli.mjs">下载 CLI（已注入令牌）</a>',
			"</div>",
			'<div class="tnl-row tnl-dim" style="font-size:11px;margin-top:8px">AI 侧探测： curl --socks5-hostname 127.0.0.1:1080 &lt;url&gt;</div>',
			"</div>",
			// P4: 目录选择器 modal（默认隐藏）
			'<div class="tnl-bm" id="tnl-bm" style="display:none">',
			'<div class="tnl-bm-card">',
			'<div class="tnl-bm-head"><b>选择白名单目录</b><button class="tnl-btn sm" id="tnl-bm-x">关闭</button></div>',
			'<div class="tnl-bm-path" id="tnl-bm-path">—</div>',
			'<div class="tnl-bm-list" id="tnl-bm-list">加载中…</div>',
			'<div class="tnl-bm-foot">',
			'<button class="tnl-btn primary" id="tnl-bm-pick">选择此目录</button>',
			"</div>",
			"</div>",
			"</div>",
			// P4+: 硬件概览 modal（默认隐藏）
			'<div class="tnl-bm" id="tnl-hw" style="display:none">',
			'<div class="tnl-bm-card">',
			'<div class="tnl-bm-head"><b>硬件概览</b><button class="tnl-btn sm" id="tnl-hw-x">关闭</button></div>',
			'<pre id="tnl-hw-body" class="tnl-bm-path" style="margin:14px;white-space:pre-wrap;font-size:12.5px;line-height:1.9">加载中…</pre>',
			"</div>",
			"</div>",
			// P4-B: pi agent 任务 modal（默认隐藏）
			'<div class="tnl-bm" id="tnl-tk" style="display:none">',
			'<div class="tnl-bm-card" style="width:520px">',
			'<div class="tnl-bm-head"><b>指挥设备 pi agent</b><button class="tnl-btn sm" id="tnl-tk-x">关闭</button></div>',
			'<textarea id="tnl-tk-prompt" placeholder="任务描述（如：列出 Downloads 下大于 100MB 的文件）" style="margin:10px 14px 6px;width:calc(100% - 28px);height:64px;background:var(--bg-elev2,#8881);color:var(--text,inherit);border:1px solid var(--border,#8884);border-radius:8px;padding:8px;font-size:12.5px;resize:vertical"></textarea>',
			'<div class="tnl-row" style="margin:0 14px"><label style="font-size:12px;color:var(--text-dim,#999)"><input type="checkbox" id="tnl-tk-full"> 允许写入/执行（bash/edit/write，默认只读）</label>',
			'<button class="tnl-btn primary sm" id="tnl-tk-run" style="margin-left:auto">执行任务</button></div>',
			'<div class="tnl-tk-meta" id="tnl-tk-meta" style="display:none"></div>',
			'<pre id="tnl-tk-out" class="tnl-bm-path" style="margin:0 14px 14px;max-height:260px;overflow-y:auto;white-space:pre-wrap;font-size:11.5px;line-height:1.7">（结果将显示在这里）</pre>',
			"</div>",
			"</div>",
			"</div>",
		].join("\n");
		el.insertAdjacentHTML("beforeend", H);
		const $ = (s) => el.querySelector(s);
		let running = null;
		let curOs = "macOS";

		// 页签切换
		$("#tnl-tabs").addEventListener("click", (e) => {
			const b = e.target.closest("button.tab");
			if (!b) return;
			curOs = b.dataset.os;
			const tabs = $("#tnl-tabs").querySelectorAll("button.tab");
			for (const x of tabs) x.classList.toggle("on", x === b);
			$("#tnl-persist").textContent = persistCmd(curOs);
		});
		$("#tnl-persist").textContent = persistCmd(curOs);

		// 出口切换 + 设备配置保存（事件委托）
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
				// P4: 卸载该设备 CLI（停常驻+删文件）
				if (!confirm("确定卸载该设备上的隧道 CLI？\n将停止常驻服务并删除 CLI 文件，设备将从列表消失。")) return;
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
				// P4: 打开目录选择器
				openBrowse(b.dataset.id);
				return;
			}
			if (b.classList.contains("tnl-cfg-hw")) {
				// P4+: 打开硬件概览
				openHw(b.dataset.id);
				return;
			}
			if (b.classList.contains("tnl-cfg-task")) {
				// P4-B: 打开任务面板（受设备能力模型约束）
				const dev = (lastDevices || []).find((d) => d.id === b.dataset.id);
				$("#tnl-tk").style.display = "flex";
				$("#tnl-tk-prompt").dataset.id = b.dataset.id;
				const canWrite = !!dev?.caps?.fsWrite;
				const fullBox = $("#tnl-tk-full");
				if (fullBox) {
					fullBox.disabled = !canWrite;
					if (!canWrite) fullBox.checked = false;
					fullBox.title = canWrite ? "" : "设备未开启写权限（可在能力设置中开启）";
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

		// ── P4: 目录选择器（经隧道逐级浏览设备目录，选中后追加到白名单输入框） ─────────
		let browseId = null,
			browseAbs = null,
			browseHome = "/";
		const rel = (p) => (browseHome && p.startsWith(browseHome) ? "~" + p.slice(browseHome.length) : p); // 绝对路径→~/显示
		async function browseTo(p) {
			$("#tnl-bm-list").textContent = "加载中…";
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
					$("#tnl-bm-list").innerHTML += '<div class="tnl-bm-item" style="color:var(--text-faint,#777)">无子目录</div>';
			} catch {
				$("#tnl-bm-list").textContent = "浏览失败";
			}
		}
		function openBrowse(id) {
			browseId = id;
			browseAbs = null;
			$("#tnl-bm").style.display = "flex";
			browseTo("~");
		}
		// ── P4+: 硬件概览 ─────────
		async function openHw(id) {
			$("#tnl-hw").style.display = "flex";
			$("#tnl-hw-body").textContent = "加载中…";
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
					"型号     " + (d.model || "—"),
					"系统     " + (d.osv || "—") + " (" + d.arch + ")",
					"CPU      " + (d.cpu || "—") + " × " + d.cores,
					"内存     " + d.memGB + " GB",
					"根分区   " + (d.disk || "—"),
					"运行时长 " + d.uptimeH + " 小时",
					"负载     " + (d.load || []).join(" / "),
				].join("\n");
			} catch {
				$("#tnl-hw-body").textContent = "查询失败";
			}
		}
		$("#tnl-hw-x").onclick = () => {
			$("#tnl-hw").style.display = "none";
		};
		$("#tnl-hw").addEventListener("click", (e) => {
			if (e.target.id === "tnl-hw") $("#tnl-hw").style.display = "none";
		});
		// ── P4-B: 任务面板 ─────────
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
				$("#tnl-tk-out").textContent = "请先填写任务描述";
				return;
			}
			const full = $("#tnl-tk-full").checked;
			$("#tnl-tk-run").disabled = true;
			$("#tnl-tk-out").textContent = "任务执行中（设备端 pi agent，最长 5 分钟）…";
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
					// pi --mode json 输出 NDJSON 事件流：提取最后的 assistant 文本，回退原样
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
						'<span class="tnl-cur">✓ 完成</span><span class="tnl-dim">设备端 pi agent · 耗时 ' + secs + "s</span>";
					$("#tnl-tk-out").textContent = text || String(d.output || "").slice(-3000) || "（无输出）";
				}
			} catch {
				$("#tnl-tk-out").textContent = "✗ 请求失败";
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
			// 追加到对应设备的白名单输入框（去重）
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
					: "暂无操作记录";
			} catch {
				/* 审计拉取失败静默 */
			}
		}
		loadAudit();
		const auditTimer = setInterval(loadAudit, 10000);

		function renderDevs(d) {
			const dv = $("#tnl-devs");
			const list = d.devices ?? [];
			if (!list.length) {
				dv.innerHTML =
					'<div class="tnl-dim" style="padding:10px 8px;font-size:12px">暂无设备连入 —— 在主人设备上运行 CLI 后出现在这里</div>';
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
							? '<span class="tnl-os" style="color:var(--red-text,var(--red,#d33))">CLI 需更新</span>'
							: "";
					let tag;
					if (x.id === d.activeAgentId) tag = '<span class="tnl-cur">当前出口</span>';
					else if (x.online) tag = '<button class="tnl-btn sm" data-id="' + esc(x.id) + '">设为出口</button>';
					else tag = '<span class="tnl-dim" style="font-size:11px">重连中</span>';
					const caps = x.caps ?? {};
					const cfgRow = x.online
						? [
								'<div class="tnl-cfg" data-id="' + esc(x.id) + '">',
								'<label><input type="checkbox" class="tnl-cfg-fsr" ' +
									(caps.fsRead ? "checked" : "") +
									"> 文件读</label>",
								'<label><input type="checkbox" class="tnl-cfg-fsw" ' +
									(caps.fsWrite ? "checked" : "") +
									"> 文件写</label>",
								'<input class="tnl-wl" value="' +
									esc((caps.whitelist ?? []).join(", ")) +
									'" placeholder="白名单目录（逗号分隔）">',
								'<span class="tnl-btnrow">',
								'<button class="tnl-btn sm tnl-cfg-task" data-id="' + esc(x.id) + '">任务</button>',
								'<button class="tnl-btn sm tnl-cfg-hw" data-id="' + esc(x.id) + '">硬件</button>',
								'<button class="tnl-btn sm tnl-cfg-browse" data-id="' + esc(x.id) + '">浏览…</button>',
								'<span class="tnl-btnrow-sep"></span>',
								'<button class="tnl-btn sm primary tnl-cfg-save" data-id="' + esc(x.id) + '">保存配置</button>',
								'<button class="tnl-btn sm danger tnl-cfg-uninst" data-id="' + esc(x.id) + '">卸载</button>',
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
					? "隧道在线 · 出口 " + (act ? act.name : "")
					: d.running
						? "服务运行 · 等待设备连入"
						: "服务已停止";
				btn.textContent = d.running ? "停止服务" : "启动服务";
				btn.className = "tnl-btn " + (d.running ? "danger" : "primary");
				$("#tnl-conns").textContent = "活跃 " + d.activeConns + " · 累计 " + d.totalServed;
				if (d.tokenRedacted) {
					$("#tnl-token").textContent = d.tokenPrefix + " (脱敏)";
					$("#tnl-token").title = "宿主未设 PI_WEB_TOKEN，公网下已脱敏保护；设置口令后解锁";
				} else {
					$("#tnl-token").textContent = d.tokenPrefix;
					$("#tnl-token").title = "";
				}
				$("#tnl-ports").textContent = "WS :" + d.wsPort + " · SOCKS5 127.0.0.1:" + d.socksPort;
				lastLanIp = d.lanIp || "";
				lastPort = d.wsPort || 8765;
				lastToken = d.token || "";
				lastDevices = d.devices || [];
				$("#tnl-persist").textContent = persistCmd(curOs); // lanIp/port 到位后刷新命令
				renderDevs(d);
			} catch {
				$("#tnl-state").textContent = "状态读取失败（插件未激活？）";
			}
		}
		// ── 模型通道（v1.2）：状态 + 手动指定/恢复自动 ──────────────────────
		async function refreshMe() {
			try {
				const r = await fetch("/plugins-api/tunnel/modelenv");
				const d = await r.json();
				const st = $("#tnl-me-state");
				if (d.resolved) {
					const src =
						d.resolved.source === "manual" ? "手动指定" : d.resolved.source === "override" ? "请求指定" : "自动挑选";
					st.textContent = "生效：" + src + " · " + d.resolved.model + " · key…" + (d.resolved.keyTail || "—");
					st.style.color = "";
				} else {
					st.textContent = "未解析" + (d.resolveError ? "：" + d.resolveError : "") + "——请手动指定";
					st.style.color = "var(--red-text,var(--red,#ff3b30))";
				}
				if (d.manual) {
					$("#tnl-me-base").value = d.manual.baseUrl;
					$("#tnl-me-model").value = d.manual.model;
				}
				const cands = (d.candidates || [])
					.filter((c) => c.api === "openai-completions" && c.hasKey)
					.map((c) => c.provider + "（" + (c.models[0] || "") + "）")
					.join(" · ");
				$("#tnl-me-cands").textContent = cands
					? "自动候选：" + cands
					: "自动候选：无（需 models.json provider 为 openai-completions 型且 provider-keys 有 key）";
			} catch {
				$("#tnl-me-state").textContent = "状态读取失败";
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
					alert("保存失败：" + (d.error || "未知错误"));
					return;
				}
				$("#tnl-me-key").value = "";
				refreshMe();
			} catch {
				alert("保存失败：网络错误");
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
		// ── Mesh 桥（P3a）：开关 + 状态 ─────────────────────
		async function refreshMesh() {
			try {
				const r = await fetch("/plugins-api/tunnel/mesh");
				const d = await r.json();
				const st = $("#tnl-mesh-state");
				const btn = $("#tnl-mesh-toggle");
				if (d.enabled) {
					st.textContent =
						"已开启 · " +
						(d.agentName || "—") +
						(d.device ? "（" + d.device + "）" : "") +
						(d.running ? "" : " · 桥未运行（服务未启动？）");
					st.style.color = d.running ? "" : "var(--red-text,var(--red,#ff3b30))";
					btn.textContent = "关闭 Mesh 桥";
				} else {
					st.textContent = "已关闭——开启后设备 pi agent 加入 pi_messenger";
					st.style.color = "";
					btn.textContent = "开启 Mesh 桥";
				}
				$("#tnl-mesh-info").textContent = d.queue || d.pending ? "队列 " + d.queue + " · 待回 " + d.pending : "";
			} catch {
				$("#tnl-mesh-state").textContent = "状态读取失败";
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
				alert("切换失败：网络错误");
			}
		};
		// P3b: 设备端 mesh 会话快照查看/重置
		$("#tnl-mesh-session").onclick = async () => {
			try {
				const r = await fetch("/plugins-api/tunnel/mesh/session");
				const d = await r.json();
				if (d.ok) {
					const s = d.session;
					alert(
						"设备 mesh 会话：\n" +
							(s.exists
								? "会话 ID：" +
									s.sessionId +
									"\n最近活跃：" +
									s.updatedAt +
									"\n文件大小：" +
									(s.size / 1024).toFixed(1) +
									" KB"
								: "无会话（尚未进行过 mesh 对话）"),
					);
				} else alert("读取失败：" + (d.error || "未知错误"));
			} catch {
				alert("读取失败：网络错误");
			}
		};
		$("#tnl-mesh-reset").onclick = async () => {
			if (!confirm("确定重置设备端 mesh 会话？\n\n重置后设备将遗忘之前的对话记忆，下条消息开启新会话。")) return;
			try {
				const r = await fetch("/plugins-api/tunnel/mesh/reset", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
				const d = await r.json();
				alert(d.ok ? "已重置（原会话 " + (d.removed || "无") + "）" : "重置失败：" + (d.error || "未知错误"));
			} catch {
				alert("重置失败：网络错误");
			}
		};
		refreshMesh();
		refreshMe();
		refresh();
		const timer = setInterval(refresh, 3000);

		$("#tnl-toggle").onclick = async () => {
			const ep = running ? "/plugins-api/tunnel/stop" : "/plugins-api/tunnel/start";
			try {
				await fetch(ep, { method: "POST" });
			} catch {}
			refresh();
		};
		$("#tnl-rotate").onclick = async () => {
			if (!confirm("重置令牌后，所有已分发 CLI 将无法重连（需重新下载）。确定重置？")) return;
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
				ok.textContent = "复制失败：请手动选中命令块复制";
				ok.style.color = "var(--red-text, var(--red, #ff3b30))";
				ok.style.display = "inline";
				setTimeout(() => {
					ok.style.display = "none";
					ok.textContent = "已复制";
					ok.style.color = "";
				}, 2600);
			}
		};

		return () => {
			clearInterval(timer);
			clearInterval(auditTimer);
		};
	},
});
