import {
	appPath,
	decodeBytes,
	expandSnippet,
	findBuffer,
	readSessions,
	saveSessions,
	matchesHost,
	importableHosts,
} from "./lib/workbench-state.mjs";
import { createInputQueue } from "./lib/input-queue.mjs";
import { createOperations } from "./lib/operations.mjs";
import { compact } from "./lib/compact.mjs";
import { buildRemoteWorkspaceUri } from "./lib/workspace-uri.mjs";
import { esc as escapeHtml } from "@pi-web-ui/plugin-sdk/client";

let xtermModule = null;
async function loadXterm() {
	if (!xtermModule) {
		try {
			xtermModule = await import("./vendor/xterm.bundle.mjs");
		} catch (error) {
			xtermModule = null;
			throw error;
		}
	}
	return xtermModule;
}

function buildTermTheme() {
	const cs = getComputedStyle(document.documentElement);
	const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
	return {
		background: v("--term-bg", "#0b0d12"),
		foreground: v("--term-fg", "#e6e8ef"),
		cursor: v("--term-cursor", v("--accent", "#8b5cf6")),
		cursorAccent: v("--term-cursor-accent", "#0b0d12"),
		selectionBackground: v("--term-selection", "rgba(139, 92, 246, 0.35)"),
		black: v("--term-black", "#1a1d26"),
		red: v("--term-red", "#f87171"),
		green: v("--term-green", "#34d399"),
		yellow: v("--term-yellow", "#fbbf24"),
		blue: v("--term-blue", "#60a5fa"),
		magenta: v("--term-magenta", "#c084fc"),
		cyan: v("--term-cyan", "#22d3ee"),
		white: v("--term-white", "#e6e8ef"),
		brightBlack: v("--term-bright-black", "#6b7284"),
		brightRed: v("--term-bright-red", "#f87171"),
		brightGreen: v("--term-bright-green", "#34d399"),
		brightYellow: v("--term-bright-yellow", "#fbbf24"),
		brightBlue: v("--term-bright-blue", "#60a5fa"),
		brightMagenta: v("--term-bright-magenta", "#c084fc"),
		brightCyan: v("--term-bright-cyan", "#22d3ee"),
		brightWhite: v("--term-bright-white", "#ffffff"),
	};
}

