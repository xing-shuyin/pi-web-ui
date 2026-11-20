import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";
import { DICT } from "./i18n.mjs";

/** 面板文案：语言解析 / 回退 / 插值都在 SDK 里，这里只按当前界面语言取词。禁自建语言偏好，只跟宿主全局语言。 */
const i18n = createPluginI18n(DICT);
const t = (key, params) => i18n.t(key, params);

/** 语言切换时就地重渲染静态文案（输入值与监听保留），动态计数由 refresh() 重画。 */
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

export default {
	async mount(el, ctx) {
		// 首帧：显式读取宿主全局语言（SDK 内部同样以 locale.current() 为单源）
		try {
			globalThis.window?.__piWebUiHost?.locale?.current?.();
		} catch {}
		const sendHost = async (type, payload = {}) => {
			return await ctx.send({ type, ...payload });
		};

		el.innerHTML = `
			<div class="wecom-root" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); font-size: 13px;">
				<!-- Topbar Header -->
				<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--bg-elev);">
					<div style="display: flex; align-items: center; gap: 8px;">
						<span style="font-size: 18px;">💼</span>
						<span style="font-weight: 600; font-size: 14px;" data-i18n="workbenchTitle">${t("workbenchTitle")}</span>
						<span class="wecom-status-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);" data-i18n="statusChecking">${t("statusChecking")}</span>
					</div>
					<div style="display: flex; gap: 8px;">
						<button class="wecom-btn-config" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;" data-i18n="configCredentials">${t("configCredentials")}</button>
					</div>
				</div>

				<!-- Main Container -->
				<div style="flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px;">
					<!-- Bot Status Overview Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
							<div style="font-weight: 600; font-size: 14px;" data-i18n="botStatusTitle">${t("botStatusTitle")}</div>
							<div class="wecom-bot-toggle-wrap">
								<button class="wecom-btn-toggle-bot" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;" data-i18n="toggleBotService">${t("toggleBotService")}</button>
							</div>
						</div>
						<div style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); display: grid; gap: 12px;">
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;" data-i18n="bridgeState">${t("bridgeState")}</div>
								<div class="wecom-metric-state" style="font-size: 14px; font-weight: 600;" data-i18n="notStarted">${t("notStarted")}</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;" data-i18n="messagesReceived">${t("messagesReceived")}</div>
								<div class="wecom-metric-recv" style="font-size: 14px; font-weight: 600;">${t("msgCount", { n: 0 })}</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;" data-i18n="messagesReplied">${t("messagesReplied")}</div>
								<div class="wecom-metric-sent" style="font-size: 14px; font-weight: 600;">${t("msgCount", { n: 0 })}</div>
							</div>
						</div>
						<div style="margin-top: 10px; font-size: 12px; color: var(--text-dim); line-height: 1.5;">
							${t("botDescription")}
						</div>
					</div>

					<!-- Webhook Push Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 12px;" data-i18n="webhookPushTitle">${t("webhookPushTitle")}</div>
						<div style="display: flex; flex-direction: column; gap: 10px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="cardTitleLabel">${t("cardTitleLabel")}</label>
								<input type="text" class="wecom-push-title" data-i18n-ph="cardTitlePlaceholder" placeholder="${t("cardTitlePlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="cardTextLabel">${t("cardTextLabel")}</label>
								<textarea class="wecom-push-text" rows="4" data-i18n-ph="cardTextPlaceholder" placeholder="${t("cardTextPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); resize: vertical; font-family: inherit;"></textarea>
							</div>
							<div style="display: flex; justify-content: flex-end; gap: 8px;">
								<button class="wecom-btn-push" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;" data-i18n="sendToGroup">${t("sendToGroup")}</button>
							</div>
						</div>
					</div>
				</div>

				<!-- Settings Modal -->
				<div class="wecom-modal-settings" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
					<div style="width: 520px; max-width: 90vw; max-height: 85vh; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
						<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<span style="font-weight: 600;" data-i18n="settingsTitle">${t("settingsTitle")}</span>
							<button class="wecom-modal-close" style="background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 16px;">✕</button>
						</div>
						<div style="padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;">
							<div>
								<div style="font-weight: 600; margin-bottom: 8px;" data-i18n="webhookSectionTitle">${t("webhookSectionTitle")}</div>
								<div>
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="webhookKeyLabel">${t("webhookKeyLabel")}</label>
									<input type="password" class="wecom-cfg-webhook-key" placeholder="693a91f6-7xxx-4xxx-xxxx-xxxxxxxxxxxx" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;" data-i18n="appSectionTitle">${t("appSectionTitle")}</div>
								<div style="display: flex; gap: 10px; margin-bottom: 8px;">
									<div style="flex: 1;">
										<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="corpIdLabel">${t("corpIdLabel")}</label>
										<input type="text" class="wecom-cfg-corpid" placeholder="wwxxxxxxxxxxxxxxxx" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
									</div>
									<div style="flex: 1;">
										<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="corpSecretLabel">${t("corpSecretLabel")}</label>
										<input type="password" class="wecom-cfg-corpsecret" data-i18n-ph="keepUnchangedPlaceholder" placeholder="${t("keepUnchangedPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
									</div>
								</div>
								<div>
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="agentIdLabel">${t("agentIdLabel")}</label>
									<input type="text" class="wecom-cfg-agentid" placeholder="1000002" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;" data-i18n="botAccessTitle">${t("botAccessTitle")}</div>
								<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
									<input type="checkbox" id="wecom-cfg-bot-enabled" class="wecom-cfg-bot-enabled" style="cursor: pointer;" />
									<label for="wecom-cfg-bot-enabled" style="font-size: 12px; cursor: pointer; user-select: none;" data-i18n="botEnabledLabel">${t("botEnabledLabel")}</label>
								</div>
								<div style="margin-bottom: 8px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="whitelistLabel">${t("whitelistLabel")}</label>
									<input type="text" class="wecom-cfg-allowed-users" data-i18n-ph="whitelistPlaceholder" placeholder="${t("whitelistPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div>
									<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
										<label style="color: var(--text-dim);" data-i18n="workspaceLabel">${t("workspaceLabel")}</label>
									</div>
									<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
										<input type="text" class="wecom-cfg-workspace" data-i18n-ph="workspacePlaceholder" placeholder="${t("workspacePlaceholder")}" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
										<select class="wecom-cfg-ws-select" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
											<option value="" data-i18n="selectProjectPlaceholder">${t("selectProjectPlaceholder")}</option>
										</select>
										<button type="button" class="wecom-cfg-ws-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;" data-i18n="browse">${t("browse")}</button>
										<button type="button" class="wecom-cfg-use-cwd" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;" data-i18n="useCurrentProject">${t("useCurrentProject")}</button>
									</div>
								</div>
								<div style="margin-top: 10px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);" data-i18n="modelLabel">${t("modelLabel")}</label>
									<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
										<input type="text" class="wecom-cfg-model" data-i18n-ph="modelPlaceholder" placeholder="${t("modelPlaceholder")}" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
										<button type="button" class="wecom-cfg-model-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;" data-i18n="selectModel">${t("selectModel")}</button>
										<select class="wecom-cfg-thinking" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
											<option value="" data-i18n="thinkingFollowGlobal">${t("thinkingFollowGlobal")}</option>
											<option value="off" data-i18n="thinkingOff">${t("thinkingOff")}</option>
											<option value="low" data-i18n="thinkingLow">${t("thinkingLow")}</option>
											<option value="medium" data-i18n="thinkingMedium">${t("thinkingMedium")}</option>
											<option value="high" data-i18n="thinkingHigh">${t("thinkingHigh")}</option>
											<option value="max" data-i18n="thinkingMax">${t("thinkingMax")}</option>
										</select>
									</div>
								</div>
							</div>
						</div>
						<div style="padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<button class="wecom-btn-test-cfg" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;" data-i18n="testConnection">${t("testConnection")}</button>
							<div style="display: flex; gap: 8px;">
								<button class="wecom-modal-cancel" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;" data-i18n="cancel">${t("cancel")}</button>
								<button class="wecom-btn-save-cfg" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;" data-i18n="saveConfig">${t("saveConfig")}</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		`;

		const q = (sel) => el.querySelector(sel);
		const statusBadge = q(".wecom-status-badge");
		const metricState = q(".wecom-metric-state");
		const metricRecv = q(".wecom-metric-recv");
		const metricSent = q(".wecom-metric-sent");
		const modal = q(".wecom-modal-settings");

		const cfgWebhookKey = q(".wecom-cfg-webhook-key");
		const cfgCorpId = q(".wecom-cfg-corpid");
		const cfgCorpSecret = q(".wecom-cfg-corpsecret");
		const cfgAgentId = q(".wecom-cfg-agentid");
		const cfgBotEnabled = q(".wecom-cfg-bot-enabled");
		const cfgAllowedUsers = q(".wecom-cfg-allowed-users");
		const cfgWorkspace = q(".wecom-cfg-workspace");
		const cfgWsSelect = q(".wecom-cfg-ws-select");
		const cfgWsBrowse = q(".wecom-cfg-ws-browse");
		const cfgModel = q(".wecom-cfg-model");
		const cfgModelBrowse = q(".wecom-cfg-model-browse");
		const cfgThinking = q(".wecom-cfg-thinking");

		let currentState = {};

		async function refresh() {
			const res = await sendHost("get_state");
			if (!res) return;
			currentState = res;

			const b = res.botStatus || {};
			if (b.state === "waiting_callback" || b.state === "connected") {
				statusBadge.textContent = t("bridgeEnabled");
				statusBadge.style.color = "var(--amber, #eab308)";
				metricState.textContent = t("bridgeWaitingExternal");
				metricState.style.color = "var(--amber, #eab308)";
			} else if (b.state === "connecting") {
				statusBadge.textContent = t("connecting");
				statusBadge.style.color = "var(--amber, #eab308)";
				metricState.textContent = t("connectingDots");
				metricState.style.color = "var(--amber, #eab308)";
			} else if (b.state === "error") {
				statusBadge.textContent = t("error");
				statusBadge.style.color = "var(--red, #ef4444)";
				metricState.textContent = t("connectError");
				metricState.style.color = "var(--red, #ef4444)";
			} else {
				statusBadge.textContent = t("notStarted");
				statusBadge.style.color = "var(--text-dim)";
				metricState.textContent = t("notStarted");
				metricState.style.color = "var(--text-dim)";
			}

			metricRecv.textContent = t("msgCount", { n: b.messagesReceived || 0 });
			metricSent.textContent = t("msgCount", { n: b.messagesReplied || 0 });
		}

		q(".wecom-btn-config").addEventListener("click", () => {
			const cfg = currentState.config || {};
			cfgWebhookKey.value = "";
			cfgWebhookKey.placeholder = cfg.hasWebhookKey ? t("secretStoredPlaceholder") : t("webhookKeyPlaceholder");
			cfgCorpId.value = cfg.corpId || "";
			cfgCorpSecret.value = "";
			cfgCorpSecret.placeholder = cfg.hasCorpSecret ? t("secretStoredPlaceholder") : t("corpSecretPlaceholder");
			cfgAgentId.value = cfg.agentId || "";
			cfgBotEnabled.checked = Boolean(cfg.botEnabled);
			cfgAllowedUsers.value = Array.isArray(cfg.allowedUsers) ? cfg.allowedUsers.join(", ") : "";
			cfgWorkspace.value = cfg.workspace || "";
			cfgModel.value = cfg.model || "";
			cfgThinking.value = cfg.thinkingLevel || "";

			try {
				const hostProjects = globalThis.window?.__piWebUiHost?.listProjects?.() ?? [];
				cfgWsSelect.innerHTML = `<option value="" data-i18n="selectProjectPlaceholder">${t("selectProjectPlaceholder")}</option>`;
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

			modal.style.display = "flex";
		});

		q(".wecom-cfg-use-cwd")?.addEventListener("click", () => {
			if (currentState.hostCwd) cfgWorkspace.value = currentState.hostCwd;
		});
		cfgWsSelect?.addEventListener("change", () => {
			if (cfgWsSelect.value) cfgWorkspace.value = cfgWsSelect.value;
		});
		cfgWsBrowse?.addEventListener("click", async () => {
			const host = globalThis.window?.__piWebUiHost;
			if (typeof host?.pickDirectory !== "function") return;
			const res = await host.pickDirectory({
				title: t("pickDirTitle"),
				initialPath: cfgWorkspace.value.trim() || currentState.hostCwd || "",
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
		q(".wecom-modal-close").addEventListener("click", () => (modal.style.display = "none"));
		q(".wecom-modal-cancel").addEventListener("click", () => (modal.style.display = "none"));

		q(".wecom-btn-test-cfg").addEventListener("click", async () => {
			const btn = q(".wecom-btn-test-cfg");
			btn.disabled = true;
			btn.textContent = t("testing");
			const testCfg = {
				webhookKey: cfgWebhookKey.value.trim(),
				corpId: cfgCorpId.value.trim(),
				corpSecret: cfgCorpSecret.value.trim(),
			};
			const res = await sendHost("test_config", { config: testCfg });
			btn.disabled = false;
			btn.textContent = t("testConnection");

			const messages = res?.results?.messages || [];
			alert?.(messages.join("\n") || (res?.success ? t("testPassed") : t("testFailed")));
		});

		q(".wecom-btn-save-cfg").addEventListener("click", async () => {
			const btn = q(".wecom-btn-save-cfg");
			btn.disabled = true;
			btn.textContent = t("saving");

			const newCfg = {
				webhookKey: cfgWebhookKey.value.trim(),
				corpId: cfgCorpId.value.trim(),
				corpSecret: cfgCorpSecret.value.trim(),
				agentId: cfgAgentId.value.trim(),
				botEnabled: Boolean(cfgBotEnabled.checked),
				allowedUsers: cfgAllowedUsers.value
					.split(/[,，\s]+/)
					.map((s) => s.trim())
					.filter(Boolean),
				workspace: cfgWorkspace.value.trim(),
				model: cfgModel.value.trim(),
				thinkingLevel: cfgThinking.value,
			};

			const res = await sendHost("save_config", { config: newCfg });
			btn.disabled = false;
			btn.textContent = t("saveConfig");

			if (res?.success) {
				modal.style.display = "none";
				refresh();
			} else {
				alert?.(t("saveFailed", { error: res?.message || t("unknownError") }));
			}
		});

		q(".wecom-btn-toggle-bot").addEventListener("click", async () => {
			const isRunning = Boolean(currentState.botStatus?.enabled);
			const action = isRunning ? "stop_bot" : "start_bot";
			await sendHost(action);
			refresh();
		});

		q(".wecom-btn-push").addEventListener("click", async () => {
			const titleInput = q(".wecom-push-title");
			const textInput = q(".wecom-push-text");
			const text = textInput.value.trim();
			if (!text) {
				alert?.(t("pushTextRequired"));
				return;
			}

			const btn = q(".wecom-btn-push");
			btn.disabled = true;
			btn.textContent = t("sending");
			try {
				const res = await sendHost("send_webhook", {
					payload: {
						msgType: "markdown",
						title: titleInput.value.trim() || t("defaultNotifyTitle"),
						text,
					},
				});
				if (res?.success) {
					alert?.(t("pushSuccess"));
					textInput.value = "";
				} else {
					alert?.(t("sendFailed", { error: res?.message || t("unknownError") }));
				}
			} finally {
				btn.disabled = false;
				btn.textContent = t("sendToGroup");
			}
		});

		// 宿主切语言后重渲染：静态文案就地更新 + 动态状态重拉（输入值与监听保留）
		const offLocale = i18n.onChange(() => {
			try {
				applyStaticTexts(el);
			} catch {}
			try {
				refresh();
			} catch {}
		});

		await refresh();
		return () => {
			try {
				offLocale?.();
			} catch {}
		};
	},
};
