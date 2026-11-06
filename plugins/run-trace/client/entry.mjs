const LANE_FILTER = { input: "input", model: "model", tools: "tools" };

const I18N = {
	zh: {
		title: "运行轨迹",
		live: "实时",
		current: "当前",
		search: "搜索分段…",
		fit: "⤢ 适应",
		follow: "◎ 跟随",
		zoomHint: "滚轮缩放 · 拖拽平移 · 点击色块看分析",
		flowHint: "实时流动 · 刻度固定 · 拖拽暂停跟随",
		replay: "回放",
		exitReplay: "退出回放",
		play: "播放",
		pause: "暂停",
		speed: "速度",
		skipIdle: "跳过空闲",
		clear: "清空",
		confirmClear: "确定清空全部轨迹吗？（重拉当前对话恢复）",
		empty: "暂无对话",
		emptyHint: "打开一个对话后，这里直接显示它的时间线与分析。",
		selectHint: "点击时间轴色块或左侧分段查看分析。",
		loading: "加载中…",
		noMatch: "没有匹配的分段（检查搜索/筛选）。",
		copy: "复制",
		copied: "已复制",
		lanes: { input: "输入", model: "模型", tools: "工具" },
		filters: { input: "输入", model: "模型", tools: "工具" },
		tabs: { overview: "概述", preview: "预览", raw: "原始内容", source: "来源" },
		status: { done: "已完成", running: "执行中", error: "失败" },
		f: {
			source: "来源",
			status: "状态",
			dur: "时长",
			turn: "轮次",
			len: "长度",
			pos: "位置",
			total: "总时长",
			turns: "轮数",
			segs: "分段",
			toolCalls: "工具调用",
			toolErr: "工具失败",
			toolTime: "工具耗时",
			slowest: "最慢工具",
			files: "文件改动",
			phase: "阶段分布",
			calls: "累计调用",
			avg: "平均",
			errRate: "失败率",
			share: "耗时占比",
			msgKey: "消息",
			toolCall: "调用",
			conv: "对话",
			time: "时间",
		},
	},
	en: {
		title: "Run Trace",
		live: "live",
		current: "active",
		search: "Search segments…",
		fit: "⤢ Fit",
		follow: "◎ Follow",
		zoomHint: "wheel zoom · drag pan · click a block for analysis",
		flowHint: "live flow · fixed ruler · drag pauses follow",
		replay: "Replay",
		exitReplay: "Exit replay",
		play: "Play",
		pause: "Pause",
		speed: "Speed",
		skipIdle: "skip idle",
		clear: "Clear",
		confirmClear: "Clear all traces? (re-pull restores the open conversation)",
		empty: "No conversation",
		emptyHint: "Open a conversation and its timeline + analysis show up here.",
		selectHint: "Click a ruler block or a left segment for analysis.",
		loading: "Loading…",
		noMatch: "No matching segments (check search/filters).",
		copy: "Copy",
		copied: "Copied",
		lanes: { input: "Input", model: "Model", tools: "Tools" },
		filters: { input: "Input", model: "Model", tools: "Tools" },
		tabs: { overview: "Overview", preview: "Preview", raw: "Raw", source: "Source" },
		status: { done: "Done", running: "Running", error: "Failed" },
		f: {
			source: "Source",
			status: "Status",
			dur: "Duration",
			turn: "Turn",
			len: "Length",
			pos: "Position",
			total: "Total",
			turns: "Turns",
			segs: "Segments",
			toolCalls: "Tool calls",
			toolErr: "Tool errors",
			toolTime: "Tool time",
			slowest: "Slowest tools",
			files: "Files changed",
			phase: "Phases",
			calls: "Calls",
			avg: "Avg",
			errRate: "Error rate",
			share: "Time share",
			msgKey: "Message",
			toolCall: "Call",
			conv: "Conversation",
			time: "Time",
		},
	},
};

import { esc } from "@pi-web-ui/plugin-sdk/client";

function fmtClock(t) {
	try {
		return new Date(t).toLocaleTimeString();
	} catch {
		return "";
	}
}
function fmtDur(ms) {
	if (ms === undefined || ms === null) return "—";
	const s = Math.max(0, ms) / 1000;
	if (s < 1) return `${Math.round(ms)}ms`;
	if (s < 60) return `${s.toFixed(1)}s`;
	return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}
function chipFor(seg, lang) {
	if (seg.kind === "user") return lang === "zh" ? "用户" : "user";
	if (seg.kind === "thinking") return lang === "zh" ? "思考" : "think";
	if (seg.kind === "text") return lang === "zh" ? "回答" : "text";
	if (seg.kind === "file") return lang === "zh" ? "文件" : "file";
	if (seg.kind === "system") return lang === "zh" ? "系统" : "sys";
	if (seg.kind === "result") return lang === "zh" ? "结果" : "done";
	if (seg.kind === "tool") return (seg.meta?.tool ?? "tool").slice(0, 10);
	return seg.kind;
}

const TOOL_PALETTE = [
	"#3b82f6",
	"#22c55e",
	"#ec4899",
	"#06b6d4",
	"#f97316",
	"#84cc16",
	"#818cf8",
	"#fb7185",
	"#eab308",
	"#14b8a6",
];
const TOOL_FIXED = {
	read: "#2dd4bf",
	get: "#2dd4bf",
	list: "#2dd4bf",
	glob: "#2dd4bf",
	grep: "#2dd4bf",
	search: "#2dd4bf",
	fetch: "#2dd4bf",
	cat: "#2dd4bf",
	show: "#2dd4bf",
	query: "#2dd4bf",
	edit: "#f59e0b",
	write: "#f59e0b",
	patch: "#f59e0b",
	apply: "#f59e0b",
	create: "#f59e0b",
	save: "#f59e0b",
	move: "#f59e0b",
	rename: "#f59e0b",
	bash: "#a78bfa",
};
function toolColor(name) {
	const n = String(name ?? "tool");
	if (TOOL_FIXED[n]) return TOOL_FIXED[n];
	let h = 0;
	for (let i = 0; i < n.length; i++) h = ((h << 5) - h + n.charCodeAt(i)) | 0;
	return TOOL_PALETTE[Math.abs(h) % TOOL_PALETTE.length];
}

const MODEL_COLORS = { thinking: "#38bdf8", text: "#3b82f6" };
function laneColor(seg) {
	if (seg.status === "error") return "#f87171";
	if (seg.lane === "tools") return toolColor(seg.meta?.tool ?? (seg.kind === "file" ? "file" : "tool"));
	if (seg.lane === "model" && (seg.kind === "thinking" || seg.kind === "text")) return MODEL_COLORS[seg.kind];
	return null;
}

