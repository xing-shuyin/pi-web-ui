export const CSS = `
.ig {
	--ig-r: 12px;
	--ig-r-sm: 8px;
	--ig-gap: 12px;
	--ig-shadow: 0 8px 28px rgba(0, 0, 0, .38);
	position: relative;
	display: flex;
	flex-direction: column;
	flex: 1 1 auto;
	height: 100%;
	min-height: 0;
	font-size: 13px;
	color: var(--text, #e6e8ef);
	background: var(--bg, #0d0e12);
}

/* ---------- 顶栏 ---------- */
.ig-top { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border-soft, #1e2230); background: var(--topbar-bg, var(--bg-elev, #14161c)); min-width: 0; }
.ig-brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.ig-logo { width: 28px; height: 28px; flex: none; border-radius: 9px; display: grid; place-items: center; font-size: 15px; background: linear-gradient(135deg, var(--brand-grad-a, #8b5cf6), var(--brand-grad-b, #6366f1)); box-shadow: 0 3px 10px rgba(99, 102, 241, .35); }
.ig-brandtext { display: flex; flex-direction: column; min-width: 0; }
.ig-brandtext b { font-size: 14px; line-height: 1.35; }
.ig-brandsub { color: var(--text-faint, #6b7284); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ig-spacer { flex: 1 1 auto; min-width: 0; }
.ig-tabs { display: flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--sunken-bg, rgba(0, 0, 0, .15)); flex: none; }
.ig-tab { border: none; background: transparent; color: var(--text-dim, #9aa1b4); border-radius: 8px; padding: 5px 13px; cursor: pointer; font: inherit; font-size: 12.5px; transition: background .12s ease, color .12s ease; }
.ig-tab:hover { color: var(--text, #e6e8ef); background: var(--glow-05, rgba(255, 255, 255, .05)); }
.ig-tab.on { color: var(--text, #e6e8ef); background: var(--card-bg, var(--bg-elev, #14161c)); box-shadow: 0 1px 3px rgba(0, 0, 0, .3); }

/* ---------- 通用控件 ---------- */
.ig-btn { display: inline-flex; align-items: center; gap: 6px; background: var(--chip-bg, var(--bg-elev2, #1a1d26)); color: var(--text, #e6e8ef); border: 1px solid var(--border, #262a35); border-radius: 9px; padding: 5px 11px; cursor: pointer; font: inherit; font-size: 12.5px; text-decoration: none; transition: border-color .12s ease, background .12s ease, transform .08s ease; }
.ig-btn:hover { border-color: var(--accent, #8b5cf6); }
.ig-btn:active { transform: translateY(1px); }
.ig-btn[disabled] { opacity: .45; cursor: not-allowed; }
.ig-btn:focus-visible { outline: 2px solid var(--accent, #8b5cf6); outline-offset: 1px; }
.ig-iconbtn { width: 30px; height: 30px; padding: 0; justify-content: center; font-size: 13px; flex: none; }
.ig-primary { background: linear-gradient(135deg, var(--brand-grad-a, #8b5cf6), var(--brand-grad-b, #6366f1)); border-color: transparent; color: #fff; font-weight: 600; box-shadow: 0 4px 14px rgba(99, 102, 241, .32); }
.ig-primary:hover { filter: brightness(1.06); border-color: transparent; }
.ig-danger { color: var(--red, #f87171); }
.ig-danger:hover { border-color: var(--red, #f87171); }
.ig-small { padding: 3px 8px; font-size: 11.5px; border-radius: 7px; }
.ig-ghost { background: transparent; border-color: transparent; color: var(--text-dim, #9aa1b4); }
.ig-ghost:hover { background: var(--glow-05, rgba(255, 255, 255, .05)); color: var(--text, #e6e8ef); border-color: transparent; }
.ig-input, .ig-area { background: var(--inputbox-bg, var(--bg-elev2, #1a1d26)); color: var(--text, #e6e8ef); border: 1px solid var(--border, #262a35); border-radius: var(--ig-r-sm); padding: 7px 10px; font: inherit; font-size: 12.5px; min-width: 0; width: 100%; box-sizing: border-box; transition: border-color .12s ease; }
.ig-input:focus, .ig-area:focus { outline: none; border-color: var(--accent, #8b5cf6); }
.ig-area { resize: vertical; line-height: 1.55; }
.ig-mono { font-family: var(--mono, ui-monospace, monospace); font-size: 11.5px; }
.ig-dim { color: var(--text-faint, #6b7284); font-size: 11px; }
.ig-warn { color: var(--amber, #fbbf24); font-size: 11.5px; overflow-wrap: anywhere; }
.ig-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono, ui-monospace, monospace); font-size: 11px; }
.ig-x { background: transparent; border: none; color: var(--text-faint, #6b7284); cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 5px; border-radius: 6px; }
.ig-x:hover { color: var(--red, #f87171); background: var(--red-soft, rgba(248, 113, 113, .12)); }

/* ---------- 页容器 ---------- */
.ig-panes { flex: 1 1 auto; min-height: 0; display: flex; }
.ig-pane { flex: 1 1 auto; min-width: 0; min-height: 0; display: none; }
.ig-pane.on { display: flex; }
.ig-gen { flex-direction: column; }
.ig-svc { flex-direction: row; }
.ig-cfg { flex-direction: column; overflow-y: auto; overscroll-behavior: contain; padding: 16px; }

/* ---------- 结果流 ---------- */
.ig-feed-head { display: flex; align-items: center; gap: 8px; padding: 10px 16px 0; min-width: 0; }
.ig-feed-head b { font-size: 12.5px; }
.ig-feed { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 10px 16px 16px; }
.ig-grid-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: var(--ig-gap); align-items: start; }
.ig-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 44px 18px; text-align: center; }
.ig-empty-art { width: 62px; height: 62px; border-radius: 20px; display: grid; place-items: center; font-size: 28px; background: linear-gradient(135deg, var(--accent-soft, rgba(139, 92, 246, .14)), var(--blue-soft, rgba(59, 130, 246, .12))); border: 1px solid var(--border-soft, #1e2230); }
.ig-empty-title { font-size: 14px; font-weight: 600; }
.ig-empty-sub { color: var(--text-dim, #9aa1b4); font-size: 12px; max-width: 460px; line-height: 1.6; overflow-wrap: anywhere; }
.ig-examples { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; max-width: 640px; }
.ig-ex { background: var(--chip-bg, var(--bg-elev2, #1a1d26)); border: 1px dashed var(--border, #262a35); color: var(--text-dim, #9aa1b4); border-radius: 999px; padding: 5px 12px; font: inherit; font-size: 11.5px; cursor: pointer; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: all .12s ease; }
.ig-ex:hover { color: var(--text, #e6e8ef); border-color: var(--accent, #8b5cf6); border-style: solid; }

/* ---------- 图片卡 ---------- */
.ig-tile { position: relative; border-radius: var(--ig-r); overflow: hidden; background: var(--card-bg, var(--bg-elev, #14161c)); border: 1px solid var(--border-soft, #1e2230); display: flex; flex-direction: column; transition: border-color .14s ease, transform .14s ease, box-shadow .14s ease; }
.ig-tile:hover { border-color: var(--border, #262a35); transform: translateY(-1px); box-shadow: var(--ig-shadow); }
.ig-media { position: relative; width: 100%; aspect-ratio: 1 / 1; overflow: hidden; background: var(--sunken-bg, rgba(0, 0, 0, .15)); cursor: zoom-in; }
.ig-media.ig-skel { min-height: 168px; }
.ig-media img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ig-tile-hover { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px; opacity: 0; transition: opacity .14s ease; background: linear-gradient(to top, rgba(0, 0, 0, .55), rgba(0, 0, 0, .12)); }
.ig-tile:hover .ig-tile-hover { opacity: 1; }
.ig-tile-hover .ig-btn { background: rgba(20, 22, 28, .82); backdrop-filter: blur(3px); }
.ig-badge { position: absolute; left: 8px; top: 8px; font-size: 10.5px; padding: 2px 7px; border-radius: 999px; background: rgba(13, 14, 18, .72); color: var(--text-dim, #9aa1b4); backdrop-filter: blur(3px); }
.ig-tile-meta { display: flex; flex-direction: column; gap: 3px; padding: 7px 9px 8px; min-width: 0; }
.ig-tile-prompt { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ig-tile-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ig-tile-line .ig-dim:not(.ig-ellip) { flex: none; white-space: nowrap; }
.ig-ellip { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 运行中：骨架屏 + 进度 */
.ig-skel { position: relative; overflow: hidden; background: var(--sunken-bg, rgba(0, 0, 0, .15)); }
.ig-skel::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%); background: linear-gradient(90deg, transparent, var(--glow-05, rgba(255, 255, 255, .05)), transparent); animation: ig-shimmer 1.5s infinite; }
@keyframes ig-shimmer { 100% { transform: translateX(100%); } }
.ig-spin { width: 13px; height: 13px; border-radius: 999px; border: 2px solid var(--border, #262a35); border-top-color: var(--accent, #8b5cf6); animation: ig-spin .8s linear infinite; flex: none; }
@keyframes ig-spin { to { transform: rotate(360deg); } }
.ig-skel-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--text-dim, #9aa1b4); font-size: 11.5px; }
.ig-tile.is-err { border-color: var(--red, #f87171); }
.ig-errbody { padding: 10px; display: flex; flex-direction: column; gap: 7px; }
.ig-errtext { color: var(--red-text, #fca5a5); font-size: 11.5px; max-height: 96px; overflow: auto; overflow-wrap: anywhere; white-space: pre-wrap; margin: 0; }

/* ---------- 底部提示词坞 ---------- */
.ig-dock { flex: none; border-top: 1px solid var(--border-soft, #1e2230); background: var(--panel-bg, var(--bg-elev, #14161c)); padding: 10px 16px 12px; display: flex; flex-direction: column; gap: 8px; }
.ig-chips { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
.ig-chip { display: inline-flex; align-items: center; gap: 6px; background: var(--chip-bg, var(--bg-elev2, #1a1d26)); border: 1px solid var(--border-soft, #1e2230); border-radius: 999px; padding: 3px 9px; font-size: 11.5px; color: var(--text-dim, #9aa1b4); }
.ig-chip select, .ig-chip input { background: transparent; border: none; color: var(--text, #e6e8ef); font: inherit; font-size: 11.5px; cursor: pointer; padding: 0; min-width: 40px; max-width: 190px; }
.ig-chip input[type="number"] { width: 34px; text-align: center; }
.ig-chip select:focus, .ig-chip input:focus { outline: none; color: var(--accent, #8b5cf6); }
.ig-chip-ico { opacity: .75; font-size: 11px; }
.ig-chip.on { border-color: var(--accent, #8b5cf6); color: var(--text, #e6e8ef); }
.ig-chip.warn { border-color: var(--amber, #fbbf24); color: var(--amber, #fbbf24); }
.ig-refchip { display: inline-flex; align-items: center; gap: 5px; background: var(--chip-bg, var(--bg-elev2, #1a1d26)); border: 1px solid var(--border-soft, #1e2230); border-radius: 999px; padding: 2px 4px 2px 2px; max-width: 190px; }
.ig-refchip img { width: 20px; height: 20px; border-radius: 999px; object-fit: cover; }
.ig-refchip span { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.ig-prompt { display: flex; align-items: flex-end; gap: 10px; background: var(--inputbox-bg, var(--bg-elev2, #1a1d26)); border: 1px solid var(--border, #262a35); border-radius: var(--ig-r); padding: 8px 8px 8px 12px; transition: border-color .12s ease, box-shadow .12s ease; }
.ig-prompt:focus-within { border-color: var(--accent, #8b5cf6); box-shadow: 0 0 0 3px var(--accent-soft, rgba(139, 92, 246, .14)); }
.ig-prompt textarea { flex: 1 1 auto; min-width: 0; background: transparent; border: none; color: var(--text, #e6e8ef); font: inherit; font-size: 13px; line-height: 1.55; resize: none; padding: 5px 0; max-height: 180px; outline: none; }
.ig-prompt textarea::placeholder { color: var(--text-faint, #6b7284); }
.ig-run { flex: none; border: none; border-radius: 10px; padding: 9px 16px; font: inherit; font-size: 12.5px; font-weight: 600; color: #fff; cursor: pointer; background: linear-gradient(135deg, var(--brand-grad-a, #8b5cf6), var(--brand-grad-b, #6366f1)); box-shadow: 0 4px 14px rgba(99, 102, 241, .32); display: inline-flex; align-items: center; gap: 7px; transition: filter .12s ease, transform .08s ease; }
.ig-run:hover:not([disabled]) { filter: brightness(1.07); }
.ig-run:active:not([disabled]) { transform: translateY(1px); }
.ig-run[disabled] { opacity: .45; cursor: not-allowed; box-shadow: none; }
.ig-dock-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.ig-adv { border: 1px solid var(--border-soft, #1e2230); border-radius: var(--ig-r-sm); padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; background: var(--card-bg, var(--bg-elev, #14161c)); }
.ig-adv summary { cursor: pointer; color: var(--text-dim, #9aa1b4); font-size: 11.5px; }
.ig-adv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }

/* ---------- 表单 ---------- */
.ig-form { display: flex; flex-direction: column; gap: var(--ig-gap); max-width: 760px; }
.ig-card { background: var(--card-bg, var(--bg-elev, #14161c)); border: 1px solid var(--border-soft, #1e2230); border-radius: var(--ig-r); padding: 13px 14px; display: flex; flex-direction: column; gap: 11px; }
.ig-card-head { display: flex; align-items: center; gap: 8px; }
.ig-card-head b { font-size: 12.5px; }
.ig-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
.ig-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.ig-label { color: var(--text-dim, #9aa1b4); font-size: 11.5px; display: flex; align-items: center; gap: 6px; }
.ig-hint { color: var(--text-faint, #6b7284); font-size: 11px; overflow-wrap: anywhere; line-height: 1.5; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ig-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12.5px; }
.ig-switch input { appearance: none; width: 34px; height: 19px; border-radius: 999px; background: var(--border, #262a35); position: relative; cursor: pointer; transition: background .14s ease; flex: none; margin: 0; }
.ig-switch input::after { content: ""; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 999px; background: var(--switch-knob, #fff); transition: transform .14s ease; }
.ig-switch input:checked { background: var(--accent, #8b5cf6); }
.ig-switch input:checked::after { transform: translateX(15px); }
.ig-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ig-testout { font-size: 11.5px; padding: 7px 10px; border-radius: var(--ig-r-sm); border: 1px solid var(--border, #262a35); overflow-wrap: anywhere; line-height: 1.5; }
.ig-testout.good { color: var(--green, #34d399); border-color: var(--green, #34d399); background: var(--green-soft, rgba(52, 211, 153, .12)); }
.ig-testout.bad { color: var(--red-text, #fca5a5); border-color: var(--red, #f87171); background: var(--red-soft, rgba(248, 113, 113, .12)); }

/* ---------- 服务页 ---------- */
.ig-svc-list { width: 254px; flex: none; border-right: 1px solid var(--border-soft, #1e2230); display: flex; flex-direction: column; min-height: 0; }
.ig-svc-listhead { display: flex; align-items: center; gap: 8px; padding: 11px 12px 6px; }
.ig-svc-items { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; padding: 4px 8px 8px; display: flex; flex-direction: column; gap: 3px; }
.ig-svc-item { display: flex; align-items: center; gap: 9px; background: transparent; border: 1px solid transparent; border-radius: 10px; padding: 7px 8px; cursor: pointer; text-align: left; color: var(--text, #e6e8ef); min-width: 0; font: inherit; transition: background .12s ease, border-color .12s ease; }
.ig-svc-item:hover { background: var(--glow-04, rgba(255, 255, 255, .04)); }
.ig-svc-item.on { border-color: var(--accent, #8b5cf6); background: var(--accent-soft, rgba(139, 92, 246, .14)); }
.ig-avatar { width: 26px; height: 26px; flex: none; border-radius: 8px; display: grid; place-items: center; font-size: 12px; font-weight: 600; background: var(--sunken-bg, rgba(0, 0, 0, .15)); border: 1px solid var(--border-soft, #1e2230); }
.ig-svc-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ig-svc-text b { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ig-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--green, #34d399); flex: none; }
.ig-dot.off { background: var(--text-faint, #6b7284); }
.ig-dot.nokey { background: var(--amber, #fbbf24); }
.ig-svc-add { display: flex; flex-direction: column; gap: 5px; padding: 8px 10px 11px; border-top: 1px solid var(--border-soft, #1e2230); }
.ig-svc-editor { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.ig-svc-editorbody { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; padding: 14px 16px; }
.ig-svc-footer { flex: none; border-top: 1px solid var(--border-soft, #1e2230); padding: 10px 16px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; background: var(--panel-bg, var(--bg-elev, #14161c)); }

/* ---------- 弹层 ---------- */
.ig-overlay { position: fixed; inset: 0; background: rgba(6, 7, 10, .74); backdrop-filter: blur(3px); z-index: 60; display: flex; align-items: center; justify-content: center; padding: 22px; }
.ig-modal { background: var(--bg-elev2, #1a1d26); border: 1px solid var(--border, #262a35); border-radius: 14px; width: min(940px, 95vw); max-height: 90vh; display: flex; flex-direction: column; gap: 9px; padding: 12px; overflow: hidden; box-shadow: var(--ig-shadow); }
.ig-modalbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.ig-pickgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 8px; overflow-y: auto; overscroll-behavior: contain; padding: 3px 2px; }
.ig-diritem { grid-column: 1 / -1; text-align: left; background: transparent; border: 1px solid var(--border-soft, #1e2230); border-radius: var(--ig-r-sm); padding: 6px 9px; cursor: pointer; color: var(--text, #e6e8ef); font: inherit; font-size: 12px; }
.ig-diritem:hover { border-color: var(--accent, #8b5cf6); }
.ig-pickitem { display: flex; flex-direction: column; gap: 3px; padding: 4px; border: 1px solid var(--border-soft, #1e2230); border-radius: var(--ig-r-sm); background: var(--card-bg, var(--bg-elev, #14161c)); cursor: pointer; overflow: hidden; transition: border-color .12s ease; }
.ig-pickitem:hover { border-color: var(--border, #262a35); }
.ig-pickitem.on { border-color: var(--accent, #8b5cf6); box-shadow: inset 0 0 0 1px var(--accent, #8b5cf6); }
.ig-pickitem img { width: 100%; height: 74px; object-fit: cover; border-radius: 6px; display: block; background: var(--sunken-bg, rgba(0, 0, 0, .15)); }
.ig-pickitem span { font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 大图查看 */

/* ---------- 提示条 ---------- */
.ig-toast { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 80; pointer-events: none; }
.ig-toast-card { background: var(--tooltip-bg, #232733); border: 1px solid var(--border, #262a35); color: var(--text, #e6e8ef); border-radius: 999px; padding: 7px 15px; font-size: 12px; box-shadow: var(--ig-shadow); max-width: 76vw; overflow-wrap: anywhere; animation: ig-pop .16s ease-out; }
@keyframes ig-pop { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* 滚动条跟随宿主风格 */
.ig ::-webkit-scrollbar { width: 9px; height: 9px; }
.ig ::-webkit-scrollbar-thumb { background: var(--scroll-thumb, #2a2f3d); border-radius: 999px; }
.ig ::-webkit-scrollbar-thumb:hover { background: var(--scroll-thumb-hover, #3a4152); }

/* ---------- 窄屏 ---------- */
@media (max-width: 760px) {
	.ig-top { flex-wrap: wrap; row-gap: 8px; }
	.ig-brandsub { display: none; }
	.ig-feed-head, .ig-feed, .ig-dock, .ig-cfg, .ig-svc-editorbody, .ig-svc-footer { padding-left: 11px; padding-right: 11px; }
	.ig-grid-tiles { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 9px; }
	.ig-chips { gap: 6px; }
	.ig-chip { padding: 3px 8px; }
	.ig-svc { flex-direction: column; }
	.ig-svc-list { width: auto; max-height: 40vh; border-right: none; border-bottom: 1px solid var(--border-soft, #1e2230); }
	.ig-prompt { align-items: stretch; flex-direction: column; }
	.ig-run { justify-content: center; }
}
`;
