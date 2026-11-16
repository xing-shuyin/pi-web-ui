import { makeT } from "./i18n.mjs";

/** 面板文案：语言解析 / 回退 / 插值都在 SDK 里，这里只按当前界面语言取词。 */
const t = makeT();

export default {
	async mount(el, ctx) {
		const sendHost = async (type, payload = {}) => {
			return await ctx.send({ type, ...payload });
		};

		el.innerHTML = `
			<div class="discord-root" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); font-size: 13px;">
				<!-- Topbar Header -->
				<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--bg-elev);">
					<div style="display: flex; align-items: center; gap: 8px;">
						<span style="font-size: 18px;">🎮</span>
						<span style="font-weight: 600; font-size: 14px;">${t("workbenchTitle")}</span>
						<span class="discord-status-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">${t("statusChecking")}</span>
					</div>
					<div style="display: flex; gap: 8px;">
						<button class="discord-btn-config" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">${t("configCredentials")}</button>
					</div>
				</div>

				<!-- Main Container -->
				<div style="flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px;">
					<!-- Bot Status Overview Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
							<div style="font-weight: 600; font-size: 14px;">${t("botStatusTitle")}</div>
							<div class="discord-bot-toggle-wrap">
								<button class="discord-btn-toggle-bot" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">${t("toggleBotService")}</button>
							</div>
						</div>
						<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">${t("duplexState")}</div>
								<div class="discord-metric-state" style="font-size: 14px; font-weight: 600;">${t("notStarted")}</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">${t("botAccount")}</div>
								<div class="discord-metric-username" style="font-size: 14px; font-weight: 600;">--</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">${t("messagesReceived")}</div>
								<div class="discord-metric-recv" style="font-size: 14px; font-weight: 600;">${t("msgCount", { n: 0 })}</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">${t("messagesReplied")}</div>
								<div class="discord-metric-sent" style="font-size: 14px; font-weight: 600;">${t("msgCount", { n: 0 })}</div>
							</div>
						</div>
						<div style="margin-top: 10px; font-size: 12px; color: var(--text-dim); line-height: 1.5;">
							${t("botDescription")}
						</div>
					</div>

					<!-- Send Message Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 12px;">${t("sendCardTitle")}</div>
						<div style="display: flex; flex-direction: column; gap: 10px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${t("channelIdLabel")}</label>
								<input type="text" class="discord-send-channelid" placeholder="${t("channelIdPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${t("messageTextLabel")}</label>
								<textarea class="discord-send-text" rows="3" placeholder="${t("messageTextPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); resize: vertical; font-family: inherit;"></textarea>
							</div>
							<div style="display: flex; justify-content: flex-end; gap: 8px;">
								<button class="discord-btn-send" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">${t("sendMessage")}</button>
							</div>
						</div>
					</div>
				</div>

				<!-- Settings Modal -->
				<div class="discord-modal-settings" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
					<div style="width: 520px; max-width: 90vw; max-height: 85vh; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
						<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<span style="font-weight: 600;">${t("settingsTitle")}</span>
							<button class="discord-modal-close" style="background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 16px;">✕</button>
						</div>
						<div style="padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${t("botTokenLabel")}</label>
								<input type="password" class="discord-cfg-token" placeholder="${t("botTokenPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								<div style="margin-top: 4px; font-size: 11px; color: var(--text-dim);">${t("botTokenHint")}</div>
							</div>

							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${t("defaultChannelLabel")}</label>
								<input type="text" class="discord-cfg-default-channel" placeholder="${t("defaultChannelPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;">${t("botAccessTitle")}</div>
								<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
									<input type="checkbox" id="discord-cfg-bot-enabled" class="discord-cfg-bot-enabled" style="cursor: pointer;" />
									<label for="discord-cfg-bot-enabled" style="font-size: 12px; cursor: pointer; user-select: none;">${t("botEnabledLabel")}</label>
								</div>
								<div style="margin-bottom: 8px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${t("whitelistLabel")}</label>
									<input type="text" class="discord-cfg-allowed-users" placeholder="${t("whitelistPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div>
									<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
										<label style="color: var(--text-dim);">${t("workspaceLabel")}</label>
									</div>
									<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
										<input type="text" class="discord-cfg-workspace" placeholder="${t("workspacePlaceholder")}" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
										<select class="discord-cfg-ws-select" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
											<option value="">${t("selectProjectPlaceholder")}</option>
										</select>
										<button type="button" class="discord-cfg-ws-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">${t("browse")}</button>
										<button type="button" class="discord-cfg-use-cwd" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">${t("useCurrentProject")}</button>
									</div>
								</div>
								<div style="margin-top: 10px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${t("modelLabel")}</label>
									<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
										<input type="text" class="discord-cfg-model" placeholder="${t("modelPlaceholder")}" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
										<button type="button" class="discord-cfg-model-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">${t("selectModel")}</button>
										<select class="discord-cfg-thinking" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
											<option value="">${t("thinkingFollowGlobal")}</option>
											<option value="off">${t("thinkingOff")}</option>
											<option value="low">${t("thinkingLow")}</option>
											<option value="medium">${t("thinkingMedium")}</option>
											<option value="high">${t("thinkingHigh")}</option>
											<option value="max">${t("thinkingMax")}</option>
										</select>
									</div>
								</div>
							</div>
						</div>
						<div style="padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<button class="discord-btn-test-cfg" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">${t("testConnection")}</button>
							<div style="display: flex; gap: 8px;">
								<button class="discord-modal-cancel" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">${t("cancel")}</button>
								<button class="discord-btn-save-cfg" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">${t("saveConfig")}</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		`;

		const q = (sel) => el.querySelector(sel);
		const statusBadge = q(".discord-status-badge");
		const metricState = q(".discord-metric-state");
		const metricUsername = q(".discord-metric-username");
		const metricRecv = q(".discord-metric-recv");
		const metricSent = q(".discord-metric-sent");
		const modal = q(".discord-modal-settings");

		const cfgToken = q(".discord-cfg-token");
		const cfgDefaultChannel = q(".discord-cfg-default-channel");
		const cfgBotEnabled = q(".discord-cfg-bot-enabled");
		const cfgAllowedUsers = q(".discord-cfg-allowed-users");
		const cfgWorkspace = q(".discord-cfg-workspace");
		const cfgWsSelect = q(".discord-cfg-ws-select");
		const cfgWsBrowse = q(".discord-cfg-ws-browse");
		const cfgModel = q(".discord-cfg-model");
		const cfgModelBrowse = q(".discord-cfg-model-browse");
		const cfgThinking = q(".discord-cfg-thinking");

		let currentState = {};

		async function refresh() {
			const res = await sendHost("get_state");
			if (!res) return;
			currentState = res;

			const b = res.botStatus || {};
			if (b.state === "connected") {
				statusBadge.textContent = t("online");
				statusBadge.style.color = "var(--green, #22c55e)";
				metricState.textContent = t("connectedOnline");
				metricState.style.color = "var(--green, #22c55e)";
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

			metricUsername.textContent = b.botUsername ? `@${b.botUsername}` : "--";
			metricRecv.textContent = t("msgCount", { n: b.messagesReceived || 0 });
			metricSent.textContent = t("msgCount", { n: b.messagesReplied || 0 });
		}

		q(".discord-btn-config").addEventListener("click", () => {
			const cfg = currentState.config || {};
			cfgToken.value = "";
			cfgToken.placeholder = cfg.hasBotToken ? t("secretStoredPlaceholder") : t("botTokenFillPlaceholder");
			cfgDefaultChannel.value = cfg.defaultChannelId || "";
			cfgBotEnabled.checked = Boolean(cfg.botEnabled);
			cfgAllowedUsers.value = Array.isArray(cfg.allowedUsers) ? cfg.allowedUsers.join(", ") : "";
			cfgWorkspace.value = cfg.workspace || "";
			cfgModel.value = cfg.model || "";
			cfgThinking.value = cfg.thinkingLevel || "";

			try {
				const hostProjects = globalThis.window?.__piWebUiHost?.listProjects?.() ?? [];
				cfgWsSelect.innerHTML = `<option value="">${t("selectProjectPlaceholder")}</option>`;
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

		q(".discord-cfg-use-cwd")?.addEventListener("click", () => {
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
		q(".discord-modal-close").addEventListener("click", () => (modal.style.display = "none"));
		q(".discord-modal-cancel").addEventListener("click", () => (modal.style.display = "none"));

		q(".discord-btn-test-cfg").addEventListener("click", async () => {
			const btn = q(".discord-btn-test-cfg");
			btn.disabled = true;
			btn.textContent = t("testing");
			const testCfg = {
				botToken: cfgToken.value.trim(),
			};
			const res = await sendHost("test_config", { config: testCfg });
			btn.disabled = false;
			btn.textContent = t("testConnection");
			alert?.(res?.message || (res?.success ? t("testPassed") : t("testFailed")));
		});

		q(".discord-btn-save-cfg").addEventListener("click", async () => {
			const btn = q(".discord-btn-save-cfg");
			btn.disabled = true;
			btn.textContent = t("saving");

			const newCfg = {
				botToken: cfgToken.value.trim(),
				defaultChannelId: cfgDefaultChannel.value.trim(),
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

		q(".discord-btn-toggle-bot").addEventListener("click", async () => {
			const isRunning = currentState.botStatus?.state === "connected";
			const action = isRunning ? "stop_bot" : "start_bot";
			await sendHost(action);
			refresh();
		});

		q(".discord-btn-send").addEventListener("click", async () => {
			const channelInput = q(".discord-send-channelid");
			const textInput = q(".discord-send-text");
			const text = textInput.value.trim();
			if (!text) {
				alert?.(t("sendTextRequired"));
				return;
			}

			const btn = q(".discord-btn-send");
			btn.disabled = true;
			btn.textContent = t("sending");
			try {
				const res = await sendHost("send_message", {
					channelId: channelInput.value.trim(),
					text,
				});
				if (res?.success) {
					alert?.(t("sendSuccess"));
					textInput.value = "";
				} else {
					alert?.(t("sendFailed", { error: res?.message || t("unknownError") }));
				}
			} finally {
				btn.disabled = false;
				btn.textContent = t("sendMessage");
			}
		});

		await refresh();
	},
};
