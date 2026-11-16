import qrcode from "./vendor/qrcode.js";
import { renderMiniMd, stripNoteScaffold } from "./md.mjs?v=2.8.0";
import { esc } from "@pi-web-ui/plugin-sdk/client";
import { makeT } from "./i18n.mjs";

/** 面板文案：语言解析 / 回退 / 插值都在 SDK 里，这里只按当前界面语言取词。 */
const t = makeT();

export default {
	async mount(el, ctx) {
		let ridSeq = 0;
		const pendingReplies = new Map();

		if (typeof ctx.onData === "function") {
			ctx.onData((payload) => {
				const rid = payload && payload.__rid;
				if (rid) {
					const waiter = pendingReplies.get(rid);
					if (waiter) {
						pendingReplies.delete(rid);
						clearTimeout(waiter.timer);
						waiter.resolve(payload);
						return;
					}
				}
				if (payload?.type === "bili:action" && payload?.action) {
					appendActionTerminal(payload.action);
					const _st = payload.action.step;
					if (_st === "done" || _st === "error") void refreshAfterRun();
				}
			});
		}

		const sendMsg = (type, payload = {}) => {
			if (typeof ctx.send === "function") {
				const rid = `bili-${Date.now()}-${++ridSeq}`;
				return new Promise((resolve) => {
					const timer = setTimeout(() => {
						pendingReplies.delete(rid);
						resolve({ ok: false, error: t("hostTimeout") });
					}, 30000);
					pendingReplies.set(rid, { resolve, timer });
					try {
						ctx.send({ ...payload, type, __rid: rid });
					} catch (err) {
						pendingReplies.delete(rid);
						clearTimeout(timer);
						resolve({ ok: false, error: String(err?.message || err) });
					}
				});
			}

			const apiBase = ctx.apiBase || "/plugins-api/bili-scroll";
			const endpoint = type.replace(/^bili:/, "").replace(/-/g, "/");
			return fetch(`${apiBase}/${endpoint}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			})
				.then((r) => r.json())
				.catch((err) => ({ ok: false, error: String(err?.message || err) }));
		};

		const httpGet = (endpoint, params = {}) => {
			const apiBase = ctx.apiBase || "/plugins-api/bili-scroll";
			const q = new URLSearchParams(params).toString();
			const url = `${apiBase}/${endpoint}${q ? `?${q}` : ""}`;
			return fetch(url, { headers: { Accept: "application/json" } })
				.then((r) => r.json())
				.catch((err) => ({ ok: false, error: String(err?.message || err) }));
		};

		const httpPost = (endpoint, body = {}) => {
			const apiBase = ctx.apiBase || "/plugins-api/bili-scroll";
			return fetch(`${apiBase}/${endpoint}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			})
				.then((r) => r.json())
				.catch((err) => ({ ok: false, error: String(err?.message || err) }));
		};

		el.innerHTML = `
			<div class="bili-root" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); font-size: 13px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; position: relative; overflow: hidden;">
				<style>
					/* Inbox styles share the host theme. */
					.bili-inbox { min-width: 0; max-width: 100%; display: flex; flex-direction: column; gap: 10px; }
					.bili-inbox button, .bili-inbox textarea { padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; }
					.bili-inbox button { cursor: pointer; }
					.bili-inbox button:disabled { opacity: .5; cursor: default; }
					.bili-inbox .bili-dm-send { background: var(--accent); color: var(--accent-contrast, #fff); }
					.bili-inbox-list { display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow: auto; overscroll-behavior: contain; }
					.bili-inbox-list button { text-align: left; }
					.bili-inbox-list button[aria-pressed="true"] { border-color: var(--accent); }
					.bili-inbox-list button, .bili-dm-message, .bili-dm-selected { min-width: 0; max-width: 100%; overflow-wrap: anywhere; word-break: break-word; white-space: pre-wrap; }
					.bili-dm-message { padding: 8px; border: 1px solid var(--border); border-radius: 6px; }
					.bili-dm-compose { width: 100%; box-sizing: border-box; resize: vertical; }
					/* bili-scroll 开关按钮及交互增强 */
					.bili-switch-wrap {
						position: relative;
						display: inline-flex;
						align-items: center;
						width: 44px;
						height: 24px;
						cursor: pointer;
						user-select: none;
						flex-shrink: 0;
					}
					.bili-cfg-dm-watch {
						position: absolute;
						opacity: 0;
						width: 0;
						height: 0;
						margin: 0;
					}
					.bili-toggle-slider {
						position: absolute;
						top: 0;
						left: 0;
						right: 0;
						bottom: 0;
						background-color: color-mix(in srgb, var(--border, #444) 75%, var(--bg, #111));
						border: 1.5px solid var(--border, #666);
						border-radius: 24px;
						transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
						box-sizing: border-box;
					}
					.bili-toggle-slider::before {
						content: "";
						position: absolute;
						height: 16px;
						width: 16px;
						left: 2px;
						top: 2.5px;
						background-color: #ffffff;
						border-radius: 50%;
						transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.2s ease;
						box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
					}
					.bili-cfg-dm-watch:checked + .bili-toggle-slider {
						background-color: var(--accent);
						border-color: var(--accent);
					}
					.bili-cfg-dm-watch:checked + .bili-toggle-slider::before {
						transform: translateX(20px);
						background-color: var(--accent-contrast, #ffffff);
					}
					.bili-switch-wrap:hover .bili-toggle-slider {
						border-color: color-mix(in srgb, var(--accent) 60%, var(--border, #888));
					}
					.bili-cfg-dm-watch:focus-visible + .bili-toggle-slider {
						outline: 2px solid var(--accent);
						outline-offset: 2px;
					}
					/* 复选框增强 */
					.bili-root input[type="checkbox"]:not(.bili-cfg-dm-watch) {
						width: 16px;
						height: 16px;
						accent-color: var(--accent);
						cursor: pointer;
						margin: 0;
					}
				</style>
				<!-- 顶部 Header（仪表盘式：品牌块 + 状态徽标 + 刷新） -->
				<div class="bili-topbar">
					<!-- ═══ v2.6 顶栏：品牌 + 状态 pills（额度/轮次/投递/峰谷）+ 动作组 ═══ -->
<div class="bili-brand">
						<div class="bili-logo">📺</div>
<div class="bili-brand-text">
<div class="bili-brand-row">
<span class="bili-brand-title">${t("brandTitle")}</span>
<span class="bili-badge-ver" hidden>v—</span>
<span class="bili-badge-always" title="${t("badgeAlwaysTitle")}">${t("badgeAlways")}</span>
<span class="bili-pill-stat" title="${t("pillQuotaTitle")}">${t("pillPickedLabel")} <b class="bili-hp-quota">—</b></span>
<span class="bili-pill-stat" title="${t("pillRoundsTitle")}"><b class="bili-hp-rounds">—</b></span>
<span class="bili-pill-stat" title="${t("pillDmTitle")}"><b class="bili-hp-dmmode">—</b></span>
<span style="color: var(--border);">|</span>
<span class="bili-hp-lastrun" style="font-size: 10px; color: var(--text-dim); font-family: ui-monospace, Menlo, Consolas, monospace;">${t("lastRunPrefix")} —</span>
</div>
<div class="bili-brand-sub">${t("brandSub")}</div>
</div>
					</div>
<div class="bili-topbar-actions">
<button class="bili-btn-run-top" type="button" title="${t("topRunTitle")}">${t("topRun")}</button>
<button class="bili-btn-runs" type="button" title="${t("topRunsTitle")}">${t("topRuns")}</button>
<button class="bili-btn-settings" type="button" title="${t("topSettingsTitle")}">${t("topSettings")}</button>
<button class="bili-btn-refresh" type="button" title="${t("topRefreshTitle")}">${t("topRefresh")}</button>
</div>
				</div>
				<!-- 仪表盘样式（跟随宿主主题变量） -->
				<style>
					/* 与宿主一致：全量 border-box（插件内元素默认不是） */
					.bili-root, .bili-root * { box-sizing: border-box; }
					.bili-topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--bg-elev); flex: none; }
					.bili-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
					.bili-logo { width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; font-size: 19px; flex: none; background: linear-gradient(135deg, var(--accent), var(--blue, #23ade5)); box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 30%, transparent); }
					.bili-brand-text { min-width: 0; }
					.bili-brand-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
					.bili-brand-title { font-weight: 800; font-size: 15px; }
					.bili-brand-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; overflow-wrap: anywhere; }
					.bili-badge-ver { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent); }
					.bili-badge-always { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--blue, #23ade5) 15%, transparent); color: var(--blue, #23ade5); border: 1px solid color-mix(in srgb, var(--blue, #23ade5) 35%, transparent); }
					.bili-status-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--green, #22c55e) 15%, transparent); color: var(--green, #22c55e); border: 1px solid color-mix(in srgb, var(--green, #22c55e) 32%, transparent); }
					.bili-btn-refresh { padding: 6px 12px; border-radius: 10px; border: 1px solid var(--border); background: transparent; color: var(--text); cursor: pointer; font-size: 12px; flex: none; }
					.bili-btn-refresh:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
/* v2.6 KPI 四宫格已删，数据并入顶栏 pills（.bili-pill-stat） */
					/* 主区两栅（容器自适应：窄了就上下堆叠） */
					.bili-dash-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
					.bili-card { border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px; background: var(--bg-elev); min-width: 0; }
					.bili-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
					.bili-card-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-weight: 700; font-size: 14px; }
					.bili-card-title-hint { font-weight: 400; font-size: 11px; color: var(--text-dim); }
					.bili-card-sub { font-size: 12px; line-height: 1.55; color: var(--text-dim); margin-top: 3px; overflow-wrap: anywhere; }
					.bili-pill-peak { font-size: 11px; font-weight: 500; padding: 1px 8px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); }
					/* 操作行 */
					.bili-run-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
					.bili-btn-run-duty { display: inline-flex; align-items: center; gap: 6px; border: none; border-radius: 10px; padding: 9px 16px; background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #fff)); color: var(--accent-contrast, #fff); font-weight: 700; font-size: 13px; cursor: pointer; box-shadow: 0 6px 18px color-mix(in srgb, var(--accent) 32%, transparent); }
					.bili-btn-ghost { border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; background: transparent; color: var(--text); font-size: 12px; cursor: pointer; }
					.bili-btn-ghost:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
					.bili-btn-ghost.bili-btn-xs { padding: 4px 10px; font-size: 11px; border-radius: 8px; }
					.bili-btn-save { padding: 8px 24px; border: none; border-radius: 10px; background: var(--accent); color: var(--accent-contrast, #fff); font-weight: 700; font-size: 13px; cursor: pointer; }
					/* 实时动作终端 */
					.bili-terminal { display: flex; flex-direction: column; margin-top: 12px; border: 1px solid #26282e; border-radius: 10px; background: #0c0d0e; color: #d4d4d4; overflow: hidden; }
					.bili-terminal-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 12px; background: #16181b; border-bottom: 1px solid #282a2e; }
					.bili-terminal-head-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
					.bili-terminal-title { font-size: 12px; font-weight: 600; color: #fff; }
					.bili-pulse-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #52c41a; flex: none; }
					.bili-action-status-pill { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: #26292e; color: #a0a0a0; }
					.bili-btn-clear-terminal { padding: 2px 8px; border-radius: 4px; border: 1px solid #3c3f44; background: #222428; color: #aaa; cursor: pointer; font-size: 11px; }
					.bili-action-terminal-body { height: 190px; overflow-y: auto; overscroll-behavior: contain; padding: 10px 14px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
					/* 日报 */
					.bili-report-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
					.bili-report-select { padding: 4px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; max-width: 220px; }
					.bili-report-content { margin-top: 10px; max-height: 280px; overflow-y: auto; overscroll-behavior: contain; padding: 12px; border-radius: 10px; background: var(--bg); border: 1px solid var(--border); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
					/* 关键设置行 */
					.bili-set-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
					.bili-set-rows > .bili-set-row:last-child { border-bottom: none; }
					.bili-set-row > span { font-size: 12px; color: var(--text-dim); min-width: 0; overflow-wrap: anywhere; }
					.bili-set-row input[type="number"], .bili-set-row select { width: 112px; flex: none; padding: 6px 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-size: 12px; }
					.bili-btn-save-quick { width: 100%; margin-top: 12px; padding: 9px 16px; border: none; border-radius: 10px; background: var(--accent); color: var(--accent-contrast, #fff); font-weight: 700; font-size: 13px; cursor: pointer; }
					.bili-note { margin-top: 10px; padding: 9px 11px; border-radius: 10px; font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; color: var(--text); background: color-mix(in srgb, var(--accent) 10%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent); }
					/* 开关：任意 switch-wrap 内的 checkbox 都走滑块，隐藏原生框 */
					.bili-root .bili-switch-wrap > input[type="checkbox"] { position: absolute; opacity: 0; width: 0; height: 0; margin: 0; }
					.bili-switch-wrap input:checked + .bili-toggle-slider { background-color: var(--accent); border-color: var(--accent); }
					.bili-switch-wrap input:checked + .bili-toggle-slider::before { transform: translateX(20px); background-color: var(--accent-contrast, #fff); }
					/* 顶栏动作区 */
					.bili-topbar-actions { display: flex; align-items: center; gap: 8px; flex: none; }
/* 顶栏四个按钮同一套（v2.9）：同内边距/圆角/字号字重，hover 才露 accent */
					.bili-topbar-actions .bili-btn-run-top, .bili-topbar-actions .bili-btn-refresh, .bili-topbar-actions .bili-btn-settings, .bili-topbar-actions .bili-btn-runs { padding: 7px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--text); font-size: 12px; font-weight: 600; line-height: 1.5; cursor: pointer; flex: none; white-space: nowrap; }
					.bili-topbar-actions .bili-btn-run-top:hover, .bili-topbar-actions .bili-btn-refresh:hover, .bili-topbar-actions .bili-btn-settings:hover, .bili-topbar-actions .bili-btn-runs:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--bg)); }
					.bili-topbar-actions button:active { transform: translateY(1px); }
					.bili-runs-summary { display: flex; flex-wrap: wrap; gap: 8px 14px; font-size: 12px; color: var(--text-dim); margin: 8px 0 10px; }
					.bili-runs-summary b { color: var(--text); }
					.bili-runs-select { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; }
					.bili-runs-timeline { margin-top: 10px; max-height: 380px; overflow: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
					.bili-runs-step { display: flex; gap: 8px; align-items: baseline; padding: 5px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); overflow-wrap: anywhere; }
					.bili-runs-clock { color: var(--text-dim); font-size: 11px; flex: none; }
					.bili-runs-tag { flex: none; font-size: 11px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-dim); }
					.bili-runs-msg { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
					.bili-runs-msg a { color: var(--accent); }
					.bili-runs-badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); }
					.bili-runs-badge.ok { color: var(--green, #22c55e); border-color: color-mix(in srgb, var(--green, #22c55e) 40%, var(--border)); }
					.bili-runs-badge.run { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
					.bili-runs-badge.warn { color: #faad14; border-color: color-mix(in srgb, #faad14 45%, var(--border)); }
					.bili-runs-badge.err { color: #ff4d4f; border-color: color-mix(in srgb, #ff4d4f 45%, var(--border)); }
					/* 设置弹窗：绝对定位在插件面板内，不 fixed、不写死层级，避免盖住宿主 UI */
					.bili-modal { position: absolute; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; padding: 16px; }
					.bili-modal[hidden] { display: none; }
					.bili-modal-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.45); }
					.bili-modal-panel { position: relative; display: flex; flex-direction: column; width: min(780px, 100%); max-height: 100%; min-height: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--bg-elev); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35); overflow: hidden; }
					.bili-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); flex: none; }
					.bili-modal-title { font-weight: 800; font-size: 14px; min-width: 0; overflow-wrap: anywhere; }
					.bili-modal-sub { margin-left: 6px; font-weight: 400; font-size: 11px; color: var(--text-dim); }
					.bili-modal-close { width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 9px; background: var(--bg); color: var(--text); font-size: 13px; cursor: pointer; flex: none; }
					.bili-modal-close:hover { border-color: var(--accent); }
					.bili-modal-nav { display: flex; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--border); flex: none; overflow-x: auto; }
					.bili-modal-tab { padding: 7px 12px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--text-dim); font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; flex: none; }
					.bili-modal-tab.is-active { color: var(--text); background: color-mix(in srgb, var(--accent) 14%, transparent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
					.bili-modal-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
					.bili-pane { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
					.bili-pane[hidden] { display: none; }
					/* 提示词：能看见的默认值 + 固定追加部分 */
					.bili-prompt-area { width: 100%; box-sizing: border-box; margin-top: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; line-height: 1.55; resize: vertical; overflow-wrap: anywhere; }
					.bili-prompt-fixed { margin-top: 8px; padding: 10px; border-radius: 8px; border: 1px dashed var(--border); background: color-mix(in srgb, var(--accent) 6%, transparent); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; line-height: 1.5; color: var(--text-dim); white-space: pre-wrap; overflow-wrap: anywhere; }
					.bili-prompt-fixed::before { content: "${t("promptFixedBadge")}"; display: block; margin-bottom: 6px; font-family: inherit; font-weight: 700; color: var(--text); }
					textarea.bili-prompt-fixed { width: 100%; box-sizing: border-box; resize: vertical; color: var(--text); }
					.bili-prompt-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
					.bili-prompt-state { font-weight: 400; }
					@media (max-width: 620px) { .bili-brand-sub { display: none; } .bili-modal { padding: 8px; } }
					/* ═══ v2.5 深空高级列表（B 方案）：主页纯封面流，内部滚动 ═══ */
					.bili-range-seg { display: inline-flex; background: color-mix(in srgb, var(--text) 7%, transparent); border: 1px solid var(--border); border-radius: 999px; padding: 2px; gap: 2px; }
					.bili-range-seg button { border: 0; background: transparent; color: var(--text-dim); font-size: 11.5px; font-weight: 600; padding: 5px 12px; border-radius: 999px; cursor: pointer; white-space: nowrap; }
					.bili-range-seg button.is-active { background: var(--accent); color: var(--accent-contrast, #fff); }
					.bili-day-select { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 999px; padding: 5px 10px; font-size: 11.5px; cursor: pointer; max-width: 150px; }
					.bili-btn-run-2 { padding: 6px 12px; border-radius: 999px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-contrast, #fff); font-size: 11.5px; font-weight: 700; cursor: pointer; white-space: nowrap; }
					.bili-cards-grid.bili-b-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; margin-top: 12px; flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 2px 2px 8px; align-content: start; }
					.bili-b-card { background: color-mix(in srgb, var(--text) 4%, transparent); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; cursor: pointer; min-width: 0; transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease; }
					.bili-b-card:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--accent) 55%, transparent); box-shadow: 0 14px 36px rgba(0,0,0,.35); }
					.bili-b-cover { position: relative; aspect-ratio: 16/9; overflow: hidden; background: #000; }
					.bili-b-cover img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .35s ease; }
					.bili-b-card:hover .bili-b-cover img { transform: scale(1.05); }
					.bili-b-cover::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, transparent 55%, rgba(0,0,0,.6)); pointer-events: none; }
					.bili-b-meta { position: absolute; left: 8px; right: 8px; bottom: 6px; z-index: 2; display: flex; gap: 8px; align-items: center; color: #fff; font-size: 11px; text-shadow: 0 1px 2px rgba(0,0,0,.6); }
					.bili-b-meta svg { width: 12px; height: 12px; flex: none; }
					.bili-b-meta .m { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
					.bili-b-dur { margin-left: auto; background: rgba(0,0,0,.6); border: 1px solid rgba(255,255,255,.2); padding: 1px 7px; border-radius: 999px; font-size: 10.5px; flex: none; }
					.bili-b-flags { position: absolute; left: 8px; top: 8px; z-index: 2; display: flex; gap: 5px; }
					.bili-b-flags i { font-style: normal; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,.25); backdrop-filter: blur(8px); }
					.bili-b-flags .f-like { background: rgba(251,114,153,.88); color: #fff; }
					.bili-b-flags .f-fav { background: rgba(0,174,236,.88); color: #fff; }
					.bili-b-flags .f-cmt { background: rgba(0,0,0,.62); color: #fff; }
					.bili-b-body { padding: 10px 12px 12px; }
					.bili-b-title { font-size: 13px; font-weight: 600; line-height: 1.45; margin: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 38px; overflow-wrap: anywhere; }
					.bili-b-up { display: flex; align-items: center; gap: 6px; margin-top: 8px; color: var(--text-dim); font-size: 11.5px; min-width: 0; }
					.bili-b-ava { width: 20px; height: 20px; border-radius: 50%; flex: none; background: conic-gradient(from 40deg, #fb7299, #00aeec, #a78bfa, #fb7299); padding: 1.5px; }
					.bili-b-ava b { display: flex; width: 100%; height: 100%; border-radius: 50%; background: var(--bg-elev); align-items: center; justify-content: center; font-size: 9px; color: var(--text); }
					.bili-b-acts { display: flex; gap: 10px; margin-top: 6px; font-size: 11px; color: var(--text-dim); align-items: center; }
					.bili-b-acts svg { width: 12px; height: 12px; vertical-align: -2px; }
					.bili-b-acts .on { color: var(--accent); font-weight: 700; }
					/* ═══ v2.5 详情弹窗 ═══ */
					.bili-detail[hidden] { display: none; }
/* v2.6 层级约定（插件内部）：详情弹窗 40 > 设置弹窗 50 > 动作通知走宿主全局通知；卡片 hover 的 transform 不再抢层级 */
.bili-detail { position: absolute; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; padding: 14px; }
					.bili-detail-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.6); backdrop-filter: blur(10px); }
					.bili-detail-panel { position: relative; width: min(880px, 100%); max-height: 100%; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 16px; background: var(--bg-elev); box-shadow: 0 24px 80px rgba(0,0,0,.5); overflow: hidden; }
					.bili-detail-head { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-bottom: 1px solid var(--border); flex: none; }
					.bili-detail-title { margin: 0; font-size: 14px; line-height: 1.5; font-weight: 700; }
					.bili-detail-sub { font-size: 11px; color: var(--text-dim); margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; }
					.bili-detail-sub em { font-style: normal; background: var(--bg); border: 1px solid var(--border); padding: 0 8px; border-radius: 999px; }
					.bili-detail-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; overflow: hidden; }
					.bili-detail-left { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 12px; border-right: 1px solid var(--border); }
					.bili-detail-right { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
					.bili-sum-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11px; color: var(--text-dim); flex: none; }
					.bili-sum-label { font-weight: 700; font-size: 11.5px; color: var(--text); }
					.bili-sum-meta { min-width: 0; overflow-wrap: anywhere; }
					.bili-sum-regen { margin-left: auto; font-size: 10.5px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg); color: var(--text-dim); cursor: pointer; }
					.bili-sum-regen:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); color: var(--accent); }
					.bili-sum-body { min-width: 0; }
					.bili-sum-empty { border: 1px dashed color-mix(in srgb, var(--accent) 40%, transparent); border-radius: 12px; padding: 12px; background: color-mix(in srgb, var(--accent) 6%, transparent); font-size: 12px; color: var(--text-dim); display: flex; flex-direction: column; gap: 8px; line-height: 1.6; }
					.bili-sum-empty b { color: var(--text); }
					.bili-sum-cta { align-self: flex-start; font-size: 11.5px; padding: 6px 12px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); cursor: pointer; font-weight: 700; }
					.bili-sum-cta:disabled { opacity: .6; cursor: default; }
					.bili-sum-busy { display: flex; flex-direction: column; gap: 7px; font-size: 12px; color: var(--text-dim); line-height: 1.6; }
					.bili-sum-busy .skel { height: 10px; border-radius: 999px; background: linear-gradient(90deg, var(--border), color-mix(in srgb, var(--border) 40%, transparent), var(--border)); background-size: 200% 100%; animation: biliShimmer 1.4s linear infinite; }
					@keyframes biliShimmer { to { background-position: -200% 0; } }
					.bili-sum-raw { margin-top: 2px; }
					.bili-sum-raw > summary { cursor: pointer; font-size: 11px; color: var(--text-dim); }
					.bili-sum-raw-body { margin-top: 8px; border-top: 1px dashed var(--border); padding-top: 8px; }
					.bili-detail-player { border-radius: 12px; overflow: hidden; position: relative; aspect-ratio: 16/9; background: #000; border: 1px solid var(--border); }
					.bili-detail-player img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .55; }
					.bili-detail-play { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
					.bili-detail-play button { width: 54px; height: 54px; border-radius: 50%; border: 1px solid rgba(255,255,255,.35); background: rgba(255,255,255,.14); backdrop-filter: blur(10px); color: #fff; font-size: 18px; cursor: pointer; }
					.bili-detail-player iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
					.bili-detail-acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
					.bili-detail-acts .chip { font-size: 11px; border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px; background: var(--bg); color: var(--text-dim); }
					.bili-detail-acts .chip.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 50%, transparent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
					.bili-detail-cmt { border: 1px solid var(--border); background: var(--bg); border-radius: 10px; padding: 8px 10px; margin-top: 8px; font-size: 12px; }
					.bili-detail-cmt .who { font-size: 11px; color: var(--text-dim); margin-bottom: 3px; display: flex; justify-content: space-between; }
					.bili-md blockquote { margin: 0 0 10px; padding: 9px 12px; border-radius: 0 10px 10px 0; border-left: 3px solid var(--accent); background: color-mix(in srgb, var(--accent) 9%, transparent); font-size: 12.5px; line-height: 1.7; }
					.bili-md h4 { margin: 12px 0 6px; font-size: 12px; color: var(--text-dim); letter-spacing: .05em; }
					.bili-md h5 { margin: 10px 0 4px; font-size: 11.5px; color: var(--text-dim); }
					.bili-md hr { border: 0; border-top: 1px dashed var(--border); margin: 10px 0; }
					.bili-md ul { margin: 6px 0; padding-left: 18px; font-size: 12.5px; }
					.bili-md ol { margin: 6px 0; padding-left: 20px; font-size: 12.5px; }
					.bili-md li { margin: 3px 0; line-height: 1.65; }
					.bili-md p { margin: 6px 0; font-size: 12.5px; line-height: 1.7; }
					.bili-md code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; padding: 1px 5px; border-radius: 5px; background: color-mix(in srgb, var(--border) 55%, transparent); }
					.bili-md a { color: var(--accent); }
					.bili-md .bili-ts { font-variant-numeric: tabular-nums; font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); color: var(--accent); text-decoration: none; white-space: nowrap; }
					.bili-md p.bili-row { color: var(--text-dim); }
@media (max-width: 720px) { .bili-detail-body { grid-template-columns: 1fr; } .bili-detail-left { border-right: 0; border-bottom: 1px solid var(--border); } }

/* ═══ v2.6 顶栏状态 pills ═══ */
.bili-pill-stat { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--text-dim); border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent); }
.bili-pill-stat b { color: var(--text); font-weight: 700; font-variant-numeric: tabular-nums; }
.bili-pill-stat b:empty::after { content: "—"; }

/* ═══ v2.6 详情弹窗：双栏 + 账号动作台账 ═══ */
.bili-detail-panel { width: min(960px, 100%); }
.bili-detail-body { grid-template-columns: minmax(0, 58fr) minmax(0, 42fr); }
.bili-detail-player-hint { font-size: 11px; color: var(--text-dim); margin-top: 6px; }
.bili-ledger { margin-top: 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); overflow: hidden; }
.bili-ledger-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent); font-size: 11.5px; font-weight: 700; }
.bili-ledger-sub { font-weight: 400; font-size: 10px; color: var(--text-dim); overflow-wrap: anywhere; }
.bili-ledger-rows { display: flex; flex-direction: column; }
.bili-ledger-row { display: flex; align-items: flex-start; gap: 9px; padding: 7px 10px; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); min-width: 0; }
.bili-ledger-row:last-child { border-bottom: none; }
.bili-ledger-ico { flex: none; width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; font-size: 12px; background: color-mix(in srgb, var(--border) 45%, transparent); }
.bili-ledger-ico.on { background: color-mix(in srgb, var(--green, #22c55e) 14%, transparent); color: var(--green, #22c55e); }
.bili-ledger-ico.warn { background: color-mix(in srgb, var(--amber, #f59e0b) 14%, transparent); color: var(--amber, #f59e0b); }
.bili-ledger-main { flex: 1; min-width: 0; font-size: 12px; line-height: 1.5; }
.bili-ledger-main .t { font-weight: 700; font-size: 12px; }
.bili-ledger-main .t.ok { color: var(--green, #22c55e); }
.bili-ledger-main .t.no { color: var(--text-dim); }
.bili-ledger-main .t.unknown { color: var(--amber, #f59e0b); }
.bili-ledger-main .d { color: var(--text-dim); font-size: 11px; margin-top: 1px; overflow-wrap: anywhere; }
.bili-ledger-quote { margin-top: 4px; padding: 6px 9px; border-radius: 8px; background: color-mix(in srgb, var(--border) 40%, transparent); color: var(--text); font-size: 11.5px; overflow-wrap: anywhere; }
.bili-ledger-act { flex: none; align-self: center; font-size: 10.5px; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg-elev); color: var(--text); cursor: pointer; }
.bili-ledger-act:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); color: var(--accent); }
.bili-detail-sub em.detail-stat-sub { color: var(--text-dim); }
.bili-detail-acts .chip.skel { opacity: .55; }
.bili-detail-acts .chip[data-act='fav'] { cursor: pointer; }

/* ═══ v2.6 视频列表：网格 / 列表双视图 ═══ */
.bili-wall-toggle { display: inline-flex; overflow: hidden; border: 1px solid var(--border); border-radius: 10px; flex: none; }
.bili-wt { padding: 5px 10px; font-size: 11px; border: none; background: var(--bg); color: var(--text-dim); cursor: pointer; }
.bili-wt + .bili-wt { border-left: 1px solid var(--border); }
.bili-wt:hover { color: var(--text); }
.bili-wt.is-active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-weight: 700; }
.bili-cards-grid.is-list { grid-template-columns: 1fr; }
.bili-cards-grid.is-list .bili-b-card { display: flex; align-items: flex-start; gap: 12px; }
.bili-cards-grid.is-list .bili-b-cover { width: 168px; aspect-ratio: 16/9; flex: none; }
.bili-cards-grid.is-list .bili-b-body { flex: 1; min-width: 0; padding: 10px 12px 10px 0; }
.bili-cards-grid.is-list .bili-b-title { white-space: nowrap; }
.bili-cards-grid.is-list .bili-b-up { margin-top: 2px; }
.bili-cards-grid.is-list .whyline { -webkit-line-clamp: 1; }
.bili-b-card .whyline { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

/* ═══ v2.6 设置弹窗底部常驻保存栏 ═══ */
.bili-modal-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--border); flex: none; background: var(--bg-elev); }
.bili-modal-foot-hint { font-size: 11px; color: var(--text-dim); min-width: 0; overflow-wrap: anywhere; }
.bili-btn-save-foot { flex: none; padding: 8px 22px; border: none; border-radius: 10px; background: var(--accent); color: var(--accent-contrast, #fff); font-weight: 700; font-size: 13px; cursor: pointer; }
.bili-btn-save-foot:disabled { opacity: 0.55; cursor: not-allowed; }

/* ═══ 清空：列表头部按钮 + 确认弹层 ═══ */
.bili-btn-clear-history { flex: none; font-size: 11px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg); color: var(--text-dim); cursor: pointer; }
.bili-btn-clear-history:hover { border-color: color-mix(in srgb, var(--red, #ef4444) 55%, var(--border)); color: var(--red, #ef4444); }
.bili-clear-warn { font-size: 12.5px; color: var(--text); }
.bili-clear-list { margin: 8px 0 0; padding-left: 18px; font-size: 12.5px; line-height: 1.7; color: var(--text); }
.bili-clear-list li { margin: 3px 0; }
.bili-clear-keep { margin-top: 12px; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--green, #22c55e) 10%, transparent); border: 1px solid color-mix(in srgb, var(--green, #22c55e) 30%, transparent); font-size: 12px; line-height: 1.6; color: var(--text); }
.bili-btn-clear-ok { flex: none; padding: 8px 18px; border: 1px solid color-mix(in srgb, var(--red, #ef4444) 60%, transparent); border-radius: 10px; background: color-mix(in srgb, var(--red, #ef4444) 16%, transparent); color: var(--red, #ef4444); font-weight: 700; font-size: 13px; cursor: pointer; }
.bili-btn-clear-ok:disabled { opacity: 0.55; cursor: not-allowed; }

/* 跑一轮已并入顶栏统一按钮（一套 padding/圆角/字重，见顶栏动作区） */
</style>


				<!-- 主滚屏区域 -->
				<div class="bili-scrollable" style="flex: 1; min-height: 0; overflow: hidden; padding: 16px; display: flex; flex-direction: column; gap: 16px;">
<!-- 提示条 / Feedback -->
<div class="bili-feedback-bar" style="display: none; padding: 8px 12px; border-radius: 6px; font-size: 12px; line-height: 1.4;"></div>

<!-- ═══════════ 唯一界面：日常（其余配置全在右上「⚙️ 设置」弹窗） ═══════════ -->
					<div class="bili-page-daily" style="display: flex; flex-direction: column; gap: 12px; flex: 1; min-height: 0;">

<!-- ① 它刷过的视频（深空高级封面流 · 内部滚动） -->
<div class="bili-card" style="flex: 1; min-height: 0; display: flex; flex-direction: column;">
							<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
								<div>
<div class="bili-card-title">${t("watchedTitle")} <span class="bili-card-title-hint">${t("watchedHint")}</span></div>
								</div>
								<button class="bili-btn-clear-history" type="button" title="${t("clearTitle")}">${t("clearBtn")}</button>
								<!-- 筛选 Chips（data key, not UI：data-tier 的值参与服务端筛选查询，不翻译） -->
								<div class="bili-watched-filters" style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center;">
									<button class="bili-chip-state" data-state="" style="padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); background: var(--accent); color: var(--accent-contrast, #fff); font-size: 11px; cursor: pointer;">${t("chipAll")}</button>
									<button class="bili-chip-state" data-state="picked" style="padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 11px; cursor: pointer;">${t("chipPicked")}</button>
									<button class="bili-chip-state" data-state="skipped" style="padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 11px; cursor: pointer;">${t("chipSkipped")}</button>
									<button class="bili-chip-state" data-state="commented" style="padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 11px; cursor: pointer;">${t("chipCommented")}</button>
									<span style="color: var(--border);">|</span>
									<button class="bili-chip-tier" data-tier="" style="padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 11px; cursor: pointer;">${t("chipAllTiers")}</button>
									<button class="bili-chip-tier" data-tier="值得看" style="padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 11px; cursor: pointer;">${t("chipTierWorth")}</button>
									<button class="bili-chip-tier" data-tier="可以看" style="padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 11px; cursor: pointer;">${t("chipTierWatchable")}</button>
								</div>
							</div>

<!-- 时间范围：默认上次可切今日近7天往期 -->
<div class="bili-range-row" style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px;">
<div class="bili-range-seg">
<button class="is-active" data-range="last">${t("rangeBtnLast")}</button>
<button data-range="today">${t("rangeBtnToday")}</button>
<button data-range="week">${t("rangeBtnWeek")}</button>
</div>
<select class="bili-day-select" title="${t("daySelectTitle")}"></select>
<span class="bili-range-hint" style="font-size: 11px; color: var(--text-dim);">${t("clickCoverHint")}</span>
<span style="flex: 1;"></span>
<div class="bili-wall-toggle" role="group" aria-label="${t("viewToggleAria")}">
<button class="bili-wt is-active" data-view="grid" type="button" title="${t("viewGridTitle")}">${t("viewGrid")}</button>
<button class="bili-wt" data-view="list" type="button" title="${t("viewListTitle")}">${t("viewList")}</button>
</div>
</div>

<!-- 视频网格卡片容器（内部滚动主页不滚） -->
<div class="bili-cards-grid bili-b-grid">
								<div style="grid-column: 1 / -1; padding: 24px; text-align: center; color: var(--text-dim);">${t("loadingCards")}</div>
							</div>

							<!-- 卡片分页控制器 -->
							<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); font-size: 12px;">
								<span class="bili-page-info" style="color: var(--text-dim);">${t("pageInfo", { from: 0, to: 0, total: 0 })}</span>
								<div style="display: flex; gap: 8px;">
									<button class="bili-btn-prev-page bili-btn-ghost bili-btn-xs">${t("prevPage")}</button>
									<button class="bili-btn-next-page bili-btn-ghost bili-btn-xs">${t("nextPage")}</button>
								</div>
							</div>
						</div>

<!-- ② v2.6 KPI 四宫格已并入顶栏状态 pills，不再有独立区块 -->

						<!-- ③ 一键巡检 + 精选速报（其余配置都在右上「⚙️ 设置」弹窗） -->
						<div class="bili-dash-grid" hidden>
							<div class="bili-dash-main">
								<!-- ⚡ 一键巡检 -->
								<div class="bili-card">
									<div class="bili-card-head">
										<div>
											<div class="bili-card-title">${t("dashTitle")} <span class="bili-pill-peak">${t("peakPill", { state: t("peakOn") })}</span></div>
											<div class="bili-card-sub">${t("dashSub")}</div>
										</div>
									</div>
									<div class="bili-run-row">
										<button class="bili-btn-run-duty"><span>🚀</span><span>${t("runNow")}</span></button>
										<button class="bili-btn-ghost bili-btn-chat-mode">${t("chatRoam")}</button>
										<button class="bili-btn-ghost bili-btn-fav-today">${t("favToday")}</button>
									</div>

									<!-- AI 实时动作视窗 (Live Action Terminal) -->
									<div class="bili-terminal">
										<div class="bili-terminal-head">
											<div class="bili-terminal-head-left">
												<span class="bili-pulse-dot"></span>
												<span class="bili-terminal-title">${t("terminalTitle")}</span>
												<span class="bili-action-status-pill">${t("terminalIdleStatus")}</span>
											</div>
											<button class="bili-btn-clear-terminal">${t("terminalClear")}</button>
										</div>
										<div class="bili-action-terminal-body"><span style="color: #666;">${t("terminalIdleHint")}</span></div>
									</div>
								</div>

								<!-- 📑 精选速报 -->
								<div class="bili-card">
									<div class="bili-card-head">
										<div class="bili-card-title">${t("reportTitle")} <span class="bili-card-title-hint">${t("reportHint")}</span></div>
										<div class="bili-report-actions">
											<select class="bili-report-select"></select>
											<button class="bili-btn-ghost bili-btn-copy-report">${t("copyMarkdown")}</button>
										</div>
									</div>
									<div class="bili-report-content">${t("reportEmpty")}</div>
								</div>
							</div>


						</div>
					</div>
				</div>

<!-- ═══════════ v2.6 视频详情弹窗：左 = 视频 + 账号动作台账；右 = 总结 + 证据 ═══════════ -->
<div class="bili-detail" hidden>
<div class="bili-detail-backdrop"></div>
<div class="bili-detail-panel" role="dialog" aria-modal="true" aria-label="${t("detailAria")}">
<div class="bili-detail-head">
<div style="flex: 1; min-width: 0;">
<h3 class="bili-detail-title"></h3>
<div class="bili-detail-sub"></div>
</div>
<button class="bili-btn-ghost bili-detail-open" style="flex: none;">${t("openOnBili")}</button>
<button class="bili-modal-close bili-detail-close" type="button" aria-label="${t("closeDetail")}">✕</button>
</div>
<div class="bili-detail-body">
<div class="bili-detail-left">
<div class="bili-detail-player">
<img class="bili-detail-cover" alt="" />
<div class="bili-detail-play"><button type="button" title="${t("playTitle")}">▶</button></div>
</div>
<div style="font-size: 11px; color: var(--text-dim); margin-top: 6px;">${t("playerHint")}</div>
<div class="bili-detail-acts"></div>
<div class="bili-ledger">
<div class="bili-ledger-title">${t("ledgerTitle")} <span class="bili-ledger-sub">${t("ledgerSub")}</span></div>
<div class="bili-ledger-rows"></div>
</div>
<div class="bili-detail-comments"></div>
</div>
<div class="bili-detail-right">
<div class="bili-sum-bar">
<span class="bili-sum-label">${t("summaryLabel")}</span>
<span class="bili-sum-meta"></span>
<button class="bili-sum-regen" type="button" hidden>${t("regenerate")}</button>
</div>
<div class="bili-sum-body bili-md"></div>
</div>
</div>
</div>
</div>

<!-- ═══════════ 清空确认 ═══════════ -->
<div class="bili-modal bili-clear-modal" hidden>
<div class="bili-modal-backdrop bili-clear-backdrop"></div>
<div class="bili-modal-panel" role="dialog" aria-modal="true" aria-label="${t("clearModalAria")}">
<div class="bili-modal-head">
<div class="bili-modal-title">${t("clearModalTitle")}</div>
<button class="bili-modal-close bili-clear-close" type="button" aria-label="${t("close")}">✕</button>
</div>
<div class="bili-modal-body">
<div class="bili-clear-warn">${t("clearWarn")}</div>
<ul class="bili-clear-list">
<li>${t("clearItem1")}</li>
<li>${t("clearItem2")}</li>
<li>${t("clearItem3")}</li>
</ul>
<div class="bili-clear-keep">${t("clearKeep")}</div>
</div>
<div class="bili-modal-foot">
<span class="bili-modal-foot-hint">${t("clearFootHint")}</span>
<button class="bili-btn-clear-cancel bili-btn-ghost" type="button">${t("cancel")}</button>
<button class="bili-btn-clear-ok" type="button">${t("clearConfirm")}</button>
</div>
</div>
</div>

<!-- ═══════════ 「📊 运行状态」弹窗：每次跑一轮的状态记录，下拉切轮次看 AI 每一步 ═══════════ -->
<div class="bili-modal bili-runs-modal" hidden>
<div class="bili-modal-backdrop bili-runs-backdrop"></div>
<div class="bili-modal-panel" role="dialog" aria-modal="true" aria-label="${t("runsAria")}">
<div class="bili-modal-head">
<div class="bili-modal-title">${t("runsTitle")} <span class="bili-modal-sub">${t("runsSub")}</span></div>
<button class="bili-modal-close bili-runs-close" type="button" aria-label="${t("closeRuns")}">✕</button>
</div>
<div class="bili-modal-body">
<div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px;">
<select class="bili-runs-select" aria-label="${t("runsSelectAria")}"></select>
<button class="bili-btn-refresh bili-runs-reload" type="button" title="${t("runsReloadTitle")}">🔄</button>
</div>
<div class="bili-runs-head" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;"></div>
<div class="bili-runs-summary"></div>
<div class="bili-runs-picks" style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px;"></div>
<div class="bili-runs-timeline"><div style="color: var(--text-dim);">${t("runsLoading")}</div></div>
</div>
<div class="bili-modal-foot">
<span class="bili-modal-foot-hint">${t("runsFootHint")}</span>
<button class="bili-btn-clear-cancel bili-runs-close2 bili-btn-ghost" type="button">${t("closeBtn")}</button>
</div>
</div>
</div>

<!-- ═══════════ 「⚙️ 设置」弹窗：所有配置都收在这里 ═══════════ -->
				<div class="bili-modal bili-settings-modal" hidden>
					<div class="bili-modal-backdrop"></div>
					<div class="bili-modal-panel" role="dialog" aria-modal="true" aria-label="${t("settingsAria")}">
						<div class="bili-modal-head">
							<div class="bili-modal-title">${t("settingsTitle")} <span class="bili-modal-sub">${t("settingsSub")}</span></div>
							<button class="bili-modal-close" type="button" aria-label="${t("closeSettings")}">✕</button>
						</div>
						<div class="bili-modal-nav">
							<button class="bili-modal-tab is-active" type="button" data-pane="quick">${t("tabQuick")}</button>
							<button class="bili-modal-tab" type="button" data-pane="prompt">${t("tabPrompt")}</button>
							<button class="bili-modal-tab" type="button" data-pane="taste">${t("tabTaste")}</button>
							<button class="bili-modal-tab" type="button" data-pane="social">${t("tabSocial")}</button>
							<button class="bili-modal-tab" type="button" data-pane="adv">${t("tabAdv")}</button>
						</div>
						<div class="bili-modal-body">
							<!-- 常用：原「关键设置」，补丁式保存，即时生效 -->
							<div class="bili-pane" data-pane="quick">
								<div class="bili-card">
									<div class="bili-card-title">${t("quickTitle")} <span class="bili-card-title-hint">${t("quickHint")}</span></div>
									<div class="bili-card-sub">${t("quickSub")}</div>
									<div class="bili-set-rows">
										<div class="bili-set-row"><span>${t("perDayLabel")}</span><input class="bili-quick-perday" type="number" min="1" max="30" value="5" /></div>
										<div class="bili-set-row"><span>${t("dmMinsLabel")}</span><input class="bili-quick-mins" type="number" min="1" max="60" value="1" /></div>
										<div class="bili-set-row"><span>${t("dmModeLabel")}</span><select class="bili-quick-dmmode"><option value="only">${t("dmModeOnlyOpt")}</option><option value="both">${t("dmModeBothOpt")}</option><option value="off">${t("dmModeOffOpt")}</option></select></div>
										<div class="bili-set-row"><span>${t("peakLabel")}</span><label class="bili-switch-wrap" title="${t("peakSwitchTitle")}"><input type="checkbox" class="bili-quick-peak" checked /><span class="bili-toggle-slider"></span></label></div>
										<div class="bili-set-row"><span>${t("watchLabel")}</span><label class="bili-switch-wrap" title="${t("watchSwitchTitle")}"><input type="checkbox" class="bili-quick-watch" checked /><span class="bili-toggle-slider"></span></label></div>
									</div>
						<button class="bili-btn-save-quick bili-btn-save" hidden></button>
						<div class="bili-note">${t("quickNote")}</div>
								</div>
							</div>

							<!-- 提示词：默认值直接填在框里，能看能改 -->
							<div class="bili-pane bili-page-prompt" data-pane="prompt" hidden>
								<div class="bili-card">
									<div class="bili-card-title">${t("promptTitle")} <span class="bili-card-title-hint bili-prompt-state">${t("promptStateDefault")}</span></div>
									<div class="bili-card-sub">
										${t("promptSub")}
									</div>
									<textarea class="bili-cfg-analyze-prompt bili-prompt-area" rows="12" spellcheck="false"></textarea>
									<textarea class="bili-prompt-fixed bili-prompt-fixed-analyze bili-prompt-area" rows="8" spellcheck="false"></textarea>
									<div class="bili-prompt-actions">
						<button class="bili-btn-save-prompts bili-btn-save" type="button" hidden></button>
						<button class="bili-btn-reset-analyze bili-btn-ghost" type="button">${t("resetAnalyze")}</button>
									</div>
								</div>
								<div class="bili-card">
									<div class="bili-card-title">${t("summaryPromptTitle")}</div>
									<div class="bili-card-sub">
										${t("summaryPromptSub")}
									</div>
									<textarea class="bili-cfg-summary-prompt bili-prompt-area" rows="9" spellcheck="false"></textarea>
									<textarea class="bili-prompt-fixed bili-prompt-fixed-summary bili-prompt-area" rows="6" spellcheck="false"></textarea>
									<div class="bili-prompt-actions">
						<button class="bili-btn-save-prompts bili-btn-save" type="button" hidden></button>
						<button class="bili-btn-reset-summary bili-btn-ghost" type="button">${t("resetSummary")}</button>
									</div>
								</div>
								<div class="bili-card">
									<div class="bili-card-title">${t("dmPromptTitle")}</div>
									<div class="bili-card-sub">${t("dmPromptSub")}</div>
									<textarea class="bili-cfg-dm-prompt bili-prompt-area" rows="6" spellcheck="false"></textarea>
									<textarea class="bili-prompt-fixed bili-prompt-fixed-dm bili-prompt-area" rows="4" spellcheck="false"></textarea>
								</div>
								<div class="bili-note">${t("promptsNote")}</div>
							</div>

							<!-- 偏好 -->
							<div class="bili-pane bili-page-taste" data-pane="taste" hidden>
						<!-- 模型、思考强度与工作区目录 -->
						<div class="bili-card">
							<div class="bili-card-title">${t("tasteTitle")}</div>
							<div class="bili-card-sub">
								${t("tasteSub")}
							</div>
							<div style="margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">${t("modelLabel")}</div>
									<div style="display: flex; gap: 6px;">
										<select class="bili-cfg-model" style="flex: 1; min-width: 0; padding: 7px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;">
											<option value="">${t("followActiveModel")}</option>
										</select>
										<button type="button" class="bili-btn-pick-model bili-btn-ghost">${t("pickModel")}</button>
									</div>
								</div>
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">${t("reasoningLabel")}</div>
									<select class="bili-cfg-reasoning-effort" style="width: 100%; padding: 7px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;">
										<option value="medium">${t("effortMedium")}</option>
										<option value="high">${t("effortHigh")}</option>
										<option value="low">${t("effortLow")}</option>
										<option value="off">${t("effortOff")}</option>
									</select>
								</div>
								<div style="grid-column: 1 / -1; display: flex; flex-direction: column; gap: 8px;">
									<label>${t("visionLabel")}
										<input class="bili-cfg-vision-model" type="text" placeholder="${t("visionPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 7px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px;" />
									</label>
									<label style="display: flex; align-items: center; gap: 8px;"><input type="checkbox" class="bili-cfg-transcribe" checked />${t("transcribeLabel")}</label>
									<div style="font-size: 12px; color: var(--text-dim);">${t("visionHint")}</div>
								</div>
								<div style="grid-column: 1 / -1;">
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">${t("workspaceLabel")}</div>
									<div style="display: flex; gap: 6px;">
										<input type="text" class="bili-cfg-workspace" placeholder="${t("workspacePlaceholder")}" style="flex: 1; min-width: 0; box-sizing: border-box; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;" />
										<button type="button" class="bili-btn-pick-workspace bili-btn-ghost">${t("pickWorkspace")}</button>
									</div>
								</div>
							</div>
						</div>

						<div class="bili-card">
							<div class="bili-card-title">${t("personaTitle")}</div>
							<div class="bili-card-sub">${t("personaSub")}</div>
							<div style="margin-top: 8px; display: flex; flex-direction: column; gap: 8px;">
								<textarea class="bili-cfg-persona" rows="4" placeholder="${t("personaPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; line-height: 1.5; font-family: inherit;"></textarea>
								<div style="display: flex; gap: 8px;">
									<button class="bili-btn-import-agents bili-btn-ghost bili-btn-xs">${t("importAgents")}</button>
								</div>
							</div>
						</div>

						<div class="bili-card">
							<div class="bili-card-title">${t("keywordsTitle")}</div>
							<div class="bili-card-sub">${t("keywordsSub")}</div>
							<div style="margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">${t("keywordsLabel")}</div>
									<textarea class="bili-cfg-keywords" rows="4" style="width: 100%; box-sizing: border-box; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; font-family: monospace;"></textarea>
								</div>
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">${t("excludeLabel")}</div>
									<textarea class="bili-cfg-exclude" rows="4" style="width: 100%; box-sizing: border-box; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; font-family: monospace;"></textarea>
								</div>
							</div>
						</div>

						<div class="bili-card">
							<div class="bili-card-title">${t("favTitle")}</div>
							<div style="margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">${t("favLabel")}</div>
									<div style="display: flex; gap: 6px;">
										<select class="bili-cfg-fav-folder" style="flex: 1; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;">
											<option value="0">${t("favNone")}</option>
										</select>
										<button class="bili-btn-reload-favs bili-btn-ghost bili-btn-xs">${t("refreshBtn")}</button>
									</div>
								</div>
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">${t("reportLevelLabel")}</div>
									<select class="bili-cfg-report-level" style="width: 100%; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;">
										<option value="full">${t("reportFull")}</option>
										<option value="brief">${t("reportBrief")}</option>
										<option value="off">${t("reportOff")}</option>
									</select>
								</div>
							</div>
						</div>

						<div>
							<button class="bili-btn-save-taste bili-btn-save" hidden></button>
						</div>
					</div>

					<!-- 互动 -->
					<div class="bili-pane bili-page-social" data-pane="social" hidden>
						<div class="bili-card">
							<div class="bili-card-title">${t("socialTitle")}</div>
							<div class="bili-card-sub">
								${t("socialSub")}
							</div>
							<div style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;">
								<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
									<input type="radio" name="bili_dm_mode" value="only" checked />
									<span><strong>${t("dmOnlyStrong")}</strong> ${t("dmOnlyDesc")}</span>
								</label>
								<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
									<input type="radio" name="bili_dm_mode" value="both" />
									<span><strong>${t("dmBothStrong")}</strong> ${t("dmBothDesc")}</span>
								</label>
								<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
									<input type="radio" name="bili_dm_mode" value="off" />
									<span><strong>${t("dmOffStrong")}</strong> ${t("dmOffDesc")}</span>
								</label>
							</div>
						</div>

						<div class="bili-card">
							<div class="bili-card-title">${t("recipientTitle")}</div>
							<div style="margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">${t("uidLabel")}</div>
									<input type="number" class="bili-cfg-dm-uid" placeholder="${t("uidPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;" />
								</div>
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">${t("mentionLabel")}</div>
									<input type="text" class="bili-cfg-mention-name" placeholder="${t("mentionPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;" />
								</div>
							</div>
						</div>

						<div class="bili-card">
							<div style="display: flex; justify-content: space-between; align-items: center;">
								<div>
									<div class="bili-card-title">${t("watchTitle")}</div>
									<div class="bili-card-sub">
										${t("watchSub")}
									</div>
								</div>
								<label class="bili-switch-wrap" title="${t("watchSwitchTitle")}">
									<input type="checkbox" class="bili-cfg-dm-watch" checked />
									<span class="bili-toggle-slider"></span>
								</label>
							</div>
							<div style="margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
								<div>
									<label style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;"><input type="checkbox" class="bili-cfg-dm-auto-reply" checked />${t("autoReplyLabel")}</label>
									<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 8px;">${t("autoReplyHint")}</div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">${t("watchMinsLabel")}</div>
									<input type="number" class="bili-cfg-dm-minutes" value="1" min="1" max="60" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;" />
								</div>
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">${t("replyLimitLabel")}</div>
									<input type="number" class="bili-cfg-dm-reply-limit" value="20" min="0" max="100" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;" />
								</div>
							</div>
						</div>

						<div class="bili-card">
							<div class="bili-card-title">${t("commentTitle")}</div>
							<div style="margin-top: 10px; display: flex; flex-direction: column; gap: 10px;">
								<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
									<input type="checkbox" class="bili-cfg-auto-comment" />
									<span>${t("autoCommentLabel")}</span>
								</label>
								<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
									<input type="checkbox" class="bili-cfg-reply-comments" />
									<span>${t("replyCommentsLabel")}</span>
								</label>
							</div>
						</div>

						<div class="bili-inbox bili-card">
							<div class="bili-card-title">${t("inboxTitle")}</div>
							<div style="color: var(--text-dim);">${t("inboxHint")}</div>
							<button class="bili-dm-refresh" type="button">${t("inboxRefresh")}</button>
							<div class="bili-dm-status" role="status" aria-live="polite">${t("inboxNotLoaded")}</div>
							<div class="bili-inbox-list bili-dm-sessions" aria-label="${t("inboxSessionsAria")}"></div>
							<button class="bili-dm-more-sessions" type="button" hidden>${t("inboxMoreSessions")}</button>
							<div class="bili-dm-selected">${t("inboxNoSelection")}</div>
							<button class="bili-dm-refresh-messages" type="button" disabled>${t("inboxRefreshHistory")}</button>
							<div class="bili-inbox-list bili-dm-messages" aria-label="${t("inboxHistoryAria")}"></div>
							<button class="bili-dm-more-messages" type="button" hidden>${t("inboxMoreMessages")}</button>
							<label>${t("composeLabel")}<textarea class="bili-dm-compose" rows="3" disabled placeholder="${t("composePlaceholder")}"></textarea></label>
							<button class="bili-dm-send" type="button" disabled>${t("sendToSelected")}</button>
						</div>
						<div>
							<button class="bili-btn-save-social bili-btn-save" hidden></button>
						</div>
					</div>

					<!-- 高级 -->
					<div class="bili-pane bili-page-adv" data-pane="adv" hidden>
						<!-- 账号绑定与凭证卡片 -->
						<div class="bili-card-user bili-card">
							<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
								<div class="bili-user-info" style="display: flex; align-items: center; gap: 12px;">
									<div class="bili-avatar" style="width: 44px; height: 44px; border-radius: 50%; background: var(--border); display: flex; align-items: center; justify-content: center; font-size: 20px; overflow: hidden; flex: none;">
										👤
									</div>
									<div>
										<div class="bili-uname" style="font-weight: 600; font-size: 14px;">${t("notLoggedIn")}</div>
										<div class="bili-udesc" style="font-size: 12px; color: var(--text-dim); margin-top: 2px;">${t("notLoggedInDesc")}</div>
									</div>
								</div>
								<div class="bili-user-actions" style="display: flex; gap: 8px;">
									<button class="bili-btn-login bili-btn-save">${t("loginQr")}</button>
									<button class="bili-btn-logout bili-btn-ghost" style="display: none;">${t("logout")}</button>
								</div>
							</div>

							<!-- 扫码出码视窗 -->
							<div class="bili-qr-section" style="display: none; margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--border); text-align: center;">
								<div style="font-size: 13px; font-weight: 600; margin-bottom: 8px;">${t("qrTitle")}</div>
								<div class="bili-qr-container" style="display: inline-flex; align-items: center; justify-content: center; min-width: 180px; min-height: 180px; padding: 10px; background: #fff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.12);">
									<div class="bili-qr-svg-slot" style="display: flex; align-items: center; justify-content: center;"></div>
								</div>
								<div class="bili-qr-status" style="font-size: 12px; color: var(--text-dim); margin-top: 8px;">${t("qrWaiting")}</div>
								<div style="margin-top: 8px;">
									<button class="bili-btn-cancel-login bili-btn-ghost bili-btn-xs">${t("cancelQr")}</button>
								</div>
							</div>
						</div>

						<!-- 环境与依赖安装 -->
						<div class="bili-card">
							<div class="bili-card-title">${t("envTitle")}</div>
							<div class="bili-card-sub">
								${t("envSub")}
							</div>
							<div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
								<button class="bili-btn-install bili-btn-ghost">${t("installMain")}</button>
								<button class="bili-btn-install-asr bili-btn-ghost">${t("installAsr")}</button>
							</div>
							<div class="bili-install-tail" style="margin-top: 10px; padding: 8px 10px; border-radius: 6px; background: #0c0d0e; color: #a0a0a0; font-family: monospace; font-size: 11px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; display: none;"></div>
						</div>

						<!-- 工具箱与自检 -->
						<div class="bili-card">
							<div class="bili-card-title">${t("toolboxTitle")}</div>
							<div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
								<button class="bili-btn-check-up bili-btn-ghost">${t("checkUp")}</button>
								<button class="bili-btn-diagnose bili-btn-ghost">${t("diagnose")}</button>
								<button class="bili-btn-selfcheck bili-btn-ghost">${t("selfcheck")}</button>
								<button class="bili-btn-verify bili-btn-ghost">${t("verifyComments")}</button>
								<button class="bili-btn-open-out bili-btn-ghost">${t("openOut")}</button>
								<button class="bili-btn-open-home bili-btn-ghost">${t("openHome")}</button>
							</div>
								<div class="bili-diag-result" style="margin-top: 10px; display: none; padding: 10px; border-radius: 6px; background: var(--bg); border: 1px solid var(--border); font-size: 12px; line-height: 1.5; white-space: pre-wrap; font-family: monospace;"></div>
							</div>
						</div>
					</div>
					<!-- 常驻底栏：在滚动区之外，所有页签共用，不随内容滚动 -->
					<div class="bili-modal-foot">
						<span class="bili-modal-foot-hint">${t("footHint")}</span>
						<button class="bili-btn-save-foot" type="button">${t("save")}</button>
					</div>
				</div>
				</div>
				</div>
			</div>
		`;

		const btnSettings = el.querySelector(".bili-btn-settings");
		const settingsModal = el.querySelector(".bili-settings-modal");
		const btnCloseSettings = el.querySelector(
			".bili-settings-modal > .bili-modal-panel > .bili-modal-head .bili-modal-close",
		);
		const settingsBackdrop = el.querySelector(".bili-settings-modal > .bili-modal-backdrop");
		const modalTabs = [...el.querySelectorAll(".bili-modal-tab")];
		const modalPanes = [...el.querySelectorAll(".bili-pane")];
		const cfgAnalyzePrompt = el.querySelector(".bili-cfg-analyze-prompt");
		const cfgSummaryPrompt = el.querySelector(".bili-cfg-summary-prompt");
		const cfgDmPrompt = el.querySelector(".bili-cfg-dm-prompt");
		const promptFixedAnalyze = el.querySelector(".bili-prompt-fixed-analyze");
		const promptFixedSummary = el.querySelector(".bili-prompt-fixed-summary");
		const promptFixedDm = el.querySelector(".bili-prompt-fixed-dm");
		const promptState = el.querySelector(".bili-prompt-state");
		const btnSavePrompts = el.querySelector(".bili-btn-save-prompts");
		const btnResetAnalyze = el.querySelector(".bili-btn-reset-analyze");
		const btnResetSummary = el.querySelector(".bili-btn-reset-summary");
		const promptDefaults = { analyze: "", summary: "", dm: "" };
		const promptFixedDefaults = { analyze: "", summary: "", dm: "" };
		// 固定追加前端预校验（与服务端 validateFixed 同规则，最终以服务端为准）
		const FIXED_KIND_KEYS = {
			analyze: ["tier", "whyWorth", "insights", "comment"],
			summary: ["结论", "要点", "局限"], // developer-facing, not UI：提示词契约字段名
			dm: [],
		};
		const checkFixedClient = (kind, text) => {
			const rawText = String(text || "").trim();
			if (!rawText) return null;
			if (rawText.length > 4000) return t("fixedTooLong", { n: rawText.length });
			const miss = (FIXED_KIND_KEYS[kind] || []).filter((k) => !rawText.includes(k));
			if (miss.length) return t("fixedMissing", { keys: miss.join(t("listSeparator")) });
			// developer-facing, not UI：校验词表只认提示词契约里的中文/英文条款词
			const safe =
				(rawText.includes("不可信") && (rawText.includes("不执行") || rawText.includes("不得执行"))) ||
				(/untrusted/i.test(rawText) && /never\s+execute/i.test(rawText));
			if (!safe) return t("fixedClauseRequired");
			return null;
		};
		const feedbackBar = el.querySelector(".bili-feedback-bar");
		const btnRefresh = el.querySelector(".bili-btn-refresh");

		// 清空：列表头部按钮 → 确认弹层 → POST /clear → 刷新列表与状态
		const clearModal = el.querySelector(".bili-clear-modal");
		const btnClearOpen = el.querySelector(".bili-btn-clear-history");
		const btnClearCancel = el.querySelector(".bili-btn-clear-cancel");
		const btnClearOk = el.querySelector(".bili-btn-clear-ok");
		const btnClearClose = el.querySelector(".bili-clear-close");
		const clearBackdrop = el.querySelector(".bili-clear-backdrop");
		const closeClear = () => {
			if (!clearModal || clearModal.hidden) return;
			clearModal.hidden = true;
			document.removeEventListener("keydown", onClearKey);
		};
		function onClearKey(event) {
			if (event.key === "Escape") closeClear();
		}
		const openClear = () => {
			if (!clearModal) return;
			clearModal.hidden = false;
			btnClearOk && (btnClearOk.disabled = false);
			if (btnClearOk) btnClearOk.textContent = t("clearConfirm");
			document.addEventListener("keydown", onClearKey);
		};
		if (btnClearOpen) btnClearOpen.addEventListener("click", openClear);
		if (btnClearCancel) btnClearCancel.addEventListener("click", closeClear);
		if (btnClearClose) btnClearClose.addEventListener("click", closeClear);
		if (clearBackdrop) clearBackdrop.addEventListener("click", closeClear);
		if (btnClearOk)
			btnClearOk.addEventListener("click", async () => {
				btnClearOk.disabled = true;
				btnClearOk.textContent = t("clearing");
				const res = await httpPost("clear", {});
				if (res && res.ok) {
					closeClear();
					const r = res.removed || {};
					notify(t("clearDone", { reports: r.reports || 0, notes: r.notes || 0, summaries: r.summaries || 0 }), "good");
					currentOffset = 0;
					await loadWatchedCards();
					refreshStatus(true);
				} else {
					btnClearOk.disabled = false;
					btnClearOk.textContent = t("clearConfirm");
					notify(t("clearFailed", { err: res?.error || t("unknownError") }), "warn");
				}
			});

		const badgeVer = el.querySelector(".bili-badge-ver");
		const statQuota = el.querySelector(".bili-stat-quota");
		const statRounds = el.querySelector(".bili-stat-rounds");
		const statDmMode = el.querySelector(".bili-stat-dm-mode");
		const statNotesCount = el.querySelector(".bili-stat-notes-count");
		const statLastRun = el.querySelector(".bili-stat-lastrun");
		const pillPeak = el.querySelector(".bili-pill-peak");
		const btnRunDuty = el.querySelector(".bili-btn-run-duty");
		const btnChatMode = el.querySelector(".bili-btn-chat-mode");
		const btnFavToday = el.querySelector(".bili-btn-fav-today");
		const cardsGrid = el.querySelector(".bili-cards-grid");
		const pageInfo = el.querySelector(".bili-page-info");
		const btnPrevPage = el.querySelector(".bili-btn-prev-page");
		const btnNextPage = el.querySelector(".bili-btn-next-page");
		const terminalBody = el.querySelector(".bili-action-terminal-body");
		const btnClearTerminal = el.querySelector(".bili-btn-clear-terminal");
		const btnRunTop = el.querySelector(".bili-btn-run-top");
		const detailLedger = el.querySelector(".bili-ledger");
		const detailLedgerRows = el.querySelector(".bili-ledger-rows");
		const reportSelect = el.querySelector(".bili-report-select");
		const reportContent = el.querySelector(".bili-report-content");
		const btnCopyReport = el.querySelector(".bili-btn-copy-report");

		const cfgModel = el.querySelector(".bili-cfg-model");
		const btnPickModel = el.querySelector(".bili-btn-pick-model");
		const cfgReasoningEffort = el.querySelector(".bili-cfg-reasoning-effort");
		const cfgVisionModel = el.querySelector(".bili-cfg-vision-model");
		const cfgTranscribe = el.querySelector(".bili-cfg-transcribe");
		const cfgWorkspace = el.querySelector(".bili-cfg-workspace");
		const btnPickWorkspace = el.querySelector(".bili-btn-pick-workspace");
		const cfgPersona = el.querySelector(".bili-cfg-persona");
		const btnImportAgents = el.querySelector(".bili-btn-import-agents");
		const cfgKeywords = el.querySelector(".bili-cfg-keywords");
		const cfgExclude = el.querySelector(".bili-cfg-exclude");
		const cfgFavFolder = el.querySelector(".bili-cfg-fav-folder");
		const btnReloadFavs = el.querySelector(".bili-btn-reload-favs");
		const cfgReportLevel = el.querySelector(".bili-cfg-report-level");
		const btnSaveTaste = el.querySelector(".bili-btn-save-taste");
		const quickPerDay = el.querySelector(".bili-quick-perday");
		const quickMins = el.querySelector(".bili-quick-mins");
		const quickDmMode = el.querySelector(".bili-quick-dmmode");
		const quickPeak = el.querySelector(".bili-quick-peak");
		const quickWatch = el.querySelector(".bili-quick-watch");
		const btnSaveQuick = el.querySelector(".bili-btn-save-quick");

		const dmRadios = el.querySelectorAll('input[name="bili_dm_mode"]');
		const cfgDmUid = el.querySelector(".bili-cfg-dm-uid");
		const cfgMentionName = el.querySelector(".bili-cfg-mention-name");
		const cfgDmWatch = el.querySelector(".bili-cfg-dm-watch");
		const cfgDmAutoReply = el.querySelector(".bili-cfg-dm-auto-reply");
		const cfgDmMinutes = el.querySelector(".bili-cfg-dm-minutes");
		const cfgDmReplyLimit = el.querySelector(".bili-cfg-dm-reply-limit");
		const cfgAutoComment = el.querySelector(".bili-cfg-auto-comment");
		const cfgReplyComments = el.querySelector(".bili-cfg-reply-comments");
		const btnSaveSocial = el.querySelector(".bili-btn-save-social");
		const btnSaveFoot = el.querySelector(".bili-btn-save-foot");
		if (btnSaveFoot) {
			btnSaveFoot.addEventListener("click", () => {
				const target = { quick: btnSaveQuick, prompt: btnSavePrompts, taste: btnSaveTaste, social: btnSaveSocial }[
					settingsPane
				];
				if (target) target.click();
			});
		}

		const dmSessions = el.querySelector(".bili-dm-sessions");
		const dmMessages = el.querySelector(".bili-dm-messages");
		const dmStatus = el.querySelector(".bili-dm-status");
		const dmSelected = el.querySelector(".bili-dm-selected");
		const dmCompose = el.querySelector(".bili-dm-compose");
		const dmSend = el.querySelector(".bili-dm-send");
		const dmRefresh = el.querySelector(".bili-dm-refresh");
		const dmRefreshMessages = el.querySelector(".bili-dm-refresh-messages");
		const dmMoreSessions = el.querySelector(".bili-dm-more-sessions");
		const dmMoreMessages = el.querySelector(".bili-dm-more-messages");
		let selectedUid = "";
		let sessions = [];
		let messages = [];
		let sessionsCursor;
		let messagesCursor;
		let sessionsBusy = false;
		let messagesBusy = false;
		let sending = false;
		let messageGeneration = 0;
		const drafts = new Map();

		function renderSessions() {
			dmSessions.innerHTML = sessions
				.map(
					(s) =>
						`<button type="button" data-uid="${esc(String(s.uid))}" aria-pressed="${String(s.uid) === selectedUid}">${t("dmSessionLine", { uid: esc(String(s.uid)), unread: esc(String(s.unread ?? 0)), ts: esc(String(s.lastTs ?? "")) })}\n${esc(String(s.preview ?? ""))}</button>`,
				)
				.join("");
		}

		function renderMessages() {
			dmMessages.innerHTML =
				messages
					.map(
						(m) =>
							`<div class="bili-dm-message">${m.fromMe ? t("dmMsgMe") : `UID: ${esc(selectedUid)}`} · ${t("dmMsgMeta", { ts: esc(String(m.ts ?? "")), kind: esc(String(m.kind ?? "")) })}\n${esc(String(m.text ?? ""))}${m.bvid ? `\n${t("dmMsgVideo", { bv: esc(String(m.bvid)) })}` : ""}</div>`,
					)
					.join("") || t("dmNoMessages");
		}

		async function loadSessions(more = false) {
			if (sessionsBusy) return;
			sessionsBusy = true;
			dmRefresh.disabled = dmMoreSessions.disabled = true;
			dmStatus.textContent = t("dmLoadingSessions");
			try {
				const res = await sendMsg("bili:dm-sessions", { size: 20, ...(more ? { cursor: sessionsCursor } : {}) });
				if (!res?.ok || !Array.isArray(res.sessions)) throw new Error(res?.error || t("dmInvalidSessions"));
				sessions = [...new Map([...(more ? sessions : []), ...res.sessions].map((s) => [String(s.uid), s])).values()];
				sessionsCursor = res.nextCursor;
				dmMoreSessions.hidden = !(res.hasMore && res.nextCursor != null);
				renderSessions();
				dmStatus.textContent = sessions.length ? t("dmLoadedSessions", { n: sessions.length }) : t("dmNoSessions");
			} catch (err) {
				dmStatus.textContent = t("dmReadFailed", { err: err.message });
			} finally {
				sessionsBusy = false;
				dmRefresh.disabled = dmMoreSessions.disabled = false;
			}
		}

		async function loadMessages(more = false) {
			if (!selectedUid || messagesBusy) return;
			const uid = selectedUid;
			const generation = ++messageGeneration;
			messagesBusy = true;
			dmRefreshMessages.disabled = dmMoreMessages.disabled = true;
			dmStatus.textContent = t("dmLoadingHistory", { uid });
			try {
				const res = await sendMsg("bili:dm-messages", { uid, size: 30, ...(more ? { cursor: messagesCursor } : {}) });
				if (generation !== messageGeneration) return;
				if (!res?.ok || !Array.isArray(res.messages)) throw new Error(res?.error || t("dmInvalidMessages"));
				messages = [
					...new Map([...(more ? messages : []), ...res.messages].map((m) => [String(m.key), m])).values(),
				].sort((a, b) => Number(a.ts) - Number(b.ts));
				messagesCursor = res.nextCursor;
				dmMoreMessages.hidden = !(res.hasMore && res.nextCursor != null);
				renderMessages();
				dmStatus.textContent = t("dmLoadedMessages", { uid, n: messages.length });
			} catch (err) {
				if (generation === messageGeneration) dmStatus.textContent = t("dmReadFailed", { err: err.message });
			} finally {
				if (generation === messageGeneration) {
					messagesBusy = false;
					dmRefreshMessages.disabled = dmMoreMessages.disabled = false;
				}
			}
		}

		dmRefresh.addEventListener("click", () => loadSessions());
		dmMoreSessions.addEventListener("click", () => loadSessions(true));
		dmRefreshMessages.addEventListener("click", () => loadMessages());
		dmMoreMessages.addEventListener("click", () => loadMessages(true));
		dmSessions.addEventListener("click", (event) => {
			const button = event.target.closest("button[data-uid]");
			if (!button || sending) return;
			if (selectedUid) drafts.set(selectedUid, dmCompose.value);
			selectedUid = button.dataset.uid;
			++messageGeneration;
			messagesBusy = false;
			messages = [];
			messagesCursor = undefined;
			dmMessages.textContent = "";
			dmMoreMessages.hidden = true;
			dmSelected.textContent = t("dmSelectedUid", { uid: selectedUid });
			dmSend.textContent = t("dmSendToUid", { uid: selectedUid });
			dmCompose.disabled = dmSend.disabled = false;
			dmCompose.value = drafts.get(selectedUid) || "";
			renderSessions();
			loadMessages();
		});
		dmSend.addEventListener("click", async () => {
			const uid = selectedUid;
			const text = dmCompose.value.trim();
			if (!uid || !text || sending) return;
			sending = true;
			dmSend.disabled = dmCompose.disabled = true;
			dmStatus.textContent = t("dmSending", { uid });
			try {
				const res = await sendMsg("bili:dm-send", { uid, text });
				if (!res?.ok) throw new Error(res?.error || t("dmSendFailed"));
				dmCompose.value = "";
				drafts.delete(uid);
				dmStatus.textContent = t("dmSent", { uid });
			} catch (err) {
				dmStatus.textContent = t("dmSendUnconfirmed", { uid, err: err.message });
			} finally {
				sending = false;
				dmSend.disabled = dmCompose.disabled = false;
			}
		});

		const avatar = el.querySelector(".bili-avatar");
		const uname = el.querySelector(".bili-uname");
		const udesc = el.querySelector(".bili-udesc");
		const btnLogin = el.querySelector(".bili-btn-login");
		const btnLogout = el.querySelector(".bili-btn-logout");
		const qrSection = el.querySelector(".bili-qr-section");
		const qrSvgSlot = el.querySelector(".bili-qr-svg-slot");
		const qrStatus = el.querySelector(".bili-qr-status");
		const btnCancelLogin = el.querySelector(".bili-btn-cancel-login");
		const btnInstall = el.querySelector(".bili-btn-install");
		const btnInstallAsr = el.querySelector(".bili-btn-install-asr");
		const installTail = el.querySelector(".bili-install-tail");
		const btnCheckUp = el.querySelector(".bili-btn-check-up");
		const btnDiagnose = el.querySelector(".bili-btn-diagnose");
		const btnSelfcheck = el.querySelector(".bili-btn-selfcheck");
		const btnVerify = el.querySelector(".bili-btn-verify");
		const btnOpenOut = el.querySelector(".bili-btn-open-out");
		const btnOpenHome = el.querySelector(".bili-btn-open-home");
		const diagResult = el.querySelector(".bili-diag-result");

		let currentStatus = null;
		let currentWatchedState = "";
		let currentWatchedTier = "";
		let currentOffset = 0;
		const PAGE_SIZE = 24;
		let pollTimer = null;
		// v2.5 时间范围：last=上次那批所在日期 today=今日 week=近7天 day=指定往期
		let detailRows = []; // v2.5 当前列表行缓存供弹窗取数
		let rangeMode = "last";
		let rangeDay = "";
		let availDays = [];
		const dayOf = (d) => d.toISOString().slice(0, 10);
		const addDays = (s, n) => {
			const d = new Date(s + "T00:00:00");
			d.setDate(d.getDate() + n);
			return dayOf(d);
		};
		const SVG_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
		const SVG_DM =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="12" rx="3"/><path d="M6 12h4M6 15h7M14 12h4"/></svg>';
		const SVG_LIKE =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 11v9H4v-9h3zm1 9c0 .6.4 1 1 1h7.6c1.4 0 2.6-1 2.9-2.4l1.3-5.6c.3-1.4-.8-2.7-2.2-2.7H14l.8-3.8c.1-.8-.4-1.5-1.2-1.5-1.4 0-2.6 1-2.8 2.4L8 11z"/></svg>';
		const SVG_FAV =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
		const SVG_CMT =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>';
		const notify = (msg, tone = "info") => {
			feedbackBar.style.display = "block";
			feedbackBar.textContent = msg;
			if (tone === "good") {
				feedbackBar.style.background = "color-mix(in srgb, var(--green, #22c55e) 15%, transparent)";
				feedbackBar.style.color = "var(--green, #22c55e)";
				feedbackBar.style.border = "1px solid color-mix(in srgb, var(--green, #22c55e) 30%, transparent)";
			} else if (tone === "warn") {
				feedbackBar.style.background = "color-mix(in srgb, var(--amber, #f59e0b) 15%, transparent)";
				feedbackBar.style.color = "var(--amber, #f59e0b)";
				feedbackBar.style.border = "1px solid color-mix(in srgb, var(--amber, #f59e0b) 30%, transparent)";
			} else {
				feedbackBar.style.background = "color-mix(in srgb, var(--accent) 15%, transparent)";
				feedbackBar.style.color = "var(--accent)";
				feedbackBar.style.border = "1px solid color-mix(in srgb, var(--accent) 30%, transparent)";
			}
			setTimeout(() => {
				feedbackBar.style.display = "none";
			}, 4000);
		};

		let settingsPane = "quick";

		function showSettingsPane(pane) {
			settingsPane = pane || "quick";
			for (const tab of modalTabs) tab.classList.toggle("is-active", tab.dataset.pane === settingsPane);
			for (const item of modalPanes) item.hidden = item.dataset.pane !== settingsPane;
			// v2.6 底部常驻保存按钮：按当前页签分派到对应保存逻辑
			if (btnSaveFoot) {
				const saveBy = { quick: btnSaveQuick, prompt: btnSavePrompts, taste: btnSaveTaste, social: btnSaveSocial };
				const labels = {
					quick: t("saveQuickFoot"),
					prompt: t("savePromptFoot"),
					taste: t("saveTasteFoot"),
					social: t("saveSocialFoot"),
					adv: t("advNoSave"),
				};
				const target = saveBy[settingsPane] || null;
				btnSaveFoot.disabled = !target;
				btnSaveFoot.textContent = labels[settingsPane] || t("save");
			}
		}

		// 关闭不拉配置：未保存的编辑留在输入框里，避免关窗即丢草稿。
		function closeSettings() {
			if (settingsModal.hidden) return;
			settingsModal.hidden = true;
			document.removeEventListener("keydown", onSettingsKey);
		}

		function onSettingsKey(event) {
			if (event.key === "Escape") closeSettings();
		}

		function openSettings(pane) {
			showSettingsPane(pane || settingsPane);
			// 收藏夹下拉和提示词只有弹窗里看得见，每次打开补拉一次，别让用户对着旧快照保存。
			reloadFavFolders();
			void loadPrompts();
			settingsModal.hidden = false;
			document.addEventListener("keydown", onSettingsKey);
		}

		if (btnSettings) btnSettings.addEventListener("click", () => openSettings());
		if (btnCloseSettings) btnCloseSettings.addEventListener("click", () => closeSettings());
		if (settingsBackdrop) settingsBackdrop.addEventListener("click", () => closeSettings());

		// ═══ v2.9 运行状态弹窗：顶栏按钮点开，下拉切轮次，看该轮 AI 每一步动作 ═══
		const btnRuns = el.querySelector(".bili-btn-runs");
		const runsModal = el.querySelector(".bili-runs-modal");
		const runsBackdrop = el.querySelector(".bili-runs-backdrop");
		const runsSelect = el.querySelector(".bili-runs-select");
		const runsHead = el.querySelector(".bili-runs-head");
		const runsSummary = el.querySelector(".bili-runs-summary");
		const runsPicks = el.querySelector(".bili-runs-picks");
		const runsTimeline = el.querySelector(".bili-runs-timeline");
		const runsReload = el.querySelector(".bili-runs-reload");
		let runsCache = [];
		let runsPollTimer = null;
		const RUN_STEP_LABEL = {
			start: t("stepStart"),
			status: t("stepStatus"),
			search: t("stepSearch"),
			search_result: t("stepSearchResult"),
			read_subtitle: t("stepReadSubtitle"),
			index_hit: t("stepIndexHit"),
			index_err: t("stepIndexErr"),
			analyze: t("stepAnalyze"),
			skip_badword: t("stepSkipBadword"),
			skip_unworthy: t("stepSkipUnworthy"),
			no_subtitle: t("stepNoSubtitle"),
			picked: t("stepPicked"),
			taste: t("stepTaste"),
			filter: t("stepFilter"),
			cluster: t("stepCluster"),
			quota_reached: t("stepQuotaReached"),
			check: t("stepCheck"),
			summary_batch: t("stepSummaryBatch"),
			summary: t("stepSummary"),
			summary_ok: t("stepSummaryOk"),
			summary_err: t("stepSummaryErr"),
			sync_workspace: t("stepSyncWorkspace"),
			dm_sent: t("stepDmSent"),
			dm_dup: t("stepDmDup"),
			dm_skip: t("stepDmSkip"),
			dm_fail: t("stepDmFail"),
			comment_sent: t("stepCommentSent"),
			comment_dup: t("stepCommentDup"),
			comment_err: t("stepCommentErr"),
			fav_done: t("stepFavDone"),
			done: t("stepDone"),
			error: t("stepError"),
		};
		const runStatusMeta = (s) => {
			if (s === "running") return { text: t("runStatusRunning"), cls: "run" };
			if (s === "success") return { text: t("runStatusSuccess"), cls: "ok" };
			if (s === "quota_reached") return { text: t("runStatusQuota"), cls: "warn" };
			if (s === "aborted") return { text: t("runStatusAborted"), cls: "warn" };
			if (s === "error") return { text: t("runStatusError"), cls: "err" };
			return { text: String(s || t("runStatusUnknown")), cls: "" };
		};
		const fmtDur = (ms) => {
			const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
			if (s < 60) return t("durationSec", { s });
			return t("durationMin", { m: Math.floor(s / 60), s: s % 60 });
		};
		const fmtTime = (iso) => {
			try {
				return new Date(iso).toLocaleString("zh-CN", { hour12: false });
			} catch {
				return String(iso || "—");
			}
		};
		const linkBvid = (html) =>
			esc(html).replace(
				/BV[0-9A-Za-z]{10}/g,
				(m) => `<a href="https://www.bilibili.com/video/${m}" target="_blank" rel="noreferrer">${m}</a>`,
			);
		function renderRunDetail(run) {
			if (!run) {
				runsHead.innerHTML = "";
				runsSummary.innerHTML = "";
				runsPicks.innerHTML = "";
				runsTimeline.innerHTML = `<div style="color: var(--text-dim);">${t("runsEmpty")}</div>`;
				return;
			}
			const meta = runStatusMeta(run.status);
			runsHead.innerHTML = `<span class="bili-runs-badge ${meta.cls}">${meta.text}</span><b>${t("runHeadRound", { n: esc(String(run.round ?? "—")) })}</b><span style="color: var(--text-dim); font-size: 12px;">${esc(run.trigger || "")} · ${esc(fmtTime(run.startedAt))}</span>`;
			runsSummary.innerHTML = `<span>${t("runsSumPicked", { n: `<b>${run.pickedDelta ?? 0}</b>` })}</span><span>${t("runsSumCandidates", { n: `<b>${run.candidates ?? 0}</b>` })}</span><span>${t("runsSumSkipped", { n: `<b>${run.skippedNoSubtitle ?? 0}</b>` })}</span><span>${t("runsSumToday", { now: `<b>${run.pickedToday ?? 0}/${run.quota ?? "—"}</b>` })}</span><span>${t("runsSumDuration", { d: `<b>${fmtDur(run.durationMs)}</b>` })}</span>`;
			const picks = Array.isArray(run.picks) ? run.picks : [];
			runsPicks.innerHTML = picks
				.map(
					(p) =>
						`<a href="${esc(p.url || `https://www.bilibili.com/video/${p.bvid}`)}" target="_blank" rel="noreferrer" style="font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--accent); text-decoration: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${esc(p.title || p.bvid)}">⭐ ${esc(String(p.title || p.bvid).slice(0, 22))}</a>`,
				)
				.join("");
			const acts = Array.isArray(run.actions) ? run.actions : [];
			if (!acts.length) {
				runsTimeline.innerHTML = `<div style="color: var(--text-dim);">${run.status === "running" ? t("runJustStarted") : esc(run.lastMessage || run.message || t("runNoActions"))}</div>`;
				return;
			}
			runsTimeline.innerHTML = acts
				.map((a) => {
					const label = RUN_STEP_LABEL[a.step] || a.step || t("actionFallback");
					return `<div class="bili-runs-step"><span class="bili-runs-clock">${esc(a.clock || "")}</span><span class="bili-runs-tag">${esc(label)}</span><span class="bili-runs-msg">${linkBvid(a.message || "")}</span></div>`;
				})
				.join("");
			runsTimeline.scrollTop = runsTimeline.scrollHeight;
		}
		async function loadRunsList(preferId) {
			runsTimeline.innerHTML = `<div style="color: var(--text-dim);">${t("runsLoading")}</div>`;
			const res = await httpGet("runs", { limit: 30 });
			if (!res || !res.ok) {
				runsTimeline.innerHTML = `<div style="color: var(--text-dim);">${t("fetchFailed", { err: esc(res?.error || t("unknownError")) })}</div>`;
				return;
			}
			runsCache = Array.isArray(res.runs) ? res.runs : [];
			if (!runsCache.length) {
				runsSelect.innerHTML = "";
				renderRunDetail(null);
				return;
			}
			runsSelect.innerHTML = runsCache
				.map((r) => {
					const meta = runStatusMeta(r.status);
					return `<option value="${esc(r.id)}">${t("runOption", { round: esc(String(r.round ?? "—")), trigger: esc(r.trigger || ""), status: meta.text, n: r.pickedDelta ?? 0, time: esc(fmtTime(r.startedAt)) })}</option>`;
				})
				.join("");
			const target = runsCache.find((r) => r.id === preferId) || runsCache[0];
			runsSelect.value = target.id;
			await loadRunDetail(target.id);
		}
		async function loadRunDetail(id) {
			const lite = runsCache.find((r) => r.id === id);
			if (lite && Array.isArray(lite.actions) && lite.actions.length) {
				renderRunDetail(lite);
				return;
			}
			const res = await httpGet("run", { id });
			if (res && res.ok && res.run) {
				const idx = runsCache.findIndex((r) => r.id === id);
				if (idx >= 0) runsCache[idx] = { ...runsCache[idx], ...res.run };
				renderRunDetail(res.run);
			} else if (lite) {
				renderRunDetail(lite);
			} else {
				runsTimeline.innerHTML = `<div style="color: var(--text-dim);">${t("runNotFound")}</div>`;
			}
		}
		function stopRunsPoll() {
			if (runsPollTimer) {
				clearInterval(runsPollTimer);
				runsPollTimer = null;
			}
		}
		function closeRuns() {
			if (!runsModal || runsModal.hidden) return;
			runsModal.hidden = true;
			stopRunsPoll();
			document.removeEventListener("keydown", onRunsKey);
		}
		function onRunsKey(event) {
			if (event.key === "Escape") closeRuns();
		}
		async function openRuns() {
			runsModal.hidden = false;
			document.addEventListener("keydown", onRunsKey);
			await loadRunsList(runsSelect.value || undefined);
			stopRunsPoll();
			runsPollTimer = setInterval(async () => {
				if (runsModal.hidden) {
					stopRunsPoll();
					return;
				}
				const cur = runsCache.find((r) => r.id === runsSelect.value);
				if (cur && cur.status === "running") await loadRunDetail(cur.id);
				else {
					const res = await httpGet("runs", { limit: 30 });
					if (
						res &&
						res.ok &&
						Array.isArray(res.runs) &&
						res.runs.length &&
						res.runs[0].id !== (runsCache[0] && runsCache[0].id)
					) {
						await loadRunsList(runsSelect.value);
					}
				}
			}, 5000);
		}
		if (btnRuns) btnRuns.addEventListener("click", openRuns);
		for (const b of el.querySelectorAll(".bili-runs-close, .bili-runs-close2")) b.addEventListener("click", closeRuns);
		if (runsBackdrop) runsBackdrop.addEventListener("click", closeRuns);
		if (runsSelect) runsSelect.addEventListener("change", () => loadRunDetail(runsSelect.value));
		if (runsReload) runsReload.addEventListener("click", () => loadRunsList(runsSelect.value || undefined));
		for (const tab of modalTabs) tab.addEventListener("click", () => showSettingsPane(tab.dataset.pane));
		// KPI 卡片兼作入口：点「额度」去常用页、点「投递方式」去互动页，单界面也能改到关键项。
		for (const card of el.querySelectorAll(".bili-kpi-link")) {
			card.addEventListener("click", () => openSettings(card.dataset.openPane));
		}

		// 提示词可看可改：框里填的就是当前生效文本，与默认一致时存空串（默认只有一份来源）。
		async function loadPrompts(force = false) {
			const res = await httpGet("prompts");
			if (!res || !res.ok) return;
			promptDefaults.analyze = String(res.analyze?.default || "");
			promptDefaults.summary = String(res.summary?.default || "");
			promptDefaults.dm = String(res.dm?.default || "");
			promptFixedDefaults.analyze = String(res.analyze?.fixedDefault || "");
			promptFixedDefaults.summary = String(res.summary?.fixedDefault || "");
			promptFixedDefaults.dm = String(res.dm?.fixedDefault || "");
			if (force || !cfgAnalyzePrompt.dataset.dirty) cfgAnalyzePrompt.value = res.analyze?.effective || "";
			if (force || !cfgSummaryPrompt.dataset.dirty) cfgSummaryPrompt.value = res.summary?.effective || "";
			if (force || !cfgDmPrompt.dataset.dirty) cfgDmPrompt.value = res.dm?.effective || "";
			if (promptFixedAnalyze && (force || !promptFixedAnalyze.dataset.dirty))
				promptFixedAnalyze.value = res.analyze?.fixedEffective ?? res.analyze?.fixed ?? "";
			if (promptFixedSummary && (force || !promptFixedSummary.dataset.dirty))
				promptFixedSummary.value = res.summary?.fixedEffective ?? res.summary?.fixed ?? "";
			if (promptFixedDm && (force || !promptFixedDm.dataset.dirty))
				promptFixedDm.value = res.dm?.fixedEffective ?? res.dm?.fixed ?? "";
			if (promptState)
				promptState.textContent = res.analyze?.override ? t("promptStateCustom") : t("promptStateDefault");
		}

		for (const area of [
			cfgAnalyzePrompt,
			cfgSummaryPrompt,
			cfgDmPrompt,
			promptFixedAnalyze,
			promptFixedSummary,
			promptFixedDm,
		]) {
			if (!area) continue;
			area.addEventListener("input", () => {
				area.dataset.dirty = "true";
			});
		}

		if (btnSavePrompts) {
			const savePrompts = async () => {
				const analyze = cfgAnalyzePrompt.value.trim();
				const summary = cfgSummaryPrompt.value.trim();
				const dm = cfgDmPrompt.value.trim();
				const fixedAnalyze = (promptFixedAnalyze?.value || "").trim();
				const fixedSummary = (promptFixedSummary?.value || "").trim();
				const fixedDm = (promptFixedDm?.value || "").trim();
				for (const [kind, text] of [
					["analyze", fixedAnalyze],
					["summary", fixedSummary],
					["dm", fixedDm],
				]) {
					const err = checkFixedClient(kind, text);
					if (err) {
						notify(t("fixedInvalid", { err }), "warn");
						return;
					}
				}
				const res = await httpPost("config", {
					analyzePrompt: analyze === promptDefaults.analyze.trim() ? "" : analyze,
					summaryPrompt: summary === promptDefaults.summary.trim() ? "" : summary,
					dmPrompt: dm === promptDefaults.dm.trim() ? "" : dm,
					analyzeFixed: fixedAnalyze === promptFixedDefaults.analyze.trim() ? "" : fixedAnalyze,
					summaryFixed: fixedSummary === promptFixedDefaults.summary.trim() ? "" : fixedSummary,
					dmFixed: fixedDm === promptFixedDefaults.dm.trim() ? "" : fixedDm,
				});
				if (res && res.ok) {
					delete cfgAnalyzePrompt.dataset.dirty;
					delete cfgSummaryPrompt.dataset.dirty;
					delete cfgDmPrompt.dataset.dirty;
					if (promptFixedAnalyze) delete promptFixedAnalyze.dataset.dirty;
					if (promptFixedSummary) delete promptFixedSummary.dataset.dirty;
					if (promptFixedDm) delete promptFixedDm.dataset.dirty;
					await loadPrompts(true);
					notify(t("promptSaved"), "good");
				} else {
					notify(t("saveFailed", { err: res?.error || t("unknownException") }), "warn");
				}
			};
			// 每张提示词卡片各自一个保存键，都写同一份配置
			for (const b of el.querySelectorAll(".bili-btn-save-prompts")) b.addEventListener("click", savePrompts);
		}

		if (btnResetAnalyze) {
			btnResetAnalyze.addEventListener("click", async () => {
				cfgAnalyzePrompt.value = promptDefaults.analyze;
				delete cfgAnalyzePrompt.dataset.dirty;
				if (promptFixedAnalyze) {
					promptFixedAnalyze.value = promptFixedDefaults.analyze;
					delete promptFixedAnalyze.dataset.dirty;
				}
				const res = await httpPost("config", { analyzePrompt: "", analyzeFixed: "" });
				if (res && res.ok) {
					await loadPrompts(true);
					notify(t("resetAnalyzeDone"), "good");
				} else {
					notify(t("resetFailed", { err: res?.error || t("unknownException") }), "warn");
				}
			});
		}

		if (btnResetSummary) {
			btnResetSummary.addEventListener("click", async () => {
				cfgSummaryPrompt.value = promptDefaults.summary;
				delete cfgSummaryPrompt.dataset.dirty;
				if (promptFixedSummary) {
					promptFixedSummary.value = promptFixedDefaults.summary;
					delete promptFixedSummary.dataset.dirty;
				}
				const res = await httpPost("config", { summaryPrompt: "", summaryFixed: "" });
				if (res && res.ok) {
					await loadPrompts(true);
					notify(t("resetSummaryDone"), "good");
				} else {
					notify(t("resetFailed", { err: res?.error || t("unknownException") }), "warn");
				}
			});
		}

		let wallView = "grid"; // v2.6 视频列表视图：grid 封面网格 / list 紧凑列表

		function appendActionTerminal(act) {
			const time = act.time || new Date().toLocaleTimeString();
			const line = document.createElement("div");
			line.style.marginBottom = "3px";

			let color = "#d4d4d4";
			let level = "info";
			if (act.status === "finished" || act.status === "success" || act.step === "picked") {
				color = "#52c41a";
			} else if (act.step === "skip_badword" || act.step === "no_subtitle") {
				color = "#faad14";
				level = "warning";
			} else if (act.step?.includes("err") || act.step === "error") {
				color = "#ff4d4f";
				level = "error";
			}

			line.innerHTML = `<span style="color: #666;">[${esc(String(time))}]</span> <span style="color: ${color};">${esc(act.message || "")}</span>`;
			terminalBody.appendChild(line);
			terminalBody.scrollTop = terminalBody.scrollHeight;

			// v2.6 动作通知走宿主全局通知（pi-web-ui:toast → 全局 NoticeToast），不再占插件界面
			try {
				window.dispatchEvent(
					new CustomEvent("pi-web-ui:toast", { detail: { text: String(act.message || ""), level } }),
				);
			} catch {}
		}

		// 跑完一轮（done/error）自动刷新：回到第一页拉新列表 + 顶栏状态 + 开着的运行状态弹窗
		async function refreshAfterRun() {
			try {
				currentOffset = 0;
				await loadWatchedCards();
			} catch {}
			try {
				await refreshStatus(true);
			} catch {}
			try {
				if (runsModal && !runsModal.hidden) await loadRunsList(runsSelect.value || undefined);
			} catch {}
		}

		if (btnRunTop) btnRunTop.addEventListener("click", () => btnRunDuty.click());

		btnClearTerminal.addEventListener("click", () => {
			terminalBody.innerHTML = `<span style="color: #666;">${t("terminalCleared")}</span>`;
		});

		async function refreshStatus(force = false) {
			const res = await httpGet("status");
			if (!res || !res.ok) return;
			currentStatus = res;

			if (badgeVer) {
				if (res.version) {
					badgeVer.textContent = `v${res.version}`;
					badgeVer.hidden = false;
				} else {
					badgeVer.hidden = true;
				}
			}

			const quota = res.config?.perDay || 5;
			if (statQuota) statQuota.textContent = t("statQuota", { picked: res.pickedToday || 0, quota });
			if (statRounds) statRounds.textContent = t("statRounds", { n: res.ranToday || 0 });
			if (statNotesCount) statNotesCount.textContent = t("statNotes", { n: res.notesCount || 0 });
			if (statLastRun) {
				const ts = Number(res.lastRunAt) || 0;
				statLastRun.textContent = ts ? t("lastRunAt", { time: new Date(ts).toLocaleTimeString() }) : t("lastRunNone");
			}
			if (pillPeak)
				pillPeak.textContent = t("peakStatePill", {
					state: res.config?.peakValley === false ? t("peakOff") : t("peakOn"),
				});

			const dmMode = res.config?.dmMode || "only";
			if (statDmMode) {
				statDmMode.textContent =
					dmMode === "only" ? t("dmStatOnly") : dmMode === "both" ? t("dmStatBoth") : t("dmStatOff");
			}

			// v2.6 顶栏 pills 与隐藏 KPI 同步（挑中/额度 · 巡检 · 投递方式 · 末次）
			const hpQuota = el.querySelector(".bili-hp-quota");
			const hpRounds = el.querySelector(".bili-hp-rounds");
			const hpDmmode = el.querySelector(".bili-hp-dmmode");
			const hpLastrun = el.querySelector(".bili-hp-lastrun");
			if (hpQuota) hpQuota.textContent = `${res.pickedToday || 0}/${quota}`;
			if (hpRounds) hpRounds.textContent = t("statRounds", { n: res.ranToday || 0 });
			if (hpDmmode)
				hpDmmode.textContent =
					dmMode === "only" ? t("dmPillOnly") : dmMode === "both" ? t("dmPillBoth") : t("dmPillOff");
			const lastTs = Number(res.lastRunAt) || 0;
			if (hpLastrun)
				hpLastrun.textContent = lastTs
					? t("lastRunAt", { time: new Date(lastTs).toLocaleTimeString() })
					: t("lastRunNone");

			populateModelOptions(res.config?.model || "");
			if (force || !cfgVisionModel.dataset.dirty) cfgVisionModel.value = res.config?.visionModel || "";
			if (force || !cfgTranscribe.dataset.dirty) cfgTranscribe.checked = res.config?.transcribe !== false;
			if (cfgReasoningEffort) cfgReasoningEffort.value = res.config?.reasoningEffort || "medium";
			if (cfgWorkspace && (force || !cfgWorkspace.value)) cfgWorkspace.value = res.config?.workspace || "";
			if (cfgPersona && (force || !cfgPersona.value)) cfgPersona.value = res.config?.personaPrompt || "";
			if (cfgKeywords && (force || !cfgKeywords.value)) cfgKeywords.value = res.config?.keywords || "";
			if (cfgExclude && (force || !cfgExclude.value)) cfgExclude.value = res.config?.excludeKeywords || "";
			if (cfgReportLevel) cfgReportLevel.value = res.config?.reportLevel || "full";

			dmRadios.forEach((r) => {
				r.checked = r.value === dmMode;
			});
			if (cfgDmUid && (force || !cfgDmUid.value)) cfgDmUid.value = res.config?.dmUid || "";
			if (cfgMentionName && (force || !cfgMentionName.value)) cfgMentionName.value = res.config?.mentionName || "";
			if (cfgDmWatch && (force || !cfgDmWatch.dataset.dirty)) cfgDmWatch.checked = res.config?.dmWatch !== false;
			if (force || !cfgDmAutoReply.dataset.dirty) cfgDmAutoReply.checked = res.config?.dmAutoReply !== false;
			if (cfgDmMinutes) cfgDmMinutes.value = res.config?.dmWatchMinutes || 1;
			if (cfgDmReplyLimit) cfgDmReplyLimit.value = res.config?.dmReplyPerDay || 20;
			if (cfgAutoComment) cfgAutoComment.checked = Boolean(res.config?.autoComment);
			if (cfgReplyComments) cfgReplyComments.checked = Boolean(res.config?.replyToComments);
			if (quickPerDay) quickPerDay.value = Number(res.config?.perDay) || 5;
			if (quickMins) quickMins.value = Number(res.config?.dmWatchMinutes) || 1;
			if (quickDmMode) quickDmMode.value = res.config?.dmMode || "only";
			if (quickPeak) quickPeak.checked = res.config?.peakValley !== false;
			if (quickWatch) quickWatch.checked = res.config?.dmWatch !== false;

			if (res.user?.loggedIn) {
				avatar.innerHTML = res.user.face
					? `<img src="${esc(res.user.face)}" referrerpolicy="no-referrer" style="width: 100%; height: 100%; object-fit: cover;" />`
					: "👤";
				uname.innerHTML = `${esc(res.user.uname)} <span style="font-size: 11px; padding: 1px 5px; border-radius: 4px; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent);">Lv.${res.user.level || 0}</span>`;
				udesc.textContent = t("userDesc", {
					uid: res.user.mid,
					coins: res.user.money || 0,
					vip: res.user.vipType ? t("vipAnnual") : t("vipNormal"),
				});
				btnLogin.style.display = "none";
				btnLogout.style.display = "inline-block";
			} else {
				avatar.innerHTML = "👤";
				uname.textContent = t("notLoggedIn");
				udesc.textContent = t("notLoggedInDesc");
				btnLogin.style.display = "inline-block";
				btnLogout.style.display = "none";
			}

			if (res.reports && res.reports.length > 0) {
				reportSelect.innerHTML = res.reports
					.map((r) => `<option value="${esc(r.date)}">${esc(r.title)}</option>`)
					.join("");
				loadReport(res.reports[0].date);
			}

			if (res.installTail) {
				installTail.style.display = "block";
				installTail.textContent = res.installTail;
			}
		}

		async function loadReport(day) {
			const res = await httpGet("report", { day });
			if (res && res.exists) {
				reportContent.textContent = res.text;
			} else {
				reportContent.textContent = t("reportNone");
			}
		}

		reportSelect.addEventListener("change", () => {
			loadReport(reportSelect.value);
		});

		btnCopyReport.addEventListener("click", () => {
			if (reportContent.textContent) {
				navigator.clipboard.writeText(reportContent.textContent);
				notify(t("reportCopied"), "good");
			}
		});

		async function loadWatchedCards() {
			const params = {
				offset: currentOffset,
				limit: PAGE_SIZE,
			};
			if (currentWatchedState) params.state = currentWatchedState;
			if (currentWatchedTier) params.tier = currentWatchedTier;
			// 时间范围换算成服务端 day/from/to（默认上次=最新有数据的日期）
			if (rangeMode === "day" && rangeDay) params.day = rangeDay;
			else if (rangeMode === "today") {
				params.day = dayOf(new Date());
			} else if (rangeMode === "week" && availDays.length) params.from = addDays(availDays[0], -6);

			const res = await httpGet("watched", params);
			if (!res || !res.ok) {
				cardsGrid.innerHTML = `<div style="grid-column: 1 / -1; padding: 20px; text-align: center; color: var(--text-dim);">${t("cardsLoadFailed", { err: esc(res?.error || t("unknownException")) })}</div>`;
				return;
			}

			const rows = res.rows || [];
			detailRows = rows;
			const total = res.total || 0;
			pageInfo.textContent = t("pageInfo", {
				from: total === 0 ? 0 : currentOffset + 1,
				to: currentOffset + rows.length,
				total,
			});
			btnPrevPage.disabled = currentOffset === 0;
			btnNextPage.disabled = currentOffset + rows.length >= total;
			// 日期下拉与范围提示（days 由服务端随包返回）
			if (Array.isArray(res.days) && res.days.length) availDays = res.days;
			const daySel = el.querySelector(".bili-day-select");
			if (daySel && availDays.length && !daySel.options.length) {
				daySel.innerHTML = availDays.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
			}
			if (daySel && rangeMode === "last" && availDays.length) daySel.value = availDays[0];
			if (daySel && rangeMode === "day" && rangeDay) daySel.value = rangeDay;
			const rangeHint = el.querySelector(".bili-range-hint");
			if (rangeHint) {
				rangeHint.textContent =
					rangeMode === "last"
						? t("rangeLast", { day: availDays[0] || "", total })
						: rangeMode === "today"
							? t("rangeToday", { total })
							: rangeMode === "week"
								? t("rangeWeek", { total })
								: t("rangeDay", { day: rangeDay, total });
			}

			if (rows.length === 0) {
				cardsGrid.innerHTML = `<div style="grid-column: 1 / -1; padding: 30px; text-align: center; color: var(--text-dim);">${t("noWatched")}</div>`;
				return;
			}

			const fmtCount = (n) => {
				const v = Number(n);
				if (!Number.isFinite(v)) return "—";
				if (v >= 10000) return t("countCompact", { wan: (v / 10000).toFixed(1), k: Math.round(v / 1000) });
				return String(v);
			};
			const statsRow = (item) =>
				`<span class="stat-like" data-bv="${esc(item.bvid)}">${SVG_LIKE} …</span><span class="stat-fav" data-bv="${esc(item.bvid)}">${SVG_FAV} …</span><span class="stat-reply" data-bv="${esc(item.bvid)}">${SVG_CMT} …</span><span style="margin-left:auto;font-family:ui-monospace,Menlo,Consolas,monospace;">${esc(item.bvid.slice(0, 7))}…</span>`;
			const coverBox = (item) =>
				`<div class="bili-b-cover"><img src="/plugins-api/bili-scroll/cover?bv=${esc(item.bvid)}" loading="lazy" alt="" onerror="this.style.display='none'" /><div class="bili-b-flags">${item.tier ? `<i class="f-like">${esc(item.tier)}</i>` : ""}${item.picked && !item.tier ? `<i class="f-like">${t("flagPicked")}</i>` : ""}${item.delivered || item.commented ? `<i class="f-cmt">${t("flagDelivered")}</i>` : ""}${item.summary ? `<i class="f-cmt">${t("flagSummary")}</i>` : item.note ? `<i class="f-cmt">${t("flagNote")}</i>` : ""}</div><div class="bili-b-meta"><span class="m stat-play" data-bv="${esc(item.bvid)}">${SVG_PLAY} …</span><span class="m stat-dm" data-bv="${esc(item.bvid)}">${SVG_DM} …</span><span class="bili-b-dur stat-dur" data-bv="${esc(item.bvid)}">${esc(item.day)}</span></div></div>`;
			const bodyBox = (item) =>
				`<div class="bili-b-body"><p class="bili-b-title">${esc(item.title || item.bvid)}</p><div class="bili-b-up"><span class="bili-b-ava"><b>${esc((item.up || "?").slice(0, 1))}</b></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(item.up || t("upUnknown"))} · ${esc(item.day)}</span></div><div class="bili-b-acts">${statsRow(item)}</div>${item.why ? `<div class="whyline" style="font-size:11px;color:var(--text-dim);margin-top:4px;">💡 ${esc(item.why)}</div>` : ""}</div>`;
			cardsGrid.innerHTML = rows
				.map(
					(item, idx) =>
						`<div class="bili-b-card" data-idx="${idx}" role="button" tabindex="0" title="${t("cardTitle")}">${coverBox(item)}${bodyBox(item)}</div>`,
				)
				.join("");
			// 懒加载真实播放/弹幕/时长/赞藏数（B站味封面底边行）
			const statBvs = [...new Set(rows.map((r) => r.bvid))];
			for (const bv of statBvs) {
				httpGet("video-stat", { bvid: bv })
					.then((sr) => {
						if (!sr || !sr.ok || !sr.stat) return;
						const s = sr.stat;
						const q = (sel) => cardsGrid.querySelectorAll(`${sel}[data-bv="${bv}"]`);
						q(".stat-play").forEach((n) => {
							n.innerHTML = `${SVG_PLAY} ${esc(fmtCount(s.view))}`;
						});
						q(".stat-dm").forEach((n) => {
							n.innerHTML = `${SVG_DM} ${esc(fmtCount(s.danmaku))}`;
						});
						q(".stat-dur").forEach((n) => {
							n.textContent = s.duration || n.textContent;
						});
						q(".stat-like").forEach((n) => {
							n.innerHTML = `${SVG_LIKE} ${esc(fmtCount(s.like))}`;
						});
						q(".stat-fav").forEach((n) => {
							n.innerHTML = `${SVG_FAV} ${esc(fmtCount(s.favorite))}`;
						});
						q(".stat-reply").forEach((n) => {
							n.innerHTML = `${SVG_CMT} ${esc(fmtCount(s.reply))}`;
						});
					})
					.catch(() => {});
			}
			bindCardClicks();

			cardsGrid.querySelectorAll(".bili-btn-view-note").forEach((btn) => {
				btn.addEventListener("click", async (e) => {
					e.stopPropagation();
					const bv = btn.dataset.bv;
					const day = btn.dataset.day;
					const res = await httpGet("note", { bvid: bv, day, kind: "report" });
					if (res && res.ok && res.text) {
						reportContent.textContent = res.text;
						notify(t("noteLoaded", { bv }), "good");
						reportContent.scrollIntoView({ behavior: "smooth", block: "nearest" });
					} else {
						notify(t("noteNotFound"), "warn");
					}
				});
			});
		}

		el.querySelectorAll(".bili-chip-state").forEach((btn) => {
			btn.addEventListener("click", () => {
				el.querySelectorAll(".bili-chip-state").forEach((b) => {
					b.style.background = "var(--bg)";
					b.style.color = "var(--text)";
				});
				btn.style.background = "var(--accent)";
				btn.style.color = "var(--accent-contrast, #fff)";
				currentWatchedState = btn.dataset.state;
				currentOffset = 0;
				loadWatchedCards();
			});
		});

		el.querySelectorAll(".bili-chip-tier").forEach((btn) => {
			btn.addEventListener("click", () => {
				el.querySelectorAll(".bili-chip-tier").forEach((b) => {
					b.style.background = "var(--bg)";
					b.style.color = "var(--text)";
				});
				btn.style.background = "var(--accent)";
				btn.style.color = "var(--accent-contrast, #fff)";
				currentWatchedTier = btn.dataset.tier;
				currentOffset = 0;
				loadWatchedCards();
			});
		});

		// v2.6 网格 / 列表视图切换（重渲染当前页）
		el.querySelectorAll(".bili-wall-toggle .bili-wt").forEach((btn) => {
			btn.addEventListener("click", () => {
				if (btn.dataset.view === wallView) return;
				el.querySelectorAll(".bili-wall-toggle .bili-wt").forEach((b) => b.classList.toggle("is-active", b === btn));
				wallView = btn.dataset.view;
				cardsGrid.classList.toggle("is-list", wallView === "list");
				loadWatchedCards();
			});
		});

		btnPrevPage.addEventListener("click", () => {
			if (currentOffset >= PAGE_SIZE) {
				currentOffset -= PAGE_SIZE;
				loadWatchedCards();
			}
		});

		btnNextPage.addEventListener("click", () => {
			currentOffset += PAGE_SIZE;
			loadWatchedCards();
		});

		async function reloadFavFolders() {
			const res = await httpGet("fav-folders");
			if (res && res.ok) {
				const cur = cfgFavFolder.value;
				cfgFavFolder.innerHTML =
					`<option value="0">${t("favNone")}</option>` +
					(res.folders || [])
						.map(
							(f) => `<option value="${f.id}">${t("favFolderItem", { title: esc(f.title), n: f.count || 0 })}</option>`,
						)
						.join("");
				if (cur) cfgFavFolder.value = cur;
			}
		}

		// ══ v2.5 详情弹窗 + 时间范围切换 ══
		const detailRoot = el.querySelector(".bili-detail");
		let currentDetailBv = "";
		let currentDetailItem = null;

		function bindCardClicks() {
			cardsGrid.querySelectorAll(".bili-b-card").forEach((card) => {
				const openIt = () => {
					const idx = Number(card.dataset.idx) || 0;
					const item = detailRows[idx];
					if (item) openDetail(item);
				};
				card.addEventListener("click", openIt);
				card.addEventListener("keydown", (e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						openIt();
					}
				});
			});
		}

		const DM_STATE_TXT = {
			drafted: t("dmStateDrafted"),
			sent: t("dmStateSent"),
			acked: t("dmStateAcked"),
			acted: t("dmStateActed"),
			expired: t("dmStateExpired"),
			failed: t("dmStateFailed"),
		};
		const stateTxt = (s) => DM_STATE_TXT[s] || "";

		function ledgerSkeleton() {
			const row = (ico, title) =>
				`<div class="bili-ledger-row"><span class="bili-ledger-ico">${ico}</span><div class="bili-ledger-main"><div class="t no">${title}</div><div class="d">${t("querying")}</div></div></div>`;
			if (detailLedgerRows)
				detailLedgerRows.innerHTML = [
					row("👍", t("like")),
					row("⭐", t("favorite")),
					row("💬", t("comment")),
					row("✉️", t("dm")),
				].join("");
		}

		const likeAction = (act) =>
			act.like === true
				? ""
				: `<button class="bili-ledger-act" data-act="like" type="button">${t("likeAction")}</button>`;

		function ledgerRowDone({ ico, title, ok, detail, quote, action }) {
			const cls = ok === true ? "ok" : ok === false ? "no" : "unknown";
			return `<div class="bili-ledger-row"><span class="bili-ledger-ico ${ok === true ? "on" : ""}">${ico}</span><div class="bili-ledger-main"><div class="t ${cls}">${title}</div>${detail ? `<div class="d">${detail}</div>` : ""}${quote ? `<div class="bili-ledger-quote">${quote}</div>` : ""}</div>${action || ""}</div>`;
		}

		function renderLedger(item, act) {
			if (!detailLedgerRows) return;
			const likeBadge = act.like === null ? t("likeUnknown") : act.like ? t("likeYes") : t("likeNo");
			const likeDetail = act.like === null ? t("likeDetailUnknown") : act.like ? t("likeDetailYes") : t("likeDetailNo");
			const favBadge = act.fav === null ? t("likeUnknown") : act.fav ? t("favYes") : t("favNo");
			const favDetail =
				act.fav === null
					? t("favDetailUnknown")
					: act.favPartial
						? t("favDetailPartial")
						: t("favDetailOk", { day: esc(item.day) });
			let cTitle = t("noRecordedComment");
			let cDetail = act.comment ? "" : t("noPublicComment");
			let cQuote = "";
			if (act.comment) {
				const st =
					act.comment.state === "failed" ? t("dmStateFailed") : stateTxt(act.comment.state) || act.comment.state;
				cTitle = `${t("commentedLabel")} · <span style="font-weight:400;color:var(--text-dim)">${esc(st)}${act.comment.day ? ` · ${esc(act.comment.day)}` : ""}${act.comment.rpid ? ` · rpid ${act.comment.rpid}` : ""}</span>`;
				cQuote = esc(act.comment.text || "");
			} else if (item?.commented) {
				cDetail = t("commentTraceOnly");
			}
			const dmRow = act.dm
				? {
						t: t("inDigestDm", {
							state: `<span style="font-weight:400;color:var(--text-dim)">${esc(stateTxt(act.dm.state) || act.dm.state)} · ${esc(act.dm.day)}</span>`,
						}),
						d: t("inDigestDmDetail"),
					}
				: { t: t("noDm"), d: t("noDmDetail") };
			detailLedgerRows.innerHTML = [
				ledgerRowDone({ ico: "👍", title: likeBadge, ok: act.like, detail: likeDetail, action: likeAction(act) }),
				ledgerRowDone({
					ico: "⭐",
					title: favBadge,
					ok: act.fav,
					detail: favDetail,
					action: `<button class="bili-ledger-act" data-act="fav" type="button">${t("favToTarget")}</button>`,
				}),
				ledgerRowDone({
					ico: "💬",
					title: t("comment"),
					ok: act.comment ? true : false,
					detail: cDetail,
					quote: act.comment ? cQuote : "",
				}),
				ledgerRowDone({ ico: "✉️", title: t("dm"), ok: act.dm ? true : false, detail: dmRow.d }),
			].join("");
			if (act.dm) {
				const titleEl = detailLedgerRows.querySelector(".bili-ledger-row:last-child .t");
				if (titleEl) titleEl.innerHTML = dmRow.t;
			}
			bindDetailActs(item);
		}

		function loadAccountActions(item) {
			if (!item) return;
			httpGet("account-actions", { bvid: item.bvid })
				.then((r) => {
					if (currentDetailBv !== item.bvid) return;
					if (r && r.ok) renderLedger(item, r);
					else if (detailLedgerRows) {
						detailLedgerRows.innerHTML =
							`<div class="bili-ledger-row"><div class="bili-ledger-main"><div class="t no">${t("ledgerQueryFailed")}</div><div class="d">` +
							esc((r && r.error) || t("unknownException")) +
							"</div></div></div>";
					}
				})
				.catch(() => {
					if (detailLedgerRows && currentDetailBv === item.bvid) {
						detailLedgerRows.innerHTML = `<div class="bili-ledger-row"><div class="bili-ledger-main"><div class="t no">${t("ledgerQueryFailed")}</div><div class="d">${t("networkError")}</div></div></div>`;
					}
				});
		}

		function openDetail(item) {
			if (!detailRoot || !item) return;
			currentDetailBv = item.bvid;
			currentDetailItem = item;
			el.querySelector(".bili-detail-title").textContent = item.title || item.bvid;
			el.querySelector(".bili-detail-sub").innerHTML =
				`<em>${esc(item.bvid)}</em><em>${esc(item.up || t("upUnknown"))}</em><em>${esc(item.day)}</em><em class="detail-stat-sub">${t("statsLoading")}</em>`;
			el.querySelector(".bili-detail-cover").src = `/plugins-api/bili-scroll/cover?bv=${item.bvid}`;
			el.querySelector(".bili-sum-meta").textContent = "";
			el.querySelector(".bili-sum-regen").hidden = true;
			el.querySelector(".bili-sum-body").innerHTML =
				`<p style="color: var(--text-dim); font-size: 12px;">${t("readingSummary")}</p>`;
			el.querySelector(".bili-detail-acts").innerHTML =
				`<span class="chip skel">${t("viewsPlaceholder")}</span><span class="chip skel">${t("danmakuPlaceholder")}</span><span class="chip on" data-act="fav">${t("favToTarget")}</span>`;
			el.querySelector(".bili-detail-comments").innerHTML = "";
			ledgerSkeleton();
			loadAccountActions(item);
			detailRoot.hidden = false;
			const player = el.querySelector(".bili-detail-player");
			const playBtn = player.querySelector(".bili-detail-play");
			const newPlay = playBtn.cloneNode(true);
			playBtn.replaceWith(newPlay);
			newPlay.addEventListener("click", () => {
				if (player.querySelector("iframe")) return;
				const ifr = document.createElement("iframe");
				ifr.src = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(item.bvid)}&autoplay=1&high_quality=1&danmaku=0`;
				ifr.allow = "fullscreen; autoplay; encrypted-media";
				ifr.loading = "lazy";
				ifr.referrerPolicy = "no-referrer";
				player.appendChild(ifr);
			});
			const openBtn = el.querySelector(".bili-detail-open");
			const newOpen = openBtn.cloneNode(true);
			openBtn.replaceWith(newOpen);
			newOpen.addEventListener("click", () =>
				window.open(item.url || `https://www.bilibili.com/video/${item.bvid}`, "_blank"),
			);
			bindDetailActs(item);
			loadDetailSummary(item);
			httpGet("video-stat", { bvid: item.bvid })
				.then((sr) => {
					if (sr && sr.ok && sr.stat) {
						const st = sr.stat;
						const em2 = el.querySelector(".detail-stat-sub");
						if (em2) {
							em2.textContent = t("statsInline", { views: fmtCount(st.view), danmaku: fmtCount(st.danmaku) });
						}
						el.querySelector(".bili-detail-acts").innerHTML = [
							`<span class="chip">${t("viewsChip", { n: fmtCount(st.view) })}</span>`,
							`<span class="chip">${t("danmakuChip", { n: fmtCount(st.danmaku) })}</span>`,
							`<span class="chip">${t("likesChip", { n: fmtCount(st.like) })}</span>`,
							`<span class="chip">${t("favoritesChip", { n: fmtCount(st.favorite) })}</span>`,
							`<span class="chip on" data-act="fav">${t("favToDefault")}</span>`,
						].join("");
						bindDetailActs(item);
					}
				})
				.catch(() => {});
			const cmtBox = el.querySelector(".bili-detail-comments");
			if (cmtBox) cmtBox.innerHTML = "";
		}

		// ── 右栏：只展示一份 AI 一次性写好的内容总结文档 ──
		function summaryMetaText(meta) {
			const m = meta || {};
			const bits = [];
			if (m.model) bits.push(String(m.model));
			if (m.at) {
				try {
					bits.push(
						new Date(m.at).toLocaleString("zh-CN", {
							month: "2-digit",
							day: "2-digit",
							hour: "2-digit",
							minute: "2-digit",
						}),
					);
				} catch {}
			}
			return bits.join(" · ");
		}

		async function loadDetailSummary(item) {
			const body = el.querySelector(".bili-sum-body");
			if (!body) return;
			const metaEl = el.querySelector(".bili-sum-meta");
			const regen = el.querySelector(".bili-sum-regen");
			metaEl.textContent = "";
			regen.hidden = true;
			const r = await httpGet("note", { bvid: item.bvid, day: item.day });
			if (currentDetailBv !== item.bvid) return;
			// 巡检后台正在写这条：不催、不重复起任务，直接等文件出来
			if (r && r.ok && r.kind === "pending") {
				metaEl.textContent = t("backgroundWriting");
				await pollDetailSummary(item, {
					busy: (msg) => {
						body.innerHTML = `<div class="bili-sum-busy"><div>${msg}</div><div class="skel" style="width: 92%"></div><div class="skel" style="width: 78%"></div></div>`;
					},
					metaEl,
					regen,
				});
				return;
			}
			if (r && r.ok && r.kind === "summary" && r.text) {
				body.innerHTML = renderMiniMd(r.text, { url: item.url, t });
				metaEl.textContent = summaryMetaText(r.meta);
				regen.hidden = false;
				regen.onclick = () => generateDetailSummary(item, regen);
				return;
			}
			// 没有总结：不直接铺旧报告原文，先提示 + 生成 + 可选折叠原文
			const hasReport = Boolean(r && r.ok && r.text);
			body.innerHTML = `
				<div class="bili-sum-empty">
					<div><b>${t("summaryEmptyTitle")}</b><br/>${t("summaryEmptyBody")}</div>
					<button class="bili-sum-cta" type="button">${t("generateSummary")}</button>
					${hasReport ? `<details class="bili-sum-raw"><summary>${t("viewRawNote")}</summary><div class="bili-md bili-sum-raw-body"></div></details>` : ""}
				</div>`;
			if (hasReport) {
				body.querySelector(".bili-sum-raw-body").innerHTML = renderMiniMd(stripNoteScaffold(r.text), {
					url: item.url,
					t,
				});
			}
			body.querySelector(".bili-sum-cta").onclick = (e) => generateDetailSummary(item, e.currentTarget);
		}

		async function generateDetailSummary(item, btn) {
			const body = el.querySelector(".bili-sum-body");
			if (!body) return;
			const metaEl = el.querySelector(".bili-sum-meta");
			const regen = el.querySelector(".bili-sum-regen");
			if (btn) {
				btn.disabled = true;
				btn.textContent = t("generating");
			}
			metaEl.textContent = t("generating");
			regen.hidden = true;
			const busy = (msg) => {
				body.innerHTML = `<div class="bili-sum-busy">
				<div>${msg}</div>
				<div class="skel" style="width: 92%"></div>
				<div class="skel" style="width: 78%"></div>
				<div class="skel" style="width: 86%"></div>
				</div>`;
			};
			busy(t("summaryBusy"));
			const r = await httpPost("summary", { bvid: item.bvid, day: item.day, force: true });
			if (currentDetailBv !== item.bvid) return;
			// 后台任务模式：轮询状态直到出文档或报错（最多 4 分钟）
			if (r && r.ok && r.state === "running") {
				await pollDetailSummary(item, { busy, metaEl, regen });
				return;
			}
			if (r && r.ok && r.text) {
				showDetailSummary(item, r);
				return;
			}
			showSummaryError(item, r?.error || t("unknownError"));
		}

		async function pollDetailSummary(item, { busy, metaEl, regen }) {
			let idleStreak = 0;
			for (let i = 0; i < 80; i++) {
				await new Promise((resolve) => setTimeout(resolve, 3000));
				if (currentDetailBv !== item.bvid) return;
				const s = await httpGet("summary-status", { bvid: item.bvid, day: item.day });
				if (currentDetailBv !== item.bvid) return;
				if (s && s.state === "done" && s.text) {
					showDetailSummary(item, s);
					return;
				}
				if (s && s.state === "error") {
					showSummaryError(item, s.error || t("generateFailed"));
					return;
				}
				// idle 有两种：后台巡检在写（/note 会报 pending），或任务真的丢了
				if (s && s.state === "idle") {
					idleStreak += 1;
					if (idleStreak >= 2) {
						const note = await httpGet("note", { bvid: item.bvid, day: item.day });
						if (currentDetailBv !== item.bvid) return;
						if (note && note.ok && note.kind === "summary" && note.text) {
							showDetailSummary(item, note);
							return;
						}
						if (!(note && note.ok && note.kind === "pending")) {
							showSummaryError(item, t("taskInterrupted"));
							return;
						}
					}
				} else {
					idleStreak = 0;
				}
				if (i === 12) busy(t("summaryStillWriting"));
			}
			metaEl.textContent = "";
			regen.hidden = true;
			showSummaryError(item, t("summaryTimeout"));
		}

		function showDetailSummary(item, res) {
			const body = el.querySelector(".bili-sum-body");
			if (!body) return;
			body.innerHTML = renderMiniMd(res.text || "", { url: item.url, t });
			const metaEl = el.querySelector(".bili-sum-meta");
			if (metaEl) metaEl.textContent = summaryMetaText(res.meta);
			const regen = el.querySelector(".bili-sum-regen");
			if (regen) {
				regen.hidden = false;
				regen.disabled = false;
				regen.textContent = t("regenerate");
				regen.onclick = () => generateDetailSummary(item, regen);
			}
			notify(t("summaryReady"), "good");
		}

		function showSummaryError(item, message) {
			const body = el.querySelector(".bili-sum-body");
			if (!body) return;
			const regen = el.querySelector(".bili-sum-regen");
			if (regen) {
				regen.hidden = true;
				regen.disabled = false;
			}
			const metaEl = el.querySelector(".bili-sum-meta");
			if (metaEl) metaEl.textContent = "";
			body.innerHTML = `<div class="bili-sum-empty">
				<div><b>${t("summaryFailedTitle")}</b><br/>${esc(message)}</div>
				<button class="bili-sum-cta" type="button">${t("retry")}</button>
			</div>`;
			body.querySelector(".bili-sum-cta").onclick = (e) => generateDetailSummary(item, e.currentTarget);
		}

		function bindDetailActs(item) {
			el.querySelectorAll(".bili-detail-acts .chip[data-act='fav'], .bili-ledger-act[data-act='fav']").forEach(
				(btn) => {
					btn.onclick = async () => {
						btn.textContent = t("favoriting");
						const r = await httpPost("fav-add", { bvid: item.bvid });
						if (r && r.ok) {
							btn.textContent = r.already ? t("favAlreadyBtn") : t("favDoneBtn");
							notify(r.already ? t("favAlreadyToast") : t("favDoneToast"), "good");
							loadAccountActions(item);
						} else {
							btn.textContent = t("favFailedBtn");
							notify((r && r.error) || t("favFailed"), "warn");
						}
					};
				},
			);
			el.querySelectorAll(".bili-ledger-act[data-act='like']").forEach((btn) => {
				btn.onclick = async () => {
					btn.textContent = t("liking");
					const r = await httpPost("like-add", { bvid: item.bvid });
					if (r && r.ok) {
						btn.textContent = t("likedBtn");
						notify(t("likedToast"), "good");
						loadAccountActions(item);
					} else {
						btn.textContent = t("likeRetry");
						notify((r && r.error) || t("likeFailed"), "warn");
					}
				};
			});
		}

		function closeDetail() {
			if (!detailRoot) return;
			const player = el.querySelector(".bili-detail-player");
			const ifr = player.querySelector("iframe");
			if (ifr) ifr.remove();
			detailRoot.hidden = true;
		}
		if (detailRoot) {
			el.querySelector(".bili-detail-backdrop").addEventListener("click", closeDetail);
			el.querySelector(".bili-detail-close").addEventListener("click", closeDetail);
		}

		// 时间范围切换
		el.querySelectorAll(".bili-range-seg button").forEach((btn) => {
			btn.addEventListener("click", () => {
				el.querySelectorAll(".bili-range-seg button").forEach((b) => b.classList.remove("is-active"));
				btn.classList.add("is-active");
				rangeMode = btn.dataset.range;
				if (rangeMode === "day") rangeDay = rangeDay || availDays[0] || "";
				currentOffset = 0;
				loadWatchedCards();
			});
		});
		const daySelEl = el.querySelector(".bili-day-select");
		if (daySelEl) {
			daySelEl.addEventListener("change", () => {
				rangeDay = daySelEl.value;
				rangeMode = "day";
				el.querySelectorAll(".bili-range-seg button").forEach((b) => b.classList.remove("is-active"));
				currentOffset = 0;
				loadWatchedCards();
			});
		}
		const rangeRunBtn = el.querySelector(".bili-btn-run-2");
		if (rangeRunBtn) rangeRunBtn.addEventListener("click", () => btnRunDuty.click());
		btnReloadFavs.addEventListener("click", () => {
			reloadFavFolders();
			notify(t("favsUpdated"), "good");
		});

		function populateModelOptions(selectedModel = "") {
			const hostModels = window.__piWebUiHost?.models?.list?.() || [];
			cfgModel.innerHTML = `<option value="">${t("followActiveModel")}</option>`;
			let hasSelected = !selectedModel;
			for (const m of hostModels) {
				// 宿主给的 id 已带 provider 前缀，再拼一次就会变成 provider/provider/id（模型接口不认）
				const mid = String(m.id || "");
				const fullId = mid.includes("/") || !m.provider ? mid : `${m.provider}/${mid}`;
				if (!fullId) continue;
				const opt = document.createElement("option");
				opt.value = fullId;
				opt.textContent = `${m.name || m.id} (${m.provider || "default"})`;
				if (selectedModel && (fullId === selectedModel || m.id === selectedModel)) {
					opt.selected = true;
					hasSelected = true;
				}
				cfgModel.appendChild(opt);
			}
			if (selectedModel && !hasSelected) {
				const opt = document.createElement("option");
				opt.value = selectedModel;
				opt.textContent = t("modelCustomSuffix", { model: selectedModel });
				opt.selected = true;
				cfgModel.appendChild(opt);
			}
		}

		btnPickModel.addEventListener("click", async () => {
			if (typeof window.__piWebUiHost?.pickModel === "function") {
				const cur = cfgModel.value || window.__piWebUiHost.getCurrentModelId?.() || "";
				const res = await window.__piWebUiHost.pickModel({ currentModelId: cur });
				if (res && res.ok && res.modelId) {
					populateModelOptions(res.modelId);
					cfgModel.value = res.modelId;
					notify(t("modelPicked", { name: res.name || res.modelId }), "good");
				}
			} else {
				notify(t("pickModelHint"), "info");
			}
		});

		btnPickWorkspace.addEventListener("click", async () => {
			if (typeof window.__piWebUiHost?.pickDirectory === "function") {
				const cur = cfgWorkspace.value.trim();
				const res = await window.__piWebUiHost.pickDirectory({ initialPath: cur || undefined });
				if (res && res.ok && res.path) {
					cfgWorkspace.value = res.path;
					notify(t("workspacePicked", { path: res.path }), "good");
				}
			} else {
				notify(t("workspaceHint"), "info");
			}
		});

		for (const input of [cfgVisionModel, cfgTranscribe, cfgDmWatch, cfgDmAutoReply]) {
			input.addEventListener("input", () => {
				input.dataset.dirty = "true";
			});
		}

		btnSaveTaste.addEventListener("click", async () => {
			const patch = {
				model: cfgModel.value.trim(),
				visionModel: cfgVisionModel.value.trim(),
				transcribe: cfgTranscribe.checked,
				reasoningEffort: cfgReasoningEffort.value,
				workspace: cfgWorkspace.value.trim(),
				personaPrompt: cfgPersona.value.trim(),
				keywords: cfgKeywords.value.trim(),
				excludeKeywords: cfgExclude.value.trim(),
				favFolderId: Number(cfgFavFolder.value) || 0,
				reportLevel: cfgReportLevel.value,
			};
			const res = await httpPost("config", patch);
			if (res && res.ok) {
				notify(t("tasteSaved"), "good");
				for (const input of [cfgVisionModel, cfgTranscribe, cfgDmWatch, cfgDmAutoReply]) {
					if (input) delete input.dataset.dirty;
				}
				refreshStatus(true);
			} else {
				notify(t("saveFailed", { err: res?.error || t("unknownException") }), "warn");
			}
		});
		if (btnSaveQuick) {
			btnSaveQuick.addEventListener("click", async () => {
				const patch = {
					perDay: Math.max(1, Number(quickPerDay?.value) || 5),
					dmWatchMinutes: Math.max(1, Number(quickMins?.value) || 1),
					dmMode: quickDmMode?.value || "only",
					peakValley: quickPeak ? quickPeak.checked : true,
					dmWatch: quickWatch ? quickWatch.checked : true,
				};
				const res = await httpPost("config", patch);
				if (res && res.ok) {
					notify(t("quickSaved"), "good");
					refreshStatus(true);
				} else {
					notify(t("saveFailed", { err: res?.error || t("unknownException") }), "warn");
				}
			});
		}

		btnImportAgents.addEventListener("click", () => {
			if (currentStatus?.personaFromWs) {
				cfgPersona.value = currentStatus.personaFromWs;
				notify(t("agentsImported"), "good");
			} else {
				notify(t("agentsNotFound"), "warn");
			}
		});

		btnSaveSocial.addEventListener("click", async () => {
			let dmMode = "only";
			dmRadios.forEach((r) => {
				if (r.checked) dmMode = r.value;
			});
			const patch = {
				dmMode,
				dmUid: Number(cfgDmUid.value) || 0,
				mentionName: cfgMentionName.value.trim(),
				dmWatch: cfgDmWatch.checked,
				dmAutoReply: cfgDmAutoReply.checked,
				dmWatchMinutes: Math.max(1, Number(cfgDmMinutes.value) || 1),
				dmReplyPerDay: Number(cfgDmReplyLimit.value) || 20,
				autoComment: cfgAutoComment.checked,
				replyToComments: cfgReplyComments.checked,
			};
			const res = await httpPost("config", patch);
			if (res && res.ok) {
				notify(t("socialSaved"), "good");
				for (const input of [cfgVisionModel, cfgTranscribe, cfgDmWatch, cfgDmAutoReply]) {
					if (input) delete input.dataset.dirty;
				}
				refreshStatus(true);
			} else {
				notify(t("saveFailed", { err: res?.error || t("unknownException") }), "warn");
			}
		});

		btnLogin.addEventListener("click", async () => {
			qrSection.style.display = "block";
			qrStatus.textContent = t("qrRequesting");
			qrSvgSlot.innerHTML = "";

			const res = await httpPost("login/start");
			if (!res || !res.ok) {
				qrStatus.textContent = t("qrFailed", { err: res?.error || t("networkError") });
				return;
			}

			qrStatus.textContent = t("qrWaitingPhone");
			try {
				const qr = qrcode(0, "M");
				qr.addData(String(res.url || ""));
				qr.make();
				const qrSvg = qr.createSvgTag({ cellSize: 4, margin: 4 });
				qrSvgSlot.innerHTML = qrSvg;
			} catch (e) {
				console.error("[bili-scroll] QR generation failed", e);
				qrSvgSlot.textContent = t("qrGenFailed");
			}

			if (pollTimer) clearInterval(pollTimer);
			pollTimer = setInterval(async () => {
				const pollRes = await httpPost("login/poll", { key: res.key });
				if (pollRes.state === "scanned") {
					qrStatus.textContent = t("qrScanned");
				} else if (pollRes.state === "ok") {
					clearInterval(pollTimer);
					qrSection.style.display = "none";
					notify(t("loginSuccess"), "good");
					refreshStatus();
				} else if (pollRes.state === "expired") {
					clearInterval(pollTimer);
					qrStatus.textContent = t("qrExpired");
				}
			}, 2500);
		});

		btnCancelLogin.addEventListener("click", () => {
			if (pollTimer) clearInterval(pollTimer);
			qrSection.style.display = "none";
		});

		btnLogout.addEventListener("click", async () => {
			await httpPost("login/logout");
			notify(t("loggedOut"), "info");
			refreshStatus();
		});

		btnRunDuty.addEventListener("click", async () => {
			notify(t("dutyStarted"), "info");
			const r = await httpPost("duty/run");
			if (r && r.started) {
				appendActionTerminal({ step: "start", message: t("dutyBackground") });
			}
		});

		btnChatMode.addEventListener("click", () => {
			const prompt = t("roamPrompt");
			if (typeof ctx.insertPrompt === "function") {
				ctx.insertPrompt(prompt);
				notify(t("roamInserted"), "good");
			} else {
				navigator.clipboard.writeText(prompt);
				notify(t("roamCopied"), "good");
			}
		});

		btnFavToday.addEventListener("click", async () => {
			const res = await httpPost("fav-today");
			if (res && res.ok) {
				notify(t("favTodayDone", { added: res.added, total: res.total }), "good");
			} else {
				notify(t("favTodayFailed", { err: res?.error || t("unknownException") }), "warn");
			}
		});

		let installPollingTimer = null;
		function startInstallTailPolling() {
			if (installPollingTimer) clearInterval(installPollingTimer);
			installTail.style.display = "block";
			installPollingTimer = setInterval(async () => {
				const res = await httpGet("status");
				if (res && res.installTail) {
					installTail.textContent = res.installTail;
					installTail.scrollTop = installTail.scrollHeight;
				}
				if (res && !res.installing && !res.asrInstalling) {
					clearInterval(installPollingTimer);
					installPollingTimer = null;
					refreshStatus();
				}
			}, 1500);
		}

		btnInstall.addEventListener("click", async () => {
			notify(t("installingMain"), "info");
			startInstallTailPolling();
			const r = await httpPost("install");
			if (r && r.started) {
				notify(r.hint || t("installMainBg"), "info");
			}
		});

		btnInstallAsr.addEventListener("click", async () => {
			notify(t("installingAsr"), "info");
			startInstallTailPolling();
			const r = await httpPost("install-asr");
			if (r && r.started) {
				notify(r.hint || t("installAsrBg"), "info");
			}
		});

		btnCheckUp.addEventListener("click", async () => {
			notify(t("testingApi"), "info");
			diagResult.style.display = "block";
			diagResult.textContent = t("testingCreds");
			const res = await httpGet("status");
			diagResult.textContent = res.loggedIn ? t("credsOk") : t("credsBad");
		});

		btnDiagnose.addEventListener("click", async () => {
			const res = await httpGet("diagnose");
			if (res && res.text) {
				navigator.clipboard.writeText(res.text);
				diagResult.style.display = "block";
				diagResult.textContent = res.text;
				notify(t("diagCopied"), "good");
			}
		});

		btnSelfcheck.addEventListener("click", async () => {
			const res = await httpGet("selfcheck");
			diagResult.style.display = "block";
			if (res && res.items) {
				const lines = res.items.map(
					(i) =>
						`${t("selfcheckLine", { ok: i.ok ? "✅" : "❌", name: i.name, detail: i.detail, fix: i.fix ? t("selfcheckFix", { fix: i.fix }) : "" })}`,
				);
				diagResult.textContent = lines.join("\n");
			}
		});

		btnVerify.addEventListener("click", async () => {
			notify(t("verifyingComments"), "info");
			diagResult.style.display = "block";
			diagResult.textContent = t("verifyingList");
			const res = await httpPost("verify");
			if (res && res.text) {
				diagResult.textContent = res.text;
				notify(t("verifyDone"), "good");
			}
		});

		btnOpenOut.addEventListener("click", () => httpPost("open", { what: "out" }));
		btnOpenHome.addEventListener("click", () => httpPost("open", { what: "home" }));

		btnRefresh.addEventListener("click", () => {
			refreshStatus();
			loadWatchedCards();
			reloadFavFolders();
			notify(t("dataRefreshed"), "info");
		});

		refreshStatus();
		loadWatchedCards();
		reloadFavFolders();
	},
};
