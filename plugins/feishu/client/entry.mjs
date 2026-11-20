import { createPluginI18n, esc as escapeHtml } from "@pi-web-ui/plugin-sdk/client";
import { DICT } from "./i18n.mjs";

/** 面板文案：语言解析 / 回退 / 插值都在 SDK 里，这里只按当前界面语言取词。禁自建语言偏好，只跟宿主全局语言。 */
const i18n = createPluginI18n(DICT);
const t = (key, params) => i18n.t(key, params);

/** 语言切换时就地重渲染静态文案（输入值与监听保留），动态列表由 refreshAll() 重画。 */
function applyStaticTexts(root) {
	const scope = root ?? document;
	scope.querySelectorAll("[data-i18n]").forEach((n) => {
		const k = n.getAttribute("data-i18n");
		if (k) n.textContent = t(k);
	});
	scope.querySelectorAll("[data-i18n-ph]").forEach((n) => {
		const k = n.getAttribute("data-i18n-ph");
		if (k) n.setAttribute("placeholder", t(k));
	});
	scope.querySelectorAll("[data-i18n-title]").forEach((n) => {
		const k = n.getAttribute("data-i18n-title");
		if (k) n.setAttribute("title", t(k));
	});
}

function activate(ctx) {
	ctx.ui?.registerView?.({
		id: "feishu",
		label: t("appName"),
		icon: "🐦",
		render(container) {
			renderFeishuWorkbench(container, ctx);
		},
	});
}

activate.mount = function mount(el, ctx) {
	const off = renderFeishuWorkbench(el, ctx);
	return () => {
		try {
			if (typeof off === "function") off();
		} catch {}
		try {
			if (el) el.innerHTML = "";
		} catch {}
	};
};

export default activate;

function formatDate(isoStr) {
	if (!isoStr) return "";
	try {
		const d = new Date(isoStr);
		const now = new Date();
		const isToday = d.toDateString() === now.toDateString();
		const hours = String(d.getHours()).padStart(2, "0");
		const minutes = String(d.getMinutes()).padStart(2, "0");
		if (isToday) return `${hours}:${minutes}`;
		const month = String(d.getMonth() + 1).padStart(2, "0");
		const day = String(d.getDate()).padStart(2, "0");
		return `${month}-${day} ${hours}:${minutes}`;
	} catch {
		return isoStr;
	}
}