export default {
	mount(container, ctx) {
		const root = document.createElement("div");
		root.className = "rw-root";

		const styleEl = document.createElement("style");
		styleEl.textContent = `
			.rw-root {
				display: flex;
				flex-direction: column;
				height: 100%;
				width: 100%;
				background: var(--bg);
				color: var(--text);
				font-family: inherit;
				box-sizing: border-box;
				overflow: hidden;
				position: relative;
			}
			.rw-root.rw-fullscreen {
				position: fixed !important;
				inset: 0 !important;
				z-index: 9999 !important;
				width: 100vw !important;
				height: 100vh !important;
			}
			.rw-header {
				display: flex;
				align-items: center;
				justify-content: space-between;
				padding: 9px 16px;
				border-bottom: 1px solid var(--border);
				background: var(--bg-elev, #14161c);
				flex-shrink: 0;
				gap: 12px;
				flex-wrap: wrap;
			}
			.rw-header-left {
				display: flex;
				align-items: center;
				gap: 10px;
			}
			.rw-header-right {
				display: flex;
				align-items: center;
				gap: 10px;
				flex-shrink: 0;
			}
			.rw-title {
				font-size: 14.5px;
				font-weight: 600;
				display: flex;
				align-items: center;
				gap: 6px;
			}
			.rw-sub {
				font-size: 11.5px;
				color: var(--text-faint);
			}
			.rw-nav {
				display: flex;
				gap: 4px;
				background: var(--bg);
				padding: 3px;
				border-radius: 6px;
				border: 1px solid var(--border);
			}
			.rw-nav-btn {
				border: none;
				background: transparent;
				color: var(--text-faint);
				padding: 4px 12px;
				border-radius: 4px;
				cursor: pointer;
				font-size: 12.5px;
				font-weight: 500;
				transition: all 0.15s ease;
			}
			.rw-nav-btn.active {
				background: var(--bg-elev2, #1a1d26);
				color: var(--text);
				font-weight: 600;
			}
			.rw-btn {
				display: inline-flex;
				align-items: center;
				gap: 5px;
				padding: 5px 11px;
				border-radius: 6px;
				font-size: 12px;
				cursor: pointer;
				border: 1px solid var(--border);
				background: var(--bg-elev2, #1a1d26);
				color: var(--text);
				transition: all 0.15s ease;
				user-select: none;
			}
			.rw-btn:hover {
				border-color: var(--accent);
			}
			.rw-btn.primary {
				background: var(--accent);
				color: var(--accent-contrast, #fff);
				border-color: var(--accent);
			}
			.rw-btn.danger {
				color: var(--red);
			}
			.rw-btn.danger:hover {
				background: color-mix(in srgb, var(--red) 15%, transparent);
			}
			.rw-btn.sm {
				padding: 3px 8px;
				font-size: 11.5px;
			}

			/* 主体展示区 */
			.rw-body {
				flex: 1;
				display: flex;
				flex-direction: column;
				min-height: 0;
				position: relative;
			}

			/* 主机资产面板 */
			.rw-hosts-pane, .rw-tunnels-pane {
				flex: 1;
				overflow-y: auto;
				padding: 16px 20px;
				box-sizing: border-box;
				display: flex;
				flex-direction: column;
				gap: 12px;
			}
			.rw-hosts-toolbar {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 12px;
				margin-bottom: 4px;
				flex-wrap: wrap;
			}
			.rw-search-input {
				flex: 1;
				max-width: 380px;
				padding: 6px 12px;
				border-radius: 6px;
				border: 1px solid var(--border);
				background: var(--bg-elev2, #1a1d26);
				color: var(--text);
				font-size: 12.5px;
				outline: none;
			}
			.rw-search-input:focus {
				border-color: var(--accent);
			}
			.rw-host-card, .rw-tunnel-card {
				background: var(--card-bg, var(--bg-elev, #14161c));
				border: 1px solid var(--border);
				border-radius: 8px;
				padding: 13px 16px;
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 14px;
				transition: border-color 0.15s ease, box-shadow 0.15s ease;
			}
			.rw-host-card:hover, .rw-tunnel-card:hover {
				border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
			}
			.rw-host-main {
				min-width: 0;
				flex: 1;
			}
			.rw-host-head {
				display: flex;
				align-items: center;
				gap: 8px;
				margin-bottom: 5px;
				flex-wrap: wrap;
			}
			.rw-host-name {
				font-size: 14px;
				font-weight: 600;
				color: var(--text);
			}
			.rw-host-badge {
				font-size: 11px;
				padding: 2px 7px;
				border-radius: 10px;
				background: var(--bg-elev2, #1a1d26);
				color: var(--text-faint);
				border: 1px solid var(--border);
			}
			.rw-host-badge.success {
				color: var(--green);
				border-color: color-mix(in srgb, var(--green) 40%, var(--border));
			}
			.rw-host-meta {
				display: flex;
				flex-wrap: wrap;
				gap: 14px;
				font-size: 12px;
				color: var(--text-faint);
			}
			.rw-host-ops {
				display: flex;
				align-items: center;
				gap: 6px;
				flex-shrink: 0;
				flex-wrap: wrap;
			}

			/* 终端面板 */
			.rw-term-pane {
				flex: 1;
				display: flex;
				flex-direction: column;
				min-height: 0;
				background: var(--term-bg, #0b0d12);
			}
			.rw-term-bar {
				display: flex;
				align-items: center;
				justify-content: space-between;
				padding: 5px 12px;
				background: var(--bg-elev, #14161c);
				border-bottom: 1px solid var(--border);
				gap: 8px;
				flex-shrink: 0;
				position: relative;
				flex-wrap: wrap;
			}
			.rw-term-tabs {
				display: flex;
				gap: 5px;
				overflow-x: auto;
				align-items: center;
			}
			.rw-term-tab {
				display: inline-flex;
				align-items: center;
				gap: 6px;
				padding: 4px 10px;
				border-radius: 4px;
				font-size: 12px;
				background: var(--bg-elev2, #1a1d26);
				color: var(--text-faint);
				border: 1px solid var(--border);
				cursor: pointer;
				user-select: none;
				transition: all 0.12s ease;
			}
			.rw-term-tab.active {
				background: var(--bg);
				color: var(--text);
				font-weight: 600;
				border-color: var(--accent);
			}
			.rw-tab-close {
				cursor: pointer;
				opacity: 0.6;
				border-radius: 3px;
				padding: 0 2px;
			}
			.rw-tab-close:hover {
				opacity: 1;
				background: var(--border);
			}
			.rw-term-tab-add {
				display: inline-flex;
				align-items: center;
				justify-content: center;
				width: 24px;
				height: 24px;
				border-radius: 4px;
				background: var(--bg-elev2, #1a1d26);
				border: 1px solid var(--border);
				color: var(--text);
				cursor: pointer;
				font-size: 14px;
				font-weight: 600;
				line-height: 1;
				transition: all 0.15s ease;
			}
			.rw-term-tab-add:hover {
				border-color: var(--accent);
				color: var(--accent);
				background: var(--bg);
			}
			.rw-term-tools {
				display: flex;
				align-items: center;
				gap: 6px;
				flex-shrink: 0;
				flex-wrap: wrap;
			}

			/* 布局选择器 */
			.rw-layout-group {
				display: flex;
				background: var(--bg);
				padding: 2px;
				border-radius: 5px;
				border: 1px solid var(--border);
				gap: 2px;
			}
			.rw-layout-btn {
				border: none;
				background: transparent;
				color: var(--text-faint);
				padding: 2px 7px;
				border-radius: 3px;
				font-size: 11px;
				cursor: pointer;
			}
			.rw-layout-btn.active {
				background: var(--bg-elev2, #1a1d26);
				color: var(--text);
				font-weight: 600;
			}

			/* 快捷指令条 */
			.rw-snippet-bar {
				display: flex;
				align-items: center;
				gap: 5px;
				padding: 4px 12px;
				background: color-mix(in srgb, var(--bg-elev2, #1a1d26) 80%, black);
				border-bottom: 1px solid var(--border);
				overflow-x: auto;
				flex-shrink: 0;
			}
			.rw-snippet-btn {
				padding: 2px 7px;
				border-radius: 3px;
				font-size: 11px;
				font-family: var(--mono, monospace);
				background: var(--bg-elev, #14161c);
				border: 1px solid var(--border);
				color: var(--text);
				cursor: pointer;
				white-space: nowrap;
			}
			.rw-snippet-btn:hover {
				border-color: var(--accent);
				color: var(--accent);
			}

			/* 终端视口与布局（单标签 / 分屏 / 画布） */
			.rw-term-viewport {
				flex: 1;
				min-height: 0;
				padding: 4px;
				box-sizing: border-box;
				background: var(--term-bg, #0b0d12);
				position: relative;
			}
			.rw-term-viewport.layout-tabs {
				display: block;
			}
			.rw-term-viewport.layout-grid {
				display: grid;
				grid-template-columns: 1fr 1fr;
				gap: 6px;
				padding: 6px;
				overflow: auto;
			}
			.rw-term-viewport.layout-quad {
				display: grid;
				grid-template-columns: 1fr 1fr;
				grid-template-rows: 1fr 1fr;
				gap: 6px;
				padding: 6px;
				overflow: auto;
			}
			.rw-term-viewport.layout-canvas {
				display: grid;
				grid-template-columns: repeat(auto-fit, minmax(460px, 1fr));
				grid-auto-rows: minmax(290px, 1fr);
				gap: 8px;
				padding: 6px;
				overflow: auto;
			}

			/* 独立终端单元卡片 */
			.rw-term-cell {
				display: flex;
				flex-direction: column;
				background: var(--term-bg, #0b0d12);
				border: 1px solid var(--border);
				border-radius: 6px;
				overflow: hidden;
				min-height: 200px;
				height: 100%;
				position: relative;
				box-sizing: border-box;
				transition: border-color 0.15s ease;
			}
			.rw-term-cell.focused {
				border-color: var(--accent);
			}
			.rw-term-cell.cell-maximized {
				position: absolute !important;
				inset: 4px !important;
				z-index: 45 !important;
				border-color: var(--accent) !important;
			}
			.rw-term-cell-header {
				display: flex;
				align-items: center;
				justify-content: space-between;
				padding: 4px 10px;
				background: var(--bg-elev, #14161c);
				border-bottom: 1px solid var(--border);
				font-size: 11.5px;
				flex-shrink: 0;
				user-select: none;
			}
			.rw-term-cell-title {
				display: flex;
				align-items: center;
				gap: 6px;
				font-weight: 600;
				color: var(--text);
			}
			.rw-term-cell-ops {
				display: flex;
				align-items: center;
				gap: 4px;
			}
			.rw-cell-op-btn {
				background: transparent;
				border: none;
				color: var(--text-faint);
				cursor: pointer;
				padding: 2px 4px;
				border-radius: 3px;
				font-size: 11px;
			}
			.rw-cell-op-btn:hover {
				background: var(--bg-elev2, #1a1d26);
				color: var(--text);
			}
			.rw-term-cell-body {
				flex: 1;
				min-height: 0;
				padding: 2px;
				box-sizing: border-box;
				position: relative;
			}

			.rw-term-empty {
				position: absolute;
				inset: 0;
				display: flex;
				flex-direction: column;
				align-items: center;
				justify-content: center;
				background: var(--bg);
				color: var(--text-faint);
				gap: 12px;
			}

			/* 凭据外带直通条（对标 Termcp notify_user out-of-band input） */
			.rw-secure-bar {
				position: absolute;
				top: 8px;
				left: 50%;
				transform: translateX(-50%);
				display: flex;
				align-items: center;
				gap: 8px;
				padding: 6px 14px;
				background: var(--menu-bg, var(--bg-elev2, #1a1d26));
				border: 1px solid var(--accent);
				border-radius: 8px;
				box-shadow: 0 8px 28px rgba(0,0,0,0.7);
				z-index: 60;
				font-size: 12px;
				max-width: 90%;
			}
			.rw-secure-input {
				padding: 4px 8px;
				border-radius: 4px;
				border: 1px solid var(--border);
				background: var(--bg);
				color: var(--text);
				font-size: 12px;
				width: 220px;
				outline: none;
			}
			.rw-secure-input:focus {
				border-color: var(--accent);
			}

			.rw-term-reconnect-bar {
				position: absolute;
				top: 8px;
				right: 12px;
				display: flex;
				align-items: center;
				gap: 8px;
				padding: 5px 12px;
				background: var(--menu-bg, var(--bg-elev2, #1a1d26));
				border: 1px solid var(--amber, #f59e0b);
				border-radius: 6px;
				box-shadow: 0 4px 16px rgba(0,0,0,0.4);
				z-index: 50;
				font-size: 12px;
			}

			/* 实底弹出菜单（解决透底问题） */
			.rw-popmenu {
				position: absolute;
				top: 36px;
				left: 12px;
				background: var(--menu-bg, var(--bg-elev2, #1a1d26));
				border: 1px solid var(--border);
				border-radius: 8px;
				box-shadow: 0 10px 30px rgba(0, 0, 0, 0.7);
				z-index: 100;
				min-width: 250px;
				padding: 6px;
				display: flex;
				flex-direction: column;
				gap: 2px;
			}
			.rw-popmenu-header {
				font-size: 11px;
				font-weight: 600;
				color: var(--text-faint);
				padding: 4px 8px;
			}
			.rw-popmenu-item {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 8px;
				padding: 7px 10px;
				border-radius: 6px;
				font-size: 12.5px;
				color: var(--text);
				cursor: pointer;
				border: none;
				background: transparent;
				width: 100%;
				text-align: left;
				transition: background 0.12s ease;
			}
			.rw-popmenu-item:hover {
				background: var(--bg-elev3, rgba(255, 255, 255, 0.08));
				color: var(--accent);
			}
			.rw-popmenu-divider {
				height: 1px;
				background: var(--border);
				margin: 4px 0;
			}

			/* 模态框 */
			.rw-modal-overlay {
				position: absolute;
				inset: 0;
				background: rgba(0, 0, 0, 0.65);
				display: flex;
				align-items: center;
				justify-content: center;
				z-index: 99;
				backdrop-filter: blur(2px);
			}
			.rw-modal {
				width: 480px;
				max-width: 92%;
				background: var(--bg-elev2, #1a1d26);
				border: 1px solid var(--border);
				border-radius: 10px;
				box-shadow: 0 12px 36px rgba(0,0,0,0.6);
				padding: 20px;
				display: flex;
				flex-direction: column;
				gap: 14px;
				box-sizing: border-box;
			}
			.rw-modal-title {
				font-size: 15px;
				font-weight: 600;
			}
			.rw-form-row {
				display: flex;
				flex-direction: column;
				gap: 5px;
			}
			.rw-form-row label {
				font-size: 12px;
				color: var(--text-faint);
			}
			.rw-form-row input, .rw-form-row select {
				padding: 7px 10px;
				border-radius: 6px;
				border: 1px solid var(--border);
				background: var(--bg);
				color: var(--text);
				font-size: 13px;
				outline: none;
			}
			.rw-form-row input:focus, .rw-form-row select:focus {
				border-color: var(--accent);
			}
			.rw-form-inline {
				display: flex;
				gap: 10px;
			}
			.rw-form-inline .rw-form-row {
				flex: 1;
			}
			.rw-modal-footer {
				display: flex;
				justify-content: flex-end;
				gap: 10px;
				margin-top: 10px;
			}
		`;
		styleEl.textContent += `
			.rw-root *, .rw-root *::before, .rw-root *::after { box-sizing: border-box; }
			.rw-root :is(.rw-header-left,.rw-header-right,.rw-host-main,.rw-host-ops,.rw-term-tools,.rw-host-head,.rw-term-tabs,.rw-modal,.rw-task-card) { min-width:0; max-width:100%; }
			.rw-root :is(.rw-header-right,.rw-host-ops,.rw-term-tools,.rw-host-head) { flex-wrap:wrap; }
			.rw-root :is(pre,.rw-host-name,.rw-host-meta,.rw-task-card,.rw-btn) { overflow-wrap:anywhere; word-break:break-word; }
			.rw-root pre { white-space:pre-wrap; max-height:300px; overflow:auto; }
			.rw-root :is(.rw-modal,.rw-hosts-pane,.rw-tunnels-pane) { overscroll-behavior:contain; }
			.rw-root .rw-modal { max-height:90vh; overflow:auto; }
			.rw-root textarea { width:100%; background:var(--bg); color:var(--text); border:1px solid var(--border); }
			.rw-task-targets { display:flex; flex-direction:column; max-height:160px; overflow:auto; }
			.rw-task-card { margin-top:12px; border:1px solid var(--border); padding:10px; border-radius:6px; }
			.rw-root button:disabled { opacity:.55; cursor:default; }
		`;
		root.appendChild(styleEl);

		let currentTab = "hosts";
		let termLayout = "tabs";
		let broadcastInput = false;
		let hosts = [];
		let tunnels = [];
		let filterKeyword = "";
		let activeShells = [];
		let activeShellIndex = -1;
		let modalVisible = false;
		let activePopmenu = null,
			popmenuTimer,
			popmenuListener;
		let showSnippetBar = true;
		let disposed = false,
			fitTimer;
		const lifecycle = new AbortController();
		const broadcastTargets = new Set();
		let groupFilter = "",
			environmentFilter = "";
		const sessionKey = `remote-workbench:sessions:${appPath(ctx, "/", import.meta.url)}`;
		const persistSessions = () => saveSessions(sessionStorage, sessionKey, activeShells);
		const post = (path, payload) => api(path, { method: "POST", body: JSON.stringify(payload) });
		const operations = createOperations({ root, api, post, hosts: () => hosts });

		const header = document.createElement("div");
		header.className = "rw-header";
		header.innerHTML = `
			<div class="rw-header-left">
				<div class="rw-title">🖥️ 远程工作台</div>
				<div class="rw-sub">全局主机 · Web SSH 终端 · 画布分屏 · SFTP 联动 · 端口转发</div>
			</div>
			<div class="rw-header-right">
				<div class="rw-nav">
					<button class="rw-nav-btn active" data-tab="hosts">主机资产</button>
					<button class="rw-nav-btn" data-tab="term">Web 终端 (<span id="rw-term-count">0</span>)</button>
					<button class="rw-nav-btn" data-tab="tunnels">端口转发 (<span id="rw-tunnel-count">0</span>)</button>
				</div>
				<button class="rw-btn primary" id="rw-btn-add">＋ 添加主机</button>
			</div>
		`;
		root.appendChild(header);
		const tasksButton = document.createElement("button");
		tasksButton.className = "rw-btn";
		tasksButton.textContent = "多机任务中心";
		tasksButton.onclick = () => operations.tasks();
		header.querySelector(".rw-header-right").append(tasksButton);

		const body = document.createElement("div");
		body.className = "rw-body";
		root.appendChild(body);

		const hostsPane = document.createElement("div");
		hostsPane.className = "rw-hosts-pane";
		body.appendChild(hostsPane);

		const termPane = document.createElement("div");
		termPane.className = "rw-term-pane";
		termPane.style.display = "none";
		termPane.innerHTML = `
			<div class="rw-term-bar">
				<div class="rw-term-tabs" id="rw-term-tabs"></div>
				<div class="rw-term-tools">
					<!-- 布局切换器：标签单屏 / 双列 / 四宫格 / 画布平铺 -->
					<div class="rw-layout-group">
						<button class="rw-layout-btn active" data-layout="tabs" title="单标签页视图">📑 标签</button>
						<button class="rw-layout-btn" data-layout="grid" title="左右双列平铺">◫ 双列</button>
						<button class="rw-layout-btn" data-layout="quad" title="四宫格矩阵分屏">⊞ 四格</button>
						<button class="rw-layout-btn" data-layout="canvas" title="自适应画布多卡片平铺">🎨 画布</button>
					</div>
					<!-- 多机广播输入开关 -->
					<button class="rw-btn sm" id="rw-tool-broadcast" title="明确选择目标与环境后广播到所选终端">⚡ 广播输入: 关</button>
					<button class="rw-btn sm" id="rw-tool-export" title="清理 ANSI 与进度条后导出纯净文本日志 (Termcp Compact)">📄 导出日志</button>
					<button class="rw-btn sm" id="rw-tool-clear" title="清除屏幕 (clear)">🧹 清屏</button>
					<button class="rw-btn sm" id="rw-tool-reconnect" title="重新连接当前终端">🔄 重连</button>
					<button class="rw-btn sm" id="rw-tool-snippet" title="显示/隐藏快捷运维指令条">⚡ 快捷条</button>
					<button class="rw-btn sm" id="rw-tool-fullscreen" title="全屏终端模式 (Esc 退出)">⛶ 全屏</button>
				</div>
			</div>
			<div class="rw-snippet-bar" id="rw-snippet-bar">
				<span style="font-size: 11px; color: var(--text-faint); margin-right: 4px;">快捷指令:</span>
				<button class="rw-snippet-btn" data-cmd="SIGINT">Ctrl+C</button>
				<button class="rw-snippet-btn" data-cmd="SIGQUIT">Ctrl+D</button>
				<button class="rw-snippet-btn" data-cmd="ESC">Esc</button>
				<button class="rw-snippet-btn" data-cmd="TAB">Tab</button>
				<button class="rw-snippet-btn" data-cmd="clear">clear</button>
				<button class="rw-snippet-btn" data-cmd="top">top</button>
				<button class="rw-snippet-btn" data-cmd="htop">htop</button>
				<button class="rw-snippet-btn" data-cmd="df -h">df -h</button>
				<button class="rw-snippet-btn" data-cmd="free -m">free -m</button>
				<button class="rw-snippet-btn" data-cmd="docker ps">docker ps</button>
				<button class="rw-snippet-btn" data-cmd="tail -f /var/log/syslog">tail syslog</button>
			</div>
			<div class="rw-term-viewport layout-tabs" id="rw-term-viewport">
				<div class="rw-term-empty" id="rw-term-empty">
					<div style="font-size: 32px;">💻</div>
					<div>暂无打开的远程终端会话</div>
					<button class="rw-btn primary" id="rw-btn-goto-hosts">从主机列表中选择并连接</button>
				</div>
				<!-- 凭据外带直通输入条（检测到 Sudo/Password 时滑出） -->
				<div class="rw-secure-bar" id="rw-secure-bar" style="display: none;">
					<span>🔒 <b>凭据/Sudo 提权请求</b>（发送到下方明确标记的终端）:</span>
					<input type="password" class="rw-secure-input" id="rw-secure-input" placeholder="输入密码 / Key 口令" />
					<button class="rw-btn primary sm" id="rw-secure-send">发送</button>
					<button class="rw-btn sm" id="rw-secure-cancel">取消 (Ctrl+C)</button>
				</div>
				<div class="rw-term-reconnect-bar" id="rw-reconnect-bar" style="display: none;">
					<span>⚠️ 远程连接已断开</span>
					<button class="rw-btn primary sm" id="rw-reconnect-btn">立即重连</button>
				</div>
			</div>
		`;
		body.appendChild(termPane);

		const tunnelsPane = document.createElement("div");
		tunnelsPane.className = "rw-tunnels-pane";
		tunnelsPane.style.display = "none";
		body.appendChild(tunnelsPane);

		async function api(path, options = {}) {
			const res = await fetch(appPath(ctx, `/plugins-api/remote-workbench${path}`, import.meta.url), {
				signal: lifecycle.signal,
				headers: { "Content-Type": "application/json" },
				...options,
			});
			const json = await res.json();
			if (!res.ok || !json.ok) throw new Error(json.error || `请求失败 (${res.status})`);
			if (disposed) throw new Error("工作台已卸载");
			return json.data;
		}

		async function refreshHosts() {
			try {
				const data = await api("/hosts");
				hosts = data?.hosts ?? [];
				renderHosts();
			} catch (err) {
				console.error("[remote-workbench] 加载主机失败:", err);
			}
		}

		async function refreshTunnels() {
			try {
				const data = await api("/tunnels");
				tunnels = data?.tunnels ?? [];
				renderTunnels();
			} catch (err) {
				console.error("[remote-workbench] 加载隧道失败:", err);
			}
		}

		function renderHosts() {
			hostsPane.innerHTML = "";

			const toolbar = document.createElement("div");
			toolbar.className = "rw-hosts-toolbar";
			toolbar.innerHTML = `
				<div style="display: flex; gap: 8px; flex: 1; align-items: center; flex-wrap: wrap;">
					<input type="text" class="rw-search-input" id="rw-search" placeholder="🔍 搜索主机 IP / 名称 / 用户名..." value="${escapeHtml(filterKeyword)}" />
					<button class="rw-btn sm" id="rw-btn-scan-sshconfig" title="扫描并导入本机 ~/.ssh/config 主机">⚙ 导入 ~/.ssh/config</button>
					<button class="rw-btn sm primary" id="rw-btn-open-all-canvas" title="一键将所有主机在画布矩阵中同时连接并平铺展示">🎨 画布平铺全部主机</button>
				</div>
				<div style="font-size: 12px; color: var(--text-faint);">共 ${hosts.length} 台全局主机</div>
			`;
			hostsPane.appendChild(toolbar);
			for (const [field, selected, setter] of [
				[
					"group",
					groupFilter,
					(v) => {
						groupFilter = v;
					},
				],
				[
					"environment",
					environmentFilter,
					(v) => {
						environmentFilter = v;
					},
				],
			]) {
				const select = document.createElement("select");
				select.className = "rw-search-input";
				select.innerHTML =
					`<option value="">${field === "group" ? "所有分组" : "所有环境"}</option>` +
					[...new Set(hosts.map((h) => h[field]).filter(Boolean))]
						.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
						.join("");
				select.value = selected;
				select.onchange = () => {
					setter(select.value);
					renderHostCards();
				};
				toolbar.append(select);
			}

			toolbar.querySelector("#rw-search").addEventListener("input", (e) => {
				filterKeyword = e.target.value.trim().toLowerCase();
				renderHostCards();
			});

			toolbar.querySelector("#rw-btn-scan-sshconfig").addEventListener("click", () => showSshConfigImportModal());

			toolbar.querySelector("#rw-btn-open-all-canvas").addEventListener("click", () => {
				if (!hosts.length) {
					alert("当前暂无主机，请先添加主机");
					return;
				}
				termLayout = "canvas";
				switchTab("term");
				hosts
					.filter((h) => matchesHost(h, filterKeyword, groupFilter, environmentFilter))
					.forEach((h) => {
						const existing = activeShells.find(
							(s) => s.host === h.host && s.username === h.username && s.port === (h.port || 22),
						);
						if (!existing) openTerminal(h);
					});
			});

			const listContainer = document.createElement("div");
			listContainer.id = "rw-hosts-list";
			listContainer.style.display = "flex";
			listContainer.style.flexDirection = "column";
			listContainer.style.gap = "10px";
			hostsPane.appendChild(listContainer);

			renderHostCards();
		}

		function renderHostCards() {
			const listContainer = hostsPane.querySelector("#rw-hosts-list");
			if (!listContainer) return;
			listContainer.innerHTML = "";

			const filtered = hosts.filter((h) => matchesHost(h, filterKeyword, groupFilter, environmentFilter));

			if (!filtered.length) {
				listContainer.innerHTML = `
					<div class="rw-hosts-empty" style="padding: 40px 0;">
						<div style="font-size: 28px;">🌐</div>
						<div>${hosts.length ? "没有匹配的主机" : "全局主机库（global-hosts.json）为空"}</div>
						<button class="rw-btn primary" id="rw-empty-add">＋ 添加远程主机</button>
					</div>
				`;
				listContainer.querySelector("#rw-empty-add")?.addEventListener("click", () => showEditModal());
				return;
			}

			filtered.forEach((h) => {
				const card = document.createElement("div");
				card.className = "rw-host-card";
				const authText = h.authType === "key" ? "密钥认证" : h.authType === "agent" ? "Agent" : "密码认证";
				const timeText = h.lastConnected ? new Date(h.lastConnected).toLocaleString() : "从未连接";

				card.innerHTML = `
					<div class="rw-host-main">
						<div class="rw-host-head">
							<span style="font-size: 16px;">💻</span>
							<span class="rw-host-name">${escapeHtml(h.name)}</span><span class="rw-host-badge">${escapeHtml(h.group || "未分组")} · ${escapeHtml(h.environment || "未标记环境")}</span>
							<span class="rw-host-badge">${authText}</span>
							${h.reviewMode ? `<span class="rw-host-badge" style="color: var(--amber, #f59e0b); border-color: var(--amber, #f59e0b);">🛡️ 生产保护</span>` : ""}
							<span class="rw-host-badge" id="rw-probe-badge-${escapeHtml(h.name)}" style="display: none;"></span>
							${h.description ? `<span style="font-size: 12px; color: var(--text-faint);">· ${escapeHtml(h.description)}</span>` : ""}
						</div>
						<div class="rw-host-meta">
							<span>地址: <b>${escapeHtml(h.username)}@${escapeHtml(h.host)}:${h.port || 22}</b></span>
							${h.remotePath ? `<span>路径: ${escapeHtml(h.remotePath)}</span>` : ""}
							<span>最近连接: ${timeText}</span>
						</div>
					</div>
					<div class="rw-host-ops">
						<button class="rw-btn primary rw-op-term" title="打开 Web SSH 终端">⚡ 终端</button>
						<button class="rw-btn rw-op-files" title="轻量浏览远端目录树与文件">📂 文件</button>
						<button class="rw-btn rw-op-health">健康</button><button class="rw-btn rw-op-meta">分组/环境</button><button class="rw-btn rw-op-tmux">tmux</button>
						<button class="rw-btn rw-op-probe" title="探测服务器配置与在线状态">🔍 探测</button>
						<button class="rw-btn rw-op-tunnel" title="建立本地到远端的端口转发隧道 (-L)">🔀 转发</button>
						<button class="rw-btn rw-op-sftp" title="在 SFTP 插件中联动使用">☁️ SFTP</button>
						<button class="rw-btn rw-op-workspace" title="设为当前远程工作区">📁 工作区</button>
						<button class="rw-btn rw-op-edit" title="编辑主机配置">✎ 编辑</button>
						<button class="rw-btn danger rw-op-del" title="从全局删除">🗑</button>
					</div>
				`;

				card.querySelector(".rw-op-health").onclick = () => operations.health(h);
				card.querySelector(".rw-op-tmux").onclick = () => {
					const tmuxSession = prompt("tmux 会话名（字母、数字、_、-；留空自动生成）", "");
					if (tmuxSession === null) return;
					if (tmuxSession && !/^[a-zA-Z0-9_-]{1,64}$/.test(tmuxSession)) {
						alert("会话名格式无效");
						return;
					}
					openTerminal({ ...h, tmux: true, tmuxSession });
				};
				card.querySelector(".rw-op-meta").onclick = async () => {
					const group = prompt("主机分组", h.group || "");
					if (group === null) return;
					const environment = prompt("环境（例如 production / staging）", h.environment || "");
					if (environment === null) return;
					try {
						await post("/hosts/metadata", { name: h.name, group, environment });
						await refreshHosts();
					} catch (err) {
						alert(err.message);
					}
				};
				card.querySelector(".rw-op-term").addEventListener("click", () => openTerminal(h));
				card.querySelector(".rw-op-files").addEventListener("click", () => showFileExplorerModal(h));
				card.querySelector(".rw-op-probe").addEventListener("click", () => probeHostCard(h, card));
				card.querySelector(".rw-op-tunnel").addEventListener("click", () => showCreateTunnelModal(h));
				card.querySelector(".rw-op-sftp").addEventListener("click", () => linkSftp(h));
				card.querySelector(".rw-op-workspace").addEventListener("click", () => openWorkspace(h));
				card.querySelector(".rw-op-edit").addEventListener("click", () => showEditModal(h));
				card.querySelector(".rw-op-del").addEventListener("click", () => deleteHost(h.name));

				listContainer.appendChild(card);
			});
		}

		async function showSshConfigImportModal() {
			const overlay = document.createElement("div");
			overlay.className = "rw-modal-overlay";
			overlay.innerHTML = `
				<div class="rw-modal" style="width: 520px;">
					<div class="rw-modal-title">⚙ 发现并导入本机 ~/.ssh/config 主机</div>
					<div id="rw-cfg-loading" style="padding: 20px 0; text-align: center; color: var(--text-faint);">正在读取本机 ~/.ssh/config…</div>
					<div id="rw-cfg-content" style="display: none; max-height: 320px; overflow-y: auto; flex-direction: column; gap: 8px;"></div>
					<div class="rw-modal-footer">
						<button class="rw-btn" id="rw-cfg-cancel">取消</button>
						<button class="rw-btn primary" id="rw-cfg-import-btn" disabled>一键导入已选主机</button>
					</div>
				</div>
			`;
			root.appendChild(overlay);

			overlay.querySelector("#rw-cfg-cancel").addEventListener("click", () => overlay.remove());

			try {
				const res = await api("/sshconfig");
				overlay.querySelector("#rw-cfg-loading").style.display = "none";
				const contentEl = overlay.querySelector("#rw-cfg-content");
				contentEl.style.display = "flex";

				if (!res.exists || !res.list.length) {
					contentEl.innerHTML = `<div style="color: var(--text-faint); padding: 20px 0; text-align: center;">未在「${escapeHtml(res.path || "~/.ssh/config")}」中发现可用的 Host 主机块。</div>`;
					return;
				}

				let html = (res.warnings || []).map((warning) => `<div role="alert">⚠ ${escapeHtml(warning)}</div>`).join("");
				res.list.forEach((item, idx) => {
					html += `
						<label style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; cursor: ${item.imported ? "default" : "pointer"};">
							<div style="display: flex; align-items: center; gap: 10px;">
								<input type="checkbox" class="rw-cfg-cb" data-idx="${idx}" ${item.imported || item.importable === false ? "disabled" : "checked"} />
								<div>
									<div style="font-weight: 600; font-size: 13px;">${escapeHtml(item.alias)}</div><div role="alert">${(item.warnings || []).map((warning) => escapeHtml(warning)).join(" · ")}${item.importable === false ? " · 不支持此连接配置，禁止导入" : ""}</div>
									<div style="font-size: 11.5px; color: var(--text-faint);">${escapeHtml(item.username)}@${escapeHtml(item.host)}:${item.port} ${item.privateKeyPath ? `(Key: ${escapeHtml(item.privateKeyPath)})` : ""}</div>
								</div>
							</div>
							<div style="font-size: 11px;">
								${item.imported ? `<span class="rw-host-badge">已在全局库</span>` : `<span class="rw-host-badge success">新发现</span>`}
							</div>
						</label>
					`;
				});
				contentEl.innerHTML = html;

				const importBtn = overlay.querySelector("#rw-cfg-import-btn");
				const checkboxes = contentEl.querySelectorAll(".rw-cfg-cb:not(:disabled)");
				importBtn.disabled = checkboxes.length === 0;

				importBtn.addEventListener("click", async () => {
					const selected = [];
					contentEl.querySelectorAll(".rw-cfg-cb:checked:not(:disabled)").forEach((cb) => {
						const i = Number(cb.dataset.idx);
						if (res.list[i] && importableHosts([res.list[i]]).length) selected.push(res.list[i]);
					});
					if (!selected.length) return;
					importBtn.disabled = true;
					importBtn.textContent = "导入中…";
					try {
						await api("/sshconfig/import", {
							method: "POST",
							body: JSON.stringify({ items: selected }),
						});
						overlay.remove();
						await refreshHosts();
					} catch (err) {
						alert(`导入失败: ${err.message}`);
						importBtn.disabled = false;
						importBtn.textContent = "一键导入已选主机";
					}
				});
			} catch (err) {
				overlay.querySelector("#rw-cfg-loading").textContent = `扫描失败: ${err.message}`;
			}
		}

		async function showFileExplorerModal(h) {
			const overlay = document.createElement("div");
			overlay.className = "rw-modal-overlay";
			overlay.innerHTML = `
				<div class="rw-modal" style="width: 720px; max-width: 95%; max-height: 85vh; display: flex; flex-direction: column;">
					<div class="rw-modal-title" style="display: flex; justify-content: space-between; align-items: center;">
						<span>📂 远程文件浏览 — <b>${escapeHtml(h.name)}</b></span>
						<button class="rw-btn sm" id="rw-fs-close">✖</button>
					</div>

					<div style="display: flex; gap: 8px; align-items: center; margin: 4px 0;">
						<button class="rw-btn sm" id="rw-fs-up" title="返回上级目录">⬆ 上级</button>
						<button class="rw-btn sm" id="rw-fs-refresh" title="刷新">⟳ 刷新</button>
						<input type="text" id="rw-fs-path-input" style="flex: 1; padding: 4px 8px; font-size: 12px; font-family: var(--mono, monospace); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; color: var(--text);" value="${escapeHtml(h.remotePath || "/")}" />
						<button class="rw-btn sm primary" id="rw-fs-go">前往</button>
						<button class="rw-btn sm" id="rw-fs-open-ws" title="将当前浏览目录设为远程工作区">📁 设为工作区</button>
						<label class="rw-btn sm" style="cursor: pointer; position: relative;">
							<span>⬆ 上传</span>
							<input type="file" id="rw-fs-upload-input" style="display: none;" />
						</label>
					</div>

					<div id="rw-fs-list" style="flex: 1; min-height: 240px; max-height: 420px; overflow-y: auto; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 4px;">
						<div style="text-align: center; color: var(--text-faint); padding: 40px 0;">加载中…</div>
					</div>

					<div style="font-size: 11px; color: var(--text-faint); display: flex; justify-content: space-between;">
						<span>提示: 双击文件夹进入，双击文本文件直接查看预览内容</span>
						<span id="rw-fs-status"></span>
					</div>
				</div>
			`;
			root.appendChild(overlay);

			let curPath = h.remotePath || "/";
			let curParent = null;

			overlay.querySelector("#rw-fs-close").addEventListener("click", () => overlay.remove());

			function formatFileSize(bytes) {
				if (!bytes || bytes === 0) return "0 B";
				const k = 1024;
				const sizes = ["B", "KB", "MB", "GB"];
				const i = Math.floor(Math.log(bytes) / Math.log(k));
				return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
			}

			async function previewFile(filePath) {
				try {
					const res = await api("/files/read", {
						method: "POST",
						body: JSON.stringify({ hostName: h.name, path: filePath, maxBytes: 256 * 1024 }),
					});
					const prevModal = document.createElement("div");
					prevModal.className = "rw-modal-overlay";
					prevModal.innerHTML = `
						<div class="rw-modal" style="width: 760px; max-height: 80vh; display: flex; flex-direction: column;">
							<div class="rw-modal-title" style="display: flex; justify-content: space-between;">
								<span>📄 ${escapeHtml(filePath)} (${formatFileSize(res.size)})</span>
								<button class="rw-btn sm" id="rw-prev-close">✖</button>
							</div>
							<div style="flex: 1; overflow-y: auto; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px;">
								<pre style="margin: 0; font-family: var(--mono, monospace); font-size: 12px; white-space: pre-wrap; word-break: break-all;">${res.isBinary ? "(检测到二进制文件，不提供文本预览)" : escapeHtml(res.content)}</pre>
							</div>
						</div>
					`;
					root.appendChild(prevModal);
					prevModal.querySelector("#rw-prev-close").addEventListener("click", () => prevModal.remove());
				} catch (err) {
					alert(`预览失败: ${err.message}`);
				}
			}

			async function loadDir(targetPath) {
				const listEl = overlay.querySelector("#rw-fs-list");
				listEl.innerHTML = `<div style="text-align: center; color: var(--text-faint); padding: 40px 0;">加载目录中…</div>`;
				try {
					const data = await api("/files/list", {
						method: "POST",
						body: JSON.stringify({ hostName: h.name, path: targetPath }),
					});
					curPath = data.path;
					curParent = data.parentPath;
					overlay.querySelector("#rw-fs-path-input").value = curPath;
					overlay.querySelector("#rw-fs-up").disabled = !curParent;
					overlay.querySelector("#rw-fs-status").textContent = `共 ${data.items.length} 个条目`;

					if (!data.items.length) {
						listEl.innerHTML = `<div style="text-align: center; color: var(--text-faint); padding: 30px 0;">(空目录)</div>`;
						return;
					}

					let rows = "";
					data.items.forEach((it) => {
						const icon = it.isDirectory ? "📁" : "📄";
						const sizeStr = it.isDirectory ? "-" : formatFileSize(it.size);
						const timeStr = it.mtime ? new Date(it.mtime).toLocaleString() : "";
						rows += `
							<div class="rw-fs-item" data-path="${escapeHtml(it.path)}" data-isdir="${it.isDirectory}" style="display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; border-radius: 4px; cursor: pointer; font-size: 12.5px; user-select: none;">
								<div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
									<span>${icon}</span>
									<span style="font-weight: ${it.isDirectory ? "600" : "normal"};">${escapeHtml(it.name)}</span>
								</div>
								<div style="display: flex; gap: 16px; font-size: 11.5px; color: var(--text-faint); flex-shrink: 0;">
									<span>${sizeStr}</span>
									<span>${timeStr}</span>
								</div>
							</div>
						`;
					});
					listEl.innerHTML = rows;

					listEl.querySelectorAll(".rw-fs-item").forEach((el) => {
						el.addEventListener("mouseenter", () => (el.style.background = "var(--bg-elev2, #1a1d26)"));
						el.addEventListener("mouseleave", () => (el.style.background = "transparent"));
						el.addEventListener("dblclick", () => {
							const isDir = el.dataset.isdir === "true";
							const p = el.dataset.path;
							if (isDir) {
								loadDir(p);
							} else {
								previewFile(p);
							}
						});
					});
				} catch (err) {
					listEl.innerHTML = `<div style="color: var(--red); padding: 20px 10px;">读取失败: ${err.message}</div>`;
				}
			}

			overlay.querySelector("#rw-fs-up").addEventListener("click", () => {
				if (curParent) loadDir(curParent);
			});
			overlay.querySelector("#rw-fs-refresh").addEventListener("click", () => loadDir(curPath));
			overlay.querySelector("#rw-fs-go").addEventListener("click", () => {
				const val = overlay.querySelector("#rw-fs-path-input").value.trim();
				if (val) loadDir(val);
			});
			overlay.querySelector("#rw-fs-path-input").addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					const val = overlay.querySelector("#rw-fs-path-input").value.trim();
					if (val) loadDir(val);
				}
			});

			overlay.querySelector("#rw-fs-open-ws")?.addEventListener("click", () => {
				openWorkspace(h, curPath, () => overlay.remove());
			});
			overlay.querySelector("#rw-fs-upload-input").addEventListener("change", async (e) => {
				const file = e.target.files?.[0];
				if (!file) return;
				const statusEl = overlay.querySelector("#rw-fs-status");
				statusEl.textContent = `正在上传 ${file.name}…`;
				const reader = new FileReader();
				reader.onload = async () => {
					try {
						const b64 = reader.result.split(",")[1];
						await api("/files/upload", {
							method: "POST",
							body: JSON.stringify({ hostName: h.name, targetDir: curPath, fileName: file.name, b64 }),
						});
						statusEl.textContent = `✓ 上传完成`;
						loadDir(curPath);
					} catch (err) {
						alert(`上传失败: ${err.message}`);
						statusEl.textContent = `上传失败`;
					}
				};
				reader.readAsDataURL(file);
			});

			loadDir(curPath);
		}

		function renderTunnels() {
			tunnelsPane.innerHTML = "";
			const countSpan = header.querySelector("#rw-tunnel-count");
			countSpan.textContent = String(tunnels.length);

			const toolbar = document.createElement("div");
			toolbar.className = "rw-hosts-toolbar";
			toolbar.innerHTML = `
				<div style="font-size: 13px; font-weight: 600;">已启用的 SSH 端口转发隧道 (-L Local Tunnel)</div>
				<button class="rw-btn primary sm" id="rw-btn-add-tunnel">＋ 新建端口转发</button>
			`;
			tunnelsPane.appendChild(toolbar);
			toolbar.querySelector("#rw-btn-add-tunnel").addEventListener("click", () => showCreateTunnelModal());

			if (!tunnels.length) {
				const empty = document.createElement("div");
				empty.className = "rw-hosts-empty";
				empty.innerHTML = `
					<div style="font-size: 28px;">🔀</div>
					<div>当前暂无运行中的端口转发隧道</div>
					<div style="font-size: 12px; color: var(--text-faint);">可将远端集群的内网服务（如 Redis、DB、内网 Web）映射到本机端口</div>
					<button class="rw-btn primary" id="rw-empty-add-tun">立即新建转发隧道</button>
				`;
				empty.querySelector("#rw-empty-add-tun")?.addEventListener("click", () => showCreateTunnelModal());
				tunnelsPane.appendChild(empty);
				return;
			}

			const listContainer = document.createElement("div");
			listContainer.style.display = "flex";
			listContainer.style.flexDirection = "column";
			listContainer.style.gap = "10px";

			tunnels.forEach((t) => {
				const card = document.createElement("div");
				card.className = "rw-tunnel-card";
				const upTime = t.startedAt ? new Date(t.startedAt).toLocaleTimeString() : "";

				card.innerHTML = `
					<div class="rw-host-main">
						<div class="rw-host-head">
							<span class="rw-host-badge">● ${escapeHtml(t.status || "未知")}</span>${t.error ? `<span role="alert">${escapeHtml(t.error)}</span>` : ""}
							<span class="rw-host-name">127.0.0.1:${t.localPort} ➔ ${escapeHtml(t.targetHost)}:${t.targetPort}</span>
						</div>
						<div class="rw-host-meta">
							<span>SSH 跳板主机: <b>${escapeHtml(t.hostName)}</b></span>
							<span>启动于: ${upTime}</span>
						</div>
					</div>
					<div class="rw-host-ops">
						<button class="rw-btn rw-op-starttun">恢复隧道</button><button class="rw-btn rw-op-deletetun">删除配置</button><button class="rw-btn danger rw-op-stoptun" title="停止该端口转发">停止隧道</button>
					</div>
				`;

				card.querySelector(".rw-op-starttun").disabled = ["listening", "connecting", "reconnecting"].includes(t.status);
				card.querySelector(".rw-op-starttun").onclick = async () => {
					try {
						await post("/tunnels/start", { id: t.id });
						await refreshTunnels();
					} catch (err) {
						alert(err.message);
					}
				};
				card.querySelector(".rw-op-deletetun").onclick = async () => {
					if (!confirm(`删除隧道配置 ${t.hostName}:${t.localPort}？`)) return;
					try {
						await post("/tunnels/delete", { tunnelId: t.id });
						await refreshTunnels();
					} catch (err) {
						alert(err.message);
					}
				};
				card.querySelector(".rw-op-stoptun").addEventListener("click", async () => {
					if (!confirm(`确定要停止 127.0.0.1:${t.localPort} 的转发吗？`)) return;
					try {
						await api("/tunnels/stop", {
							method: "POST",
							body: JSON.stringify({ tunnelId: t.id }),
						});
						await refreshTunnels();
					} catch (err) {
						alert(`停止失败: ${err.message}`);
					}
				});

				listContainer.appendChild(card);
			});

			tunnelsPane.appendChild(listContainer);
		}

		function formatMem(mb) {
			const n = Number(mb);
			if (!n || n <= 0) return "";
			if (n >= 1024) {
				const gb = (n / 1024).toFixed(1).replace(/\.0$/, "");
				return `${gb}GB`;
			}
			return `${n}MB`;
		}

		async function probeHostCard(h, card) {
			const badge = card.querySelector(`[id^="rw-probe-badge"]`);
			const btn = card.querySelector(".rw-op-probe");
			btn.disabled = true;
			btn.textContent = "探测中…";
			try {
				const res = await api("/hosts/probe", {
					method: "POST",
					body: JSON.stringify({
						name: h.name,
						host: h.host,
						port: h.port || 22,
						username: h.username,
						auth: { type: h.authType },
					}),
				});
				btn.disabled = false;
				btn.textContent = "🔍 探测";
				const isSuccess = Boolean(res.connected || res.ok);
				if (badge && isSuccess) {
					const memStr = formatMem(res.system?.totalMemMb);
					const osStr = res.system?.distro || res.system?.os || "Linux";
					const coresStr = `${res.system?.cores || 1}核`;
					badge.textContent = `${osStr} · ${coresStr}${memStr ? ` · ${memStr}` : ""}`;
					badge.className = "rw-host-badge success";
					badge.style.display = "inline-block";
				} else {
					alert(`探测失败: ${res.error || "无法连通"}`);
				}
			} catch (err) {
				btn.disabled = false;
				btn.textContent = "🔍 探测";
				alert(`探测失败: ${err.message}`);
			}
		}

		function switchTab(tab) {
			currentTab = tab;
			header.querySelectorAll(".rw-nav-btn").forEach((b) => {
				b.classList.toggle("active", b.dataset.tab === tab);
			});
			if (tab === "hosts") {
				hostsPane.style.display = "flex";
				termPane.style.display = "none";
				tunnelsPane.style.display = "none";
			} else if (tab === "term") {
				hostsPane.style.display = "none";
				termPane.style.display = "flex";
				tunnelsPane.style.display = "none";
				renderTermTabs();
				refitActiveTerm();
			} else if (tab === "tunnels") {
				hostsPane.style.display = "none";
				termPane.style.display = "none";
				tunnelsPane.style.display = "flex";
				refreshTunnels();
			}
		}

		header.querySelectorAll(".rw-nav-btn").forEach((b) => {
			b.addEventListener("click", () => switchTab(b.dataset.tab));
		});
		termPane.querySelector("#rw-btn-goto-hosts")?.addEventListener("click", () => switchTab("hosts"));

		async function openTerminal(hostInfo) {
			switchTab("term");
			if (disposed) return;
			const reqId = `r_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

			const waitingItem = {
				id: `pending_${reqId}`,
				reqId,
				tmux: hostInfo.tmux,
				tmuxSession: hostInfo.tmuxSession,
				resumeToken: hostInfo.resumeToken,
				disposables: [],
				closed: false,
				title: `${hostInfo.username}@${hostInfo.host}`,
				host: hostInfo.host,
				port: hostInfo.port || 22,
				username: hostInfo.username,
				remotePath: hostInfo.remotePath,
				connected: false,
			};
			activeShells.push(waitingItem);
			activeShellIndex = activeShells.length - 1;
			renderTermTabs();

			try {
				const xterm = await loadXterm();
				if (disposed || waitingItem.closed) return;
				const theme = buildTermTheme();
				const term = new xterm.Terminal({
					cursorBlink: true,
					fontFamily: "var(--mono, JetBrains Mono, Cascadia Code, Consolas, monospace)",
					fontSize: 13,
					lineHeight: 1.25,
					theme,
				});
				const fit = new xterm.FitAddon();
				term.loadAddon(fit);

				const cell = document.createElement("div");
				cell.className = "rw-term-cell";
				cell.innerHTML = `
					<div class="rw-term-cell-header">
						<div class="rw-term-cell-title">
							<span class="rw-cell-status">⏳</span>
							<span>${escapeHtml(waitingItem.title)}</span>
						</div>
						<div class="rw-term-cell-ops">
							<button class="rw-cell-op-btn rw-cell-max" title="最大化/恢复此窗口">⛶</button>
							<button class="rw-cell-op-btn rw-cell-clear" title="清屏">🧹</button>
							<button class="rw-cell-op-btn rw-cell-reconnect" title="重连">🔄</button>
							<button class="rw-cell-op-btn rw-cell-close" title="关闭">✖</button>
						</div>
					</div>
					<div class="rw-term-cell-body"></div>
				`;

				const containerEl = document.createElement("div");
				containerEl.style.width = "100%";
				containerEl.style.height = "100%";

				cell.querySelector(".rw-term-cell-body").appendChild(containerEl);
				const viewport = termPane.querySelector("#rw-term-viewport");
				viewport.appendChild(cell);
				term.open(containerEl);

				waitingItem.term = term;
				waitingItem.inputQueue = createInputQueue(
					(reqId, b64) => ctx.send({ action: "shell_input", shellId: waitingItem.shellId, reqId, b64 }),
					(message) => {
						if (!disposed) alert(message);
					},
				);
				waitingItem.fit = fit;
				waitingItem.dom = containerEl;
				waitingItem.cell = cell;

				cell.querySelector(".rw-cell-max").addEventListener("click", () => {
					const isMax = cell.classList.toggle("cell-maximized");
					cell.querySelector(".rw-cell-max").textContent = isMax ? "🗗" : "⛶";
					refitActiveTerm();
				});
				cell.querySelector(".rw-cell-clear").addEventListener("click", () => {
					term.clear();
					if (waitingItem.shellId) {
						waitingItem.inputQueue.enqueue("clear\r");
					}
				});
				cell.querySelector(".rw-cell-reconnect").addEventListener("click", () => {
					const reconnectHost = {
						...hostInfo,
						resumeToken: undefined,
						tmux: waitingItem.tmux,
						tmuxSession: waitingItem.tmuxSession,
					};
					closeTerminal(waitingItem);
					openTerminal(reconnectHost);
				});
				cell.querySelector(".rw-cell-close").addEventListener("click", () => {
					closeTerminal(waitingItem);
				});
				cell.addEventListener("click", () => {
					activeShellIndex = activeShells.indexOf(waitingItem);
					renderTermTabs();
				});

				ctx.send({
					action: hostInfo.resumeToken ? "shell_attach" : "shell_open",
					resumeToken: hostInfo.resumeToken,
					tmux: hostInfo.tmux,
					tmuxSession: hostInfo.tmuxSession,
					reqId,
					host: hostInfo.host,
					port: hostInfo.port || 22,
					username: hostInfo.username,
					remotePath: hostInfo.remotePath,
					cols: term.cols,
					rows: term.rows,
				});

				waitingItem.disposables.push(term.onData((data) => sendInput(data, waitingItem)));
				waitingItem.resizeObserver = new ResizeObserver(() => refitActiveTerm());
				waitingItem.resizeObserver.observe(containerEl);
				containerEl.addEventListener(
					"paste",
					(event) => {
						const text = event.clipboardData?.getData("text/plain");
						if (text && /[\r\n]/.test(text)) {
							event.preventDefault();
							event.stopImmediatePropagation();
							previewPaste(text, waitingItem);
						}
					},
					true,
				);

				waitingItem.disposables.push(
					term.onResize(({ cols, rows }) => {
						if (waitingItem.shellId) {
							ctx.send({
								action: "shell_resize",
								shellId: waitingItem.shellId,
								cols,
								rows,
							});
						}
					}),
				);

				renderTermTabs();
				refitActiveTerm();
			} catch (err) {
				alert(`打开终端失败: ${err.message}`);
				closeTerminal(waitingItem);
			}
		}

		function reconnectActiveTerminal() {
			const current = activeShells[activeShellIndex];
			if (!current) return;
			const hostInfo = {
				name: current.title,
				host: current.host,
				port: current.port,
				username: current.username,
				remotePath: current.remotePath,
				tmux: current.tmux,
				tmuxSession: current.tmuxSession,
			};
			closeTerminal(current);
			openTerminal(hostInfo);
		}

		function closePopmenu() {
			clearTimeout(popmenuTimer);
			if (popmenuListener) document.removeEventListener("click", popmenuListener);
			popmenuListener = null;
			if (activePopmenu) {
				activePopmenu.remove();
				activePopmenu = null;
			}
		}

		function toggleNewTermMenu(anchorEl) {
			if (activePopmenu) {
				closePopmenu();
				return;
			}
			const menu = document.createElement("div");
			menu.className = "rw-popmenu";
			activePopmenu = menu;

			const rect = anchorEl.getBoundingClientRect();
			const parentRect = termPane.getBoundingClientRect();
			menu.style.left = `${Math.max(8, rect.left - parentRect.left)}px`;
			menu.style.top = `${rect.bottom - parentRect.top + 4}px`;

			let html = `<div class="rw-popmenu-header">选择要连接的主机：</div>`;
			if (hosts.length === 0) {
				html += `<div style="font-size: 12px; color: var(--text-faint); padding: 6px 8px;">暂无已保存主机</div>`;
			} else {
				hosts.forEach((h, i) => {
					html += `
						<button class="rw-popmenu-item rw-pop-host" data-index="${i}">
							<span>💻 <b>${escapeHtml(h.name)}</b></span>
							<span style="font-size: 11px; color: var(--text-faint);">${escapeHtml(h.username)}@${escapeHtml(h.host)}</span>
						</button>
					`;
				});
			}

			const currentSh = activeShells[activeShellIndex];
			if (currentSh) {
				html += `
					<div class="rw-popmenu-divider"></div>
					<button class="rw-popmenu-item" id="rw-pop-dup">
						<span>📑 在当前主机新建 Shell</span>
						<span style="font-size: 11px; color: var(--text-faint);">${escapeHtml(currentSh.title)}</span>
					</button>
				`;
			}

			html += `
				<div class="rw-popmenu-divider"></div>
				<button class="rw-popmenu-item" id="rw-pop-add-new">
					<span>➕ 添加并连接新主机...</span>
				</button>
			`;
			menu.innerHTML = html;

			menu.querySelectorAll(".rw-pop-host").forEach((btn) => {
				btn.addEventListener("click", () => {
					const idx = Number(btn.dataset.index);
					const targetHost = hosts[idx];
					closePopmenu();
					if (targetHost) openTerminal(targetHost);
				});
			});

			menu.querySelector("#rw-pop-dup")?.addEventListener("click", () => {
				closePopmenu();
				if (currentSh) {
					openTerminal({
						name: currentSh.title,
						host: currentSh.host,
						port: currentSh.port,
						username: currentSh.username,
						remotePath: currentSh.remotePath,
					});
				}
			});

			menu.querySelector("#rw-pop-add-new")?.addEventListener("click", () => {
				closePopmenu();
				showEditModal(null, (newHost) => {
					openTerminal(newHost);
				});
			});

			termPane.querySelector(".rw-term-bar")?.appendChild(menu);

			const onDocClick = (evt) => {
				if (!menu.contains(evt.target) && evt.target !== anchorEl) {
					closePopmenu();
					document.removeEventListener("click", onDocClick);
				}
			};
			popmenuListener = onDocClick;
			popmenuTimer = setTimeout(() => {
				if (!disposed && activePopmenu === menu) document.addEventListener("click", onDocClick);
			}, 10);
		}

		function renderTermTabs() {
			const tabsContainer = termPane.querySelector("#rw-term-tabs");
			const emptyTip = termPane.querySelector("#rw-term-empty");
			const reconnectBar = termPane.querySelector("#rw-reconnect-bar");
			const viewport = termPane.querySelector("#rw-term-viewport");
			const countSpan = header.querySelector("#rw-term-count");
			countSpan.textContent = String(activeShells.length);

			viewport.className = `rw-term-viewport layout-${termLayout}`;

			tabsContainer.innerHTML = "";
			if (!activeShells.length) {
				emptyTip.style.display = "flex";
				reconnectBar.style.display = "none";
			} else {
				emptyTip.style.display = "none";
				const current = activeShells[activeShellIndex];
				reconnectBar.style.display = current && !current.connected && termLayout === "tabs" ? "flex" : "none";
			}

			activeShells.forEach((sh, idx) => {
				const tab = document.createElement("div");
				tab.className = `rw-term-tab ${idx === activeShellIndex ? "active" : ""}`;
				tab.innerHTML = `
					<span>${sh.connected ? "🟢" : "🔴"}</span>
					<span>${escapeHtml(sh.title)}</span>
					<span class="rw-tab-close" title="关闭会话">✖</span>
				`;

				tab.addEventListener("click", (e) => {
					if (e.target.classList.contains("rw-tab-close")) return;
					activeShellIndex = idx;
					renderTermTabs();
					refitActiveTerm();
				});

				tab.querySelector(".rw-tab-close").addEventListener("click", () => {
					closeTerminal(sh);
				});

				tabsContainer.appendChild(tab);

				if (sh.cell) {
					const statusSpan = sh.cell.querySelector(".rw-cell-status");
					if (statusSpan) statusSpan.textContent = sh.connected ? "🟢" : "🔴";
					sh.cell.classList.toggle("focused", idx === activeShellIndex);

					if (termLayout === "tabs") {
						sh.cell.style.display = idx === activeShellIndex ? "flex" : "none";
						sh.cell.querySelector(".rw-term-cell-header").style.display = "none";
					} else {
						sh.cell.style.display = "flex";
						sh.cell.querySelector(".rw-term-cell-header").style.display = "flex";
					}
				}
			});

			const addBtn = document.createElement("button");
			addBtn.className = "rw-term-tab-add";
			addBtn.id = "rw-term-add-btn";
			addBtn.title = "新建终端会话 / 连接其他主机";
			addBtn.textContent = "＋";
			tabsContainer.appendChild(addBtn);

			addBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				toggleNewTermMenu(addBtn);
			});
		}

		function refitActiveTerm() {
			clearTimeout(fitTimer);
			fitTimer = setTimeout(() => {
				if (disposed) return;
				activeShells.forEach((sh) => {
					if (sh.fit && sh.cell && sh.cell.style.display !== "none") {
						try {
							sh.fit.fit();
						} catch {}
					}
				});
			}, 50);
		}

		function closeTerminal(sh) {
			sh.closed = true;
			sh.inputQueue?.dispose();
			if (secureTarget === sh) hideSecureBar();
			broadcastTargets.delete(sh.id);
			sh.resizeObserver?.disconnect();
			for (const disposable of sh.disposables || []) disposable.dispose();
			if (!sh.shellId) ctx.send({ action: "shell_cancel", openReqId: sh.reqId });
			if (sh.shellId) {
				ctx.send({ action: "shell_close", shellId: sh.shellId });
			}
			if (sh.term) {
				try {
					sh.term.dispose();
				} catch {}
			}
			if (sh.cell) {
				try {
					sh.cell.remove();
				} catch {}
			}
			activeShells = activeShells.filter((item) => item !== sh);
			persistSessions();
			if (activeShellIndex >= activeShells.length) {
				activeShellIndex = activeShells.length - 1;
			}
			renderTermTabs();
			refitActiveTerm();
		}

		const secureBar = termPane.querySelector("#rw-secure-bar");
		const secureInput = termPane.querySelector("#rw-secure-input");
		const secureSend = termPane.querySelector("#rw-secure-send");
		const secureCancel = termPane.querySelector("#rw-secure-cancel");
		let secureTarget = null;

		function showSecureBar(target = activeShells[activeShellIndex]) {
			if (!target?.connected || target.closed) return;
			secureTarget = target;
			secureBar.querySelector("span").textContent = `凭据目标: ${target.title} (${target.port})`;
			secureBar.style.display = "flex";
			secureInput.value = "";
			if (!disposed) secureInput.focus();
		}

		function hideSecureBar() {
			secureBar.style.display = "none";
			secureInput.value = "";
			const target = secureTarget;
			secureTarget = null;
			if (!target?.closed) target?.term?.focus();
		}

		function submitSecurePassword() {
			const current = secureTarget;
			if (current?.shellId && current.connected && !current.closed) {
				const val = secureInput.value;
				current.inputQueue.enqueue(val + "\r");
			}
			hideSecureBar();
		}

		secureSend.addEventListener("click", submitSecurePassword);
		secureInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				submitSecurePassword();
			} else if (e.key === "Escape") {
				hideSecureBar();
			}
		});
		secureCancel.addEventListener("click", () => {
			const current = secureTarget;
			if (current?.shellId && current.connected && !current.closed) {
				current.inputQueue.enqueue("\x03");
			}
			hideSecureBar();
		});

		termPane.querySelectorAll(".rw-layout-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				termPane.querySelectorAll(".rw-layout-btn").forEach((b) => b.classList.remove("active"));
				btn.classList.add("active");
				termLayout = btn.dataset.layout;
				renderTermTabs();
				refitActiveTerm();
			});
		});

		const broadcastBtn = termPane.querySelector("#rw-tool-broadcast");
		broadcastBtn.addEventListener("click", () => {
			if (broadcastInput) {
				broadcastInput = false;
				broadcastTargets.clear();
				updateBroadcast();
				return;
			}
			const overlay = document.createElement("div");
			overlay.className = "rw-modal-overlay";
			overlay.innerHTML = `<div class="rw-modal"><div class="rw-modal-title">选择广播目标（输入将发送到以下环境）</div>${activeShells
				.filter((s) => s.connected)
				.map(
					(s) =>
						`<label><input type="checkbox" value="${escapeHtml(s.id)}">${escapeHtml(s.title)}:${s.port} · ${escapeHtml(hosts.find((h) => h.host === s.host && h.username === s.username && (h.port || 22) === s.port)?.environment || "未标记环境")}</label>`,
				)
				.join(
					"",
				)}<button class="rw-btn primary rw-confirm">启用所选目标</button><button class="rw-btn rw-cancel">取消</button></div>`;
			root.append(overlay);
			overlay.querySelector(".rw-cancel").onclick = () => overlay.remove();
			overlay.querySelector(".rw-confirm").onclick = () => {
				broadcastTargets.clear();
				overlay.querySelectorAll("input:checked").forEach((el) => broadcastTargets.add(el.value));
				broadcastInput = broadcastTargets.size > 0;
				updateBroadcast();
				overlay.remove();
			};
		});
		function updateBroadcast() {
			broadcastBtn.classList.toggle("primary", broadcastInput);
			broadcastBtn.textContent = broadcastInput
				? `⚡ 广播: ${activeShells
						.filter((s) => broadcastTargets.has(s.id))
						.map((s) => s.title)
						.join(", ")}`
				: "⚡ 广播输入: 关";
		}
		function sendInput(data, source, targets = null) {
			if (disposed) return;
			const recipients =
				targets || (broadcastInput ? activeShells.filter((s) => broadcastTargets.has(s.id)) : [source]);
			for (const sh of recipients) if (sh?.connected && !sh.closed && sh.shellId) sh.inputQueue.enqueue(data);
		}
		function previewPaste(text, source) {
			if (!source?.connected || source.closed) {
				alert("请先连接终端");
				return;
			}
			const recipients = broadcastInput
				? activeShells.filter((s) => broadcastTargets.has(s.id) && s.connected)
				: [source];
			const overlay = document.createElement("div");
			overlay.className = "rw-modal-overlay";
			overlay.innerHTML = `<div class="rw-modal"><div class="rw-modal-title">多行粘贴预览</div><div>${recipients.map((s) => `${escapeHtml(s.title)}:${s.port} [${escapeHtml(hosts.find((h) => h.host === s.host && h.username === s.username && (h.port || 22) === s.port)?.environment || "未标记环境")}]`).join("<br>")}</div><textarea rows="10"></textarea><button class="rw-btn primary rw-confirm">发送以上内容</button><button class="rw-btn rw-cancel">取消</button></div>`;
			overlay.querySelector("textarea").value = text;
			root.append(overlay);
			overlay.querySelector(".rw-cancel").onclick = () => overlay.remove();
			overlay.querySelector(".rw-confirm").onclick = () => {
				sendInput(overlay.querySelector("textarea").value, source, recipients);
				overlay.remove();
			};
		}

		termPane.querySelector("#rw-tool-export").addEventListener("click", () => {
			const current = activeShells[activeShellIndex];
			if (!current?.term) return;
			const buffer = current.term.buffer.active;
			const lines = [];
			for (let i = 0; i < buffer.length; i++) {
				lines.push(buffer.getLine(i)?.translateToString(true) || "");
			}
			const rawText = lines.join("\n");
			const cleanText = compact(rawText);

			navigator.clipboard.writeText(cleanText);
			const blob = new Blob([cleanText], { type: "text/plain;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `terminal-${current.title.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${Date.now()}.log`;
			a.click();
			URL.revokeObjectURL(url);
			alert("✓ 已清洗 ANSI 噪音与覆盖进度条，纯净日志已复制到剪贴板并已触发下载！");
		});

		termPane.querySelector("#rw-tool-clear").addEventListener("click", () => {
			const current = activeShells[activeShellIndex];
			if (current?.term) {
				current.term.clear();
				if (current.shellId) {
					current.inputQueue.enqueue("clear\r");
				}
			}
		});

		termPane.querySelector("#rw-tool-reconnect").addEventListener("click", reconnectActiveTerminal);
		termPane.querySelector("#rw-reconnect-btn").addEventListener("click", reconnectActiveTerminal);

		const snippetBar = termPane.querySelector("#rw-snippet-bar");
		termPane.querySelector("#rw-tool-snippet").addEventListener("click", () => {
			showSnippetBar = !showSnippetBar;
			snippetBar.style.display = showSnippetBar ? "flex" : "none";
			refitActiveTerm();
		});

		snippetBar.querySelectorAll(".rw-snippet-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const cmd = btn.dataset.cmd;
				let payload = "";
				if (cmd === "SIGINT") payload = "\x03";
				else if (cmd === "SIGQUIT") payload = "\x04";
				else if (cmd === "ESC") payload = "\x1b";
				else if (cmd === "TAB") payload = "\t";
				else payload = `${cmd}\r`;

				sendInput(payload, activeShells[activeShellIndex]);
			});
		});

		const searchBar = document.createElement("div");
		searchBar.className = "rw-snippet-bar";
		searchBar.innerHTML = `<input class="rw-search-input" placeholder="搜索终端缓冲" aria-label="搜索终端缓冲"><button class="rw-btn rw-search-prev">上一个</button><button class="rw-btn rw-search-next">下一个</button><span role="status"></span><button class="rw-btn rw-param-command">参数化命令</button>`;
		termPane.insertBefore(searchBar, termPane.querySelector("#rw-term-viewport"));
		function search(backwards) {
			const sh = activeShells[activeShellIndex];
			if (!sh?.term) return;
			sh.searchRow = findBuffer(sh.term, searchBar.querySelector("input").value, sh.searchRow ?? -1, backwards);
			searchBar.querySelector("span").textContent = sh.searchRow < 0 ? "未找到" : `第 ${sh.searchRow + 1} 行`;
		}
		searchBar.querySelector(".rw-search-prev").onclick = () => search(true);
		searchBar.querySelector(".rw-search-next").onclick = () => search(false);
		searchBar.querySelector("input").onkeydown = (e) => {
			if (e.key === "Enter") search(e.shiftKey);
		};
		searchBar.querySelector(".rw-param-command").onclick = () => {
			const template = prompt("命令模板（{{name}} 参数会按 Shell 字面量转义）", "tail -n {{lines}} {{path}}");
			if (!template) return;
			const values = {};
			for (const key of new Set([...template.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g)].map((m) => m[1]))) {
				const value = prompt(`参数 ${key}`);
				if (value === null) return;
				values[key] = value;
			}
			previewPaste(expandSnippet(template, values) + "\r", activeShells[activeShellIndex]);
		};

		termPane.querySelector("#rw-tool-fullscreen").addEventListener("click", () => {
			root.classList.toggle("rw-fullscreen");
			refitActiveTerm();
		});

		const onKeydown = (e) => {
			if (e.key === "Escape" && root.classList.contains("rw-fullscreen")) {
				root.classList.remove("rw-fullscreen");
				refitActiveTerm();
			}
		};
		document.addEventListener("keydown", onKeydown);

		const unsubscribeData = ctx.onData((msg) => {
			if (disposed) return;
			if (!msg || typeof msg !== "object") return;

			if (msg.event === "shell_drain") {
				activeShells.find((s) => s.shellId === msg.shellId)?.inputQueue?.drain();
				return;
			}
			if (msg.reqId) {
				if (activeShells.some((s) => s.inputQueue?.reply(msg))) return;
				const target = activeShells.find((s) => !s.shellId && s.id === `pending_${msg.reqId}`);
				if (target) {
					if (msg.ok && msg.shellId) {
						target.shellId = msg.shellId;
						target.resumeToken = msg.resumeToken;
						target.tmuxSession = msg.tmuxSession || target.tmuxSession;
						target.tmux = msg.tmux ?? target.tmux;
						target.connected = true;
						persistSessions();
						renderTermTabs();
						refitActiveTerm();
					} else {
						target.resumeToken = null;
						persistSessions();
						if (target.tmux && target.tmuxSession)
							target.term?.write(`\r\n[tmux ${target.tmuxSession}: 点击重连可重新附着远端会话]\r\n`);
						target.term?.write(`\r\n\x1b[31m连接失败: ${msg.error}\x1b[0m\r\n`);
					}
				}
				if (!target && msg.ok && msg.shellId && ["shell_open", "shell_attach"].includes(msg.action))
					ctx.send({ action: "shell_close", shellId: msg.shellId });
				return;
			}

			if (msg.event === "shell_data" && msg.shellId && msg.b64) {
				const target = activeShells.find((s) => s.shellId === msg.shellId);
				if (target?.term) {
					const bytes = decodeBytes(msg.b64);
					target.term.write(bytes, () => {
						if (disposed || target.closed || !target.connected) return;
						target.lastSeq = msg.seq;
						ctx.send({ action: "shell_ack", shellId: target.shellId, seq: msg.seq });
					});
					target.decoder ||= new TextDecoder();
					const decoded = target.decoder.decode(bytes, { stream: true });

					target.promptTail = ((target.promptTail || "") + decoded).slice(-512);
					const checkText = target.promptTail.trim();
					if (
						new RegExp(
							"(?:\\bpass" + "word\\s*(?:for[^:]*)?:|\\bpassphrase\\b[^:]*:|verification\\s+code\\s*:?)\\s*$",
							"i",
						).test(checkText)
					) {
						showSecureBar(target);
					}
				}
				return;
			}

			if (msg.event === "shell_gap") {
				activeShells
					.find((s) => s.shellId === msg.shellId)
					?.term?.write(`\r\n[恢复缓冲丢失 ${msg.droppedBytes} 字节]\r\n`);
				return;
			}
			if (msg.event === "shell_close" && msg.shellId) {
				const target = activeShells.find((s) => s.shellId === msg.shellId);
				if (target) {
					if (msg.tailB64) target.term?.write(decodeBytes(msg.tailB64));
					if (msg.droppedBytes) target.term?.write(`\r\n[丢失 ${msg.droppedBytes} 字节]\r\n`);
					target.inputQueue?.dispose();
					target.connected = false;
					if (secureTarget === target) hideSecureBar();
					target.resumeToken = null;
					persistSessions();
					target.term?.write("\r\n\x1b[33m[远程连接已断开]\x1b[0m\r\n");
					renderTermTabs();
				}
				return;
			}
		});

		const syncTheme = () => {
			const th = buildTermTheme();
			for (const sh of activeShells) {
				if (sh.term) {
					sh.term.options.theme = th;
				}
			}
		};
		window.addEventListener("pi-web-ui:theme-change", syncTheme);
		const themeObserver = new MutationObserver(syncTheme);
		themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });

		const onResize = () => {
			if (currentTab === "term") refitActiveTerm();
		};
		window.addEventListener("resize", onResize);
		const heartbeat = setInterval(() => {
			for (const sh of activeShells)
				if (sh.connected) ctx.send({ action: "shell_ack", shellId: sh.shellId, seq: sh.lastSeq || 0 });
			if (currentTab === "tunnels") refreshTunnels();
		}, 10000);

		async function linkSftp(h) {
			const ok = confirm(
				`是否将「${h.name}」绑定至当前项目的 SFTP 同步？\n绑定后可在顶部「SFTP 同步」面板直接比较文件差异与上传下载。`,
			);
			if (!ok) return;
			try {
				const res = await fetch(appPath(ctx, "/plugins-api/sftp/use-global", import.meta.url), {
					signal: lifecycle.signal,
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ globalName: h.name, remotePath: h.remotePath || "/" }),
				});
				const json = await res.json();
				if (json.ok) {
					alert(`✓ 已将「${h.name}」配置为当前项目的 SFTP 远端！`);
				} else {
					alert(`绑定失败: ${json.error}`);
				}
			} catch (err) {
				alert(`SFTP 插件响应异常: ${err.message}`);
			}
		}

		async function openWorkspace(h, initialPath, onSuccess) {
			const host = globalThis.window?.__piWebUiHost;
			if (!host || typeof host.pickDirectory !== "function") {
				alert("宿主路径选择组件尚未就绪，请刷新重试");
				return;
			}

			const pathVal = initialPath || h.remotePath || (h.username === "root" ? "/root" : `/home/${h.username}`);
			const initialUri = buildRemoteWorkspaceUri(h, pathVal);

			try {
				const res = await host.pickDirectory({
					initialPath: initialUri,
					title: `选择远程工作区 — ${h.name}`,
				});

				if (!res || !res.ok || !res.path) {
					return;
				}

				const targetUri = res.path;
				const sessionRes = await host.openSession({ cwd: targetUri, newChat: false });
				if (sessionRes && sessionRes.ok) {
					if (typeof onSuccess === "function") {
						try {
							onSuccess();
						} catch {}
					}
					if (typeof host.setView === "function") {
						host.setView("chat");
					}
				} else {
					alert(`切换远程工作区失败: ${sessionRes?.error || "未知原因"}`);
				}
			} catch (err) {
				alert(`打开远程工作区异常: ${err.message}`);
			}
		}

		async function deleteHost(name) {
			if (!confirm(`确定要从全局主机库（global-hosts.json）中删除「${name}」吗？`)) return;
			try {
				await api("/hosts/delete", {
					method: "POST",
					body: JSON.stringify({ name }),
				});
				await refreshHosts();
			} catch (err) {
				alert(`删除失败: ${err.message}`);
			}
		}

		function showCreateTunnelModal(targetHost = null) {
			const overlay = document.createElement("div");
			overlay.className = "rw-modal-overlay";
			const hostOptions = hosts
				.map(
					(h) =>
						`<option value="${escapeHtml(h.name)}" ${targetHost?.name === h.name ? "selected" : ""}>${escapeHtml(h.name)} (${h.username}@${h.host})</option>`,
				)
				.join("");

			overlay.innerHTML = `
				<div class="rw-modal">
					<div class="rw-modal-title">🔀 新建本地端口转发 (-L Tunnel)</div>
					<div id="rw-tun-err" style="color: var(--red); font-size: 12px; display: none;"></div>

					<div class="rw-form-row">
						<label>SSH 跳板主机 *</label>
						<select id="rw-tun-host">
							${hostOptions}
						</select>
					</div>

					<div class="rw-form-inline">
						<div class="rw-form-row">
							<label>本地监听端口 *</label>
							<input type="number" id="rw-tun-localport" placeholder="如 8080 / 6379" value="8080" />
						</div>
						<div class="rw-form-row">
							<label>远端目标端口 *</label>
							<input type="number" id="rw-tun-remoteport" placeholder="如 80 / 3000 / 6379" value="80" />
						</div>
					</div>

					<div class="rw-form-row">
						<label>远端目标地址 (以远端主机视角)</label>
						<input type="text" id="rw-tun-targethost" value="127.0.0.1" placeholder="127.0.0.1 或内网 IP" />
					</div>

					<div class="rw-modal-footer">
						<button class="rw-btn" id="rw-tun-cancel">取消</button>
						<label><input type="checkbox" id="rw-tun-auto">断线自动恢复</label><label><input type="checkbox" id="rw-tun-save-only">仅保存配置</label><button class="rw-btn primary" id="rw-tun-start">保存并开启转发</button>
					</div>
				</div>
			`;
			root.appendChild(overlay);

			const errBox = overlay.querySelector("#rw-tun-err");
			overlay.querySelector("#rw-tun-cancel").addEventListener("click", () => overlay.remove());

			overlay.querySelector("#rw-tun-start").addEventListener("click", async () => {
				const hostName = overlay.querySelector("#rw-tun-host").value;
				const localPort = Number(overlay.querySelector("#rw-tun-localport").value);
				const targetHost = overlay.querySelector("#rw-tun-targethost").value.trim() || "127.0.0.1";
				const targetPort = Number(overlay.querySelector("#rw-tun-remoteport").value);

				if (!localPort) {
					errBox.textContent = "请填写本地监听端口";
					errBox.style.display = "block";
					return;
				}
				if (!targetPort) {
					errBox.textContent = "请填写远端目标端口";
					errBox.style.display = "block";
					return;
				}

				const startBtn = overlay.querySelector("#rw-tun-start");
				startBtn.disabled = true;
				startBtn.textContent = "启动中…";

				try {
					const saved = await post("/tunnels/save", {
						hostName,
						localPort,
						targetHost,
						targetPort,
						autoReconnect: overlay.querySelector("#rw-tun-auto").checked,
					});
					if (!overlay.querySelector("#rw-tun-save-only").checked)
						await post("/tunnels/start", { id: saved.tunnel.id });
					overlay.remove();
					switchTab("tunnels");
				} catch (err) {
					errBox.textContent = err.message;
					errBox.style.display = "block";
					startBtn.disabled = false;
					startBtn.textContent = "开启转发";
				}
			});
		}

		function showEditModal(existingHost = null, onSaved = null) {
			if (modalVisible) return;
			modalVisible = true;

			const isEdit = Boolean(existingHost);
			const overlay = document.createElement("div");
			overlay.className = "rw-modal-overlay";
			overlay.innerHTML = `
				<div class="rw-modal">
					<div class="rw-modal-title">${isEdit ? "✎ 编辑远程主机" : "＋ 添加远程主机"}（存入 global-hosts.json）</div>
					<div id="rw-modal-err" style="color: var(--red); font-size: 12px; display: none;"></div>
					
					<div class="rw-form-inline">
						<div class="rw-form-row" style="flex: 2;">
							<label>主机地址 (IP / 域名) *</label>
							<input type="text" id="rw-in-host" value="${escapeHtml(existingHost?.host || "")}" placeholder="192.168.1.100" />
						</div>
						<div class="rw-form-row" style="flex: 1;">
							<label>端口</label>
							<input type="number" id="rw-in-port" value="${existingHost?.port || 22}" />
						</div>
					</div>

					<div class="rw-form-inline">
						<div class="rw-form-row">
							<label>用户名 *</label>
							<input type="text" id="rw-in-user" value="${escapeHtml(existingHost?.username || "root")}" placeholder="root / ubuntu" />
						</div>
						<div class="rw-form-row">
							<label>认证方式</label>
							<select id="rw-in-authtype">
								<option value="password" ${existingHost?.authType === "password" ? "selected" : ""}>密码</option>
								<option value="key" ${existingHost?.authType === "key" ? "selected" : ""}>私钥</option>
								<option value="agent" ${existingHost?.authType === "agent" ? "selected" : ""}>SSH Agent</option>
							</select>
						</div>
					</div>

					<div class="rw-form-row" id="rw-row-password" style="${existingHost?.authType === "key" || existingHost?.authType === "agent" ? "display: none;" : ""}">
						<label>密码 ${isEdit ? "(留空 = 保持已保存的密码不变)" : ""}</label>
						<input type="password" id="rw-in-password" placeholder="${isEdit ? "留空表示不修改已有密码" : "••••••••"}" />
					</div>

					<div class="rw-form-row" id="rw-row-key" style="${existingHost?.authType === "key" ? "" : "display: none;"}">
						<label>私钥路径 (留空自动尝试 ~/.ssh 常用密钥)</label>
						<input type="text" id="rw-in-keypath" value="${escapeHtml(existingHost?.privateKeyPath || "")}" placeholder="~/.ssh/id_ed25519" />
						<label style="margin-top: 5px;">私钥口令 (可选)</label>
						<input type="password" id="rw-in-passphrase" placeholder="Passphrase" />
					</div>

					<div class="rw-form-inline">
						<div class="rw-form-row">
							<label>配置别名 (唯一键)</label>
							<input type="text" id="rw-in-name" value="${escapeHtml(existingHost?.name || "")}" placeholder="留空自动生成" ${isEdit ? "readonly" : ""} />
						</div>
						<div class="rw-form-row">
							<label>默认远端路径</label>
							<input type="text" id="rw-in-path" value="${escapeHtml(existingHost?.remotePath || "")}" placeholder="/var/www 或 ~" />
						</div>
					</div>

					<div class="rw-form-row">
						<label style="display: flex; align-items: center; gap: 7px; cursor: pointer; user-select: none;">
							<input type="checkbox" id="rw-in-review" ${existingHost?.reviewMode ? "checked" : ""} />
							<span style="font-size: 12.5px; color: var(--text);">🛡️ 开启高危指令审阅保护模式（拦截 AI 针对本机的 rm -rf 等破坏性操作）</span>
						</label>
					</div>

					<div class="rw-modal-footer">
						<button class="rw-btn" id="rw-modal-probe">测试连接</button>
						<button class="rw-btn" id="rw-modal-cancel">取消</button>
						<button class="rw-btn primary" id="rw-modal-save">保存</button>
					</div>
				</div>
			`;

			root.appendChild(overlay);

			const authSelect = overlay.querySelector("#rw-in-authtype");
			const passRow = overlay.querySelector("#rw-row-password");
			const keyRow = overlay.querySelector("#rw-row-key");
			const errBox = overlay.querySelector("#rw-modal-err");

			authSelect.addEventListener("change", () => {
				const val = authSelect.value;
				passRow.style.display = val === "password" ? "flex" : "none";
				keyRow.style.display = val === "key" ? "flex" : "none";
			});

			function getPayload() {
				const hostAddr = overlay.querySelector("#rw-in-host").value.trim();
				const port = Number(overlay.querySelector("#rw-in-port").value) || 22;
				const username = overlay.querySelector("#rw-in-user").value.trim();
				const authType = authSelect.value;
				const name = overlay.querySelector("#rw-in-name").value.trim();
				const remotePath = overlay.querySelector("#rw-in-path").value.trim();
				const password = overlay.querySelector("#rw-in-password").value;
				const privateKeyPath = overlay.querySelector("#rw-in-keypath").value.trim();
				const passphrase = overlay.querySelector("#rw-in-passphrase").value;
				const reviewMode = overlay.querySelector("#rw-in-review").checked;

				if (!hostAddr) throw new Error("请填写主机地址");
				if (!username) throw new Error("请填写用户名");

				return {
					name,
					host: hostAddr,
					port,
					username,
					remotePath,
					reviewMode,
					auth: {
						type: authType,
						password: authType === "password" && password ? password : undefined,
						privateKeyPath: authType === "key" ? privateKeyPath : undefined,
						passphrase: authType === "key" && passphrase ? passphrase : undefined,
					},
				};
			}

			overlay.querySelector("#rw-modal-probe").addEventListener("click", async () => {
				try {
					errBox.style.display = "none";
					const p = getPayload();
					const probeBtn = overlay.querySelector("#rw-modal-probe");
					probeBtn.textContent = "探测中…";
					probeBtn.disabled = true;

					const res = await api("/hosts/probe", {
						method: "POST",
						body: JSON.stringify(p),
					});
					probeBtn.textContent = "测试连接";
					probeBtn.disabled = false;

					const isSuccess = Boolean(res.connected || res.ok);
					if (isSuccess) {
						const memStr = formatMem(res.system?.totalMemMb);
						const osStr = res.system?.distro || res.system?.os || "Linux";
						const coresStr = `${res.system?.cores || 1} 核`;
						alert(
							`✓ 连接可用（可能复用已建立 SSH，不能验证新输入凭据）！\n系统: ${osStr} (${res.system?.arch || "x64"})\nCPU: ${coresStr}${memStr ? ` | 内存: ${memStr}` : ""}`,
						);
					} else {
						errBox.textContent = `连接失败: ${res.error || "未知原因"}`;
						errBox.style.display = "block";
					}
				} catch (err) {
					errBox.textContent = err.message;
					errBox.style.display = "block";
					overlay.querySelector("#rw-modal-probe").textContent = "测试连接";
					overlay.querySelector("#rw-modal-probe").disabled = false;
				}
			});

			overlay.querySelector("#rw-modal-save").addEventListener("click", async () => {
				try {
					errBox.style.display = "none";
					const p = getPayload();
					const saveBtn = overlay.querySelector("#rw-modal-save");
					saveBtn.textContent = "保存中…";
					saveBtn.disabled = true;

					await api("/hosts", {
						method: "POST",
						body: JSON.stringify(p),
					});
					closeModal();
					await refreshHosts();
					if (typeof onSaved === "function") {
						onSaved(p);
					}
				} catch (err) {
					errBox.textContent = err.message;
					errBox.style.display = "block";
					const saveBtn = overlay.querySelector("#rw-modal-save");
					if (saveBtn) {
						saveBtn.textContent = "保存";
						saveBtn.disabled = false;
					}
				}
			});

			function closeModal() {
				overlay.remove();
				modalVisible = false;
			}

			overlay.querySelector("#rw-modal-cancel").addEventListener("click", closeModal);
		}

		header.querySelector("#rw-btn-add").addEventListener("click", () => showEditModal());

		refreshHosts();
		refreshTunnels();
		container.appendChild(root);

		for (const session of readSessions(sessionStorage, sessionKey)) if (session.resumeToken) openTerminal(session);
		const tmuxRecovery = readSessions(sessionStorage, sessionKey).filter((s) => !s.resumeToken && s.tmuxSession);
		if (tmuxRecovery.length) {
			const recover = document.createElement("button");
			recover.className = "rw-btn";
			recover.textContent = "重新连接保存的 tmux 会话";
			recover.onclick = () => {
				for (const session of tmuxRecovery) openTerminal(session);
				recover.remove();
			};
			header.querySelector(".rw-header-right").append(recover);
		}

		return () => {
			const queuedInput = activeShells.filter((sh) => sh.inputQueue?.bytes > 0);
			if (queuedInput.length)
				alert(
					`工作台已脱离，以下输入仍未发送或未获接受确认，恢复后请核对终端再决定是否重输：\n${queuedInput.map((sh) => `${sh.title}:${sh.port} · ${sh.inputQueue.bytes} 字节`).join("\n")}`,
				);
			disposed = true;
			persistSessions();
			lifecycle.abort();
			clearTimeout(fitTimer);
			clearInterval(heartbeat);
			operations.dispose();
			closePopmenu();
			unsubscribeData?.();
			document.removeEventListener("keydown", onKeydown);
			window.removeEventListener("resize", onResize);
			root.remove();
			window.removeEventListener("pi-web-ui:theme-change", syncTheme);
			themeObserver.disconnect();
			for (const sh of activeShells) {
				sh.closed = true;
				sh.inputQueue?.dispose();
				if (sh.shellId) ctx.send({ action: "shell_detach", shellId: sh.shellId });
				else ctx.send({ action: "shell_cancel", openReqId: sh.reqId });
				sh.resizeObserver?.disconnect();
				for (const disposable of sh.disposables || []) disposable.dispose();
				try {
					sh.term?.dispose();
				} catch {}
			}
			activeShells = [];
		};
	},
};
