import { esc } from "@pi-web-ui/plugin-sdk/client";
import { makeT } from "./i18n.mjs";

const t = makeT();

function fmtDate(iso) {
	if (!iso) return "";
	const d = new Date(iso);
	const today = new Date();
	return d.toDateString() === today.toDateString()
		? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: d.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function shortDomain(rawUrl) {
	try {
		const u = new URL(rawUrl);
		const parts = u.hostname.replace(/^www\./i, "").split(".");
		if (parts.length > 2) {
			const tail2 = parts.slice(-2).join(".");
			if (/^(com|co|org|net|edu|gov)\.[a-z]{2}$/i.test(tail2) && parts.length >= 3) {
				return parts.slice(-3).join(".");
			}
			return tail2;
		}
		return parts.join(".");
	} catch {
		return t("linkFallback");
	}
}

function renderInlineLinks(line) {
	const cleaned = String(line ?? "").replace(
		/\[https?:\/\/[^\s\]]+\.(?:png|jpe?g|gif|svg|webp|ico)(?:\?[^\s\]]*)?\]/gi,
		"",
	);

	const urlRegex = /\[(https?:\/\/[^\s\]]+)\]|(https?:\/\/[^\s<>")\]]+)/gi;
	let out = "";
	let lastIdx = 0;
	let m;
	while ((m = urlRegex.exec(cleaned)) !== null) {
		out += esc(cleaned.slice(lastIdx, m.index));
		const rawUrl = m[1] || m[2];
		const domain = shortDomain(rawUrl);
		out += `<a class="mail-link-chip" href="${esc(rawUrl)}" target="_blank" rel="noopener noreferrer" title="${esc(rawUrl)}">🔗 ${esc(domain)} ↗</a>`;
		lastIdx = urlRegex.lastIndex;
	}
	out += esc(cleaned.slice(lastIdx));
	return out;
}

function cleanMailPlainText(raw) {
	return String(raw ?? "")
		.replace(/\r\n/g, "\n")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&copy;/gi, "©")
		.replace(/&ndash;/gi, "–")
		.replace(/&mdash;/gi, "—")
		.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
		.replace(/@media[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gi, "\n")
		.replace(/(?:^|\n)[ \t]*(?:[a-z0-9_.*#\-:>+, \t]+\n)*[ \t]*[a-z0-9_.*#\-:>+, \t]+\{[^{}]*\}/gi, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function formatMailBody(text, truncated = false) {
	const raw = cleanMailPlainText(text);
	const lines = raw.split("\n");
	const blocks = [];
	let inList = false;
	let inFooter = false;
	let paraLines = [];

	const flushPara = () => {
		if (!paraLines.length) return;
		const content = paraLines.map(renderInlineLinks).join("<br/>");
		if (content.trim()) blocks.push(`<p>${content}</p>`);
		paraLines = [];
	};
	const closeList = () => {
		if (inList) {
			blocks.push("</ul>");
			inList = false;
		}
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (/^\[https?:\/\/[^\s\]]+\.(?:png|jpe?g|gif|svg|webp|ico)(?:\?[^\s\]]*)?\]$/i.test(trimmed)) {
			continue;
		}
		if (/^(--+|___+|\*{3,})$/.test(trimmed)) {
			flushPara();
			closeList();
			if (!inFooter) {
				blocks.push('<hr class="mail-hr"/><div class="mail-footer">');
				inFooter = true;
			} else {
				blocks.push('<hr class="mail-hr"/>');
			}
			continue;
		}
		if (!trimmed) {
			flushPara();
			closeList();
			continue;
		}
		const listMatch = trimmed.match(/^([*\-•])\s+(.*)$/);
		if (listMatch) {
			flushPara();
			if (!inList) {
				blocks.push("<ul>");
				inList = true;
			}
			blocks.push(`<li>${renderInlineLinks(listMatch[2])}</li>`);
			continue;
		}
		if (trimmed.startsWith(">")) {
			flushPara();
			closeList();
			blocks.push(`<blockquote>${renderInlineLinks(trimmed.replace(/^>+\s*/, ""))}</blockquote>`);
			continue;
		}
		closeList();
		paraLines.push(line);
	}
	flushPara();
	closeList();
	if (inFooter) blocks.push("</div>");
	if (truncated) blocks.push(`<p style="opacity:.55;font-size:12px">${t("truncated")}</p>`);
	return blocks.join("");
}

const emptyReaderHtml = () => `<div class="empty-reader">${t("emptyReader")}</div>`;

export default {
	mount(container, ctx) {
		container.innerHTML = `
<div class="wmx">
	<style>
		.wmx { max-width: 1100px; margin: 0 auto; font-size: 13px; display: grid; gap: 10px; }
		.wmx-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.wmx h2 { margin: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.wmx .chip {
			font-size: 11px; padding: 1px 8px; border-radius: 99px;
			border: 1px solid var(--border, #333); opacity: .85; font-weight: normal;
		}
		.wmx .chip.ok { color: var(--green, #4ade80); border-color: color-mix(in srgb, var(--green, #4ade80) 40%, transparent); }
		.wmx .chip.err { color: var(--red, #f87171); border-color: color-mix(in srgb, var(--red, #f87171) 40%, transparent); }
		.wmx .chip.badge { color: var(--amber, #fbbf24); }
		.wmx .head-actions { margin-left: auto; display: flex; gap: 6px; align-items: center; }
		.wmx button {
			background: var(--bg-elev, #16161d); color: inherit;
			border: 1px solid var(--border, #333); border-radius: 6px;
			padding: 3px 10px; cursor: pointer; font: inherit; font-size: 12px;
		}
		.wmx .head-actions button { padding: 2px 9px; opacity: .85; }
		.wmx .head-actions button:hover { opacity: 1; border-color: var(--accent, #7c5cff); }
		.wmx .btn-compose { color: var(--accent, #7c5cff); border-color: color-mix(in srgb, var(--accent, #7c5cff) 45%, transparent); background: transparent; opacity: 1; }
		.wmx button.primary { background: var(--accent, #7c5cff); color: var(--accent-contrast, #fff); border-color: transparent; }
		.wmx button.danger:hover { color: var(--red, #f87171); border-color: var(--red, #f87171); }
		.wmx input, .wmx select, .wmx textarea {
			background: var(--bg-elev, #16161d); color: inherit;
			border: 1px solid var(--border, #333); border-radius: 6px;
			padding: 5px 8px; font: inherit; font-size: 12px; resize: vertical;
		}
		.wmx .hint { opacity: .55; font-size: 11px; margin: -4px 0 0; }
		.wmx .hint button { padding: 1px 8px; }

		/* 左右结构 */
		.wmx-body { display: grid; grid-template-columns: minmax(300px, 42%) 1fr; gap: 12px; align-items: start; }
		@media (max-width: 760px) { .wmx-body { grid-template-columns: 1fr; } }
		.pane-list { display: grid; gap: 8px; min-width: 0; }
		.wmx .toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
		.wmx .toolbar input[type="search"] { flex: 1; min-width: 120px; }
		.wmx ul.maillist {
			list-style: none; margin: 0; padding: 0; display: grid; gap: 5px;
			max-height: calc(100vh - 260px); max-height: calc(100dvh - 260px); overflow: auto;
		}
		.wmx ul.maillist li {
			border: 1px solid var(--border, #333); border-radius: 7px;
			padding: 6px 10px; cursor: pointer; display: grid;
			grid-template-columns: 1fr auto; gap: 2px 10px; align-items: baseline;
		}
		.wmx ul.maillist li:hover { border-color: var(--accent, #7c5cff); }
		.wmx ul.maillist li.active { border-color: var(--accent, #7c5cff); background: color-mix(in srgb, var(--accent, #7c5cff) 8%, transparent); }
		.wmx ul.maillist li.unread { border-left: 3px solid var(--amber, #fbbf24); }
		.wmx ul.maillist .from {
			font-size: 12px; opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.wmx ul.maillist .subj {
			grid-column: 1 / -1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.wmx ul.maillist .date { opacity: .5; font-size: 11px; white-space: nowrap; }
		.wmx .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--amber, #fbbf24); margin-right: 5px; }

		/* 右侧阅读区 */
		.wmx .reader {
			border: 1px solid var(--border, #333); border-radius: 8px;
			padding: 12px 14px; display: grid; gap: 8px; align-self: stretch;
			min-height: 320px; align-content: start;
		}
		.wmx .empty-reader { display: grid; place-content: center; height: 100%; min-height: 300px; opacity: .4; }
		.wmx .reader .body {
			margin: 0; word-break: break-word; overflow-wrap: anywhere;
			font-size: 13.5px; line-height: 1.7;
			max-height: calc(100vh - 320px); max-height: calc(100dvh - 320px); overflow: auto;
			background: var(--bg-elev, #16161d); border-radius: 8px; padding: 14px 16px;
		}
		.wmx .reader .body p { margin: 0 0 10px; }
		.wmx .reader .body p:last-child { margin-bottom: 0; }
		.wmx .reader .body ul { margin: 0 0 10px; padding-left: 20px; }
		.wmx .reader .body li { margin: 4px 0; }
		.wmx .reader .body blockquote {
			margin: 6px 0; padding: 4px 10px;
			border-left: 3px solid color-mix(in srgb, var(--accent, #7c5cff) 55%, var(--border, #333));
			opacity: .85;
		}
		.wmx .mail-hr { border: 0; border-top: 1px dashed var(--border, #333); margin: 12px 0; opacity: .6; }
		.wmx .mail-footer { font-size: 12px; opacity: .65; line-height: 1.55; }
		.wmx .mail-link-chip {
			display: inline-flex; align-items: center; gap: 3px;
			padding: 1px 8px; margin: 0 2px; border-radius: 99px;
			font-size: 11.5px; line-height: 1.5; text-decoration: none;
			color: var(--accent, #7c5cff);
			background: color-mix(in srgb, var(--accent, #7c5cff) 12%, transparent);
			border: 1px solid color-mix(in srgb, var(--accent, #7c5cff) 30%, transparent);
			vertical-align: baseline; white-space: nowrap;
		}
		.wmx .mail-link-chip:hover {
			background: color-mix(in srgb, var(--accent, #7c5cff) 22%, transparent);
			text-decoration: none;
		}
		.wmx .reader .actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
		.wmx .reader .actions .act-translate {
			color: var(--accent, #7c5cff);
			border-color: color-mix(in srgb, var(--accent, #7c5cff) 45%, var(--border, #333));
		}
		.wmx .reader .actions .act-translate:hover {
			background: color-mix(in srgb, var(--accent, #7c5cff) 12%, transparent);
		}

		/* 译文卡片与主题 */
		.wmx .trans-box {
			margin-top: 8px; border: 1px solid color-mix(in srgb, var(--accent, #7c5cff) 35%, var(--border, #333));
			border-radius: 8px; background: color-mix(in srgb, var(--accent, #7c5cff) 5%, var(--bg-elev, #16161d));
			overflow: hidden;
		}
		.wmx .trans-head {
			display: flex; align-items: center; justify-content: space-between; gap: 8px;
			padding: 6px 12px; font-size: 11.5px;
			background: color-mix(in srgb, var(--accent, #7c5cff) 12%, transparent);
			border-bottom: 1px solid color-mix(in srgb, var(--accent, #7c5cff) 22%, transparent);
			color: var(--accent, #7c5cff); font-weight: 600;
		}
		.wmx .trans-head button { padding: 2px 8px; font-size: 11px; white-space: nowrap; flex-shrink: 0; }
		.wmx .trans-body {
			margin: 0; padding: 14px 16px;
			font-size: 13.5px; line-height: 1.7;
			max-height: calc(100vh - 340px); max-height: calc(100dvh - 340px); overflow: auto;
			background: transparent;
		}
		.wmx .trans-subj {
			font-size: 13px; font-weight: 500; margin-top: 3px;
			color: var(--accent, #7c5cff); opacity: .95;
		}

		/* 弹窗（设置 / 写信） */
		.wmx .modal-backdrop {
			position: fixed; inset: 0; z-index: 1000;
			background: rgba(0, 0, 0, .5);
			display: flex; align-items: center; justify-content: center;
		}
		/* hidden 属性的 UA 样式是 display:none，会被上面的 display:flex 覆盖——必须显式压回 */
		.wmx .modal-backdrop[hidden] { display: none; }
		.wmx .modal {
			width: min(600px, 94vw); max-height: 88vh;
			background: var(--bg, #101016); border: 1px solid var(--border, #333);
			border-radius: 12px; padding: 0; box-shadow: 0 18px 48px rgba(0,0,0,.45);
			display: flex; flex-direction: column; overflow: hidden;
		}
		.wmx .modal-head {
			flex-shrink: 0;
			padding: 12px 16px;
			border-bottom: 1px solid var(--border, #333);
			display: flex; align-items: center; justify-content: space-between; gap: 10px;
		}
		.wmx .modal-head b { font-size: 14px; }
		.wmx .modal-head .modal-close { flex-shrink: 0; width: 28px; height: 28px; padding: 0; line-height: 1; font-size: 13px; }
		.wmx .modal-body { overflow: auto; min-height: 0; padding: 12px 16px 16px; }
		.wmx .cfg fieldset {
			border: 1px solid var(--border, #333); border-radius: 8px;
			display: grid; grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr); gap: 6px 10px;
			padding: 8px 10px; align-items: center; margin: 8px 0 0;
		}
		.wmx .cfg fieldset legend { font-size: 11px; opacity: .6; padding: 0 6px; }
		.wmx .cfg label { font-size: 12px; opacity: .7; }
		.wmx .cfg .full { grid-column: 1 / -1; display: flex; gap: 6px; align-items: center; }
		.wmx form.compose input, .wmx form.compose textarea { width: 100%; box-sizing: border-box; }
		.wmx form.compose .row { display: flex; gap: 8px; justify-content: flex-end; }

		/* 手机竖屏（360~430px）：单列 + 大字号防 iOS 聚焦缩放 + 大点击区 + 底部弹层。桌面端零变化。 */
		@media (max-width: 640px) {
			.wmx input, .wmx select, .wmx textarea { font-size: 16px; }
			.wmx button { min-height: 36px; }
			/* 设置弹窗：label/input 上下排；占位空元素不占行 */
			.wmx .cfg fieldset { grid-template-columns: 1fr; }
			.wmx .cfg fieldset label:empty, .wmx .cfg fieldset span:empty { display: none; }
			/* 弹窗变底部弹层，底部留 safe-area */
			.wmx .modal-backdrop { align-items: flex-end; }
			.wmx .modal {
				width: 100%; max-height: 92vh; max-height: 92dvh;
				border-radius: 14px 14px 0 0;
			}
			.wmx .modal-body { padding-bottom: calc(16px + env(safe-area-inset-bottom)); }
		}
	</style>

	<header class="wmx-head">
		<h2>${t("viewTitle")}
			<span class="chip st">…</span>
			<span class="chip unseen badge" hidden></span>
		</h2>
		<div class="head-actions">
			<button class="btn-compose" title="${t("composeTitle")}">${t("btnCompose")}</button>
			<button class="btn-gear" title="${t("settingsTitle")}">${t("btnSettings")}</button>
			<button class="btn-refresh" title="${t("refreshListTitle")}">${t("btnRefresh")}</button>
		</div>
	</header>
	<p class="hint deps" hidden>${t("depsMissing")}
		<button class="btn-deps">${t("installNow")}</button></p>

	<div class="wmx-body">
		<section class="pane-list">
			<div class="toolbar">
				<select class="folder"><option value="INBOX">INBOX</option></select>
				<input type="search" class="q" placeholder="${t("searchPlaceholder")}" />
				<button class="btn-search">${t("search")}</button>
				<label style="opacity:.7;font-size:12px"><input type="checkbox" class="unseen-only" /> ${t("unreadOnly")}</label>
			</div>
			<ul class="maillist"></ul>
		</section>
		<section class="reader">${emptyReaderHtml()}</section>
	</div>

	<div class="modal-backdrop cfg-modal" hidden>
		<div class="modal" role="dialog" aria-label="${t("settingsTitle")}">
			<div class="modal-head"><b>⚙ ${t("settingsTitle")}</b><button class="modal-close" title="${t("close")}">✕</button></div>
			<div class="modal-body">
			<form class="cfg">
				<fieldset>
					<legend>${t("imapLegend")}</legend>
					<label>${t("server")}</label><input name="imapHost" placeholder="imap.example.com" />
					<label>${t("port")}</label><input name="imapPort" type="number" placeholder="993" />
					<label>${t("username")}</label><input name="imapUser" autocomplete="off" />
					<label>${t("passwordOrToken")}</label><input name="imapPass" type="password" autocomplete="new-password" />
					<label class="full"><input type="checkbox" name="imapTls" /> ${t("imapTls")}</label>
				</fieldset>
				<fieldset>
					<legend>${t("smtpLegend")}</legend>
					<label>${t("server")}</label><input name="smtpHost" placeholder="smtp.example.com" />
					<label>${t("port")}</label><input name="smtpPort" type="number" placeholder="465" />
					<label>${t("username")}</label><input name="smtpUser" autocomplete="off" />
					<label>${t("passwordOrToken")}</label><input name="smtpPass" type="password" autocomplete="new-password" />
					<label>${t("fromLabel")}</label><input name="smtpFrom" placeholder="Me &lt;me@example.com&gt;" />
					<label class="full"><input type="checkbox" name="smtpTls" /> ${t("smtpTls")}</label>
				</fieldset>
				<fieldset>
					<legend>${t("behaviorLegend")}</legend>
					<label>${t("pollSec")}</label><input name="pollSec" type="number" min="15" />
					<label>${t("transEngine")}</label>
					<select name="transModel">
						<option value="">${t("transEngineFast")}</option>
						<option value="current">${t("transEngineSession")}</option>
					</select>
					<label class="full"><input type="checkbox" name="notifyEnabled" /> ${t("notifyEnabled")}</label>
				</fieldset>
				<fieldset>
					<legend>${t("pluginUpdateLegend")}</legend>
					<label class="full" style="justify-content:space-between">
						<span style="opacity:.75">${t("updateHintLabel")}</span>
						<button type="button" class="btn-update">${t("updateNow")}</button>
					</label>
					<p class="hint full">${t("updateHint")}</p>
				</fieldset>
				<p class="hint">${t("credentialsHint")}</p>
				<div class="row" style="display:flex;justify-content:flex-end"><button type="submit" class="primary">${t("saveAndApply")}</button></div>
			</form>
			</div>
		</div>
	</div>

	<div class="modal-backdrop compose-modal" hidden>
		<div class="modal" role="dialog" aria-label="${t("composeTitle")}">
			<div class="modal-head"><b>✉ ${t("composeTitle")}</b><button class="modal-close" title="${t("close")}">✕</button></div>
			<div class="modal-body">
			<form class="compose">
				<input name="to" placeholder="${t("toPlaceholder")}" required />
				<input name="subject" placeholder="${t("subjectPlaceholder")}" />
				<textarea name="body" rows="8" placeholder="${t("bodyPlaceholder")}"></textarea>
				<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
					<label style="font-size:12px;opacity:.75;display:inline-flex;align-items:center;gap:5px;cursor:pointer">
						<input type="checkbox" name="isHtml" /> ${t("htmlBody")}
					</label>
					<div class="row" style="margin:0">
						<button type="button" class="btn-cancel">${t("cancel")}</button>
						<button type="submit" class="primary">${t("send")}</button>
					</div>
				</div>
			</form>
			</div>
		</div>
	</div>
</div>`;

		const root = container.querySelector(".wmx");
		const $ = (sel) => root.querySelector(sel);
		const st = { mails: [], activeUid: null, activeMail: null, availableModels: [], transModel: "" };

		function shortModelLabel(id) {
			const s = String(id ?? "");
			const slash = s.indexOf("/");
			return slash >= 0 ? s.slice(slash + 1) : s;
		}

		function getModelOptionsHtml(selectedVal) {
			const seen = new Set(["", "current"]);
			const opts = [
				{ val: "", text: t("modelFastOption") },
				{ val: "current", text: t("modelSessionOption") },
			];
			let hostModels = [];
			try {
				const hostBridge = ctx?.host || window.__piWebUiHost || window.__piPluginHost;
				hostModels = hostBridge?.models?.list?.() || [];
			} catch {}
			for (const m of [...hostModels, ...(st.availableModels || [])]) {
				const id =
					typeof m === "string"
						? m
						: m?.provider && m?.id && !String(m.id).includes("/")
							? `${m.provider}/${m.id}`
							: m?.id;
				if (id && !seen.has(id)) {
					seen.add(id);
					opts.push({ val: id, text: `🤖 ${shortModelLabel(id)}` });
				}
			}
			const presets = [
				"deepseek/deepseek-chat",
				"anthropic/claude-3-7-sonnet",
				"openai/gpt-4o",
				"openai/gpt-4o-mini",
				"google/gemini-2.5-pro",
			];
			for (const id of presets) {
				if (!seen.has(id)) {
					seen.add(id);
					opts.push({ val: id, text: `🤖 ${shortModelLabel(id)}` });
				}
			}
			if (selectedVal && !seen.has(selectedVal)) {
				opts.push({ val: selectedVal, text: `🤖 ${shortModelLabel(selectedVal)}` });
			}
			return opts
				.map(
					(o) =>
						`<option value="${esc(o.val)}" title="${esc(o.val || o.text)}"${o.val === selectedVal ? " selected" : ""}>${esc(o.text)}</option>`,
				)
				.join("");
		}

		function openModal(sel) {
			$(sel).hidden = false;
			const first = $(sel).querySelector("input, textarea");
			if (first) first.focus();
		}
		function closeModal(sel) {
			$(sel).hidden = true;
		}

		function setStateChips(state) {
			const chip = $(".st");
			// 状态文案由服务端下发（服务端自有文案，保持原样），仅兜底文案本地化
			chip.textContent = state.status || t("unknownStatus");
			chip.className = `chip st ${state.configured ? (state.status.startsWith("连接失败") ? "err" : "ok") : ""}`;
			const badge = $(".unseen");
			badge.hidden = !state.unseen;
			badge.textContent = t("unseenBadge", { count: state.unseen });
			$(".deps").hidden = state.depsOk || state.depsInstalling;
			$(".btn-deps").disabled = Boolean(state.depsInstalling);
			$(".btn-deps").textContent = state.depsInstalling ? t("installing") : t("installNow");
		}

		function fillSettings(cfg) {
			cfg = cfg?.config ?? cfg;
			if (!cfg) return;
			const f = $(".cfg");
			f.imapHost.value = cfg.imap?.host ?? "";
			f.imapPort.value = cfg.imap?.port ?? 993;
			f.imapUser.value = cfg.imap?.user ?? "";
			f.imapPass.placeholder = cfg.imap?.hasPass ? t("passSaved") : t("passPlaceholder");
			f.imapTls.checked = cfg.imap?.tls !== false;
			f.smtpHost.value = cfg.smtp?.host ?? "";
			f.smtpPort.value = cfg.smtp?.port ?? 465;
			f.smtpUser.value = cfg.smtp?.user ?? "";
			f.smtpPass.placeholder = cfg.smtp?.hasPass ? t("passSaved") : t("passPlaceholder");
			f.smtpFrom.value = cfg.smtp?.from ?? "";
			f.smtpTls.checked = cfg.smtp?.tls !== false;
			f.pollSec.value = cfg.pollSec ?? 60;
			f.notifyEnabled.checked = cfg.notifyEnabled !== false;

			const sel = f.transModel;
			if (sel) {
				const currentVal = cfg.transModel ?? "";
				st.transModel = currentVal;
				sel.innerHTML = getModelOptionsHtml(currentVal);
				sel.value = currentVal;
			}
		}

		function renderList() {
			const ul = $(".maillist");
			if (!st.mails.length) {
				ul.innerHTML = `<li class="empty" style="list-style:none;border:0;cursor:default;display:block;text-align:center;opacity:.45;padding:24px 0">${t("emptyList")}</li>`;
				return;
			}
			ul.innerHTML = st.mails
				.map(
					(m) => `
<li data-uid="${m.uid}" class="${m.seen ? "" : "unread"}${m.uid === st.activeUid ? " active" : ""}">
	<span class="from">${m.seen ? "" : '<span class="dot"></span>'}${esc(m.fromName || m.from)}</span>
	<span class="date">${esc(fmtDate(m.date))}</span>
	<span class="subj">${esc(m.subject)}</span>
</li>`,
				)
				.join("");
		}

		function getTranslateBtnLabel(mail) {
			if (mail._translating) return t("translating");
			if (mail._translation) {
				return mail._showTranslation ? t("showOriginal") : t("showTranslation");
			}
			return t("translate");
		}

		function renderReader(mail) {
			st.activeMail = mail;
			const r = $(".reader");
			const hasTrans = Boolean(mail._translation);
			const showTrans = hasTrans && mail._showTranslation !== false;
			const curModel = mail._translation?.model || st.transModel || "";

			let transHtml = "";
			if (showTrans) {
				const langLabel = mail._translation.targetLang === "en" ? t("langEnglish") : t("langChinese");
				const engineLabel =
					mail._translation.engine === "llm"
						? t("engineLlm", { model: shortModelLabel(mail._translation.model || t("aiModelFallback")) })
						: mail._translation.model
							? t("engineQuickNamed", { model: shortModelLabel(mail._translation.model) })
							: t("engineQuick");
				transHtml = `
<div class="trans-box">
	<div class="trans-head">
		<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0">
			<span>${t("transHead", { lang: esc(langLabel), engine: esc(engineLabel) })}</span>
			<select class="sel-card-model" title="${t("transHeadSwitchTitle")}" style="padding:1px 5px;font-size:11px;height:22px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--bg,#101016);color:inherit;border:1px solid color-mix(in srgb,var(--accent,#7c5cff) 40%,var(--border,#333));border-radius:4px;cursor:pointer">
				${getModelOptionsHtml(curModel)}
			</select>
		</div>
		<div style="display:flex;gap:6px;flex-shrink:0">
			<button type="button" class="act-copy-trans">${t("copyTranslation")}</button>
			<button type="button" class="act-toggle-orig">${mail._showOrig ? t("hideOriginal") : t("compareOriginal")}</button>
		</div>
	</div>
	<div class="body md trans-body">${formatMailBody(mail._translation.translatedText)}</div>
</div>`;
			}

			const hideOrigBody = showTrans && !mail._showOrig;
			const origHtml = hideOrigBody
				? ""
				: `${showTrans ? `<div style="font-size:11px;opacity:.55;margin-top:6px">${t("originalLabel")}</div>` : ""}<div class="body md">${formatMailBody(mail.text, mail.truncated)}</div>`;

			r.innerHTML = `
<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
	<b style="font-size:14px">${esc(mail.subject)}</b>
	<span style="opacity:.55;font-size:11px">${esc(fmtDate(mail.date))}</span>
</div>
${showTrans && mail._translation.translatedSubject ? `<div class="trans-subj">${esc(t("transSubjectPrefix"))}${esc(mail._translation.translatedSubject)}</div>` : ""}
<div style="opacity:.7;font-size:12px">${esc(mail.fromName)} &lt;${esc(mail.from)}&gt; → ${esc(mail.to)}
	${mail.hasAttachments ? t("attachmentsNote") : ""}</div>
${transHtml}
${origHtml}
<div class="actions">
	<button class="act-toggle-seen">${mail.seen ? t("markUnread") : t("markRead")}</button>
	<div style="display:inline-flex;align-items:center;gap:4px;min-width:0">
		<button class="act-translate"${mail._translating ? " disabled" : ""}>${getTranslateBtnLabel(mail)}</button>
		<select class="sel-reader-model" title="${t("selectModelTitle")}" style="padding:2px 6px;font-size:12px;height:28px;max-width:155px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--bg-elev,#16161d);color:inherit;border:1px solid var(--border,#333);border-radius:6px;cursor:pointer">
			${getModelOptionsHtml(curModel)}
		</select>
		<button class="act-browse-model" title="${t("pickModelTitle")}" style="padding:2px 7px;font-size:11px;height:28px;background:var(--bg-elev2);border:1px solid var(--border,#333);border-radius:6px;cursor:pointer">✨</button>
	</div>
	<button class="act-quote-chat" title="${t("quoteToChatTitle")}">${t("quoteToChat")}</button>
	<button class="act-reply">${t("reply")}</button>
	<button class="act-delete danger">${t("delete")}</button>
</div>`;
			$(".act-toggle-seen").onclick = () => ctx.send({ action: "mark", uids: [mail.uid], seen: !mail.seen });
			$(".act-delete").onclick = () => ctx.send({ action: "delete", uids: [mail.uid] });
			$(".act-reply").onclick = () => openCompose({ to: mail.from, subject: `Re: ${mail.subject}` });

			const quoteBtn = $(".act-quote-chat");
			if (quoteBtn) {
				quoteBtn.onclick = () => {
					const rawContent =
						showTrans && mail._translation?.translatedText ? mail._translation.translatedText : mail.text;
					const cleanBody = cleanMailPlainText(rawContent)
						.replace(/\[https?:\/\/[^\s\]]+\.(?:png|jpe?g|gif|svg|webp|ico)(?:\?[^\s\]]*)?\]/gi, "")
						.replace(/\[(https?:\/\/[^\s\]]+)\]/gi, (_, u) => `[${shortDomain(u)}](${u})`)
						.trim();
					const subjLine =
						showTrans && mail._translation?.translatedSubject && mail._translation.translatedSubject !== mail.subject
							? t("quoteTranslatedSubject", {
									subject: mail.subject,
									translated: mail._translation.translatedSubject,
								})
							: mail.subject;
					const fromStr = mail.fromName ? `${mail.fromName} <${mail.from}>` : mail.from;
					const quoteText = [
						t("quoteSubject", { uid: mail.uid, subject: subjLine }),
						t("quoteFrom", { from: fromStr, when: mail.date ? ` · ${fmtDate(mail.date)}` : "" }),
						"",
						cleanBody,
					].join("\n");

					const hostBridge = ctx?.host || window.__piWebUiHost;
					if (hostBridge?.compose) {
						hostBridge.compose({
							attachments: [
								{
									path: "",
									name: `📬 ${mail.subject}`,
									mode: "quote",
									quote: {
										text: quoteText,
										messageId: `📬 #${mail.uid} ${mail.subject}`,
										role: "attachment",
									},
									key: `mail-quote-${mail.uid}`,
								},
							],
						});
						hostBridge.setView?.("chat");
					} else {
						navigator.clipboard?.writeText?.(quoteText);
						quoteBtn.textContent = t("quoteCopied");
						setTimeout(() => {
							if (quoteBtn) quoteBtn.textContent = t("quoteToChat");
						}, 1500);
					}
				};
			}

			const triggerTranslate = (modelToUse) => {
				mail._translating = true;
				renderReader(mail);
				ctx.send({
					action: "translate",
					uid: mail.uid,
					subject: mail.subject,
					text: mail.text,
					model: modelToUse !== undefined ? modelToUse : st.transModel,
				});
			};

			const transBtn = $(".act-translate");
			if (transBtn) {
				transBtn.onclick = () => {
					if (mail._translating) return;
					if (mail._translation) {
						mail._showTranslation = !mail._showTranslation;
						renderReader(mail);
						return;
					}
					triggerTranslate(st.transModel);
				};
			}

			const readerModelSel = $(".sel-reader-model");
			if (readerModelSel) {
				readerModelSel.onchange = (e) => {
					const chosen = e.target.value;
					st.transModel = chosen;
					if (mail._translation) {
						triggerTranslate(chosen);
					}
				};
			}

			const browseModelBtn = $(".act-browse-model");
			if (browseModelBtn) {
				browseModelBtn.onclick = async () => {
					const host = globalThis.window?.__piWebUiHost;
					if (typeof host?.pickModel !== "function") return;
					const res = await host.pickModel({
						currentModelId: st.transModel === "current" ? undefined : st.transModel,
					});
					if (res?.ok && res.modelId) {
						st.transModel = res.modelId;
						renderReader(mail);
						if (mail._translation) {
							triggerTranslate(res.modelId);
						}
					}
				};
			}

			const cardModelSel = $(".sel-card-model");
			if (cardModelSel) {
				cardModelSel.onchange = (e) => {
					const chosen = e.target.value;
					st.transModel = chosen;
					triggerTranslate(chosen);
				};
			}

			const copyBtn = $(".act-copy-trans");
			if (copyBtn) {
				copyBtn.onclick = async () => {
					try {
						await navigator.clipboard.writeText(mail._translation.translatedText || "");
						copyBtn.textContent = t("copied");
						setTimeout(() => {
							if (copyBtn) copyBtn.textContent = t("copyTranslation");
						}, 1500);
					} catch {}
				};
			}

			const toggleOrigBtn = $(".act-toggle-orig");
			if (toggleOrigBtn) {
				toggleOrigBtn.onclick = () => {
					mail._showOrig = !mail._showOrig;
					renderReader(mail);
				};
			}

			if (window.matchMedia("(max-width: 640px)").matches) r.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}

		function clearReader() {
			st.activeUid = null;
			st.activeMail = null;
			$(".reader").innerHTML = emptyReaderHtml();
		}

		function openCompose(prefill = {}) {
			const f = $("form.compose");
			f.to.value = prefill.to ?? "";
			f.subject.value = prefill.subject ?? "";
			openModal(".compose-modal");
			(prefill.to ? f.body : f.to).focus();
		}

		async function refreshList() {
			ctx.send({
				action: "list",
				folder: $(".folder").value,
				unseenOnly: $(".unseen-only").checked,
			});
		}

		root.addEventListener("click", async (e) => {
			const li = e.target.closest("ul.maillist li[data-uid]");
			if (li) {
				st.activeUid = Number(li.dataset.uid);
				renderList();
				ctx.send({ action: "read", folder: $(".folder").value, uid: st.activeUid });
				return;
			}
			if (e.target.closest(".btn-refresh")) refreshList();
			if (e.target.closest(".btn-compose")) openCompose();
			if (e.target.closest(".btn-gear")) {
				ctx.send({ action: "get_state" });
				openModal(".cfg-modal");
			}
			if (e.target.closest(".btn-update")) {
				window.dispatchEvent(
					new CustomEvent("pi-web-ui:plugin-run-command", {
						detail: {
							title: t("updateTerminalTitle"),
							command: "pi-web-ui install xing-shuyin/pi-web-ui/tree/main/plugins/webmail --force",
						},
					}),
				);
				closeModal(".cfg-modal");
			}
			if (e.target.closest(".btn-deps")) ctx.send({ action: "install_deps" });
			if (e.target.closest(".btn-search")) {
				const q = $(".q").value.trim();
				if (q) ctx.send({ action: "search", query: q, folder: $(".folder").value });
				else refreshList();
			}
			for (const sel of [".cfg-modal", ".compose-modal"]) {
				const backdrop = $(sel);
				if (e.target === backdrop || e.target.closest(".modal-close")) closeModal(sel);
			}
		});
		root.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				closeModal(".compose-modal");
				closeModal(".cfg-modal");
			}
			if (e.key === "Enter" && e.target.classList.contains("q")) $(".btn-search").click();
		});
		$(".unseen-only").addEventListener("change", refreshList);

		$(".cfg").addEventListener("submit", (e) => {
			e.preventDefault();
			const f = e.target;
			const cfg = {
				imap: {
					host: f.imapHost.value.trim(),
					port: Number(f.imapPort.value) || 993,
					tls: f.imapTls.checked,
					user: f.imapUser.value.trim(),
					pass: f.imapPass.value || undefined,
				},
				smtp: {
					host: f.smtpHost.value.trim(),
					port: Number(f.smtpPort.value) || 465,
					tls: f.smtpTls.checked,
					user: f.smtpUser.value.trim(),
					pass: f.smtpPass.value || undefined,
					from: f.smtpFrom.value.trim(),
				},
				pollSec: Math.max(15, Number(f.pollSec.value) || 60),
				notifyEnabled: f.notifyEnabled.checked,
				transModel: f.transModel?.value ?? "",
			};
			for (const box of ["imap", "smtp"]) {
				for (const k of Object.keys(cfg[box])) {
					if (cfg[box][k] === undefined) delete cfg[box][k];
				}
			}
			ctx.send({ action: "save_config", config: cfg });
			closeModal(".cfg-modal");
		});

		$("form.compose").addEventListener("submit", (e) => {
			e.preventDefault();
			const f = e.target;
			const isHtml = f.isHtml?.checked;
			ctx.send({
				action: "send",
				to: f.to.value.trim(),
				subject: f.subject.value,
				body: isHtml ? undefined : f.body.value,
				html: isHtml ? f.body.value : undefined,
			});
			f.reset();
			closeModal(".compose-modal");
		});
		$("form.compose .btn-cancel").addEventListener("click", () => {
			$("form.compose").reset();
			closeModal(".compose-modal");
		});

		const off = ctx.onData((payload) => {
			const msg = payload ?? {};
			switch (msg.kind) {
				case "state":
					if (Array.isArray(msg.state?.models)) st.availableModels = msg.state.models;
					setStateChips(msg.state);
					fillSettings(msg.state ?? msg.config);
					break;
				case "mails":
					st.mails = msg.mails ?? [];
					renderList();
					break;
				case "mail":
					st.activeMail = msg.mail;
					renderReader(msg.mail);
					break;
				case "translated": {
					if (st.activeMail && st.activeMail.uid === msg.uid) {
						st.activeMail._translating = false;
						if (msg.ok) {
							st.activeMail._translation = {
								translatedSubject: msg.translatedSubject,
								translatedText: msg.translatedText,
								targetLang: msg.targetLang,
							};
							st.activeMail._showTranslation = true;
						}
						renderReader(st.activeMail);
					}
					break;
				}
				case "new-mail":
					refreshList();
					break;
				case "result":
					if (msg.action === "mark") renderList();
					if (msg.action === "delete") {
						clearReader();
						refreshList();
					}
					break;
			}
		});

		ctx.send({ action: "get_state" });
		refreshList();

		return () => {
			off();
			root.remove();
		};
	},
};