export default {
	mount(container, ctx) {
		let lang = "zh";
		const t = () => I18N[lang];
		let convs = [];
		let activeId = null;
		let lastActiveId = null;
		let selectedConvId = null;
		const segsCache = new Map();
		const detailCache = new Map();
		const pendingSeg = new Set();
		let selectedKey = null;
		let pendingScroll = null;
		let detailTab = "overview";
		let search = "";
		const filters = { input: true, model: true, tools: true };
		const replay = { on: false, idx: 0, playing: false, speed: 1, skipIdle: true, raf: 0, basePos: 0, baseClock: 0 };
		let raf = 0;
		let visApi = null;
		let visPromise = null;
		let tl = null;
		let tlItems = null;
		let tlDomEl = null;
		let tlConv = null;
		let userZoomed = false;
		let followEnabled = true;
		let suppressSelect = false;
		let tlRO = null;
		let roTimer = 0;

		function ensureVis() {
			if (!visPromise) {
				visPromise = (async () => {
					try {
						const mod = await import("./vendor/vis-timeline.bundle.mjs").catch(
							() => import("https://esm.sh/vis-timeline@8.5.4/standalone/esm/vis-timeline-graph2d.min.mjs"),
						);
						injectVisCss();
						return { Timeline: mod.Timeline, DataSet: mod.DataSet };
					} catch {
						return null;
					}
				})();
				visPromise.then((api) => {
					visApi = api;
					if (api) scheduleRender(false);
				});
			}
		}

		function injectVisCss() {
			try {
				if (document.querySelector("link[data-rtr-vis]")) return;
				const link = document.createElement("link");
				link.rel = "stylesheet";
				link.dataset.rtrVis = "1";
				link.href = new URL("./vendor/vis-timeline.css", import.meta.url).href;
				document.head.appendChild(link);
			} catch {}
		}

		function tlDom() {
			if (!tlDomEl) tlDomEl = document.createElement("div");
			return tlDomEl;
		}

		function destroyTl() {
			hideTip();
			flowStop();
			try {
				tl?.destroy();
			} catch {}
			tl = null;
			tlItems = null;
			tlConv = null;
		}

		container.innerHTML = `
<div class="rtr">
	<style>
		.rtr { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; color: var(--text, #e6e8ef); position: relative; }
		.rtr-hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border, #262a35); flex-wrap: wrap; }
		.rtr-hd h2 { margin: 0; font-size: 15px; }
		.rtr-live { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: var(--green-soft, rgba(52,211,153,.12)); color: var(--green, #34d399); }
		.rtr-hd input[type="search"] { background: var(--bg-elev, #14161c); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; padding: 5px 9px; font: inherit; width: 140px; }
		.rtr-hd .sp { flex: 1; }
		.rtr-btn { background: var(--bg-elev, #14161c); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; padding: 5px 10px; cursor: pointer; font: inherit; }
		.rtr-btn:hover { border-color: var(--accent, #8b5cff); }
		.rtr-btn.on { background: var(--accent-soft, rgba(139,92,246,.14)); border-color: var(--accent, #8b5cff); }
		.rtr-btn.danger:hover { border-color: var(--red, #f87171); color: var(--red, #f87171); }
		.rtr-convs { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--border, #262a35); overflow-x: auto; align-items: center; }
		.rtr-conv { border: 1px solid var(--border, #262a35); background: transparent; color: inherit; font: inherit; border-radius: 99px; padding: 3px 12px; cursor: pointer; white-space: nowrap; font-size: 12px; opacity: .65; }
		.rtr-conv.sel { opacity: 1; border-color: var(--accent, #8b5cff); background: var(--accent-soft, rgba(139,92,246,.14)); }
		.rtr-conv .cur { color: var(--green, #34d399); }
		.rtr-ruler { border-bottom: 1px solid var(--border, #262a35); padding: 6px 12px 8px; background: var(--bg-elev, #14161c); }
		.rtr-rulerbar { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
		.rtr-rulerbar .hint { font-size: 11px; opacity: .5; }
		.rtr-rulerbar .sp { flex: 1; }
		.rtr-rulerbar .rtr-btn { font-size: 11px; padding: 2px 9px; }
		.rtr-tlbody { height: 252px; position: relative; }
		.rtr-tlbody .vis-timeline { border: 0; background: transparent; }
		/* 流动模式：隐藏 vis 自带轴线/网格，改由 .rtr-flowgrid 自绘「位置固定、数值滚动」的刻度尺。 */
		.rtr-tlbody.flowing .vis-panel.vis-top, .rtr-tlbody.flowing .vis-panel.vis-background.vis-vertical { visibility: hidden; }
		.rtr-tlbody.flowing .vis-itemset { will-change: transform; }
		.rtr-flowgrid { position: absolute; inset: 0; pointer-events: none; z-index: 5; display: none; }
		.rtr-tlbody.flowing .rtr-flowgrid { display: block; }
		.rtr-fgtop, .rtr-fgcols { position: absolute; overflow: hidden; }
		.rtr-fgtop { top: 0; height: 24px; }
		.rtr-fgcols { bottom: 0; }
		.rtr-fgcols i { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--border-soft, #1e2230); }
		.rtr-fgtop b { position: absolute; top: 0; font-weight: 400; font-size: 11px; line-height: 20px; color: var(--text-faint, #6b7284); white-space: nowrap; font-variant-numeric: tabular-nums; }
		.rtr-fgnow { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--accent, #8b5cff); box-shadow: 0 0 8px var(--accent-soft, rgba(139,92,246,.5)); }
		.rtr-fgnow u { position: absolute; top: 0; left: 50%; transform: translateX(-50%); padding: 0 5px; border-radius: 0 0 4px 4px; background: var(--accent, #8b5cff); color: var(--accent-contrast, #fff); font-size: 10px; line-height: 15px; text-decoration: none; white-space: nowrap; font-variant-numeric: tabular-nums; }
		.rtr-tlbody .vis-panel.vis-left, .rtr-tlbody .vis-panel.vis-center { border-color: var(--border-soft, #1e2230); }
		.rtr-tlbody .vis-labelset .vis-label { color: var(--text-dim, #9aa1b4); border-color: var(--border-soft, #1e2230); background: transparent; }
		.rtr-tlbody .vis-time-axis .vis-text { color: var(--text-faint, #6b7284); }
		.rtr-tlbody .vis-time-axis .vis-grid.vis-minor, .rtr-tlbody .vis-time-axis .vis-grid.vis-major { border-color: var(--border-soft, #1e2230); }
		.rtr-tlbody .vis-item { border-radius: 0; cursor: pointer; height: 12px; }
		.rtr-tlbody .vis-item::after { content: ""; position: absolute; left: -5px; right: -5px; top: -6px; bottom: -6px; }
		.rtr-tip { position: absolute; z-index: 50; pointer-events: none; background: var(--bg-elev2, #1a1d26); border: 1px solid var(--accent, #8b5cff); border-radius: 7px; padding: 6px 10px; font-size: 12px; max-width: 320px; box-shadow: 0 4px 16px rgba(0,0,0,.45); }
		.rtr-tip .tt { font-weight: 700; margin-bottom: 2px; }
		.rtr-tip .tm { opacity: .65; font-size: 11px; }
		.rtr-tlbody .vis-item .vis-item-content { display: none; }
		.rtr-tlbody .vis-item.lane-input { background: #64748b; border-color: #64748b; }
		.rtr-tlbody .vis-item.lane-model { background: #3b82f6; border-color: #3b82f6; }
		.rtr-tlbody .vis-item.lane-tools { background: #22c55e; border-color: #16a34a; }
		.rtr-tlbody .vis-item.st-error { background: var(--red, #f87171); border-color: var(--red, #f87171); }
		.rtr-tlbody .vis-item.st-running { animation: rtr-blink 1.2s infinite; }
		.rtr-tlbody .vis-item.vis-selected { outline: 2px solid #fff; outline-offset: -1px; z-index: 2; }
		.rtr-tlbody .vis-item { box-shadow: 0 1px 5px rgba(0,0,0,.4); }
		.rtr-tlbody .vis-item.vis-selected { box-shadow: 0 0 0 1px #fff, 0 2px 10px rgba(0,0,0,.5); }
		.rtr-axis { display: flex; justify-content: space-between; font-size: 11px; opacity: .55; margin-bottom: 4px; }
		.rtr-legend { display: flex; gap: 4px 12px; flex-wrap: wrap; padding: 5px 0 7px; font-size: 11px; }
		.rtr-legend .lg-item { display: inline-flex; align-items: center; gap: 5px; opacity: .85; }
		.rtr-legend .lg-item i { width: 10px; height: 10px; border-radius: 0; display: inline-block; box-shadow: 0 1px 3px rgba(0,0,0,.4); }
		.rtr-lane { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
		.rtr-lane .ln { width: 34px; flex: none; font-size: 11px; opacity: .6; text-align: right; }
		.rtr-track { position: relative; flex: 1; height: 16px; background: var(--bg-elev2, #1a1d26); border-radius: 4px; overflow: hidden; }
		.rtr-blk { position: absolute; top: 2px; height: 10px; border-radius: 0; background: #3b82f6; opacity: .85; cursor: pointer; }
		.rtr-blk.lane-input { background: #64748b; }
		.rtr-blk.lane-model { background: #3b82f6; }
		.rtr-blk.lane-tools { background: #22c55e; }
		.rtr-blk.st-error { background: var(--red, #f87171); }
		.rtr-blk.st-running { animation: rtr-blink 1.2s infinite; }
		.rtr-blk.sel { outline: 2px solid #fff; outline-offset: -1px; z-index: 1; }
		@keyframes rtr-blink { 50% { opacity: .35; } }
		.rtr-bd { display: flex; flex: 1; min-height: 0; }
		.rtr-list { flex: 1; min-width: 0; border-right: 1px solid var(--border, #262a35); overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 5px; }
		.rtr-row { display: flex; gap: 8px; align-items: baseline; border: 1px solid transparent; border-radius: 7px; padding: 6px 9px; cursor: pointer; background: transparent; color: inherit; font: inherit; text-align: left; width: 100%; }
		.rtr-row:hover { border-color: var(--accent, #8b5cff); }
		.rtr-row.sel { background: var(--accent-soft, rgba(139,92,246,.14)); border-color: var(--accent, #8b5cff); }
		.rtr-chip { flex: none; font-size: 11px; padding: 1px 7px; border-radius: 5px; background: var(--bg-elev2, #1a1d26); border: 1px solid var(--border, #262a35); }
		.rtr-row .tt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.rtr-row time { flex: none; font-size: 11px; opacity: .55; }
		.rtr-row.err .rtr-chip { border-color: var(--red, #f87171); color: var(--red, #f87171); }
		.rtr-detail { width: 320px; min-width: 320px; flex: none; overflow-y: auto; padding: 12px 14px; min-height: 0; }
		.rtr-dtabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border, #262a35); margin-bottom: 10px; }
		.rtr-dtab { background: transparent; border: 0; border-bottom: 2px solid transparent; color: inherit; font: inherit; padding: 6px 12px; cursor: pointer; opacity: .6; }
		.rtr-dtab.on { opacity: 1; border-bottom-color: var(--accent, #8b5cff); }
		.rtr-kv { display: grid; grid-template-columns: 86px 1fr; gap: 5px 10px; font-size: 12px; margin-bottom: 12px; }
		.rtr-kv dt { opacity: .55; }
		.rtr-kv dd { margin: 0; word-break: break-word; }
		.rtr-sec { font-size: 12px; font-weight: 700; margin: 12px 0 6px; opacity: .8; }
		.rtr-bar { height: 8px; border-radius: 4px; background: var(--bg-elev2, #1a1d26); overflow: hidden; margin: 3px 0 7px; }
		.rtr-bar i { display: block; height: 100%; background: #3b82f6; }
		.rtr-detail pre { white-space: pre-wrap; word-break: break-word; background: var(--bg-elev, #14161c); border: 1px solid var(--border, #262a35); border-radius: 8px; padding: 9px 11px; font-size: 12px; margin: 0; }
		.rtr-empty { opacity: .6; text-align: center; padding: 40px 20px; }
		.rtr-spin { display: inline-block; animation: rtr-blink 1s infinite; }
		.rtr-replaybar { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--border, #262a35); background: var(--bg-elev, #14161c); font-size: 12px; }
		.rtr-replaybar input[type="range"] { flex: 1; accent-color: var(--accent, #8b5cff); }
		.rtr-replaybar select { background: var(--bg-elev2, #1a1d26); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; font: inherit; padding: 2px 6px; }
		.rtr-replaybar .skip { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; opacity: .85; white-space: nowrap; }
		.rtr-replaybar .skip input { accent-color: var(--accent, #8b5cff); margin: 0; }
		.rtr-tlbody .rtr-playhead { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--accent, #8b5cff); pointer-events: none; z-index: 6; display: none; }
		/* ---- 手机竖屏适配（≤640px）：纯覆盖，不碰桌面端 ---- */
		@media (max-width: 640px) {
			/* 三段改上下堆叠：时间轴在上，底部列表/详情两部分均分剩余高度、各内部自滚 */
			.rtr-bd { flex-direction: column; overflow: hidden; padding-bottom: env(safe-area-inset-bottom, 0px); }
			.rtr-list { flex: 1 1 0; min-height: 0; max-height: none; border-right: 0; border-bottom: 1px solid var(--border, #262a35); overflow-y: auto; }
			.rtr-detail { width: auto; min-width: 0; flex: 1 1 0; min-height: 0; overflow-y: auto; }
			/* 头部：搜索框占满剩余行，按钮给到可点尺寸 */
			.rtr-hd { gap: 10px; padding: 10px; }
			.rtr-hd input[type="search"] { flex: 1 1 140px; width: auto; min-width: 120px; min-height: 36px; padding: 8px 10px; }
			/* iOS：字号 <16px 的 input 聚焦会自动缩放页面，窄屏统一提到 16px */
			.rtr input, .rtr select, .rtr textarea { font-size: 16px; }
			.rtr-btn { min-height: 36px; padding: 7px 12px; }
			.rtr-conv { padding: 8px 14px; min-height: 36px; }
			.rtr-dtab { padding: 8px 12px; min-height: 36px; }
			.rtr-row { padding: 10px; min-height: 36px; }
			/* 时间轴省纵向空间（JS 传给 vis 的 height:"252px" 由下一条 !important 盖住显示层，不改 JS） */
			.rtr-ruler { padding: 6px 8px 8px; }
			.rtr-rulerbar { gap: 10px; }
			.rtr-rulerbar .rtr-btn { font-size: 12px; padding: 7px 12px; min-height: 36px; }
			.rtr-tlbody { height: 200px; }
			.rtr-tlbody .vis-timeline { height: 200px !important; min-height: 200px; max-height: 200px; }
			/* 窄屏细节：tooltip 不溢出右缘，回放条允许换行，kv 标签列压窄 */
			.rtr-tip { max-width: min(320px, calc(100vw - 32px)); }
			.rtr-replaybar { flex-wrap: wrap; row-gap: 6px; }
			.rtr-kv { grid-template-columns: 72px 1fr; }
		}
		/* 粗指针（触屏）：时间轴色块点击热区再放大一圈，仍纯 CSS */
		@media (hover: none) {
			.rtr-tlbody .vis-item::after { left: -8px; right: -8px; top: -10px; bottom: -10px; }
		}
	</style>
	<div class="rtr-hd">
		<h2>🧭 <span class="t-title"></span></h2>
		<span class="rtr-live"></span>
		<span class="sp"></span>
		<input type="search" class="q" />
		<button class="rtr-btn act-replay"></button>
		<button class="rtr-btn act-lang">EN</button>
		<button class="rtr-btn danger act-clear"></button>
	</div>
	<div class="rtr-convs"></div>
	<div class="rtr-ruler"><div class="rtr-rulerbar"><span class="hint"></span><span class="sp"></span><button class="rtr-btn act-follow"></button><button class="rtr-btn act-fit"></button></div><div class="rtr-legend"></div><div class="rtr-tlbody"></div></div>
	<div class="rtr-replaybar" hidden></div>
	<div class="rtr-bd">
		<div class="rtr-list"></div>
		<div class="rtr-detail"></div>
	</div>
</div>`;

		const $ = (s) => container.querySelector(s);
		const hdTitle = $(".t-title"),
			hdLive = $(".rtr-live"),
			qEl = $(".q");
		const replayBtn = $(".act-replay"),
			langBtn = $(".act-lang"),
			clearBtn = $(".act-clear");
		const convsEl = $(".rtr-convs"),
			rulerEl = $(".rtr-ruler"),
			replayBar = $(".rtr-replaybar");
		const listEl = $(".rtr-list"),
			detailEl = $(".rtr-detail");

		function applyLang() {
			const L = t();
			hdTitle.textContent = L.title;
			hdLive.textContent = `● ${L.live}`;
			qEl.placeholder = L.search;
			replayBtn.textContent = replay.on ? `⏹ ${L.exitReplay}` : `▶ ${L.replay}`;
			replayBtn.classList.toggle("on", replay.on);
			langBtn.textContent = lang === "zh" ? "EN" : "中文";
			clearBtn.textContent = `🗑 ${L.clear}`;
		}

		function convOf(id) {
			return convs.find((c) => c.id === id);
		}
		function allSegs() {
			return segsCache.get(selectedConvId ?? "") ?? [];
		}
		function visibleSegs() {
			const q = search.trim().toLowerCase();
			return allSegs().filter((s) => {
				if (!filters[s.lane]) return false;
				if (q && !`${s.title}\n${s.summary}\n${s.source}\n${s.meta?.tool ?? ""}`.toLowerCase().includes(q))
					return false;
				return true;
			});
		}

		function renderConvs() {
			const L = t();
			if (!convs.length) {
				convsEl.innerHTML = `<span style="opacity:.55;font-size:12px">${esc(L.emptyHint)}</span>`;
				return;
			}
			convsEl.innerHTML = convs
				.map(
					(c) =>
						`<button class="rtr-conv${c.id === selectedConvId ? " sel" : ""}" data-id="${esc(c.id)}">${c.id === activeId ? `<span class="cur">●</span> ` : ""}${esc(c.title || L.empty)}${c.isStreaming ? " ⏳" : ""}</button>`,
				)
				.join("");
		}

		function renderRuler() {
			const L = t();
			const hintEl = rulerEl.querySelector(".hint");
			const fitBtn = rulerEl.querySelector(".act-fit");
			const followBtn = rulerEl.querySelector(".act-follow");
			if (hintEl) hintEl.textContent = flowing ? L.flowHint : L.zoomHint;
			if (fitBtn) fitBtn.textContent = L.fit;
			if (followBtn) {
				followBtn.textContent = L.follow;
				followBtn.classList.toggle("on", followEnabled);
			}
			const body = rulerEl.querySelector(".rtr-tlbody");
			const all = visibleSegs();
			void ensureVis();
			const sized = !!body && body.clientWidth > 0 && body.clientHeight > 0;
			if (!visApi || !selectedConvId || !all.length || !sized) {
				if (tl) destroyTl();
				if (body) renderRulerFallback(body, all);
				return;
			}
			if (body && body.firstChild !== tlDom()) {
				body.innerHTML = "";
				body.appendChild(tlDom());
			}
			const groups = [
				{ id: "input", content: esc(L.lanes.input) },
				{ id: "model", content: esc(L.lanes.model) },
				{ id: "tools", content: esc(L.lanes.tools) },
			];
			if (!tl || tlConv !== selectedConvId) {
				destroyTl();
				tlItems = new visApi.DataSet(visItems(all));
				tl = new visApi.Timeline(tlDom(), tlItems, groups, {
					stack: true,
					orientation: "top",
					showMajorLabels: true,
					showMinorLabels: true,
					zoomable: true,
					moveable: true,
					selectable: true,
					multiselect: false,
					zoomMin: 10,
					zoomMax: 1000 * 60 * 60 * 24 * 30,
					margin: { item: 3, axis: 6 },
					tooltip: { followMouse: true, overflowMethod: "cap" },
					height: "252px",
				});
				tl.on("select", (props) => {
					if (suppressSelect) return;
					const id = props.items?.[0];
					if (id === undefined) {
						if (selectedKey) {
							selectedKey = null;
							scheduleRender(false);
						}
						return;
					}
					selectSeg(String(id), { scroll: true });
				});
				tl.on("rangechange", (props) => {
					scheduleEpsSync();
					if (!props?.byUser) return;
					const w = flowWin();
					if (!w) return;
					const zoomed = flowSpanSeen > 0 && Math.abs(w.span - flowSpanSeen) > Math.max(1, flowSpanSeen * 0.002);
					flowSpanSeen = w.span;
					if (!zoomed && followEnabled) {
						followEnabled = false;
						rulerEl.querySelector(".act-follow")?.classList.remove("on");
						flowSync();
					}
				});
				tl.on("rangechanged", (props) => {
					if (props.byUser) userZoomed = true;
					hideTip();
					scheduleEpsSync();
					if (replay.on) refreshPlayhead(false);
				});
				tl.on("itemover", (props) => {
					if (props.item !== undefined && props.event) showTip(String(props.item), props.event);
				});
				tl.on("itemout", () => hideTip());
				tlConv = selectedConvId;
				userZoomed = false;
				followEnabled = true;
				try {
					const aw = activeWindow(all);
					if (aw) {
						const pad = Math.max(0, (aw.end - aw.start) * 0.02);
						tl.setWindow(aw.start - pad, aw.end + pad, { animation: false });
					} else {
						tl.fit({ animation: false });
					}
				} catch {
					try {
						tl.fit({ animation: false });
					} catch {}
				}
				scheduleEpsSync();
				flowMeasure();
				flowSpanSeen = flowWin()?.span ?? 0;
				flowSync();
				requestAnimationFrame(() => {
					try {
						if (tl && tlConv === selectedConvId) tl.redraw();
					} catch {}
				});
			} else {
				try {
					tl.setGroups(groups);
					tlItems.clear();
					tlItems.add(visItems(all));
				} catch {}
				flowSync();
			}
			try {
				suppressSelect = true;
				tl.setSelection(selectedKey ? [selectedKey] : []);
			} catch {
			} finally {
				suppressSelect = false;
			}
		}

		function showTip(key, ev) {
			const s = allSegs().find((x) => x.key === key);
			if (!s) return;
			let tip = container.querySelector(".rtr-tip");
			if (!tip) {
				tip = document.createElement("div");
				tip.className = "rtr-tip";
				container.appendChild(tip);
			}
			tip.innerHTML = `<div class="tt">${esc(s.title)}</div><div class="tm">${esc(s.source ?? "")}</div><div class="tm">${esc(fmtClock(s.t))}${s.dur !== undefined ? ` · ${esc(fmtDur(s.dur))}` : ""}${s.end > s.t ? ` → ${esc(fmtClock(s.end))}` : ""}</div>`;
			tip.style.display = "block";
			const r = container.getBoundingClientRect();
			const x = Math.min(Math.max(8, (ev.clientX ?? 0) - r.left + 14), Math.max(8, r.width - 330));
			const y = Math.min(Math.max(8, (ev.clientY ?? 0) - r.top + 16), Math.max(8, r.height - 90));
			tip.style.left = `${x}px`;
			tip.style.top = `${y}px`;
		}

		function hideTip() {
			container.querySelector(".rtr-tip")?.remove();
		}

		const MIN_SLIVER_PX = 2;

		function spanMs(all) {
			if (!all.length) return 1;
			let min = Infinity,
				max = -Infinity;
			for (const s of all) {
				if (s.t < min) min = s.t;
				const e = Math.max(s.end ?? s.t, s.t);
				if (e > max) max = e;
			}
			return Math.max(1, max - min);
		}

		function tlDrawWidth() {
			try {
				const w = tlDom().clientWidth || 800;
				const lab = tlDom().querySelector(".vis-labelset");
				return Math.max(50, w - (lab ? lab.getBoundingClientRect().width : 0));
			} catch {
				return 800;
			}
		}

		function currentEps() {
			try {
				if (!tl) return 0;
				const w = tl.getWindow?.();
				if (!w) return 0;
				const a = w.start instanceof Date ? w.start.getTime() : Number(w.start);
				const b = w.end instanceof Date ? w.end.getTime() : Number(w.end);
				const span = Math.max(1, (b || 0) - (a || 0));
				return (span * MIN_SLIVER_PX) / tlDrawWidth();
			} catch {
				return 0;
			}
		}

		function syncDisplayEnds() {
			try {
				if (!tlItems || !tl) return;
				const eps = currentEps();
				const now = Date.now();
				const thr = Math.max(0.5, eps / 8);
				const upd = [];
				for (const s of visibleSegs()) {
					const startMs = s.t;
					const realEnd = Math.max(s.end ?? startMs, startMs);
					const want = s.status === "running" ? Math.max(now, startMs + eps) : Math.max(realEnd, startMs + eps);
					const cur = tlItems.get(s.key)?.end;
					const curMs = cur instanceof Date ? cur.getTime() : Number(cur ?? realEnd);
					if (Math.abs(curMs - want) > thr) upd.push({ id: s.key, end: new Date(want) });
				}
				if (upd.length) tlItems.update(upd);
			} catch {}
		}

		let epsRaf = 0;
		function scheduleEpsSync() {
			if (epsRaf) return;
			epsRaf = requestAnimationFrame(() => {
				epsRaf = 0;
				syncDisplayEnds();
			});
		}

		function isLiveConv() {
			const c = convOf(selectedConvId ?? "");
			if (c?.isStreaming) return true;
			return visibleSegs().some((s) => s.status === "running");
		}

		const FOLLOW_MARGIN_PX = 40;
		const FLOW_COMMIT_PX = 90;
		const TICK_TARGET_PX = 110;
		const TICK_LADDER = [
			1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000, 21600000,
			43200000, 86400000,
		];
		let flowing = false;
		let flowRaf = 0;
		let flowShift = 0;
		let flowWrap = null;
		let flowGrid = null;
		let flowGeom = null;
		let flowTicks = [];
		let flowStep = 0;
		let flowSig = "";
		let flowPaintSec = -1;
		let flowSpanSeen = 0;

		function fmtTick(t, withSec) {
			const d = new Date(t),
				p = (n) => String(n).padStart(2, "0");
			return withSec
				? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
				: `${p(d.getHours())}:${p(d.getMinutes())}`;
		}

		function flowWin() {
			try {
				const w = tl?.getWindow?.();
				if (!w) return null;
				const a = w.start instanceof Date ? w.start.getTime() : Number(w.start);
				const b = w.end instanceof Date ? w.end.getTime() : Number(w.end);
				if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
				return { a, b, span: b - a };
			} catch {
				return null;
			}
		}

		function flowLive() {
			return !!tl && followEnabled && !replay.on && tlConv === selectedConvId && isLiveConv();
		}

		function flowMeasure() {
			const tlbody = rulerEl.querySelector(".rtr-tlbody");
			const content = tlDom().querySelector(".vis-panel.vis-center .vis-content");
			if (!tlbody || !content) {
				flowGeom = null;
				return;
			}
			const br = tlbody.getBoundingClientRect();
			const cr = content.getBoundingClientRect();
			flowGeom = { left: cr.left - br.left, width: Math.max(80, cr.width), axisH: Math.max(0, cr.top - br.top) };
		}

		const flowX = (ms, win, width) => ((ms - win.a) / win.span) * width;
		const flowTimeAt = (x, win, width) => win.a + (x / width) * win.span;

		function flowBuild(win, geom) {
			const tlbody = rulerEl.querySelector(".rtr-tlbody");
			if (!tlbody) return;
			if (!flowGrid || flowGrid.parentNode !== tlbody) {
				flowGrid = document.createElement("div");
				flowGrid.className = "rtr-flowgrid";
				flowGrid.innerHTML =
					'<div class="rtr-fgtop"></div><div class="rtr-fgcols"></div><div class="rtr-fgnow"><u></u></div>';
				tlbody.appendChild(flowGrid);
			}
			const top = flowGrid.querySelector(".rtr-fgtop");
			const cols = flowGrid.querySelector(".rtr-fgcols");
			const nowEl = flowGrid.querySelector(".rtr-fgnow");
			top.style.cssText = `left:${geom.left}px;width:${geom.width}px;height:${geom.axisH + 4}px`;
			cols.style.cssText = `left:${geom.left}px;width:${geom.width}px;top:${geom.axisH}px`;
			nowEl.style.left = `${geom.left + geom.width - FOLLOW_MARGIN_PX}px`;
			const want = (win.span * TICK_TARGET_PX) / geom.width;
			flowStep = TICK_LADDER.find((s) => s >= want) ?? TICK_LADDER[TICK_LADDER.length - 1];
			const stepPx = (flowStep / win.span) * geom.width;
			const n = Math.max(2, Math.floor(geom.width / stepPx) + 1);
			if (flowTicks.length !== n) {
				cols.innerHTML = "";
				top.innerHTML = "";
				flowTicks = [];
				for (let i = 0; i < n; i++) {
					const line = document.createElement("i");
					cols.appendChild(line);
					const label = document.createElement("b");
					top.appendChild(label);
					flowTicks.push({ line, label, x: 0 });
				}
			}
			for (let i = 0; i < n; i++) {
				const x = i * stepPx;
				const el = flowTicks[i];
				el.x = x;
				el.line.style.left = `${x.toFixed(2)}px`;
				el.label.style.left = `${(x + 4).toFixed(2)}px`;
				el.tight = x > geom.width - 46;
			}
			flowPaintSec = -1;
		}

		function flowPaint(win, geom, now) {
			const sec = Math.floor(now / 1000);
			if (sec === flowPaintSec) return;
			flowPaintSec = sec;
			const withSec = flowStep < 60000;
			for (const tk of flowTicks)
				tk.label.textContent = tk.tight ? "" : fmtTick(flowTimeAt(tk.x + flowShift, win, geom.width), withSec);
			const u = flowGrid?.querySelector(".rtr-fgnow u");
			if (u) u.textContent = fmtTick(now, true);
		}

		function flowAbsorb(win, width, shift) {
			const a2 = win.a + (shift * win.span) / width;
			tl.setWindow(a2, a2 + win.span, { animation: false });
			try {
				if (typeof tl._origRedraw === "function") tl._origRedraw();
				else tl.redraw();
			} catch {}
			return flowWin() ?? win;
		}

		function flowTick() {
			flowRaf = 0;
			if (!flowing) return;
			flowRaf = requestAnimationFrame(flowTick);
			try {
				let win = flowWin();
				if (!win || !flowGeom) return;
				const geom = flowGeom;
				const now = Date.now();
				const nowX = geom.width - FOLLOW_MARGIN_PX;
				let shift = flowX(now, win, geom.width) - nowX;
				if (shift >= FLOW_COMMIT_PX || shift <= -FLOW_COMMIT_PX) {
					win = flowAbsorb(win, geom.width, shift);
					shift = flowX(now, win, geom.width) - nowX;
					flowSpanSeen = win.span;
				}
				flowShift = shift;
				if (flowWrap) flowWrap.style.transform = Math.abs(shift) < 0.01 ? "" : `translateX(${(-shift).toFixed(2)}px)`;
				syncDisplayEnds();
				const sig = `${geom.left}|${geom.width}|${geom.axisH}|${win.span}`;
				if (sig !== flowSig) {
					flowSig = sig;
					flowBuild(win, geom);
				}
				flowPaint(win, geom, now);
			} catch {}
		}

		function flowSync() {
			const live = flowLive();
			if (live) flowMeasure();
			if (live && !flowing) {
				flowing = true;
				flowWrap = tlDom().querySelector(".vis-itemset");
				flowSig = "";
				flowSpanSeen = flowWin()?.span ?? 0;
				rulerEl.querySelector(".rtr-tlbody")?.classList.add("flowing");
				const hintEl = rulerEl.querySelector(".hint");
				if (hintEl) hintEl.textContent = t().flowHint;
				if (!flowRaf) flowRaf = requestAnimationFrame(flowTick);
			} else if (!live && flowing) {
				flowStop();
			} else if (live) {
				if (!flowRaf) flowRaf = requestAnimationFrame(flowTick);
			}
		}

		function flowStop() {
			try {
				if (tl && flowGeom && Math.abs(flowShift) > 0.5) {
					const win = flowWin();
					if (win) flowAbsorb(win, flowGeom.width, flowShift);
				}
			} catch {}
			flowing = false;
			if (flowRaf) cancelAnimationFrame(flowRaf);
			flowRaf = 0;
			flowShift = 0;
			if (flowWrap) flowWrap.style.transform = "";
			flowWrap = null;
			rulerEl.querySelector(".rtr-tlbody")?.classList.remove("flowing");
			flowGrid?.remove();
			flowGrid = null;
			flowTicks = [];
			flowStep = 0;
			flowSig = "";
			flowPaintSec = -1;
			const hintEl = rulerEl.querySelector(".hint");
			if (hintEl) hintEl.textContent = t().zoomHint;
		}

		function activeWindow(all) {
			if (!all.length) return null;
			const ivs = all.map((s) => [s.t, Math.max(s.end ?? s.t, s.t)]).sort((a, b) => a[0] - b[0]);
			let minT = ivs[0][0],
				maxT = ivs[0][1];
			for (const [a, b] of ivs) {
				if (a < minT) minT = a;
				if (b > maxT) maxT = b;
			}
			const span = Math.max(1, maxT - minT);
			const idle = Math.min(Math.max(90000, span * 0.05), span * 0.4);
			const clusters = [];
			let cs = ivs[0][0],
				ce = ivs[0][1];
			for (let i = 1; i < ivs.length; i++) {
				const [a, b] = ivs[i];
				if (a - ce > idle) {
					clusters.push([cs, ce]);
					cs = a;
					ce = b;
				} else {
					if (a < cs) cs = a;
					if (b > ce) ce = b;
				}
			}
			clusters.push([cs, ce]);
			if (clusters.length === 1) {
				const [s, e] = clusters[0];
				return e - s >= span * 0.95 ? null : { start: s, end: e };
			}
			let best = clusters[0],
				bl = clusters[0][1] - clusters[0][0];
			for (const c of clusters) {
				const l = c[1] - c[0];
				if (l > bl) {
					bl = l;
					best = c;
				}
			}
			return bl >= span * 0.4 ? { start: best[0], end: best[1] } : null;
		}

		function visItems(all) {
			const eps = currentEps() || Math.max(1, spanMs(all) * 0.0001);
			const now = Date.now();
			return all.map((s) => {
				const startMs = s.t;
				const realEnd = Math.max(s.end ?? startMs, startMs);
				const endMs = s.status === "running" ? Math.max(now, startMs + eps) : Math.max(realEnd, startMs + eps);
				const err = s.status === "error";
				const cls = `lane-${s.lane}${err ? " st-error" : ""}${s.status === "running" ? " st-running" : ""}`;
				const color = laneColor(s);
				const style = color ? `background-color:${color};border-color:${color};` : undefined;
				return {
					id: s.key,
					group: s.lane,
					start: new Date(startMs),
					end: new Date(endMs),
					type: "range",
					content: "",
					className: cls,
					...(style ? { style } : {}),
				};
			});
		}

		function renderRulerFallback(body, all) {
			const L = t();
			if (tl) destroyTl();
			if (!selectedConvId || !all.length) {
				body.innerHTML = ["input", "model", "tools"]
					.map(
						(ln) =>
							`<div class="rtr-lane"><span class="ln">${esc(L.lanes[ln])}</span><div class="rtr-track"></div></div>`,
					)
					.join("");
				body._vis = null;
				return;
			}
			const minT = Math.min(...all.map((s) => s.t));
			const maxT = Math.max(...all.map((s) => Math.max(s.end ?? s.t, s.t)));
			const span = Math.max(1, maxT - minT);
			const total = all[all.length - 1] ? fmtDur(maxT - minT) : "";
			const pxW = body.clientWidth;
			const minSpanMs = pxW > 0 ? span * (MIN_SLIVER_PX / pxW) : 0;
			const lanes = ["input", "model", "tools"];
			body.innerHTML = `
<div class="rtr-axis"><span>${esc(fmtClock(minT))}</span><span>${esc(total)}</span><span>${esc(fmtClock(maxT))}</span></div>
${lanes
	.map((ln) => {
		const blocks = all.map((s, i) => ({ s, i })).filter(({ s }) => s.lane === ln);
		return `<div class="rtr-lane"><span class="ln">${esc(L.lanes[ln])}</span><div class="rtr-track">${blocks
			.map(({ s, i }) => {
				const left = ((s.t - minT) / span) * 100;
				const realEnd = Math.max(s.end ?? s.t, s.t);
				const end =
					s.status === "running" && minSpanMs > 0
						? Math.max(Date.now(), s.t + minSpanMs)
						: Math.max(realEnd, s.t + minSpanMs);
				const width = ((end - s.t) / span) * 100;
				const color = laneColor(s);
				return `<span class="rtr-blk lane-${ln}${s.status === "error" ? " st-error" : ""}${s.status === "running" ? " st-running" : ""}${s.key === selectedKey ? " sel" : ""}" data-i="${i}" title="${esc(s.title)}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%${color ? `;background-color:${color};border-color:${color}` : ""}"></span>`;
			})
			.join("")}</div></div>`;
	})
	.join("")}`;
			body._vis = all;
		}

		function renderList() {
			const L = t();
			const all = visibleSegs();
			if (!selectedConvId) {
				listEl.innerHTML = `<div class="rtr-empty">${esc(L.selectHint)}</div>`;
				return;
			}
			if (!all.length) {
				listEl.innerHTML = `<div class="rtr-empty">${esc(allSegs().length ? L.noMatch : L.emptyHint)}</div>`;
				return;
			}
			const shown = replay.on ? all.slice(0, replay.idx + 1) : all;
			listEl.innerHTML = shown
				.map((s) => {
					const tc =
						s.status === "error"
							? null
							: s.kind === "tool"
								? toolColor(s.meta?.tool ?? "tool")
								: s.kind === "thinking" || s.kind === "text"
									? MODEL_COLORS[s.kind]
									: null;
					return `<button class="rtr-row${s.key === selectedKey ? " sel" : ""}${s.status === "error" ? " err" : ""}" data-key="${esc(s.key)}">
<span class="rtr-chip"${tc ? ` style="border-color:${tc};color:${tc}"` : ""}>${esc(chipFor(s, lang))}</span>
<span class="tt">${esc(s.title)}</span>
<time>${esc(fmtClock(s.t))}${s.dur !== undefined ? ` · ${esc(fmtDur(s.dur))}` : ""}</time>
</button>`;
				})
				.join("");
			renderReplayBar(all);
		}

		function renderLegend() {
			const el = rulerEl.querySelector(".rtr-legend");
			if (!el) return;
			const vis = visibleSegs();
			const seen = new Map();
			if (vis.some((s) => s.kind === "thinking")) seen.set(lang === "zh" ? "思考" : "think", MODEL_COLORS.thinking);
			if (vis.some((s) => s.kind === "text")) seen.set(lang === "zh" ? "回答" : "text", MODEL_COLORS.text);
			for (const s of vis) {
				if (s.lane !== "tools" || s.status === "error") continue;
				const name = s.meta?.tool ?? (s.kind === "file" ? "file" : null);
				if (!name || seen.has(name)) continue;
				seen.set(name, toolColor(name));
			}
			el.innerHTML = [...seen.entries()]
				.map(([n, c]) => `<span class="lg-item"><i style="background:${c}"></i>${esc(n)}</span>`)
				.join("");
			el.style.display = seen.size ? "" : "none";
		}

		function renderReplayBar(all) {
			const L = t();
			if (!replay.on || !all.length) {
				replayBar.hidden = true;
				replayBar.innerHTML = "";
				return;
			}
			replayBar.hidden = false;
			const maxIdx = Math.max(0, all.length - 1);
			const idx = Math.min(replay.idx, maxIdx);
			replayBar.innerHTML = `
<button class="rtr-btn act-play">${replay.playing ? `⏸ ${esc(L.pause)}` : `▶ ${esc(L.play)}`}</button>
<input type="range" min="0" max="${maxIdx}" value="${idx}" />
<span>${idx + 1}/${all.length}</span>
<label>${esc(L.speed)} <select class="spd">${[0.5, 1, 2, 4].map((x) => `<option value="${x}"${x === replay.speed ? " selected" : ""}>${x}x</option>`).join("")}</select></label>
<label class="skip"><input type="checkbox" class="skipcb"${replay.skipIdle ? " checked" : ""} /> ${esc(L.skipIdle)}</label>`;
		}

		function kvRow(k, v) {
			return `<dt>${esc(k)}</dt><dd>${v}</dd>`;
		}

		function renderDetail() {
			const L = t(),
				F = L.f;
			const c = convOf(selectedConvId ?? "");
			const all = visibleSegs();
			const seg = allSegs().find((s) => s.key === selectedKey) ?? null;
			const cached = seg ? detailCache.get(`${selectedConvId}\n${seg.key}`) : null;

			if (!seg || !c) {
				if (!c?.analysis) {
					detailEl.innerHTML = `<div class="rtr-empty">${esc(c ? L.selectHint : L.emptyHint)}</div>`;
					return;
				}
				const a = c.analysis;
				const maxMs = Math.max(1, ...a.tools.map((x) => x.ms));
				detailEl.innerHTML = `
<h3 style="margin:0 0 8px">📊 ${esc(c.title || L.title)}</h3>
<dl class="rtr-kv">
${kvRow(F.total, esc(fmtDur(a.totalMs)))}${kvRow(F.turns, esc(String(a.turns)))}${kvRow(F.segs, esc(String(c.segCount)))}
${kvRow(F.toolCalls, esc(`${a.toolCalls}（${F.toolErr} ${a.toolErrs}）`))}${kvRow(F.toolTime, esc(fmtDur(a.toolMs)))}
${kvRow(F.files, esc(a.filesChanged.length ? `${a.filesChanged.length} 个` : "—"))}
</dl>
<div class="rtr-sec">${esc(F.phase)} · 💬${a.counts.text} 💭${a.counts.thinking} 🔧${a.counts.tool} 📝${a.counts.file} 👤${a.counts.user}</div>
<div class="rtr-sec">${esc(F.slowest)}</div>
${
	a.tools
		.slice(0, 5)
		.map(
			(x) =>
				`<div style="font-size:12px">${esc(x.name)} · ${x.calls}× · ${esc(fmtDur(x.ms))}${x.errs ? ` · ❌${x.errs}` : ""}</div><div class="rtr-bar"><i style="width:${((x.ms / maxMs) * 100).toFixed(1)}%"></i></div>`,
		)
		.join("") || `<div style="opacity:.6;font-size:12px">—</div>`
}
${a.filesChanged.length ? `<div class="rtr-sec">${esc(F.files)}</div><pre>${esc(a.filesChanged.slice(0, 20).join("\n"))}</pre>` : ""}`;
				return;
			}

			const tabs = ["overview", "preview", "raw", "source"]
				.map(
					(k) => `<button class="rtr-dtab${detailTab === k ? " on" : ""}" data-tab="${k}">${esc(L.tabs[k])}</button>`,
				)
				.join("");
			let body = "";
			if (!cached) {
				body = `<div class="rtr-empty"><span class="rtr-spin">⏳</span> ${esc(L.loading)}</div>`;
			} else if (detailTab === "overview") {
				const an = cached.analysis ?? {};
				const st = L.status[seg.status] ?? seg.status;
				body = `<dl class="rtr-kv">
${kvRow(F.source, esc(seg.source ?? "—"))}${kvRow(F.status, esc(st))}${kvRow(F.dur, esc(fmtDur(seg.dur)))}
${kvRow(F.turn, esc(an.turnText ?? (seg.turn ? `第 ${seg.turn} 轮` : "—")))}${kvRow(F.len, esc(seg.meta?.chars ? `${seg.meta.chars} 字` : `${(cached.detail ?? "").length} 字`))}${kvRow(F.pos, esc(an.position ?? "—"))}
</dl>`;
				if (an.tool) {
					const avg = an.tool.calls ? an.tool.ms / an.tool.calls : 0;
					const share = an.convToolMs ? (100 * (an.tool.ms / an.convToolMs)).toFixed(0) : "0";
					body += `<div class="rtr-sec">📈 ${esc(an.tool.name)}</div><dl class="rtr-kv">
${kvRow(F.calls, esc(`${an.tool.calls}（${F.toolErr} ${an.tool.errs}，${F.errRate} ${an.tool.calls ? Math.round((100 * an.tool.errs) / an.tool.calls) : 0}%）`))}
${kvRow(F.toolTime, esc(`${fmtDur(an.tool.ms)} · ${F.avg} ${fmtDur(avg)} · ${F.share} ${share}%`))}
</dl>`;
				}
				body += `<div class="rtr-sec">${esc(L.tabs.preview)}</div><pre>${esc((cached.detail ?? "").slice(0, 800))}</pre>`;
			} else if (detailTab === "preview") {
				body = `<pre>${esc((cached.detail ?? "").slice(0, 2000))}</pre>`;
			} else if (detailTab === "raw") {
				body = `<pre>${esc(cached.detail ?? "")}</pre><div style="height:10px"></div><button class="rtr-btn act-copy">📋 ${esc(L.copy)}</button>`;
			} else {
				const an = cached.analysis ?? {};
				body = `<dl class="rtr-kv">
${kvRow(F.msgKey, esc(seg.key))}${seg.meta?.toolCallId ? kvRow(F.toolCall, esc(seg.meta.toolCallId)) : ""}
${kvRow(F.turn, esc(an.turnText ?? (seg.turn ? `第 ${seg.turn} 轮 · 共 ${an.convTurns ?? "?"} 轮` : "—")))}
${kvRow(F.conv, esc(`${c.title ?? ""} · ${String(c.id).slice(0, 8)}`))}${kvRow(F.time, esc(fmtClock(seg.t)))}
</dl>`;
			}
			detailEl.innerHTML = `<h3 style="margin:0 0 8px">${esc(seg.title)}</h3><div class="rtr-dtabs">${tabs}</div>${body}`;
		}

		function scheduleRender(stick = true) {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				const keep = stick && !replay.on && listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
				renderConvs();
				renderRuler();
				renderLegend();
				renderList();
				if (pendingScroll) {
					const k = pendingScroll;
					pendingScroll = null;
					const q = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(k) : k;
					const row = listEl.querySelector(`[data-key="${q}"]`);
					if (row) row.scrollIntoView({ block: "nearest" });
				}
				renderDetail();
				if (keep) listEl.scrollTop = listEl.scrollHeight;
			});
		}

		function selectConv(id) {
			selectedConvId = id;
			selectedKey = null;
			replay.on = false;
			stopPlay();
			followEnabled = true;
			applyLang();
			if (id && !segsCache.has(id)) ctx.send({ action: "get_conv", convId: id });
			scheduleRender(false);
		}

		function selectSeg(key, opts = {}) {
			hideTip();
			if (key === selectedKey && !opts.force) {
				selectedKey = null;
				scheduleRender(false);
				return;
			}
			selectedKey = key;
			if (replay.on) {
				const i = visibleSegs().findIndex((s) => s.key === key);
				if (i >= 0) replay.idx = i;
			}
			const ck = `${selectedConvId}\n${key}`;
			if (key && !detailCache.has(ck) && !pendingSeg.has(ck)) {
				pendingSeg.add(ck);
				ctx.send({ action: "get_seg", convId: selectedConvId, key });
			}
			if (opts.scroll) pendingScroll = key;
			scheduleRender();
		}

		const REPLAY_PREFETCH = 12;
		function replayTrack() {
			const all = visibleSegs();
			if (!all.length) return { segs: [], totalLen: 0, realStart: 0, skipIdle: replay.skipIdle };
			const segs = [...all].sort((a, b) => a.t - b.t);
			const realStart = segs[0].t;
			const realEnd = Math.max(...segs.map((s) => Math.max(s.end ?? s.t, s.t)));
			const span = Math.max(1, realEnd - realStart);
			if (!replay.skipIdle) {
				return {
					segs: segs.map((s) => ({ seg: s, p0: s.t - realStart, p1: Math.max(s.end ?? s.t, s.t) - realStart })),
					totalLen: span,
					realStart,
					span,
					skipIdle: false,
				};
			}
			let acc = 0;
			return {
				segs: segs.map((s) => {
					const dur = Math.max(0, Math.max(s.end ?? s.t, s.t) - s.t);
					const it = { seg: s, p0: acc, p1: acc + dur };
					acc += dur;
					return it;
				}),
				totalLen: Math.max(1, acc),
				realStart,
				span,
				skipIdle: true,
			};
		}
		function activeIndexAt(track, pos) {
			let idx = -1;
			for (let i = 0; i < track.segs.length; i++) {
				if (track.segs[i].p0 <= pos) idx = i;
				else break;
			}
			return idx;
		}
		function realTimeAt(track, pos, idx) {
			if (idx < 0) return track.realStart + pos;
			if (!track.skipIdle) return track.realStart + pos;
			return track.segs[idx].seg.t + Math.max(0, pos - track.segs[idx].p0);
		}
		function currentPos(track) {
			if (!replay.playing) return replay.basePos;
			return Math.min(track.totalLen, replay.basePos + (performance.now() - replay.baseClock) * replay.speed);
		}
		function playheadShow(realMs) {
			try {
				if (!tl) return;
				let el = tlDom().querySelector(".rtr-playhead");
				if (!el) {
					tlDom().style.position = "relative";
					el = document.createElement("div");
					el.className = "rtr-playhead";
					tlDom().appendChild(el);
				}
				const w = tl.getWindow?.();
				if (!w) return;
				const a = w.start instanceof Date ? w.start.getTime() : Number(w.start);
				const b = w.end instanceof Date ? w.end.getTime() : Number(w.end);
				const span = Math.max(1, (b || 0) - (a || 0));
				const dw = tlDrawWidth();
				const left = (tlDom().clientWidth || dw) - dw;
				el.style.left = `${left + ((realMs - a) / span) * dw}px`;
				el.style.display = "block";
			} catch {}
		}
		function playheadHide() {
			const el = tlDom().querySelector(".rtr-playhead");
			if (el) el.style.display = "none";
		}
		function ensurePlayheadVisible(realMs) {
			try {
				if (!tl) return;
				const w = tl.getWindow?.();
				if (!w) return;
				const a = w.start instanceof Date ? w.start.getTime() : Number(w.start);
				const b = w.end instanceof Date ? w.end.getTime() : Number(w.end);
				const margin = (b - a) * 0.08;
				if (realMs < a + margin || realMs > b - margin) tl.moveTo(realMs, { animation: false });
			} catch {}
		}
		function refreshPlayhead(follow) {
			const tr = replayTrack();
			if (!tr.segs.length) {
				playheadHide();
				return;
			}
			const pos = currentPos(tr);
			const idx = activeIndexAt(tr, pos);
			const rt = realTimeAt(tr, pos, idx);
			playheadShow(rt);
			if (follow) ensurePlayheadVisible(rt);
		}
		function stopPlay() {
			if (replay.playing) {
				const tr = replayTrack();
				if (tr.segs.length) replay.basePos = currentPos(tr);
			}
			replay.playing = false;
			if (replay.raf) cancelAnimationFrame(replay.raf);
			replay.raf = 0;
		}
		function startPlay() {
			stopPlay();
			const tr = replayTrack();
			if (!tr.segs.length) return;
			replay.basePos = Math.max(0, Math.min(tr.totalLen, replay.basePos));
			replay.baseClock = performance.now();
			replay.playing = true;
			replay.raf = requestAnimationFrame(replayTick);
		}
		function replayTick() {
			if (!replay.playing) return;
			const tr = replayTrack();
			if (!tr.segs.length) {
				stopPlay();
				return;
			}
			const pos = currentPos(tr);
			const idx = activeIndexAt(tr, pos);
			if (idx >= 0) {
				replay.idx = idx;
				const key = tr.segs[idx].seg.key;
				if (key !== selectedKey) {
					selectedKey = key;
					pendingScroll = key;
					scheduleRender();
				}
				const end = Math.min(tr.segs.length, idx + REPLAY_PREFETCH);
				for (let k = idx; k < end; k++) {
					const kk = tr.segs[k].seg.key;
					const ck = `${selectedConvId}\n${kk}`;
					if (kk && !detailCache.has(ck) && !pendingSeg.has(ck)) {
						pendingSeg.add(ck);
						ctx.send({ action: "get_seg", convId: selectedConvId, key: kk });
					}
				}
			}
			const rt = realTimeAt(tr, pos, idx);
			playheadShow(rt);
			ensurePlayheadVisible(rt);
			if (pos >= tr.totalLen) {
				stopPlay();
				scheduleRender();
				return;
			}
			replay.raf = requestAnimationFrame(replayTick);
		}

		convsEl.addEventListener("click", (e) => {
			const b = e.target.closest("[data-id]");
			if (b) selectConv(b.dataset.id);
		});
		rulerEl.addEventListener("click", (e) => {
			if (e.target.closest(".act-follow")) {
				followEnabled = !followEnabled;
				e.target.closest(".act-follow").classList.toggle("on", followEnabled);
				flowSync();
				return;
			}
			if (e.target.closest(".act-fit")) {
				try {
					flowStop();
					tl?.fit({ animation: true });
					userZoomed = false;
					flowSpanSeen = flowWin()?.span ?? 0;
					followEnabled = false;
					rulerEl.querySelector(".act-follow")?.classList.remove("on");
				} catch {}
				return;
			}
			if (tl) return;
			const body = rulerEl.querySelector(".rtr-tlbody");
			const b = e.target.closest("[data-i]");
			if (b && body?._vis) {
				const s = body._vis[Number(b.dataset.i)];
				if (s) selectSeg(s.key, { scroll: true });
			}
		});
		listEl.addEventListener("click", (e) => {
			const b = e.target.closest("[data-key]");
			if (b) selectSeg(b.dataset.key, { scroll: true });
		});
		detailEl.addEventListener("click", (e) => {
			const tab = e.target.closest("[data-tab]");
			if (tab) {
				detailTab = tab.dataset.tab;
				scheduleRender();
				return;
			}
			if (e.target.closest(".act-copy")) {
				const cached = detailCache.get(`${selectedConvId}\n${selectedKey}`);
				const txt = cached ? `${cached.seg.title}\n${cached.detail}` : "";
				if (txt) {
					navigator.clipboard?.writeText(txt).then(
						() => {
							e.target.textContent = `✅ ${t().copied}`;
							setTimeout(scheduleRender, 1200);
						},
						() => {},
					);
				}
			}
		});
		qEl.addEventListener("input", () => {
			search = qEl.value;
			scheduleRender();
		});
		replayBtn.addEventListener("click", () => {
			if (!selectedConvId) return;
			replay.on = !replay.on;
			stopPlay();
			if (replay.on) {
				replay.idx = 0;
				replay.basePos = 0;
				selectedKey = null;
				const tr = replayTrack();
				const first = tr.segs[0];
				if (first) {
					selectedKey = first.seg.key;
					playheadShow(first.seg.t);
					selectSeg(first.seg.key, { force: true });
				}
			} else {
				playheadHide();
				followEnabled = true;
			}
			applyLang();
			scheduleRender(false);
		});
		replayBar.addEventListener("click", (e) => {
			if (e.target.closest(".act-play")) {
				if (replay.playing) stopPlay();
				else startPlay();
				scheduleRender();
			}
		});
		replayBar.addEventListener("input", (e) => {
			if (e.target.matches('input[type="range"]')) {
				stopPlay();
				const tr = replayTrack();
				const i = Number(e.target.value);
				replay.idx = i;
				const it = tr.segs[i];
				replay.basePos = it ? it.p0 : 0;
				selectedKey = it ? it.seg.key : null;
				if (it) playheadShow(it.seg.t);
				scheduleRender();
			}
		});
		replayBar.addEventListener("change", (e) => {
			if (e.target.matches(".spd")) {
				replay.speed = Number(e.target.value);
				if (replay.playing) startPlay();
			} else if (e.target.matches(".skipcb")) {
				replay.skipIdle = e.target.checked;
				const tr = replayTrack();
				const cur = selectedKey ? tr.segs.findIndex((x) => x.seg.key === selectedKey) : -1;
				if (cur >= 0) {
					replay.idx = cur;
					replay.basePos = tr.segs[cur].p0;
				}
				if (replay.playing) startPlay();
				refreshPlayhead(false);
				scheduleRender();
			}
		});
		langBtn.addEventListener("click", () => {
			lang = lang === "zh" ? "en" : "zh";
			applyLang();
			scheduleRender();
		});
		clearBtn.addEventListener("click", () => {
			if (window.confirm(t().confirmClear)) ctx.send({ action: "clear" });
		});

		const off = ctx.onData((p) => {
			if (!p || typeof p !== "object") return;
			switch (p.kind) {
				case "state":
					convs = Array.isArray(p.conversations) ? p.conversations : [];
					const prevActive = lastActiveId;
					activeId = p.activeId ?? null;
					lastActiveId = activeId;
					if (
						activeId &&
						activeId !== selectedConvId &&
						(activeId !== prevActive || !convs.some((c) => c.id === selectedConvId))
					) {
						selectConv(activeId);
						return;
					}
					scheduleRender();
					break;
				case "conv_new":
					if (p.conv && !convs.some((c) => c.id === p.conv.id)) convs.unshift(p.conv);
					if (!selectedConvId) selectConv(p.conv.id);
					else scheduleRender();
					break;
				case "conv_update":
					if (p.conv) {
						const i = convs.findIndex((c) => c.id === p.conv.id);
						if (i >= 0) convs[i] = p.conv;
						else convs.unshift(p.conv);
						if (p.conv.active) {
							activeId = p.conv.id;
							if (p.conv.id !== selectedConvId && p.conv.id !== lastActiveId) {
								lastActiveId = p.conv.id;
								selectConv(p.conv.id);
								return;
							}
							lastActiveId = p.conv.id;
						}
					}
					scheduleRender();
					break;
				case "segs": {
					if (!p.convId || !Array.isArray(p.segs)) break;
					if (p.reset || !segsCache.has(p.convId)) segsCache.set(p.convId, [...p.segs]);
					else segsCache.get(p.convId).push(...p.segs);
					if (p.convId === selectedConvId && !selectedKey && p.segs.length && !replay.on) {
						selectedKey = p.segs[p.segs.length - 1].key;
						selectSeg(selectedKey, { force: true });
						return;
					}
					scheduleRender();
					break;
				}
				case "seg_update": {
					const arr = segsCache.get(p.convId ?? "");
					const s = arr?.find((x) => x.key === p.key);
					if (s && p.patch) Object.assign(s, p.patch);
					scheduleRender();
					break;
				}
				case "seg_detail":
					if (p.key) {
						const ck = `${p.convId}\n${p.key}`;
						pendingSeg.delete(ck);
						detailCache.set(ck, { detail: String(p.detail ?? ""), seg: p.seg, analysis: p.analysis });
						if (p.convId === selectedConvId && p.key === selectedKey) scheduleRender(false);
					}
					break;
				case "cleared":
					convs = [];
					segsCache.clear();
					detailCache.clear();
					pendingSeg.clear();
					selectedConvId = null;
					selectedKey = null;
					activeId = null;
					lastActiveId = null;
					replay.on = false;
					stopPlay();
					playheadHide();
					applyLang();
					scheduleRender(false);
					break;
				default:
					break;
			}
		});

		try {
			const roBody = rulerEl.querySelector(".rtr-tlbody");
			if (roBody && typeof ResizeObserver !== "undefined") {
				tlRO = new ResizeObserver(() => {
					if (roTimer) return;
					roTimer = setTimeout(() => {
						roTimer = 0;
						scheduleRender(false);
					}, 150);
				});
				tlRO.observe(roBody);
			}
		} catch {}

		applyLang();
		scheduleRender(false);
		ctx.send({ action: "state" });

		const liveTicker = setInterval(() => {
			try {
				if (!tl || replay.on) return;
				flowSync();
				if (!flowing && visibleSegs().some((s) => s.status === "running")) syncDisplayEnds();
			} catch {}
		}, 1000);

		return () => {
			stopPlay();
			flowStop();
			clearInterval(liveTicker);
			if (raf) cancelAnimationFrame(raf);
			if (epsRaf) cancelAnimationFrame(epsRaf);
			if (roTimer) clearTimeout(roTimer);
			try {
				tlRO?.disconnect();
			} catch {}
			tlRO = null;
			destroyTl();
			off();
			container.innerHTML = "";
		};
	},
};
