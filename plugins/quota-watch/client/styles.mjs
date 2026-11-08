const STYLE_ID = "quota-watch-style";

/**
 * 底栏小卡片的**内容样式**（外壳归宿主：`web/src/components/FooterSlotPopover.tsx`）。
 * 只用宿主已有的设计令牌（`--text` / `--border` / `--accent` / `--green|amber|red`），跟着主题走，不写死颜色；
 * 这里不出现 `position: fixed` / `z-index` / 外层阴影 —— 那是宿主的活儿。
 *
 * 排版取「余额为主角」：主数字大一号、拆分退成 chips、新鲜度与刷新进度放在同一行，
 * 这样「数字在动」与「数据多旧」两件事都不用读文字找。
 */
const CSS = `
.qw-card {
	width: 306px;
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	gap: 9px;
	padding: 11px 13px 10px;
	color: var(--text);
	font-family: var(--sans);
	font-size: 12px;
}

/* ---------- 头：名字 + 档位 + 刷新（外圈=自动刷新进度） ---------- */
.qw-head {
	display: flex;
	align-items: center;
	gap: 7px;
	min-width: 0;
}
.qw-name {
	font-size: 12.5px;
	font-weight: 600;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.qw-plan {
	font-size: 10.5px;
	padding: 0 6px;
	border-radius: 999px;
	border: 1px solid var(--border);
	color: var(--text-dim);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	max-width: 45%;
}
.qw-plan[hidden] { display: none; }
.qw-gap { flex: 1 1 auto; }
.qw-head-age {
	font-size: 10.5px;
	color: var(--text-faint, var(--text-dim));
	white-space: nowrap;
	font-variant-numeric: tabular-nums;
}
.qw-head-age[hidden] { display: none; }
.qw-head-age[data-stale] { color: var(--amber-text, var(--amber)); }
.qw-refresh {
	position: relative;
	width: 24px;
	height: 24px;
	padding: 0;
	display: grid;
	place-items: center;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: transparent;
	color: var(--text-dim);
	cursor: pointer;
	flex: 0 0 auto;
}
.qw-refresh:hover { color: var(--text); background: var(--bg-elev2, var(--bg)); }
.qw-refresh[disabled] { cursor: default; opacity: 0.65; }
.qw-ring {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	transform: rotate(-90deg);
	pointer-events: none;
}
.qw-ring-track,
.qw-ring-fill {
	fill: none;
	stroke-width: 1.4;
}
.qw-ring-track { stroke: var(--border); }
.qw-ring-fill { stroke: var(--accent); opacity: 0.6; }
.qw-glyph { font-size: 12px; line-height: 1; }
.qw-refresh[data-busy="1"] .qw-glyph { animation: qw-spin 0.7s linear infinite; }

/* ---------- 正文：主数字 + 新鲜度 ---------- */
.qw-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.qw-hero {
	display: flex;
	align-items: baseline;
	gap: 8px;
	min-width: 0;
}
.qw-amount {
	font-size: 26px;
	font-weight: 650;
	line-height: 1.05;
	letter-spacing: -0.4px;
	font-variant-numeric: tabular-nums;
	overflow-wrap: anywhere;
}
.qw-cur { font-size: 13px; font-weight: 500; color: var(--text-dim); margin-right: 1px; }
.qw-amount[data-stale="1"] { color: var(--text-dim); }
.qw-unit {
	font-size: 10.5px;
	color: var(--text-faint, var(--text-dim));
	white-space: nowrap;
}
.qw-age {
	margin-left: auto;
	font-size: 10.5px;
	color: var(--text-faint, var(--text-dim));
	white-space: nowrap;
	font-variant-numeric: tabular-nums;
}
.qw-age[data-stale] { color: var(--amber-text, var(--amber)); }
.qw-card[data-tone="low"] .qw-amount { color: var(--red-text, var(--red)); }

/* 值变了做一次底色脉冲（不用加文案） */
.qw-flash { animation: qw-flash 1.1s ease-out; border-radius: 6px; }

/* ---------- 拆分 chips ---------- */
.qw-extra { display: flex; flex-wrap: wrap; gap: 5px; }
.qw-chip {
	font-size: 10.8px;
	padding: 2px 7px;
	border-radius: 7px;
	background: var(--sunken-bg, var(--bg-elev2, var(--bg)));
	color: var(--text-dim);
	font-variant-numeric: tabular-nums;
	overflow-wrap: anywhere;
}
.qw-chip b { color: var(--text); font-weight: 600; }

/* ---------- 订阅型：窗口进度 ---------- */
.qw-windows { display: flex; flex-direction: column; gap: 7px; }
.qw-win { display: flex; flex-direction: column; gap: 3px; }
.qw-win-head {
	display: flex;
	align-items: baseline;
	gap: 6px;
	font-size: 11.5px;
	min-width: 0;
}
.qw-win-label {
	flex: 1 1 auto;
	color: var(--text-dim);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.qw-win-pct { font-weight: 600; font-variant-numeric: tabular-nums; }
.qw-bar {
	height: 5px;
	border-radius: 999px;
	background: var(--sunken-bg, var(--border));
	overflow: hidden;
}
.qw-bar-fill {
	height: 100%;
	border-radius: 999px;
	background: var(--green);
	transition: width 0.3s ease;
}
.qw-win[data-level="warn"] .qw-bar-fill { background: var(--amber); }
.qw-win[data-level="low"] .qw-bar-fill { background: var(--red); }
.qw-win-sub {
	font-size: 10.5px;
	color: var(--text-dim);
	font-variant-numeric: tabular-nums;
}
.qw-win-sub:empty { display: none; }

/* ---------- 状态行 ---------- */
.qw-alert {
	font-size: 11px;
	line-height: 1.4;
	padding: 6px 8px;
	border-radius: 8px;
	background: var(--red-soft, transparent);
	color: var(--red-text, var(--red));
	overflow-wrap: anywhere;
}
.qw-note {
	font-size: 11px;
	line-height: 1.45;
	color: var(--text-dim);
	border-top: 1px dashed var(--border);
	padding-top: 6px;
	overflow-wrap: anywhere;
}
.qw-note[data-kind="error"] { color: var(--red-text, var(--red)); }
.qw-note[data-kind="warn"] { color: var(--amber-text, var(--amber)); }
.qw-note[data-kind="stale"] { color: var(--text-faint, var(--text-dim)); }
.qw-empty {
	border: 1px dashed var(--border);
	border-radius: 8px;
	padding: 10px;
	font-size: 11.5px;
	line-height: 1.45;
	color: var(--text-dim);
	text-align: center;
	overflow-wrap: anywhere;
}
.qw-empty[data-kind="error"] { color: var(--red-text, var(--red)); }

/* ---------- 脚：刷新节奏 + 新鲜度 ---------- */
.qw-foot {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 10.5px;
	color: var(--text-faint, var(--text-dim));
	border-top: 1px solid var(--border);
	padding-top: 7px;
	font-variant-numeric: tabular-nums;
	min-width: 0;
}
.qw-foot[hidden] { display: none; }
.qw-auto { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

@keyframes qw-spin { to { transform: rotate(360deg); } }
@keyframes qw-flash {
	from { background: var(--accent-soft, transparent); }
	to { background: transparent; }
}
@media (prefers-reduced-motion: reduce) {
	.qw-bar-fill { transition: none; }
	.qw-refresh[data-busy="1"] .qw-glyph { animation: none; }
	.qw-flash { animation: none; }
}
`;

export function ensureStyles() {
	const existing = document.getElementById(STYLE_ID);
	if (existing) {
		// 插件热重载时内容会变：同 id 直接换文本，别让旧样式赖着
		existing.textContent = CSS;
		return;
	}
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = CSS;
	document.head.appendChild(style);
}
