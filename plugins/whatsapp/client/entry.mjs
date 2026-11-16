import { makeT } from "./i18n.mjs";

const t = makeT();

export default {
	async mount(el, ctx) {
		const sendHost = async (type, payload = {}) => {
			return await ctx.send({ type, ...payload });
		};

		el.innerHTML = `
			<div class="whatsapp-root" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); font-size: 13px;">
				<!-- Topbar Header -->
				<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--bg-elev);">
					<div style="display: flex; align-items: center; gap: 8px;">
						<span style="font-size: 18px;">🟢</span>
						<span style="font-weight: 600; font-size: 14px;">${t("workspaceTitle")}</span>
						<span class="whatsapp-status-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">${t("checking")}</span>
					</div>
					<div style="display: flex; gap: 8px;">
						<button class="whatsapp-btn-config" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">${t("configureCredentials")}</button>
					</div>
				</div>

				<!-- Main Container -->
				<div style="flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px;">
					<!-- Bot Status Overview Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
							<div style="font-weight: 600; font-size: 14px;">${t("botStatusTitle")}</div>
							<div class="whatsapp-bot-toggle-wrap">
								<button class="whatsapp-btn-toggle-bot" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">${t("toggleBotService")}</button>
							</div>
						</div>
						<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">${t("duplexStatus")}</div>
								<div class="whatsapp-metric-state" style="font-size: 14px; font-weight: 600;">${t("stateStopped")}</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">${t("linkedAccount")}</div>
								<div class="whatsapp-metric-phone" style="font-size: 14px; font-weight: 600;">--</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">${t("messagesReceived")}</div>
								<div class="whatsapp-metric-recv" style="font-size: 14px; font-weight: 600;">${t("msgCount", { count: 0 })}</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">${t("messagesReplied")}</div>
								<div class="whatsapp-metric-sent" style="font-size: 14px; font-weight: 600;">${t("msgCount", { count: 0 })}</div>
							</div>
						</div>
						<div style="margin-top: 10px; font-size: 12px; color: var(--text-dim); line-height: 1.5;">
							${t("botIntro")}
						</div>
					</div>

					<!-- Send Message Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 12px;">${t("sendCardTitle")}</div>
						<div style="display: flex; flex-direction: column; gap: 10px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${t("targetPhoneLabel")}</label>
								<input type="text" class="whatsapp-send-phone" placeholder="${t("targetPhonePlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${t("messageTextLabel")}</label>
								<textarea class="whatsapp-send-text" rows="3" placeholder="${t("messageTextPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); resize: vertical; font-family: inherit;"></textarea>
							</div>
							<select class="whatsapp-send-kind" aria-label="${t("messageKindAria")}" style="background: var(--bg); color: var(--text);"><option value="">${t("kindText")}</option><option value="image">${t("kindImage")}</option><option value="audio">${t("kindAudio")}</option><option value="document">${t("kindDocument")}</option><option value="video">${t("kindVideo")}</option></select>
							<input class="whatsapp-send-path" placeholder="${t("mediaPathPlaceholder")}" aria-label="${t("mediaPathAria")}" style="min-width: 0; max-width: 100%; background: var(--bg); color: var(--text);" />
							<input class="whatsapp-send-mime" placeholder="${t("mimePlaceholder")}" aria-label="${t("mimeAria")}" style="min-width: 0; max-width: 100%; background: var(--bg); color: var(--text);" />
							<div style="display: flex; justify-content: flex-end; gap: 8px;">
								<button class="whatsapp-btn-send" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">${t("sendMessage")}</button>
							</div>
						</div>
					</div>
				</div>

				<!-- Settings Modal -->
				<div class="whatsapp-modal-settings" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
					<div style="width: 520px; max-width: 90vw; max-height: 85vh; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
						<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<span style="font-weight: 600;">${t("credentialsTitle")}</span>
							<button class="whatsapp-modal-close" style="background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 16px;">✕</button>
						</div>
						<div style="padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${t("phoneIdLabel")}</label>
								<input type="text" class="whatsapp-cfg-phoneid" placeholder="${t("phoneIdPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								<div style="margin-top: 4px; font-size: 11px; color: var(--text-dim);">${t("phoneIdHint")}</div>
							</div>

							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${t("accessTokenLabel")}</label>
								<input type="password" class="whatsapp-cfg-token" placeholder="${t("accessTokenPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${t("defaultRecipientLabel")}</label>
								<input type="text" class="whatsapp-cfg-default-recipient" placeholder="${t("defaultRecipientPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;">${t("botControlTitle")}</div>
								<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
									<input type="checkbox" id="whatsapp-cfg-bot-enabled" class="whatsapp-cfg-bot-enabled" style="cursor: pointer;" />
									<label for="whatsapp-cfg-bot-enabled" style="font-size: 12px; cursor: pointer; user-select: none;">${t("botEnabledLabel")}</label>
								</div>
								<div style="margin-bottom: 8px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${t("allowlistLabel")}</label>
									<input type="text" class="whatsapp-cfg-allowed-users" placeholder="${t("allowlistPlaceholder")}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div>
									<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
										<label style="color: var(--text-dim);">${t("workspaceLabel")}</label>
									</div>
									<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
										<input type="text" class="whatsapp-cfg-workspace" placeholder="${t("workspacePlaceholder")}" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
										<select class="whatsapp-cfg-ws-select" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
											<option value="">${t("quickPickProject")}</option>
										</select>
										<button type="button" class="whatsapp-cfg-ws-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">${t("browse")}</button>
										<button type="button" class="whatsapp-cfg-use-cwd" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">${t("useCurrentProject")}</button>
									</div>
								</div>
								<div style="margin-top: 10px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${t("modelLabel")}</label>
									<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
										<input type="text" class="whatsapp-cfg-model" placeholder="${t("modelPlaceholder")}" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
										<button type="button" class="whatsapp-cfg-model-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">${t("pickModel")}</button>
										<select class="whatsapp-cfg-thinking" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
											<option value="">${t("thinkingFollow")}</option>
											<option value="off">${t("thinkingOff")}</option>
											<option value="low">${t("thinkingLow")}</option>
											<option value="medium">${t("thinkingMedium")}</option>
											<option value="high">${t("thinkingHigh")}</option>
											<option value="minimal">${t("thinkingMinimal")}</option>
											<option value="xhigh">${t("thinkingXhigh")}</option>
										</select>
									</div>
								</div>
							</div>
						</div>
						<div style="padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<button class="whatsapp-btn-test-cfg" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">${t("testConnection")}</button>
							<div style="display: flex; gap: 8px;">
								<button class="whatsapp-modal-cancel" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">${t("cancel")}</button>
								<button class="whatsapp-btn-save-cfg" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">${t("saveConfig")}</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		`;

		const q = (sel) => el.querySelector(sel);
		const statusBadge = q(".whatsapp-status-badge");
		const metricState = q(".whatsapp-metric-state");
		const metricPhone = q(".whatsapp-metric-phone");
		const metricRecv = q(".whatsapp-metric-recv");
		const metricSent = q(".whatsapp-metric-sent");
		const modal = q(".whatsapp-modal-settings");

		const cfgPhoneId = q(".whatsapp-cfg-phoneid");
		const cfgToken = q(".whatsapp-cfg-token");
		const cfgDefaultRecipient = q(".whatsapp-cfg-default-recipient");
		const cfgBotEnabled = q(".whatsapp-cfg-bot-enabled");
		const cfgAllowedUsers = q(".whatsapp-cfg-allowed-users");
		const cfgWorkspace = q(".whatsapp-cfg-workspace");
		const cfgWsSelect = q(".whatsapp-cfg-ws-select");
		const cfgWsBrowse = q(".whatsapp-cfg-ws-browse");
		const cfgModel = q(".whatsapp-cfg-model");
		const cfgModelBrowse = q(".whatsapp-cfg-model-browse");
		const cfgThinking = q(".whatsapp-cfg-thinking");

		let currentState = {};

		async function refresh() {
			const res = await sendHost("get_state");
			if (!res) return;
			currentState = res;

			const b = res.botStatus || {};
			if (b.state === "connected") {
				statusBadge.textContent = t("stateOnline");
				statusBadge.style.color = "var(--green, #22c55e)";
				metricState.textContent = t("stateConnected");
				metricState.style.color = "var(--green, #22c55e)";
			} else if (b.state === "connecting") {
				statusBadge.textContent = t("stateConnecting");
				statusBadge.style.color = "var(--amber, #eab308)";
				metricState.textContent = t("stateConnectingDetail");
				metricState.style.color = "var(--amber, #eab308)";
			} else if (b.state === "error") {
				statusBadge.textContent = t("stateError");
				statusBadge.style.color = "var(--red, #ef4444)";
				metricState.textContent = t("stateErrorDetail");
				metricState.style.color = "var(--red, #ef4444)";
			} else {
				statusBadge.textContent = t("stateStopped");
				statusBadge.style.color = "var(--text-dim)";
				metricState.textContent = t("stateStopped");
				metricState.style.color = "var(--text-dim)";
			}

			metricPhone.textContent = b.displayPhone || "--";
			metricRecv.textContent = t("msgCount", { count: b.messagesReceived || 0 });
			metricSent.textContent = t("msgCount", { count: b.messagesReplied || 0 });
		}

		q(".whatsapp-btn-config").addEventListener("click", () => {
			const cfg = currentState.config || {};
			cfgPhoneId.value = cfg.phoneNumberId || "";
			cfgToken.value = "";
			cfgToken.placeholder = cfg.hasAccessToken ? t("accessTokenSaved") : t("accessTokenEnter");
			cfgDefaultRecipient.value = cfg.defaultRecipient || "";
			cfgBotEnabled.checked = Boolean(cfg.botEnabled);
			cfgAllowedUsers.value = Array.isArray(cfg.allowedUsers) ? cfg.allowedUsers.join(", ") : "";
			cfgWorkspace.value = cfg.workspace || "";
			cfgModel.value = cfg.model || "";
			cfgThinking.value = cfg.thinkingLevel || "";

			try {
				const hostProjects = globalThis.window?.__piWebUiHost?.listProjects?.() ?? [];
				cfgWsSelect.innerHTML = `<option value="">${t("quickPickProject")}</option>`;
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

		q(".whatsapp-cfg-use-cwd")?.addEventListener("click", () => {
			if (currentState.hostCwd) cfgWorkspace.value = currentState.hostCwd;
		});
		cfgWsSelect?.addEventListener("change", () => {
			if (cfgWsSelect.value) cfgWorkspace.value = cfgWsSelect.value;
		});
		cfgWsBrowse?.addEventListener("click", async () => {
			const host = globalThis.window?.__piWebUiHost;
			if (typeof host?.pickDirectory !== "function") return;
			const res = await host.pickDirectory({
				title: t("pickWorkspaceTitle"),
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
		q(".whatsapp-modal-close").addEventListener("click", () => (modal.style.display = "none"));
		q(".whatsapp-modal-cancel").addEventListener("click", () => (modal.style.display = "none"));

		q(".whatsapp-btn-test-cfg").addEventListener("click", async () => {
			const btn = q(".whatsapp-btn-test-cfg");
			btn.disabled = true;
			btn.textContent = t("testing");
			const testCfg = {
				phoneNumberId: cfgPhoneId.value.trim(),
				accessToken: cfgToken.value.trim(),
			};
			const res = await sendHost("test_config", { config: testCfg });
			btn.disabled = false;
			btn.textContent = t("testConnection");
			// res.message 由服务端下发（服务端自有文案），仅在缺失时用本地兜底
			alert?.(res?.message || (res?.success ? t("testPassed") : t("testFailed")));
		});

		q(".whatsapp-btn-save-cfg").addEventListener("click", async () => {
			const btn = q(".whatsapp-btn-save-cfg");
			btn.disabled = true;
			btn.textContent = t("saving");

			const newCfg = {
				phoneNumberId: cfgPhoneId.value.trim(),
				accessToken: cfgToken.value.trim(),
				defaultRecipient: cfgDefaultRecipient.value.trim(),
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

		q(".whatsapp-btn-toggle-bot").addEventListener("click", async () => {
			const isRunning = currentState.botStatus?.state === "connected";
			const action = isRunning ? "stop_bot" : "start_bot";
			await sendHost(action);
			refresh();
		});

		q(".whatsapp-btn-send").addEventListener("click", async () => {
			const phoneInput = q(".whatsapp-send-phone");
			const textInput = q(".whatsapp-send-text");
			const text = textInput.value.trim();
			const type = q(".whatsapp-send-kind").value;
			const path = q(".whatsapp-send-path").value.trim();
			if (type ? !path : !text) {
				alert?.(type ? t("sendMissingPath") : t("sendMissingText"));
				return;
			}

			const btn = q(".whatsapp-btn-send");
			btn.disabled = true;
			btn.textContent = t("sending");
			try {
				const res = await sendHost(type ? "send_media" : "send_message", {
					to: phoneInput.value.trim(),
					text,
					mediaType: type,
					path,
					caption: text,
					mimeType: q(".whatsapp-send-mime").value.trim(),
				});
				if (res?.success) {
					alert?.(t("sendOk"));
					textInput.value = "";
				} else {
					alert?.(t("sendFailed", { error: res?.message || t("unknownError") }));
				}
			} catch (err) {
				alert?.(t("sendFailed", { error: err.message }));
			} finally {
				btn.disabled = false;
				btn.textContent = t("sendMessage");
			}
		});

		await refresh();
	},
};