function renderFeishuWorkbench(container, ctx) {
	// 首帧：显式读取宿主全局语言（SDK 内部同样以 locale.current() 为单源）
	try {
		globalThis.window?.__piWebUiHost?.locale?.current?.();
	} catch {}
	container.innerHTML = `
		<div class="feishu-root" style="display: flex; flex-direction: column; height: 100%; width: 100%; background: var(--bg); color: var(--text); font-size: 13px; overflow: hidden; box-sizing: border-box;">
			<!-- Topbar -->
			<div class="feishu-topbar" style="display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--bg-elev); flex-shrink: 0; gap: 12px; flex-wrap: wrap;">
				<div style="display: flex; align-items: center; gap: 10px;">
					<span style="font-size: 18px;">🐦</span>
					<span style="font-weight: 600; font-size: 14px;" data-i18n="workbench">${t("workbench")}</span>
					<span class="feishu-status-badge" style="font-size: 11px; padding: 2px 8px; border-radius: 12px; background: var(--bg-elev2); color: var(--text-dim); border: 1px solid var(--border);" data-i18n="statusChecking">${t("statusChecking")}</span>
				</div>
				<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
					<input type="text" class="feishu-search-input" data-i18n-ph="searchPlaceholder" placeholder="${t("searchPlaceholder")}" style="padding: 5px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; width: 180px; outline: none;" />
					<button class="feishu-btn feishu-btn-search" style="padding: 5px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;" data-i18n="search">${t("search")}</button>
					<button class="feishu-btn feishu-btn-compose" style="padding: 5px 12px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-size: 12px; font-weight: 500;" data-i18n="newCompose">${t("newCompose")}</button>
					<button class="feishu-btn feishu-btn-refresh" style="padding: 5px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;" data-i18n-title="refreshTitle" title="${t("refreshTitle")}">${t("refresh")}</button>
					<button class="feishu-btn feishu-btn-settings" style="padding: 5px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;" data-i18n-title="settingsTitle" title="${t("settingsTitle")}">${t("settings")}</button>
				</div>
			</div>

			<!-- Main 3-Column Body -->
			<div class="feishu-body" style="display: flex; flex: 1; min-height: 0; width: 100%;">
				<!-- Left Column: Chats & Channels -->
				<div class="feishu-col-chats" style="width: 220px; border-right: 1px solid var(--border); background: var(--bg-elev); display: flex; flex-direction: column; flex-shrink: 0;">
					<div style="padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 11px; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; display: flex; justify-content: space-between; align-items: center;">
						<span data-i18n="chatsSection">${t("chatsSection")}</span>
						<button class="feishu-btn-add-chat" style="padding: 2px 6px; font-size: 11px; border-radius: 3px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;" data-i18n-title="addChatTitle" title="${t("addChatTitle")}">+</button>
					</div>
					<div class="feishu-chats-list" style="flex: 1; overflow-y: auto; padding: 6px;">
						<div style="padding: 12px; text-align: center; color: var(--text-dim);" data-i18n="loadingChats">${t("loadingChats")}</div>
					</div>
				</div>

				<!-- Middle Column: Messages Stream -->
				<div class="feishu-col-messages" style="width: 320px; border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; background: var(--bg);">
					<div class="feishu-msgs-header" style="padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
						<span class="feishu-current-chat-title" data-i18n="messagesList">${t("messagesList")}</span>
						<span class="feishu-msgs-count" style="font-size: 11px; color: var(--text-dim);">${t("msgCount", { n: 0 })}</span>
					</div>
					<div class="feishu-messages-list" style="flex: 1; overflow-y: auto; padding: 6px;">
						<div style="padding: 20px; text-align: center; color: var(--text-dim);" data-i18n="selectChatPrompt">${t("selectChatPrompt")}</div>
					</div>
				</div>

				<!-- Right Column: Message Reader & Actions -->
				<div class="feishu-col-reader" style="flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--bg); overflow-y: auto;">
					<div class="feishu-reader-placeholder" style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-dim); padding: 40px; text-align: center;">
						<span style="font-size: 32px; margin-bottom: 12px;">🐦</span>
						<div style="font-weight: 500; font-size: 15px; margin-bottom: 6px;" data-i18n="readerTitle">${t("readerTitle")}</div>
						<div style="font-size: 12px; max-width: 380px; line-height: 1.6;">
							${t("readerHint")}
						</div>
					</div>
					<div class="feishu-reader-content" style="display: none; flex-direction: column; height: 100%;">
						<!-- Reader Header -->
						<div style="padding: 16px; border-bottom: 1px solid var(--border); background: var(--bg-elev); flex-shrink: 0;">
							<div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 8px;">
								<div class="feishu-reader-subject" style="font-size: 16px; font-weight: 600; line-height: 1.4; word-break: break-word;"></div>
								<span class="feishu-reader-type-tag" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--bg-elev2); color: var(--text-dim); flex-shrink: 0;"></span>
							</div>
							<div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 12px; color: var(--text-dim); margin-bottom: 12px;">
								<div>${t("senderLabel")} <b class="feishu-reader-sender" style="color: var(--text);"></b></div>
								<div>${t("timeLabel")} <span class="feishu-reader-date"></span></div>
								<div>ID: <code class="feishu-reader-msgid" style="font-size: 11px; background: var(--bg-elev2); padding: 1px 4px; border-radius: 3px; cursor: pointer;" data-i18n-title="copyMsgIdTitle" title="${t("copyMsgIdTitle")}"></code></div>
							</div>
							<!-- Actions Toolbar -->
							<div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
								<button class="feishu-btn feishu-btn-reply" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;" data-i18n="reply">${t("reply")}</button>
								<button class="feishu-btn feishu-btn-reply-thread" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;" data-i18n="replyThread">${t("replyThread")}</button>
								<button class="feishu-btn feishu-btn-quote" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;" data-i18n-title="quoteTitle" title="${t("quoteTitle")}">${t("quote")}</button>
								<div style="display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border); border-radius: 4px; padding: 2px 6px; background: var(--bg-elev2);">
									<button class="feishu-btn feishu-btn-translate" style="background: none; border: none; color: var(--text); cursor: pointer; font-size: 12px; padding: 0;" data-i18n="translate">${t("translate")}</button>
									<select class="feishu-translate-model" style="background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 3px; font-size: 11px; padding: 1px 4px; outline: none;">
										<option value="" data-i18n="followDefault">${t("followDefault")}</option>
									</select>
								</div>
								<!-- Reaction bar -->
								<div class="feishu-reaction-bar" style="display: inline-flex; gap: 2px; align-items: center; border: 1px solid var(--border); border-radius: 4px; padding: 2px 4px; background: var(--bg-elev2);">
									<button class="feishu-react-btn" data-emoji="THUMBSUP" style="border: none; background: none; cursor: pointer; font-size: 14px;" data-i18n-title="reactLike" title="${t("reactLike")}">👍</button>
									<button class="feishu-react-btn" data-emoji="OK" style="border: none; background: none; cursor: pointer; font-size: 14px;" data-i18n-title="reactOk" title="${t("reactOk")}">👌</button>
									<button class="feishu-react-btn" data-emoji="HEART" style="border: none; background: none; cursor: pointer; font-size: 14px;" data-i18n-title="reactHeart" title="${t("reactHeart")}">❤️</button>
									<button class="feishu-react-btn" data-emoji="APPLAUSE" style="border: none; background: none; cursor: pointer; font-size: 14px;" data-i18n-title="reactApplause" title="${t("reactApplause")}">👏</button>
									<button class="feishu-react-btn" data-emoji="DONE" style="border: none; background: none; cursor: pointer; font-size: 14px;" data-i18n-title="reactDone" title="${t("reactDone")}">✅</button>
									<button class="feishu-react-btn" data-emoji="FIRE" style="border: none; background: none; cursor: pointer; font-size: 14px;" data-i18n-title="reactFire" title="${t("reactFire")}">🔥</button>
								</div>
								<button class="feishu-btn feishu-btn-recall" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--red, #f87171); background: transparent; color: var(--red, #f87171); cursor: pointer; font-size: 12px; margin-left: auto;" data-i18n-title="recallTitle" title="${t("recallTitle")}">${t("recall")}</button>
							</div>
						</div>

						<!-- Translation Banner (Conditional) -->
						<div class="feishu-translation-banner" style="display: none; padding: 12px 16px; background: var(--bg-elev2); border-bottom: 1px solid var(--border);">
							<div style="font-size: 11px; font-weight: 600; color: var(--accent); margin-bottom: 4px; display: flex; justify-content: space-between;">
								<span data-i18n="translationResult">${t("translationResult")}</span>
								<button class="feishu-btn-hide-trans" style="border: none; background: none; color: var(--text-dim); cursor: pointer; font-size: 11px;" data-i18n="hide">${t("hide")}</button>
							</div>
							<div class="feishu-translation-text" style="font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;"></div>
						</div>

						<!-- Message Body -->
						<div class="feishu-reader-body" style="flex: 1; padding: 20px; overflow-y: auto; line-height: 1.6; font-size: 13px; white-space: pre-wrap; word-break: break-word;"></div>

						<!-- Raw JSON Inspector (collapsible) -->
						<details class="feishu-raw-details" style="padding: 10px 16px; border-top: 1px solid var(--border); font-size: 11px; color: var(--text-dim); background: var(--bg-elev);">
							<summary style="cursor: pointer; user-select: none;" data-i18n="rawDetails">${t("rawDetails")}</summary>
							<pre class="feishu-raw-pre" style="margin-top: 8px; padding: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; overflow-x: auto; font-family: var(--mono, monospace); font-size: 11px; max-height: 200px;"></pre>
						</details>
					</div>
				</div>
			</div>

			<!-- Compose / Reply Modal -->
			<div class="feishu-compose-modal" style="display: none; position: absolute; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; align-items: center; justify-content: center;">
				<div style="width: 520px; max-width: 90%; max-height: 90%; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
					<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 14px; display: flex; justify-content: space-between; align-items: center;">
						<span class="feishu-compose-title" data-i18n="composeModalTitle">${t("composeModalTitle")}</span>
						<button class="feishu-compose-close" style="border: none; background: none; color: var(--text-dim); cursor: pointer; font-size: 16px;">×</button>
					</div>
					<div style="padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; font-size: 12px;">
						<div>
							<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="targetLabel">${t("targetLabel")}</label>
							<input type="text" class="feishu-input-target" data-i18n-ph="targetPlaceholder" placeholder="${t("targetPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
						</div>
						<div style="display: flex; gap: 12px;">
							<div style="flex: 1;">
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="msgTypeLabel">${t("msgTypeLabel")}</label>
								<select class="feishu-select-msgtype" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
									<option value="text" data-i18n="msgTypeText">${t("msgTypeText")}</option>
									<option value="post" data-i18n="msgTypePost">${t("msgTypePost")}</option>
									<option value="interactive" data-i18n="msgTypeInteractive">${t("msgTypeInteractive")}</option>
								</select>
							</div>
							<div class="feishu-wrap-template" style="flex: 1; display: none;">
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="cardThemeLabel">${t("cardThemeLabel")}</label>
								<select class="feishu-select-template" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
									<option value="blue" data-i18n="cardColorBlue">${t("cardColorBlue")}</option>
									<option value="wathet" data-i18n="cardColorWathet">${t("cardColorWathet")}</option>
									<option value="turquoise" data-i18n="cardColorTurquoise">${t("cardColorTurquoise")}</option>
									<option value="green" data-i18n="cardColorGreen">${t("cardColorGreen")}</option>
									<option value="yellow" data-i18n="cardColorYellow">${t("cardColorYellow")}</option>
									<option value="orange" data-i18n="cardColorOrange">${t("cardColorOrange")}</option>
									<option value="red" data-i18n="cardColorRed">${t("cardColorRed")}</option>
									<option value="violet" data-i18n="cardColorViolet">${t("cardColorViolet")}</option>
									<option value="purple" data-i18n="cardColorPurple">${t("cardColorPurple")}</option>
									<option value="grey" data-i18n="cardColorGrey">${t("cardColorGrey")}</option>
								</select>
							</div>
						</div>
						<div class="feishu-wrap-title" style="display: none;">
							<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="titleOptional">${t("titleOptional")}</label>
							<input type="text" class="feishu-input-title" data-i18n-ph="titlePlaceholder" placeholder="${t("titlePlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
						</div>
						<div>
							<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="contentLabel">${t("contentLabel")}</label>
							<textarea class="feishu-input-content" rows="6" data-i18n-ph="contentPlaceholder" placeholder="${t("contentPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); resize: vertical; font-family: inherit; font-size: 12px;"></textarea>
						</div>
					</div>
					<div style="padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px;">
						<button class="feishu-compose-cancel" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;" data-i18n="cancel">${t("cancel")}</button>
						<button class="feishu-compose-submit" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;" data-i18n="send">${t("send")}</button>
					</div>
				</div>
			</div>

			<!-- Settings Modal -->
			<div class="feishu-settings-modal" style="display: none; position: absolute; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; align-items: center; justify-content: center;">
				<div style="width: 540px; max-width: 90%; max-height: 90%; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
					<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 14px; display: flex; justify-content: space-between; align-items: center;">
						<span data-i18n="settingsModalTitle">${t("settingsModalTitle")}</span>
						<button class="feishu-settings-close" style="border: none; background: none; color: var(--text-dim); cursor: pointer; font-size: 16px;">×</button>
					</div>
					<div style="padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; font-size: 12px;">
						<div>
							<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="presetLabel">${t("presetLabel")}</label>
							<select class="feishu-cfg-preset" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
								<option value="feishu" data-i18n="presetFeishu">${t("presetFeishu")}</option>
								<option value="lark" data-i18n="presetLark">${t("presetLark")}</option>
								<option value="webhook" data-i18n="presetWebhook">${t("presetWebhook")}</option>
								<option value="custom" data-i18n="presetCustom">${t("presetCustom")}</option>
							</select>
							<div class="feishu-cfg-hint" style="margin-top: 4px; font-size: 11px; color: var(--text-dim); line-height: 1.4;"></div>
						</div>
						<div class="feishu-cfg-wrap-baseurl" style="display: none;">
							<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="baseUrlLabel">${t("baseUrlLabel")}</label>
							<input type="text" class="feishu-cfg-baseurl" placeholder="https://open.feishu.cn" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
						</div>
						<div class="feishu-cfg-app-section" style="border-top: 1px solid var(--border); padding-top: 12px;">
							<div style="font-weight: 600; margin-bottom: 8px;" data-i18n="appCredSection">${t("appCredSection")}</div>
							<div style="display: flex; gap: 10px; margin-bottom: 8px;">
								<div style="flex: 1;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="appIdLabel">${t("appIdLabel")}</label>
									<input type="text" class="feishu-cfg-appid" placeholder="cli_a1b2c3d4e5" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div style="flex: 1;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="appSecretLabel">${t("appSecretLabel")}</label>
									<input type="password" class="feishu-cfg-appsecret" data-i18n-ph="keepBlank" placeholder="${t("keepBlank")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>
							<div style="display: flex; gap: 10px;">
								<div style="flex: 1;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="defaultChatLabel">${t("defaultChatLabel")}</label>
									<input type="text" class="feishu-cfg-default-chat" data-i18n-ph="defaultChatPlaceholder" placeholder="${t("defaultChatPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div style="flex: 1;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="pollSecLabel">${t("pollSecLabel")}</label>
									<input type="number" class="feishu-cfg-pollsec" placeholder="60" min="15" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>
						</div>
						<div class="feishu-cfg-bot-section" style="border-top: 1px solid var(--border); padding-top: 12px;">
							<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
								<div style="font-weight: 600;" data-i18n="botSection">${t("botSection")}</div>
								<span class="feishu-bot-status-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);" data-i18n="botNotStarted">${t("botNotStarted")}</span>
							</div>
							<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
								<input type="checkbox" id="feishu-cfg-bot-enabled" class="feishu-cfg-bot-enabled" style="cursor: pointer;" />
								<label for="feishu-cfg-bot-enabled" style="font-size: 12px; cursor: pointer; user-select: none;" data-i18n="botEnableLabel">${t("botEnableLabel")}</label>
							</div>
							<div style="display: flex; gap: 10px; margin-bottom: 8px;">
								<div style="flex: 1;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="groupModeLabel">${t("groupModeLabel")}</label>
									<select class="feishu-cfg-group-mode" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
										<option value="mention" data-i18n="groupModeMention">${t("groupModeMention")}</option>
										<option value="none" data-i18n="groupModeNone">${t("groupModeNone")}</option>
										<option value="all" data-i18n="groupModeAll">${t("groupModeAll")}</option>
									</select>
								</div>
								<div style="flex: 1;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="allowedSendersLabel">${t("allowedSendersLabel")}</label>
									<input type="text" class="feishu-cfg-allowed-senders" data-i18n-ph="allowedSendersPlaceholder" placeholder="${t("allowedSendersPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>
							<div style="margin-bottom: 8px;">
								<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
									<label style="color: var(--text-dim);" data-i18n="workspaceLabel">${t("workspaceLabel")}</label>
								</div>
								<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
									<input type="text" class="feishu-cfg-workspace" data-i18n-ph="workspacePlaceholder" placeholder="${t("workspacePlaceholder")}" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
									<select class="feishu-cfg-ws-select" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
										<option value="" data-i18n="quickPickProject">${t("quickPickProject")}</option>
									</select>
									<button type="button" class="feishu-cfg-ws-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;" data-i18n="browse">${t("browse")}</button>
									<button type="button" class="feishu-cfg-use-cwd" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;" data-i18n="useCurrentProject">${t("useCurrentProject")}</button>
								</div>
							</div>
							<div style="margin-bottom: 8px;">
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="modelLabel">${t("modelLabel")}</label>
								<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
									<input type="text" class="feishu-cfg-model" data-i18n-ph="modelPlaceholder" placeholder="${t("modelPlaceholder")}" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
									<button type="button" class="feishu-cfg-model-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;" data-i18n="pickModel">${t("pickModel")}</button>
									<select class="feishu-cfg-thinking" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
										<option value="" data-i18n="thinkingFollow">${t("thinkingFollow")}</option>
										<option value="off" data-i18n="thinkingOff">${t("thinkingOff")}</option>
										<option value="low" data-i18n="thinkingLow">${t("thinkingLow")}</option>
										<option value="medium" data-i18n="thinkingMedium">${t("thinkingMedium")}</option>
										<option value="high" data-i18n="thinkingHigh">${t("thinkingHigh")}</option>
										<option value="max" data-i18n="thinkingMax">${t("thinkingMax")}</option>
									</select>
								</div>
							</div>
							<div class="feishu-bot-metrics" style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">${t("botMetrics", { received: 0, replied: 0 })}</div>
						</div>
						<div class="feishu-cfg-webhook-section" style="border-top: 1px solid var(--border); padding-top: 12px;">
							<div style="font-weight: 600; margin-bottom: 8px;" data-i18n="webhookSection">${t("webhookSection")}</div>
							<div style="margin-bottom: 8px;">
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="webhookUrlLabel">${t("webhookUrlLabel")}</label>
								<input type="text" class="feishu-cfg-webhook-url" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxxx" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="webhookSecretLabel">${t("webhookSecretLabel")}</label>
								<input type="password" class="feishu-cfg-webhook-secret" data-i18n-ph="keepBlank" placeholder="${t("keepBlank")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
						</div>
					</div>
					<div style="padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev2);">
						<button class="feishu-settings-test" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;" data-i18n="testConnection">${t("testConnection")}</button>
						<div style="display: flex; gap: 8px;">
							<button class="feishu-settings-cancel" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;" data-i18n="cancel">${t("cancel")}</button>
							<button class="feishu-settings-save" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;" data-i18n="saveConfig">${t("saveConfig")}</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	`;

	let state = {
		config: {},
		presets: {},
		chats: [],
		activeChatId: "",
		messages: [],
		activeMessage: null,
		models: [],
	};

	const q = (sel) => container.querySelector(sel);
	const statusBadge = q(".feishu-status-badge");
	const chatsListEl = q(".feishu-chats-list");
	const messagesListEl = q(".feishu-messages-list");
	const msgsHeaderTitle = q(".feishu-current-chat-title");
	const msgsCountEl = q(".feishu-msgs-count");

	const readerPlaceholder = q(".feishu-reader-placeholder");
	const readerContent = q(".feishu-reader-content");
	const readerSubject = q(".feishu-reader-subject");
	const readerTypeTag = q(".feishu-reader-type-tag");
	const readerSender = q(".feishu-reader-sender");
	const readerDate = q(".feishu-reader-date");
	const readerMsgId = q(".feishu-reader-msgid");
	const readerBody = q(".feishu-reader-body");
	const rawPre = q(".feishu-raw-pre");

	const transBanner = q(".feishu-translation-banner");
	const transText = q(".feishu-translation-text");
	const transModelSelect = q(".feishu-translate-model");

	const composeModal = q(".feishu-compose-modal");
	const composeTitle = q(".feishu-compose-title");
	const inputTarget = q(".feishu-input-target");
	const selectMsgType = q(".feishu-select-msgtype");
	const selectTemplate = q(".feishu-select-template");
	const wrapTemplate = q(".feishu-wrap-template");
	const wrapTitle = q(".feishu-wrap-title");
	const inputTitle = q(".feishu-input-title");
	const inputContent = q(".feishu-input-content");

	const settingsModal = q(".feishu-settings-modal");
	const cfgPreset = q(".feishu-cfg-preset");
	const cfgHint = q(".feishu-cfg-hint");
	const cfgWrapBaseUrl = q(".feishu-cfg-wrap-baseurl");
	const cfgBaseUrl = q(".feishu-cfg-baseurl");
	const cfgAppId = q(".feishu-cfg-appid");
	const cfgAppSecret = q(".feishu-cfg-appsecret");
	const cfgDefaultChat = q(".feishu-cfg-default-chat");
	const cfgPollSec = q(".feishu-cfg-pollsec");
	const cfgBotEnabled = q(".feishu-cfg-bot-enabled");
	const cfgGroupMode = q(".feishu-cfg-group-mode");
	const cfgAllowedSenders = q(".feishu-cfg-allowed-senders");
	const cfgWorkspace = q(".feishu-cfg-workspace");
	const cfgWsSelect = q(".feishu-cfg-ws-select");
	const cfgWsBrowse = q(".feishu-cfg-ws-browse");
	const cfgModel = q(".feishu-cfg-model");
	const cfgModelBrowse = q(".feishu-cfg-model-browse");
	const cfgThinking = q(".feishu-cfg-thinking");
	const botStatusBadge = q(".feishu-bot-status-badge");
	const botMetrics = q(".feishu-bot-metrics");
	const cfgWebhookUrl = q(".feishu-cfg-webhook-url");
	const cfgWebhookSecret = q(".feishu-cfg-webhook-secret");

	let composeMode = { type: "new", replyId: "", replyInThread: false };

	if (ctx.host?.listModels) {
		ctx.host
			.listModels()
			.then((models) => {
				if (Array.isArray(models)) {
					state.models = models;
					for (const m of models) {
						const id = typeof m === "string" ? m : m.id || m.name;
						const opt = document.createElement ? null : null;
						transModelSelect.insertAdjacentHTML(
							"beforeend",
							`<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`,
						);
					}
				}
			})
			.catch(() => {});
	}

	let ridSeq = 0;
	const pendingReplies = new Map();
	if (typeof ctx.onData === "function") {
		ctx.onData((payload) => {
			const rid = payload && payload.__rid;
			if (rid) {
				const waiter = pendingReplies.get(rid);
				if (!waiter) return;
				pendingReplies.delete(rid);
				clearTimeout(waiter.timer);
				waiter.resolve(payload);
				return;
			}
		});
	}

	function sendHost(type, payload = {}) {
		if (typeof ctx.send === "function") {
			const rid = `fs-${++ridSeq}`;
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					pendingReplies.delete(rid);
					resolve({ success: false, message: t("hostTimeout") });
				}, 60000);
				pendingReplies.set(rid, { resolve, timer });
				try {
					ctx.send({ ...payload, type, __rid: rid });
				} catch (err) {
					pendingReplies.delete(rid);
					clearTimeout(timer);
					resolve({ success: false, message: String(err?.message || err) });
				}
			});
		}
		return new Promise((resolve) => {
			ctx.postMessage?.({ type, ...payload }, (res) => {
				resolve(res);
			});
		});
	}

	function updateStatusBadge(status) {
		if (!statusBadge) return;
		if (status.status === "unconfigured") {
			statusBadge.textContent = t("statusUnconfigured");
			statusBadge.style.color = "var(--text-dim)";
			statusBadge.style.borderColor = "var(--border)";
		} else if (status.status === "webhook") {
			statusBadge.textContent = t("statusWebhook");
			statusBadge.style.color = "var(--accent)";
			statusBadge.style.borderColor = "var(--accent)";
		} else if (status.status === "ok") {
			statusBadge.textContent = status.unread > 0 ? t("unreadCount", { n: status.unread }) : t("statusConnected");
			statusBadge.style.color = status.unread > 0 ? "var(--accent)" : "var(--green, #4ade80)";
			statusBadge.style.borderColor = status.unread > 0 ? "var(--accent)" : "var(--green, #4ade80)";
		} else {
			statusBadge.textContent = t("statusAbnormal");
			statusBadge.style.color = "var(--red, #f87171)";
			statusBadge.style.borderColor = "var(--red, #f87171)";
		}
	}

	function renderChats() {
		if (!chatsListEl) return;
		if (!state.chats.length) {
			chatsListEl.innerHTML = `<div style="padding: 16px; text-align: center; color: var(--text-dim); font-size: 12px;" data-i18n="noChats">${t("noChats")}</div>`;
			return;
		}

		chatsListEl.innerHTML = state.chats
			.map((c) => {
				const isSelected = c.id === state.activeChatId;
				let icon = "👥";
				if (c.isWebhook) icon = "📢";
				else if (c.chatMode === "p2p") icon = "👤";
				else if (c.isCustom) icon = "📌";

				return `
					<div class="feishu-chat-item" data-id="${escapeHtml(c.id)}" style="display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 4px; cursor: pointer; margin-bottom: 2px; background: ${isSelected ? "var(--bg-elev2)" : "transparent"}; color: ${isSelected ? "var(--accent)" : "var(--text)"}; font-weight: ${isSelected ? "600" : "400"};">
						<span style="font-size: 14px;">${icon}</span>
						<div style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px;">
							${escapeHtml(c.name)}
						</div>
						${c.isCustom ? `<button class="feishu-remove-custom-btn" data-id="${escapeHtml(c.id)}" style="border: none; background: none; color: var(--text-dim); cursor: pointer; font-size: 11px;" data-i18n-title="removeCustomChatTitle" title="${t("removeCustomChatTitle")}">×</button>` : ""}
					</div>
				`;
			})
			.join("");

		chatsListEl.querySelectorAll(".feishu-chat-item").forEach((el) => {
			el.addEventListener("click", (e) => {
				if (e.target.classList.contains("feishu-remove-custom-btn")) return;
				const id = el.getAttribute("data-id");
				selectChat(id);
			});
		});

		chatsListEl.querySelectorAll(".feishu-remove-custom-btn").forEach((btn) => {
			btn.addEventListener("click", async (e) => {
				e.stopPropagation();
				const id = btn.getAttribute("data-id");
				if (window.confirm?.(t("removeCustomChatConfirm", { id }))) {
					const res = await sendHost("remove_custom_chat", { id });
					if (res?.items) {
						state.chats = res.items;
						renderChats();
					}
				}
			});
		});
	}

	function renderMessages() {
		if (!messagesListEl) return;
		if (!state.messages.length) {
			messagesListEl.innerHTML = `<div style="padding: 24px 12px; text-align: center; color: var(--text-dim); font-size: 12px;" data-i18n="noMessages">${t("noMessages")}</div>`;
			msgsCountEl.textContent = t("msgCount", { n: 0 });
			return;
		}

		msgsCountEl.textContent = t("msgCount", { n: state.messages.length });
		messagesListEl.innerHTML = state.messages
			.map((m) => {
				const isSelected = state.activeMessage && state.activeMessage.id === m.id;
				const unreadBadge = !m.seen
					? `<span style="width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex-shrink: 0;"></span>`
					: "";

				let typeBadge = "";
				if (m.msgType === "post")
					typeBadge = `<span style="font-size: 10px; padding: 1px 4px; border-radius: 3px; background: var(--bg-elev2); color: var(--text-dim);" data-i18n="typePost">${t("typePost")}</span>`;
				else if (m.msgType === "interactive")
					typeBadge = `<span style="font-size: 10px; padding: 1px 4px; border-radius: 3px; background: var(--accent); color: var(--accent-contrast, #fff);" data-i18n="typeCard">${t("typeCard")}</span>`;
				else if (m.msgType === "image")
					typeBadge = `<span style="font-size: 10px; padding: 1px 4px; border-radius: 3px; background: var(--bg-elev2); color: var(--text-dim);" data-i18n="typeImage">${t("typeImage")}</span>`;
				else if (m.msgType === "file")
					typeBadge = `<span style="font-size: 10px; padding: 1px 4px; border-radius: 3px; background: var(--bg-elev2); color: var(--text-dim);" data-i18n="typeFile">${t("typeFile")}</span>`;

				return `
					<div class="feishu-msg-item" data-id="${escapeHtml(m.id)}" style="padding: 10px; border-radius: 6px; cursor: pointer; margin-bottom: 4px; border: 1px solid ${isSelected ? "var(--accent)" : "transparent"}; background: ${isSelected ? "var(--bg-elev2)" : "var(--bg-elev)"};">
						<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 6px;">
							<div style="display: flex; align-items: center; gap: 6px; min-width: 0;">
								${unreadBadge}
								<span style="font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(m.senderName)}</span>
								${typeBadge}
							</div>
							<span style="font-size: 10px; color: var(--text-dim); flex-shrink: 0;">${formatDate(m.date)}</span>
						</div>
						<div style="font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 2px;">
							${escapeHtml(m.subject || m.preview)}
						</div>
						<div style="font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
							${escapeHtml(m.preview)}
						</div>
					</div>
				`;
			})
			.join("");

		messagesListEl.querySelectorAll(".feishu-msg-item").forEach((el) => {
			el.addEventListener("click", () => {
				const id = el.getAttribute("data-id");
				const found = state.messages.find((m) => m.id === id);
				if (found) selectMessage(found);
			});
		});
	}

	function selectChat(chatId) {
		state.activeChatId = chatId;
		const chat = state.chats.find((c) => c.id === chatId);
		if (chat) msgsHeaderTitle.textContent = chat.name;
		renderChats();
		loadMessages(chatId);
	}

	async function loadMessages(chatId) {
		messagesListEl.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-dim);" data-i18n="syncingMessages">${t("syncingMessages")}</div>`;
		const res = await sendHost("list_messages", { chatId, limit: 30 });
		if (res?.items) {
			state.messages = res.items;
			renderMessages();
		}
	}

	async function selectMessage(msg) {
		state.activeMessage = msg;
		renderMessages();

		readerPlaceholder.style.display = "none";
		readerContent.style.display = "flex";
		transBanner.style.display = "none";

		readerSubject.textContent = msg.subject || t("noSubject");
		readerTypeTag.textContent = msg.msgType || "text";
		readerSender.textContent = msg.senderName;
		readerDate.textContent = formatDate(msg.date);
		readerMsgId.textContent = msg.id;
		readerBody.textContent = msg.text || "";
		rawPre.textContent = JSON.stringify(msg.rawContent || msg, null, 2);

		if (!msg.seen) {
			msg.seen = true;
			sendHost("mark_seen", { messageIds: [msg.id] });
		}
	}

	async function refreshAll() {
		statusBadge.textContent = t("syncing");
		const st = await sendHost("get_state");
		if (st) {
			state.config = st.config || {};
			state.presets = st.presets || {};
			state.botStatus = st.botStatus || {};
			state.hostCwd = st.hostCwd || "";
			updateStatusBadge(st.status || {});
		}
		const ch = await sendHost("list_chats");
		if (ch?.items) {
			state.chats = ch.items;
			if (!state.activeChatId && state.chats.length > 0) {
				state.activeChatId = state.chats[0].id;
			}
			renderChats();
			if (state.activeChatId) {
				await loadMessages(state.activeChatId);
			}
		}
	}

	q(".feishu-btn-refresh").addEventListener("click", () => {
		refreshAll();
	});

	q(".feishu-btn-search").addEventListener("click", async () => {
		const query = q(".feishu-search-input").value.trim();
		messagesListEl.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-dim);" data-i18n="searching">${t("searching")}</div>`;
		const res = await sendHost("search_messages", { query, chatId: state.activeChatId });
		if (res?.items) {
			state.messages = res.items;
			renderMessages();
		}
	});

	q(".feishu-search-input").addEventListener("keydown", (e) => {
		if (e.key === "Enter") q(".feishu-btn-search").click();
	});

	q(".feishu-reader-msgid").addEventListener("click", () => {
		const id = readerMsgId.textContent;
		if (id && navigator.clipboard) {
			navigator.clipboard.writeText(id);
			readerMsgId.textContent = t("copied");
			setTimeout(() => {
				readerMsgId.textContent = id;
			}, 1200);
		}
	});

	q(".feishu-btn-quote").addEventListener("click", () => {
		if (!state.activeMessage) return;
		const m = state.activeMessage;
		const quoteText = `${t("quoteHeader", { sender: m.senderName, date: formatDate(m.date) })}\n> ${m.text.replace(/\n/g, "\n> ")}\n\n`;

		if (typeof window.__piWebUiHost?.compose === "function") {
			window.__piWebUiHost.compose({ text: quoteText });
			window.__piWebUiHost.setView?.("chat");
		} else if (window.__piWebUiHost?.injectDraft) {
			window.__piWebUiHost.injectDraft({
				text: quoteText,
				items: [{ label: t("quoteDraftLabel", { name: m.subject || m.id.slice(-6) }), text: quoteText, key: m.id }],
			});
			if (window.__piWebUiHost.setView) window.__piWebUiHost.setView("chat");
			else if (ctx.ui?.setView) ctx.ui.setView("chat");
		} else if (navigator.clipboard) {
			navigator.clipboard.writeText(quoteText);
			alert?.(t("quoteCopied"));
		}
	});

	q(".feishu-btn-translate").addEventListener("click", async () => {
		if (!state.activeMessage) return;
		transBanner.style.display = "block";
		transText.textContent = t("translating");
		const model = transModelSelect.value || undefined;
		const res = await sendHost("translate_message", {
			text: state.activeMessage.text,
			targetLang: "zh-CN",
			model,
		});
		if (res?.translation) {
			transText.textContent = res.translation;
		} else {
			transText.textContent = t("translateFailed");
		}
	});

	q(".feishu-btn-hide-trans").addEventListener("click", () => {
		transBanner.style.display = "none";
	});

	container.querySelectorAll(".feishu-react-btn").forEach((btn) => {
		btn.addEventListener("click", async () => {
			if (!state.activeMessage) return;
			const emoji = btn.getAttribute("data-emoji");
			const prevText = btn.textContent;
			btn.textContent = "⏳";
			const res = await sendHost("react_message", {
				messageId: state.activeMessage.id,
				emojiType: emoji,
			});
			btn.textContent = res?.success ? "✓" : prevText;
			setTimeout(() => {
				btn.textContent = prevText;
			}, 1200);
		});
	});

	q(".feishu-btn-recall").addEventListener("click", async () => {
		if (!state.activeMessage) return;
		if (window.confirm?.(t("recallConfirm"))) {
			const res = await sendHost("recall_message", { messageId: state.activeMessage.id });
			if (res?.success) {
				alert?.(t("recallDone"));
				refreshAll();
			} else {
				alert?.(t("recallFailed", { error: res?.message || t("unknownError") }));
			}
		}
	});

	q(".feishu-btn-compose").addEventListener("click", () => {
		composeMode = { type: "new", replyId: "", replyInThread: false };
		composeTitle.textContent = t("composeModalTitle");
		inputTarget.value = state.activeChatId || "";
		inputTarget.disabled = false;
		inputTitle.value = "";
		inputContent.value = "";
		selectMsgType.value = "text";
		wrapTitle.style.display = "none";
		wrapTemplate.style.display = "none";
		composeModal.style.display = "flex";
	});

	q(".feishu-btn-reply").addEventListener("click", () => {
		if (!state.activeMessage) return;
		composeMode = { type: "reply", replyId: state.activeMessage.id, replyInThread: false };
		composeTitle.textContent = t("composeReplyTitle", { sender: state.activeMessage.senderName });
		inputTarget.value = state.activeChatId || "";
		inputTarget.disabled = true;
		inputTitle.value = "";
		inputContent.value = "";
		selectMsgType.value = "text";
		wrapTitle.style.display = "none";
		wrapTemplate.style.display = "none";
		composeModal.style.display = "flex";
	});

	q(".feishu-btn-reply-thread").addEventListener("click", () => {
		if (!state.activeMessage) return;
		composeMode = { type: "reply", replyId: state.activeMessage.id, replyInThread: true };
		composeTitle.textContent = t("composeReplyThreadTitle", { sender: state.activeMessage.senderName });
		inputTarget.value = state.activeChatId || "";
		inputTarget.disabled = true;
		inputTitle.value = "";
		inputContent.value = "";
		selectMsgType.value = "text";
		wrapTitle.style.display = "none";
		wrapTemplate.style.display = "none";
		composeModal.style.display = "flex";
	});

	selectMsgType.addEventListener("change", () => {
		const val = selectMsgType.value;
		wrapTitle.style.display = val === "post" || val === "interactive" ? "block" : "none";
		wrapTemplate.style.display = val === "interactive" ? "block" : "none";
	});

	q(".feishu-compose-close").addEventListener("click", () => (composeModal.style.display = "none"));
	q(".feishu-compose-cancel").addEventListener("click", () => (composeModal.style.display = "none"));

	q(".feishu-compose-submit").addEventListener("click", async () => {
		const text = inputContent.value.trim();
		if (!text) {
			alert?.(t("emptyContent"));
			return;
		}

		const msgType = selectMsgType.value;
		const title = inputTitle.value.trim();
		const cardTemplate = selectTemplate.value;
		const target = inputTarget.value.trim();

		const submitBtn = q(".feishu-compose-submit");
		submitBtn.disabled = true;
		submitBtn.textContent = t("sending");

		let res;
		if (composeMode.type === "reply") {
			res = await sendHost("reply_message", {
				payload: {
					messageId: composeMode.replyId,
					msgType,
					text,
					title,
					cardTemplate,
					replyInThread: composeMode.replyInThread,
				},
			});
		} else {
			res = await sendHost("send_message", {
				payload: {
					receiveId: target,
					msgType,
					text,
					title,
					cardTemplate,
				},
			});
		}

		submitBtn.disabled = false;
		submitBtn.textContent = t("send");

		if (res?.success) {
			composeModal.style.display = "none";
			refreshAll();
		} else {
			alert?.(t("sendFailed", { error: res?.message || t("unknownError") }));
		}
	});

	q(".feishu-btn-add-chat").addEventListener("click", async () => {
		const id = window.prompt?.(t("addChatIdPrompt"));
		if (!id?.trim()) return;
		const name = window.prompt?.(t("addChatNamePrompt"), id.trim()) || id.trim();
		const res = await sendHost("add_custom_chat", { chat: { id: id.trim(), name } });
		if (res?.items) {
			state.chats = res.items;
			renderChats();
		}
	});

	q(".feishu-btn-settings").addEventListener("click", () => {
		const cfg = state.config || {};
		cfgPreset.value = cfg.preset || "feishu";
		cfgBaseUrl.value = cfg.baseUrl || "";
		cfgAppId.value = cfg.appId || "";
		cfgAppSecret.value = "";
		cfgAppSecret.placeholder = cfg.hasAppSecret ? t("secretSavedMask") : t("appSecretPlaceholder");
		cfgDefaultChat.value = cfg.defaultChatId || "";
		cfgPollSec.value = cfg.pollSec || 60;
		cfgBotEnabled.checked = Boolean(cfg.botEnabled);
		cfgGroupMode.value = cfg.groupResponseMode || "mention";
		cfgAllowedSenders.value = Array.isArray(cfg.allowedSenders) ? cfg.allowedSenders.join(", ") : "";
		cfgWorkspace.value = cfg.workspace || "";
		cfgModel.value = cfg.model || "";
		cfgThinking.value = cfg.thinkingLevel || "";

		try {
			const hostProjects = globalThis.window?.__piWebUiHost?.listProjects?.() ?? [];
			cfgWsSelect.innerHTML = `<option value="" data-i18n="quickPickProject">${t("quickPickProject")}</option>`;
			for (const p of hostProjects) {
				if (!p) continue;
				const name =
					p
						.replace(/[\\/]+$/, "")
						.split(/[\\/]/)
						.pop() || p;
				const opt = document.createElement("option");
				opt.value = p;
				opt.textContent = `${name} (${p})`;
				cfgWsSelect.appendChild(opt);
			}
		} catch {}

		const bStat = state.botStatus || {};
		if (bStat.state === "connected") {
			botStatusBadge.textContent = t("botOnline");
			botStatusBadge.style.color = "var(--green, #22c55e)";
		} else if (bStat.state === "connecting") {
			botStatusBadge.textContent = t("botConnecting");
			botStatusBadge.style.color = "var(--amber, #eab308)";
		} else if (bStat.state === "error") {
			botStatusBadge.textContent = t("botError");
			botStatusBadge.style.color = "var(--red, #ef4444)";
		} else {
			botStatusBadge.textContent = t("botStopped");
			botStatusBadge.style.color = "var(--text-dim)";
		}
		botMetrics.textContent = t("botMetrics", {
			received: bStat.messagesReceived || 0,
			replied: bStat.messagesReplied || 0,
		});

		cfgWebhookUrl.value = cfg.webhookUrl || "";
		cfgWebhookSecret.value = "";
		cfgWebhookSecret.placeholder = cfg.hasWebhookSecret ? t("secretSavedMask") : t("webhookSecretPlaceholder");

		updatePresetHint();
		settingsModal.style.display = "flex";
	});

	function updatePresetHint() {
		const val = cfgPreset.value;
		const preset = state.presets?.[val] || {};
		cfgHint.textContent = preset.hint || "";
		cfgWrapBaseUrl.style.display = val === "custom" ? "block" : "none";
	}

	cfgPreset.addEventListener("change", updatePresetHint);
	q(".feishu-cfg-use-cwd")?.addEventListener("click", () => {
		if (state.hostCwd) cfgWorkspace.value = state.hostCwd;
	});
	cfgWsSelect?.addEventListener("change", () => {
		if (cfgWsSelect.value) cfgWorkspace.value = cfgWsSelect.value;
	});
	cfgWsBrowse?.addEventListener("click", async () => {
		const host = globalThis.window?.__piWebUiHost;
		if (typeof host?.pickDirectory !== "function") return;
		const res = await host.pickDirectory({
			title: t("pickWorkspaceTitle"),
			initialPath: cfgWorkspace.value.trim() || state.hostCwd || "",
		});
		if (res?.ok && res.path) {
			cfgWorkspace.value = res.path;
		}
	});
	cfgModelBrowse?.addEventListener("click", async () => {
		const host = globalThis.window?.__piWebUiHost;
		if (typeof host?.pickModel !== "function") return;
		const res = await host.pickModel({
			currentModelId: cfgModel.value.trim() || undefined,
		});
		if (res?.ok && res.modelId) {
			cfgModel.value = res.modelId;
		}
	});
	q(".feishu-settings-close").addEventListener("click", () => (settingsModal.style.display = "none"));
	q(".feishu-settings-cancel").addEventListener("click", () => (settingsModal.style.display = "none"));

	q(".feishu-settings-test").addEventListener("click", async () => {
		const testBtn = q(".feishu-settings-test");
		testBtn.disabled = true;
		testBtn.textContent = t("testing");
		const testCfg = {
			preset: cfgPreset.value,
			baseUrl: cfgBaseUrl.value.trim(),
			appId: cfgAppId.value.trim(),
			appSecret: cfgAppSecret.value.trim(),
			webhookUrl: cfgWebhookUrl.value.trim(),
			webhookSecret: cfgWebhookSecret.value.trim(),
		};
		const res = await sendHost("test_config", { config: testCfg });
		testBtn.disabled = false;
		testBtn.textContent = t("testConnection");

		const messages = res?.results?.messages || [];
		alert?.(messages.join("\n") || (res?.success ? t("testPassed") : t("testFailed")));
	});

	q(".feishu-settings-save").addEventListener("click", async () => {
		const saveBtn = q(".feishu-settings-save");
		saveBtn.disabled = true;
		saveBtn.textContent = t("saving");

		const newCfg = {
			preset: cfgPreset.value,
			baseUrl: cfgBaseUrl.value.trim(),
			appId: cfgAppId.value.trim(),
			appSecret: cfgAppSecret.value.trim(),
			defaultChatId: cfgDefaultChat.value.trim(),
			pollSec: Number(cfgPollSec.value) || 60,
			botEnabled: Boolean(cfgBotEnabled.checked),
			groupResponseMode: cfgGroupMode.value,
			allowedSenders: cfgAllowedSenders.value
				.split(/[,，\s]+/)
				.map((s) => s.trim())
				.filter(Boolean),
			workspace: cfgWorkspace.value.trim(),
			model: cfgModel.value.trim(),
			thinkingLevel: cfgThinking.value,
			webhookUrl: cfgWebhookUrl.value.trim(),
			webhookSecret: cfgWebhookSecret.value.trim(),
		};

		const res = await sendHost("save_config", { config: newCfg });
		saveBtn.disabled = false;
		saveBtn.textContent = t("saveConfig");

		if (res?.success) {
			settingsModal.style.display = "none";
			refreshAll();
		} else {
			alert?.(t("saveFailed", { error: res?.message || t("unknownError") }));
		}
	});

	// 宿主切语言后重渲染：静态文案就地更新 + 动态列表重拉（输入值与监听保留）
	const offLocale = i18n.onChange(() => {
		try {
			applyStaticTexts(container);
		} catch {}
		try {
			refreshAll();
		} catch {}
	});

	refreshAll();
	return offLocale;
}
