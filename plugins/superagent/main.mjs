import { createPluginI18n, esc } from "../../plugin-sdk/client-utils.mjs";

/**
 * 外部渠道与工单面板自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 这里只维护 zh / en 两份文案；服务端返回的报错原文与工单数据（标题/ID/JSON）保持原样。
 */
const DICT = {
	zh: {
		headerTitle: "外部渠道与工单",
		headerSub: "渠道接入 → 群组独立 AI Router → Bot 执行 → 原渠道回写",
		btnRefresh: "刷新",
		notice: "默认仅观察。自动执行及外发需要明确启用 auto、房间映射和作者白名单；也可对单个工单人工授权。",
		loading: "正在加载…",
		settingsTitle: "渠道配置",
		workTitle: "工单",
		btnDeliver: "重试到期回写",
		detailEmpty: "选择工单查看详情。",
		secretSaved: "已保存；不会显示原值",
		secretEmpty: "尚未配置",
		actionKeep: "保留",
		actionSet: "替换",
		actionClear: "清空",
		secretPh: "选择替换后输入新值",
		secretOp: "{field}操作",
		field_githubSecret: "Webhook Secret",
		field_githubToken: "GitHub API Token",
		field_feishuVerificationToken: "Verification Token",
		field_feishuEncryptKey: "签名 Encrypt Key",
		field_feishuAppSecret: "App Secret",
		providerFeishu: "飞书",
		labelMode: "模式",
		modeObserve: "observe · 仅观察",
		modeAuto: "auto · 允许名单内作者触发",
		labelAuthorsGithub: "允许作者（GitHub 数字用户 ID，每行一个）",
		labelAuthorsFeishu: "允许作者（飞书 open_id，每行一个）",
		labelRepos: "允许仓库（owner/repo，每行一个）",
		labelMappingsGithub: "房间映射（每行 owner/repo=roomId）",
		labelMappingsFeishu: "房间映射（每行 chat_id=roomId）",
		labelAppId: "App ID",
		endpointLabel: "Webhook：",
		feishuNote:
			"支持带签名的文本消息事件及 AES 加密回调。先验证原始请求签名，再解密并校验 Token；Token 和 Encrypt Key 均必填。飞书发送结果不确定超过 45 分钟时需人工核对，不再自动发送。",
		roomsTitle: "可用房间 ID",
		roomsEmpty: "暂无房间，请先创建群组。",
		btnSave: "保存配置",
		itemsEmpty: "暂无工单。请配置渠道、房间映射并接收首个事件。",
		status_open: "待处理",
		status_running: "执行中",
		status_waiting: "等待",
		status_blocked: "已暂停",
		status_completed: "已完成",
		status_cancelled: "已取消",
		itemAuthorized: "已授权",
		itemObserving: "仅观察",
		detailAuthor: "作者",
		detailStatus: "状态：",
		detailAuthed: "已授权执行和回写",
		detailWatching: "观察中",
		btnPause: "暂停",
		btnResume: "恢复",
		btnComplete: "完成",
		btnAuthorize: "人工授权执行及回写",
		btnRevoke: "撤销授权",
		btnAuthorizeLatest: "授权最新事件",
		recordsTitle: "工单记录",
		notifyLoaded: "配置已加载。密钥输入框留空并选择“保留”可保留现有值；清空必须显式选择。",
		notifySaved: "配置已保存。",
		notifyRefreshed: "工单已刷新。",
		notifyDelivered: "本轮回写成功 {ok}，失败 {fail}。宿主持久队列按退避时间自动重试。",
		notifyUpdated: "工单已更新。",
		mappingError: "映射格式应为 channelId=roomId，每行一条。",
	},
	"zh-TW": {
		headerTitle: "外部管道與工單",
		headerSub: "管道接入 → 群組獨立 AI Router → Bot 執行 → 原管道回寫",
		btnRefresh: "重新整理",
		notice: "預設僅觀察。自動執行及外發需要明確啟用 auto、房間映射和作者白名單；也可對單個工單人工授權。",
		loading: "正在載入…",
		settingsTitle: "管道配置",
		workTitle: "工單",
		btnDeliver: "重試到期回寫",
		detailEmpty: "選擇工單查看詳情。",
		secretSaved: "已儲存；不會顯示原值",
		secretEmpty: "尚未配置",
		actionKeep: "保留",
		actionSet: "取代",
		actionClear: "清空",
		secretPh: "選擇取代後輸入新值",
		secretOp: "{field}操作",
		field_githubSecret: "Webhook Secret",
		field_githubToken: "GitHub API Token",
		field_feishuVerificationToken: "Verification Token",
		field_feishuEncryptKey: "簽名 Encrypt Key",
		field_feishuAppSecret: "App Secret",
		providerFeishu: "飛書",
		labelMode: "模式",
		modeObserve: "observe · 僅觀察",
		modeAuto: "auto · 允許名單內作者觸發",
		labelAuthorsGithub: "允許作者（GitHub 數字用戶 ID，每行一個）",
		labelAuthorsFeishu: "允許作者（飛書 open_id，每行一個）",
		labelRepos: "允許倉庫（owner/repo，每行一個）",
		labelMappingsGithub: "房間映射（每行 owner/repo=roomId）",
		labelMappingsFeishu: "房間映射（每行 chat_id=roomId）",
		labelAppId: "App ID",
		endpointLabel: "Webhook：",
		feishuNote:
			"支援帶簽名的文字訊息事件及 AES 加密回調。先驗證原始請求簽名，再解密並校驗 Token；Token 和 Encrypt Key 均必填。飛書發送結果不確定超過 45 分鐘時需人工核對，不再自動發送。",
		roomsTitle: "可用房間 ID",
		roomsEmpty: "暫無房間，請先建立群組。",
		btnSave: "儲存配置",
		itemsEmpty: "暫無工單。請配置管道、房間映射並接收首個事件。",
		status_open: "待處理",
		status_running: "執行中",
		status_waiting: "等待",
		status_blocked: "已暫停",
		status_completed: "已完成",
		status_cancelled: "已取消",
		itemAuthorized: "已授權",
		itemObserving: "僅觀察",
		detailAuthor: "作者",
		detailStatus: "狀態：",
		detailAuthed: "已授權執行和回寫",
		detailWatching: "觀察中",
		btnPause: "暫停",
		btnResume: "恢復",
		btnComplete: "完成",
		btnAuthorize: "人工授權執行及回寫",
		btnRevoke: "撤銷授權",
		btnAuthorizeLatest: "授權最新事件",
		recordsTitle: "工單記錄",
		notifyLoaded: "配置已載入。密鑰輸入框留空並選擇「保留」可保留現有值；清空必須顯式選擇。",
		notifySaved: "配置已儲存。",
		notifyRefreshed: "工單已重新整理。",
		notifyDelivered: "本輪回寫成功 {ok}，失敗 {fail}。宿主持久佇列按退避時間自動重試。",
		notifyUpdated: "工單已更新。",
		mappingError: "映射格式應為 channelId=roomId，每行一條。",
	},
	en: {
		headerTitle: "External Channels & Work Items",
		headerSub: "Channel intake → group AI Router → Bot execution → write back to channel",
		btnRefresh: "Refresh",
		notice:
			"Observe-only by default. Auto execution and outbound replies require auto mode, room mappings and an author allowlist; individual items can be authorized manually.",
		loading: "Loading…",
		settingsTitle: "Channel settings",
		workTitle: "Work items",
		btnDeliver: "Retry due write-backs",
		detailEmpty: "Select a work item to view details.",
		secretSaved: "Saved; value is never shown",
		secretEmpty: "Not configured",
		actionKeep: "Keep",
		actionSet: "Replace",
		actionClear: "Clear",
		secretPh: "Select Replace, then enter the new value",
		secretOp: "{field} action",
		field_githubSecret: "Webhook Secret",
		field_githubToken: "GitHub API Token",
		field_feishuVerificationToken: "Verification Token",
		field_feishuEncryptKey: "Signature Encrypt Key",
		field_feishuAppSecret: "App Secret",
		providerFeishu: "Feishu",
		labelMode: "Mode",
		modeObserve: "observe · Observe only",
		modeAuto: "auto · Allowlisted authors can trigger",
		labelAuthorsGithub: "Allowed authors (GitHub numeric user IDs, one per line)",
		labelAuthorsFeishu: "Allowed authors (Feishu open_id, one per line)",
		labelRepos: "Allowed repos (owner/repo, one per line)",
		labelMappingsGithub: "Room mappings (one owner/repo=roomId per line)",
		labelMappingsFeishu: "Room mappings (one chat_id=roomId per line)",
		labelAppId: "App ID",
		endpointLabel: "Webhook: ",
		feishuNote:
			"Supports signed text-message events and AES-encrypted callbacks. The raw request signature is verified first, then the payload is decrypted and the token checked; both Token and Encrypt Key are required. If a Feishu send result stays uncertain for over 45 minutes, reconcile it manually — it will not be retried automatically.",
		roomsTitle: "Available room IDs",
		roomsEmpty: "No rooms yet — create a group first.",
		btnSave: "Save settings",
		itemsEmpty: "No work items yet. Configure channels and room mappings, then wait for the first event.",
		status_open: "Open",
		status_running: "Running",
		status_waiting: "Waiting",
		status_blocked: "Paused",
		status_completed: "Completed",
		status_cancelled: "Cancelled",
		itemAuthorized: "Authorized",
		itemObserving: "Observing",
		detailAuthor: "Author",
		detailStatus: "Status: ",
		detailAuthed: "Authorized for execution & write-back",
		detailWatching: "Observing",
		btnPause: "Pause",
		btnResume: "Resume",
		btnComplete: "Complete",
		btnAuthorize: "Authorize execution & write-back",
		btnRevoke: "Revoke authorization",
		btnAuthorizeLatest: "Authorize latest event",
		recordsTitle: "Work item records",
		notifyLoaded:
			"Settings loaded. Leave secret inputs empty with “Keep” selected to keep current values; clearing must be explicit.",
		notifySaved: "Settings saved.",
		notifyRefreshed: "Work items refreshed.",
		notifyDelivered:
			"{ok} write-backs succeeded, {fail} failed this round. The host durable queue retries with backoff.",
		notifyUpdated: "Work item updated.",
		mappingError: "Mappings must be channelId=roomId, one per line.",
	},
};

