export const CSS = `
.nt-root, .nt-root * { box-sizing: border-box; }
.nt-root {
	--nt-bg: var(--bg, #0d0e12);
	--nt-elev: var(--bg-elev, #14161c);
	--nt-elev2: var(--bg-elev2, #1a1d26);
	--nt-border: var(--border, #262a35);
	--nt-text: var(--text, #e6e8ef);
	--nt-dim: var(--text-dim, #9aa1b4);
	--nt-faint: var(--text-faint, #6b7284);
	--nt-accent: var(--accent, #8b5cf6);
	--nt-accent-contrast: var(--accent-contrast, #ffffff);
	--nt-green: var(--green, #34d399);
	--nt-red: var(--red, #f87171);
	--nt-amber: var(--amber, #fbbf24);
	--nt-on-green: var(--on-green, #1a1a1a);
	--nt-on-red: var(--on-red, #1a1a1a);
	--nt-on-amber: var(--on-amber, #1a1a1a);
	color: var(--nt-text);
	font-size: 13px;
	line-height: 1.5;
}

/* ---------------- 应用骨架（视图与浮窗共用） ---------------- */
.nt-app { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.nt-head {
	display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
	padding: 6px 8px; border-bottom: 1px solid var(--nt-border); background: var(--nt-elev);
}
.nt-tabs { display: flex; gap: 3px; flex: none; }
.nt-tab {
	font: inherit; cursor: pointer; color: var(--nt-dim); background: transparent;
	border: 1px solid transparent; border-radius: 6px; padding: 3px 8px; white-space: nowrap;
}
.nt-tab:hover { color: var(--nt-text); background: var(--nt-elev2); }
.nt-tab.on { color: var(--nt-text); background: var(--accent-soft, rgba(139, 92, 246, 0.14)); border-color: var(--nt-border); }
.nt-tab .nt-count { margin-left: 4px; font-size: 11px; opacity: 0.65; }
.nt-grow { flex: 1 1 auto; min-width: 0; }
.nt-search {
	flex: 1 1 120px; min-width: 90px; font: inherit; color: inherit; background: var(--nt-bg);
	border: 1px solid var(--nt-border); border-radius: 6px; padding: 4px 8px;
}
.nt-btn {
	font: inherit; cursor: pointer; color: var(--nt-dim); background: var(--nt-elev2);
	border: 1px solid var(--nt-border); border-radius: 6px; padding: 3px 8px; white-space: nowrap;
}
.nt-btn:hover { color: var(--nt-text); border-color: var(--nt-accent); }
.nt-btn.on { color: var(--nt-text); background: var(--accent-soft, rgba(139, 92, 246, 0.14)); }
.nt-btn.nt-icon { padding: 3px 7px; }
.nt-btn.nt-danger { color: var(--nt-red, #f87171); }
.nt-btn:disabled { opacity: 0.5; cursor: default; }

.nt-quick { display: flex; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--nt-border); align-items: center; }
.nt-quick input {
	flex: 1 1 auto; min-width: 0; font: inherit; color: inherit; background: var(--nt-bg);
	border: 1px solid var(--nt-border); border-radius: 6px; padding: 5px 8px;
}
.nt-quick input:focus { outline: none; border-color: var(--nt-accent); }
.nt-inline-row { display: flex; gap: 6px; align-items: center; }
.nt-inline-row .nt-input { flex: 1 1 auto; min-width: 0; }

/* ---------------- 现代化闪念速记 Composer ---------------- */
.nt-composer {
	display: flex; flex-direction: column; gap: 6px; padding: 8px;
	border-bottom: 1px solid var(--nt-border); background: var(--nt-elev); flex: none;
}
.nt-composer-box {
	position: relative; display: flex; flex-direction: column;
	background: var(--nt-bg); border: 1px solid var(--nt-border);
	border-radius: 8px; overflow: hidden; transition: border-color 0.15s, box-shadow 0.15s;
}
.nt-composer-box:focus-within {
	border-color: var(--nt-accent);
	box-shadow: 0 0 0 2px var(--accent-soft, rgba(139, 92, 246, 0.15));
}
.nt-composer-text {
	width: 100%; min-height: 52px; max-height: 220px; font: inherit; color: inherit;
	background: transparent; border: 0; padding: 8px 10px; resize: none; outline: none;
	line-height: 1.5; font-size: 13px;
}
.nt-composer-tools {
	display: flex; align-items: center; gap: 6px; padding: 4px 8px 6px;
	border-top: 1px solid transparent; flex-wrap: wrap;
}
.nt-composer-box:focus-within .nt-composer-tools {
	border-top-color: var(--nt-border);
}
.nt-rem-chip {
	display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px;
	border-radius: 999px; font-size: 11px; background: var(--accent-soft, rgba(139, 92, 246, 0.14));
	color: var(--nt-text); border: 1px solid var(--nt-accent); cursor: pointer; user-select: none;
}
.nt-rem-chip.nt-overdue {
	color: var(--nt-red, #f87171); background: var(--red-soft, rgba(248, 113, 113, 0.12));
	border-color: var(--nt-red, #f87171);
}
.nt-rem-chip .nt-rem-x {
	font-size: 12px; opacity: 0.65; cursor: pointer; padding: 0 2px; line-height: 1;
}
.nt-rem-chip .nt-rem-x:hover { opacity: 1; color: var(--nt-red, #f87171); }
.nt-smart-tip {
	display: inline-flex; align-items: center; gap: 3px; font-size: 11px;
	color: var(--nt-amber, #fbbf24); background: rgba(251, 191, 36, 0.12);
	border: 1px dashed var(--nt-amber, #fbbf24); border-radius: 6px; padding: 2px 6px;
	cursor: pointer; transition: background 0.15s;
}
.nt-smart-tip:hover { background: rgba(251, 191, 36, 0.22); }
.nt-btn-primary {
	background: var(--nt-accent); color: var(--nt-accent-contrast, #fff); border-color: var(--nt-accent); font-weight: 500;
}
.nt-btn-primary:hover { opacity: 0.92; color: var(--nt-accent-contrast, #fff); }

/* 提醒弹出快捷浮层 */
.nt-pop-menu {
	position: absolute; z-index: 50; display: flex; flex-direction: column;
	background: var(--nt-elev2); border: 1px solid var(--nt-border); border-radius: 8px;
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); padding: 4px; min-width: 160px;
}
.nt-pop-item {
	display: flex; align-items: center; justify-content: space-between; gap: 8px;
	padding: 5px 8px; font-size: 12px; color: var(--nt-text); border-radius: 5px;
	cursor: pointer; background: transparent; border: 0; text-align: left; width: 100%;
}
.nt-pop-item:hover { background: var(--nt-elev); color: var(--nt-accent); }
.nt-pop-custom { padding: 4px; border-top: 1px solid var(--nt-border); margin-top: 3px; }
.nt-pop-custom input { font-size: 11px; padding: 3px 6px; width: 100%; }

/* ---------------- 现代笔记流卡片 (Cards) ---------------- */
.nt-cards { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.nt-card {
	display: flex; flex-direction: column; gap: 6px; padding: 8px 10px;
	background: var(--nt-elev); border: 1px solid var(--nt-border); border-radius: 8px;
	transition: border-color 0.15s, box-shadow 0.15s; position: relative;
}
.nt-card:hover { border-color: var(--nt-dim); }
.nt-card.nt-pinned {
	border-color: var(--nt-accent);
	background: linear-gradient(to bottom, var(--accent-soft, rgba(139, 92, 246, 0.08)), var(--nt-elev));
}
.nt-card-head {
	display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--nt-dim);
}
.nt-card-time { white-space: nowrap; }
.nt-card-pin-icon { color: var(--nt-accent); font-size: 12px; }
.nt-card-ops {
	display: flex; align-items: center; gap: 2px; margin-left: auto; opacity: 0;
	transition: opacity 0.15s;
}
.nt-card:hover .nt-card-ops, .nt-card-ops.nt-visible, .nt-card-ops:has(.nt-del-confirm) { opacity: 1; }
.nt-op-btn {
	background: transparent; border: 0; color: var(--nt-dim); cursor: pointer;
	padding: 2px 5px; border-radius: 4px; font-size: 12px; line-height: 1;
}
.nt-op-btn:hover { color: var(--nt-text); background: var(--nt-elev2); }
.nt-op-btn.nt-del:hover { color: var(--nt-red, #f87171); }
.nt-op-btn.nt-del-confirm {
	color: var(--nt-red, #f87171) !important; font-weight: bold; background: var(--red-soft, rgba(248, 113, 113, 0.14));
}
.nt-card-body {
	font-size: 13px; line-height: 1.6; word-break: break-word; white-space: pre-wrap;
	cursor: text;
}
.nt-card-body a { color: var(--nt-accent); text-decoration: underline; }
.nt-card-body code {
	font-family: var(--mono, monospace); font-size: 12px;
	background: var(--nt-elev2); padding: 1px 4px; border-radius: 4px;
}
.nt-card-body ul, .nt-card-body ol { margin: 4px 0 4px 18px; padding: 0; }
.nt-card-body .nt-task-box { cursor: pointer; margin-right: 4px; }
.nt-card-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }

/* 就地快速编辑态 */
.nt-card.nt-editing {
	border-color: var(--nt-accent);
	box-shadow: 0 0 0 2px var(--accent-soft, rgba(139, 92, 246, 0.15));
}
.nt-card-edit-area {
	width: 100%; min-height: 80px; max-height: 320px; font: inherit; color: inherit;
	background: var(--nt-bg); border: 1px solid var(--nt-border); border-radius: 6px;
	padding: 6px 8px; resize: vertical; line-height: 1.5; font-size: 13px; outline: none;
}
.nt-card-edit-area:focus { border-color: var(--nt-accent); }
.nt-card-edit-foot {
	display: flex; align-items: center; justify-content: space-between; gap: 6px;
	flex-wrap: wrap; margin-top: 4px;
}

.nt-body { flex: 1 1 auto; min-height: 0; display: flex; }
.nt-list { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 6px; }
.nt-editor {
	flex: 0 0 46%; min-width: 240px; overflow: auto; padding: 10px;
	border-left: 1px solid var(--nt-border); background: var(--nt-elev);
}
/* 浮窗里列表与编辑器二选一（下方是手机上更自然的堆叠顺序）；开关类挂在 .nt-app 上（见 app.mjs 的 openEditor） */
.nt-panel .nt-app.nt-editing .nt-list { display: none; }
.nt-panel .nt-app:not(.nt-editing) .nt-editor { display: none; }
/* ⚠ 浮窗里正文区**必须自己收缩并裁剪**：曾经的 display:block + .nt-list{flex:none}
   让列表/日历按内容自然撑高（实测 440px 的浮窗里列表高 600px），内容会画到底部工具栏、
   设置层甚至浮窗外去（日历最后一行被 footer 盖住）。 */
.nt-panel .nt-body { display: flex; flex-direction: column; position: relative; }
.nt-panel .nt-list, .nt-panel .nt-editor { flex: 1 1 auto; min-height: 0; }
.nt-panel .nt-editor { border-left: 0; min-width: 0; }
/* 浮窗里列表与编辑器二选一（下方是手机上更自然的堆叠顺序）；开关类挂在 .nt-app 上（见 app.mjs 的 openEditor） */
.nt-panel .nt-app.nt-editing .nt-list { display: none; }
.nt-panel .nt-app:not(.nt-editing) .nt-editor { display: none; }

/* ---------------- 列表 ---------------- */
.nt-group {
	font-size: 11px; color: var(--nt-faint); padding: 8px 8px 3px; letter-spacing: 0.04em;
	text-transform: uppercase;
}
.nt-group.nt-overdue { color: var(--nt-red, #f87171); }
.nt-group.nt-today { color: var(--nt-amber, #fbbf24); }
.nt-item {
	display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px; border-radius: 8px;
	border: 1px solid transparent; cursor: pointer;
}
.nt-item:hover { background: var(--nt-elev2); }
.nt-item.on { background: var(--accent-soft, rgba(139, 92, 246, 0.14)); border-color: var(--nt-border); }
.nt-item.nt-done .nt-title { text-decoration: line-through; color: var(--nt-faint); }
.nt-check { flex: none; width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--nt-accent); cursor: pointer; }
.nt-main { flex: 1 1 auto; min-width: 0; }
.nt-title { word-break: break-word; white-space: pre-wrap; }
.nt-title.nt-fixed { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.nt-meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 3px; font-size: 11px; color: var(--nt-dim); }
.nt-due-overdue { color: var(--nt-red, #f87171); }
.nt-due-today { color: var(--nt-amber, #fbbf24); }
.nt-tag {
	font-size: 11px; color: var(--nt-dim); background: var(--nt-elev2);
	border: 1px solid var(--nt-border); border-radius: 999px; padding: 0 6px;
}
.nt-pri { font-size: 11px; border-radius: 999px; padding: 0 6px; border: 1px solid transparent; }
.nt-pri-3 { color: var(--nt-red, #f87171); background: var(--red-soft, rgba(248, 113, 113, 0.12)); }
.nt-pri-2 { color: var(--nt-amber, #fbbf24); background: rgba(251, 191, 36, 0.14); }
.nt-pri-1 { color: var(--nt-dim); background: var(--nt-elev2); }
.nt-x {
	flex: none; border: 0; background: transparent; color: var(--nt-faint); cursor: pointer;
	font: inherit; padding: 0 2px; opacity: 0; line-height: 1;
}
.nt-item:hover .nt-x { opacity: 1; }
.nt-x:hover { color: var(--nt-red, #f87171); }
.nt-empty { color: var(--nt-dim); text-align: center; padding: 20px 12px; }
.nt-foot {
	display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
	padding: 5px 8px; border-top: 1px solid var(--nt-border); font-size: 11px; color: var(--nt-dim);
}
.nt-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--nt-green, #34d399); flex: none; }
.nt-dot.nt-bad { background: var(--nt-red, #f87171); }
.nt-dot.nt-busy { background: var(--nt-amber, #fbbf24); }

/* ---------------- 日历（月视图） ---------------- */
.nt-cal-head { display: flex; align-items: center; gap: 6px; padding: 6px 4px; }
.nt-cal-title { font-weight: 600; }
.nt-cal-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; }
.nt-cal-wd { text-align: center; font-size: 11px; color: var(--nt-faint); padding: 2px 0; }
.nt-cal-cell {
	min-height: 58px; padding: 3px 4px; border: 1px solid transparent; border-radius: 6px;
	background: var(--nt-elev2); cursor: pointer; overflow: hidden;
}
.nt-cal-cell:hover { border-color: var(--nt-accent); }
.nt-cal-cell.nt-out { opacity: 0.45; }
.nt-cal-cell.nt-today { box-shadow: inset 0 0 0 1px var(--nt-accent); }
.nt-cal-cell.nt-sel { background: var(--accent-soft, rgba(139, 92, 246, 0.14)); border-color: var(--nt-accent); }
.nt-cal-day { font-size: 11px; color: var(--nt-dim); }
.nt-cal-cell.nt-today .nt-cal-day { color: var(--nt-accent); font-weight: 700; }
.nt-cal-chips { display: grid; gap: 1px; margin-top: 2px; }
.nt-cal-chip {
	font-size: 10.5px; line-height: 1.35; color: var(--nt-text);
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.nt-cal-chip.nt-rem { color: var(--nt-amber, #fbbf24); }
.nt-cal-chip.nt-done { text-decoration: line-through; color: var(--nt-faint); }
.nt-cal-chip.nt-more { color: var(--nt-faint); }
.nt-cal-detail { margin-top: 8px; padding-top: 4px; border-top: 1px solid var(--nt-border); }
@media (max-width: 720px) {
	.nt-cal-cell { min-height: 44px; }
	.nt-cal-chip { font-size: 9.5px; }
}

/* ---------------- 编辑器 ---------------- */
.nt-form { display: grid; gap: 8px; }
.nt-field { display: grid; gap: 3px; }
.nt-field > label { font-size: 11px; color: var(--nt-dim); }
.nt-field.nt-inline { grid-template-columns: auto 1fr; align-items: center; gap: 8px; }
.nt-input, .nt-select, .nt-textarea {
	width: 100%; font: inherit; color: inherit; background: var(--nt-bg);
	border: 1px solid var(--nt-border); border-radius: 6px; padding: 5px 8px;
}
.nt-input:focus, .nt-select:focus, .nt-textarea:focus { outline: none; border-color: var(--nt-accent); }
.nt-textarea { min-height: 180px; resize: vertical; font-family: var(--mono, monospace); font-size: 12px; line-height: 1.55; }
.nt-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.nt-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.nt-hint { font-size: 11px; color: var(--nt-faint); }
.nt-dows { display: flex; gap: 4px; flex-wrap: wrap; }
.nt-dows .nt-btn { padding: 2px 6px; font-size: 11px; }
/* 设置块（设置覆盖层里的一节）：必须**不参与伸缩**且拿自己的层，否则会被上面
   flex:1 的正文区盖住（命中测试拿到 .nt-list，点不动开关）。 */
.nt-settings {
	display: grid; gap: 8px; padding: 8px;
	border-top: 1px dashed var(--nt-border);
	flex: 0 0 auto; position: relative; z-index: 2;
	background: var(--nt-elev); max-height: 62%; overflow-y: auto;
}
.nt-checkline { display: flex; align-items: center; gap: 6px; font-size: 12px; }
/* 标签列不许被压扁（曾经 .nt-select{width:100%} 把「语言」挤成竖排两个字） */
.nt-checkline > span { flex: none; }
.nt-checkline > .nt-select { width: auto; flex: 1 1 auto; min-width: 0; }
.nt-checkline input { accent-color: var(--nt-accent); }

/* ---------------- 浮窗 ---------------- */
.nt-panel {
	position: fixed; z-index: 350; display: flex; flex-direction: column;
	background: var(--nt-elev, #14161c); border: 1px solid var(--nt-border, #262a35);
	border-radius: 12px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5); overflow: hidden;
}
.nt-panel-head {
	display: flex; align-items: center; gap: 6px; padding: 4px 6px 4px 8px;
	background: var(--nt-elev2, #1a1d26); border-bottom: 1px solid var(--nt-border, #262a35);
	cursor: grab; user-select: none; touch-action: none;
}
.nt-panel.nt-dragging .nt-panel-head { cursor: grabbing; }
.nt-panel-title { font-size: 12px; font-weight: 600; white-space: nowrap; }
.nt-panel-head .nt-grow { height: 1px; }
.nt-head-icon { display: flex; align-items: center; color: var(--nt-accent); }
.nt-head-icon svg { width: 14px; height: 14px; display: block; }
.nt-panel-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
/* 正文区 + 设置覆盖层（覆盖层以正文区为定位基准，不用拿头栏高度算 top） */
.nt-panel-main { flex: 1 1 auto; min-height: 0; position: relative; display: flex; flex-direction: column; }
.nt-settings-pop {
	position: absolute; inset: 0; z-index: 3; display: none; flex-direction: column;
	background: var(--nt-elev); border-radius: 0;
}
.nt-settings-pop.on { display: flex; }
.nt-settings-head {
	display: flex; align-items: center; gap: 6px; padding: 6px 8px;
	border-bottom: 1px solid var(--nt-border); font-size: 12px; font-weight: 600;
}
.nt-settings-pop .nt-settings {
	flex: 1 1 auto; min-height: 0; max-height: none; border-top: 0; overflow-y: auto;
}
.nt-panel .nt-app { height: 100%; }
.nt-panel.nt-pill {
	border-radius: 999px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}
.nt-panel.nt-pill .nt-panel-head { border-bottom: 0; border-radius: 999px; }
.nt-panel.nt-pill .nt-panel-main { display: none; }
.nt-panel.nt-pill .nt-panel-head .nt-panel-title { display: none; }
.nt-panel.nt-pill .nt-pill-hide { display: none; }
/* 计数角标只属于最小化小贴片：展开时标题旁边再写一遍「笔记 0 笔记」纯属噪音 */
.nt-panel:not(.nt-pill) .nt-pill-count, .nt-panel:not(.nt-pill) .nt-pill-label { display: none; }
/* 窄窗里日历格子矮一点（7 列 × 58px 在 360px 宽的浮窗里装不下） */
.nt-panel .nt-cal-cell { min-height: 40px; }
.nt-panel .nt-cal-chip { font-size: 9px; }
/* 底部工具栏挤成一行：提醒那句长了就省略号（否则 360px 里折成两三行，白占一块） */
.nt-panel .nt-foot { flex-wrap: nowrap; }
.nt-panel .nt-foot > * { white-space: nowrap; }
.nt-panel .nt-foot-rem { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.nt-pill-count {
	display: inline-block; min-width: 16px; text-align: center; font-size: 11px;
	border-radius: 999px; padding: 0 5px; background: var(--nt-accent, #8b5cf6); color: var(--nt-accent-contrast, #fff);
}
.nt-pill-count.nt-zero { background: var(--nt-elev, #14161c); color: var(--nt-dim, #9aa1b4); }
.nt-grip {
	position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
	cursor: nwse-resize; touch-action: none;
	background: linear-gradient(135deg, transparent 50%, var(--nt-border, #262a35) 50%);
	border-bottom-right-radius: 11px;
}
.nt-panel.nt-pill .nt-grip { display: none; }

/* 窄屏（手机）：浮窗铺满可用宽度，编辑器在列表下方而不是右侧 */
@media (max-width: 720px) {
	.nt-editor { flex: 1 1 auto; min-width: 0; border-left: 0; border-top: 1px solid var(--nt-border); }
	.nt-body { flex-direction: column; }
	.nt-panel { max-width: calc(100vw - 16px); }
}
`;

export function ensureStyles() {
	try {
		const doc = globalThis.document;
		if (!doc || doc.getElementById("notes-plugin-css")) return;
		const el = doc.createElement("style");
		el.id = "notes-plugin-css";
		el.textContent = CSS;
		doc.head.appendChild(el);
	} catch {}
}