/** 界面文案：每次调用按当前宿主语言取词（SDK 内读 locale.current()）。 */
const i18n = createPluginI18n(DICT);
const t = (key, vars) => i18n.t(key, vars);
/** 工单状态显示名：未知取值原样回落（服务端数据）。 */
const statusLabel = (s) => {
	const v = t(`status_${s}`);
	return v === `status_${s}` ? (s ?? "") : v;
};

const appRoot = new URL("../../../", import.meta.url);
const appUrl = (path) => new URL(path.replace(/^\//, ""), appRoot).href;
const api = async (path, body, method = "POST") => {
	const response = await fetch(appUrl(`plugins-api/superagent${path}`), {
		credentials: "same-origin",
		...(body === undefined
			? {}
			: { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
	return data;
};
const fieldLabel = (key) => t(`field_${key}`);
const SECRET_KEYS = ["githubSecret", "githubToken", "feishuVerificationToken", "feishuEncryptKey", "feishuAppSecret"]; // 与服务端密钥表同序（仅字段名，值不落盘）
const lines = (value) =>
	value
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);

export default {
	mount(container) {
		let disposed = false;
		let selected;
		let workItems = [];
		container.innerHTML = `<link rel="stylesheet" href="${esc(appUrl("plugins-api/superagent/assets/style.css"))}">
		<div class="superagent-root">
			<header><div><h2>${esc(t("headerTitle"))}</h2><p>${esc(t("headerSub"))}</p></div><button data-action="refresh">${esc(t("btnRefresh"))}</button></header>
			<p class="sa-notice">${esc(t("notice"))}</p>
			<p role="status" class="sa-status">${esc(t("loading"))}</p>
			<div class="sa-layout"><section class="sa-settings"><h3>${esc(t("settingsTitle"))}</h3><form></form></section>
			<section class="sa-work"><div class="sa-toolbar"><h3>${esc(t("workTitle"))}</h3><button data-action="deliver">${esc(t("btnDeliver"))}</button></div><div class="sa-items"></div><article class="sa-detail"><p>${esc(t("detailEmpty"))}</p></article></section></div>
		</div>`;
		const root = container.querySelector(".superagent-root");
		const status = root.querySelector(".sa-status");
		const form = root.querySelector("form");
		const notify = (message, error = false) => {
			if (!disposed) {
				status.textContent = message;
				status.classList.toggle("sa-error", error);
			}
		};
		const showSecrets = (keys, state) =>
			keys
				.map(
					(key) =>
						`<label>${esc(fieldLabel(key))}<small>${state[key] ? esc(t("secretSaved")) : esc(t("secretEmpty"))}</small><select name="${key}-action" aria-label="${esc(t("secretOp", { field: fieldLabel(key) }))}"><option value="keep">${esc(t("actionKeep"))}</option><option value="set">${esc(t("actionSet"))}</option><option value="clear">${esc(t("actionClear"))}</option></select><input type="password" autocomplete="new-password" name="${key}" placeholder="${esc(t("secretPh"))}" disabled></label>`,
				)
				.join("");
		function renderConfig(saved, rooms) {
			form.innerHTML =
				["github", "feishu"]
					.map((provider) => {
						const cfg = saved.config[provider];
						return `<fieldset><legend>${provider === "github" ? "GitHub" : esc(t("providerFeishu"))}</legend>
				<label>${esc(t("labelMode"))}<select name="${provider}-mode"><option value="observe"${cfg.mode === "observe" ? " selected" : ""}>${esc(t("modeObserve"))}</option><option value="auto"${cfg.mode === "auto" ? " selected" : ""}>${esc(t("modeAuto"))}</option></select></label>
				${provider === "feishu" ? `<label>${esc(t("labelAppId"))}<input name="feishu-appId" value="${esc(cfg.appId)}"></label>` : ""}
				<label>${esc(provider === "github" ? t("labelAuthorsGithub") : t("labelAuthorsFeishu"))}<textarea name="${provider}-authors" rows="3">${esc(cfg.allowedAuthors.join("\n"))}</textarea></label>
				${provider === "github" ? `<label>${esc(t("labelRepos"))}<textarea name="github-repos" rows="3">${esc(cfg.allowedRepos.join("\n"))}</textarea></label>` : ""}
				<label>${esc(provider === "github" ? t("labelMappingsGithub") : t("labelMappingsFeishu"))}<textarea name="${provider}-mappings" rows="3" spellcheck="false">${esc(cfg.mappings.map((m) => `${m.channelId}=${m.roomId}`).join("\n"))}</textarea></label>
				${showSecrets(provider === "github" ? ["githubSecret", "githubToken"] : ["feishuVerificationToken", "feishuEncryptKey", "feishuAppSecret"], saved.secrets)}
				<p class="sa-endpoint">${esc(t("endpointLabel"))}<code>${esc(appUrl(`api/superagent/webhooks/${provider}`))}</code></p>
				${provider === "feishu" ? `<p>${esc(t("feishuNote"))}</p>` : ""}</fieldset>`;
					})
					.join("") +
				`<details><summary>${esc(t("roomsTitle"))}</summary><ul>${rooms.map((room) => `<li>${esc(room.name ?? room.title ?? room.id)}：<code>${esc(room.id)}</code></li>`).join("") || `<li>${esc(t("roomsEmpty"))}</li>`}</ul></details><button type="submit" class="sa-primary">${esc(t("btnSave"))}</button>`;
		}
		function renderItems() {
			root.querySelector(".sa-items").innerHTML = workItems.length
				? workItems
						.map(
							(item) =>
								`<button class="sa-item${selected === item.id ? " sa-selected" : ""}" data-id="${esc(item.id)}"><strong>${esc(item.title || item.id)}</strong><span>${esc(item.provider)} · ${esc(item.channelId)} ${esc(item.threadId)}</span><span>${esc(statusLabel(item.status))} · ${item.authorized ? esc(t("itemAuthorized")) : esc(t("itemObserving"))}</span></button>`,
						)
						.join("")
				: `<p>${esc(t("itemsEmpty"))}</p>`;
		}
		async function detail(id) {
			const { item } = await api(`/item?id=${encodeURIComponent(id)}`);
			if (disposed || selected !== id) return;
			const target = root.querySelector(".sa-detail");
			target.innerHTML = `<h3>${esc(item.title || item.id)}</h3><p>${esc(item.provider)} · ${esc(item.channelId)} ${esc(item.threadId)} · ${esc(t("detailAuthor"))} ${esc(item.authorId)}</p><p>${esc(t("detailStatus"))}${esc(statusLabel(item.status))} · ${item.authorized ? esc(t("detailAuthed")) : esc(t("detailWatching"))}</p><div class="sa-toolbar">${[
				["pause", t("btnPause")],
				["resume", t("btnResume")],
				["complete", t("btnComplete")],
				[item.authorized ? "observe" : "authorize", item.authorized ? t("btnRevoke") : t("btnAuthorize")],
				...(item.authorized && item.pendingAuthorization ? [["authorize", t("btnAuthorizeLatest")]] : []),
			]
				.map(([action, label]) => `<button data-item-action="${action}">${esc(label)}</button>`)
				.join("")}</div><h4>${esc(t("recordsTitle"))}</h4><pre></pre>`;
			target.querySelector("pre").textContent = JSON.stringify(item, null, 2);
		}
		async function refreshItems() {
			const data = await api("/items");
			if (disposed) return;
			workItems = data.items;
			renderItems();
			if (selected) await detail(selected);
		}
		async function load() {
			try {
				const [saved, roomData] = await Promise.all([api("/config"), api("/rooms")]);
				if (disposed) return;
				renderConfig(saved, roomData.rooms);
				await refreshItems();
				notify(t("notifyLoaded"));
			} catch (error) {
				notify(error.message, true);
			}
		}
		const onChange = (event) => {
			if (event.target.name?.endsWith("-action")) {
				const key = event.target.name.slice(0, -7);
				const input = form.elements.namedItem(key);
				input.disabled = event.target.value !== "set";
				input.required = event.target.value === "set";
				if (input.disabled) input.value = "";
			}
		};
		const onSubmit = async (event) => {
			event.preventDefault();
			const data = new FormData(form);
			try {
				const config = {};
				for (const provider of ["github", "feishu"]) {
					config[provider] = {
						mode: data.get(`${provider}-mode`),
						allowedAuthors: lines(data.get(`${provider}-authors`)),
						mappings: String(data.get(`${provider}-mappings`))
							.split("\n")
							.map((s) => s.trim())
							.filter(Boolean)
							.map((row) => {
								const parts = row.split("=");
								if (parts.length !== 2) throw new Error(t("mappingError"));
								return { channelId: parts[0].trim(), roomId: parts[1].trim() };
							}),
					};
				}
				config.github.allowedRepos = lines(data.get("github-repos"));
				config.feishu.appId = data.get("feishu-appId");
				const secrets = Object.fromEntries(
					SECRET_KEYS.map((key) => [
						key,
						{
							action: data.get(`${key}-action`),
							...(data.get(`${key}-action`) === "set" ? { value: data.get(key) } : {}),
						},
					]),
				);
				await api("/config", { config, secrets }, "PUT");
				await load();
				notify(t("notifySaved"));
			} catch (error) {
				notify(error.message, true);
			}
		};
		const onClick = async (event) => {
			const button = event.target.closest("button");
			if (!button || (button.form === form && button.type === "submit")) return;
			try {
				button.disabled = true;
				if (button.dataset.action === "refresh") {
					await refreshItems();
					notify(t("notifyRefreshed"));
				}
				if (button.dataset.action === "deliver") {
					const result = await api("/deliver", {});
					notify(t("notifyDelivered", { ok: result.delivered, fail: result.failed }));
				}
				if (button.dataset.id) {
					selected = button.dataset.id;
					renderItems();
					await detail(selected);
				}
				if (button.dataset.itemAction && selected) {
					await api("/items/update", { id: selected, action: button.dataset.itemAction });
					await refreshItems();
					notify(t("notifyUpdated"));
				}
			} catch (error) {
				notify(error.message, true);
			} finally {
				button.disabled = false;
			}
		};
		root.addEventListener("click", onClick);
		form.addEventListener("submit", onSubmit);
		form.addEventListener("change", onChange);
		load();
		return () => {
			disposed = true;
			root.removeEventListener("click", onClick);
			form.removeEventListener("submit", onSubmit);
			form.removeEventListener("change", onChange);
			container.replaceChildren();
		};
	},
};
