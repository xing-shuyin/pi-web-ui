export default {
	async mount(el, ctx) {
		const sendHost = async (type, payload = {}) => {
			return await ctx.send({ type, ...payload });
		};

		el.innerHTML = `
			<div class="slack-root" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); font-size: 13px;">
				<!-- Topbar Header -->
				<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--bg-elev);">
					<div style="display: flex; align-items: center; gap: 8px;">
						<span style="font-size: 18px;">💬</span>
						<span style="font-weight: 600; font-size: 14px;">Slack 机器人工作台</span>
						<span class="slack-status-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">检测中...</span>
					</div>
					<div style="display: flex; gap: 8px;">
						<button class="slack-btn-config" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">⚙️ 配置凭证</button>
					</div>
				</div>

				<!-- Main Container -->
				<div style="flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px;">
					<!-- Bot Status Overview Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
							<div style="font-weight: 600; font-size: 14px;">🤖 Slack Socket Mode 双工长连接</div>
							<div class="slack-bot-toggle-wrap">
								<button class="slack-btn-toggle-bot" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">切换机器人服务</button>
							</div>
						</div>
						<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">双工状态</div>
								<div class="slack-metric-state" style="font-size: 14px; font-weight: 600;">⚪ 未启动</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">机器人账号</div>
								<div class="slack-metric-username" style="font-size: 14px; font-weight: 600;">--</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">已接收消息</div>
								<div class="slack-metric-recv" style="font-size: 14px; font-weight: 600;">0 条</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">已回复消息</div>
								<div class="slack-metric-sent" style="font-size: 14px; font-weight: 600;">0 条</div>
							</div>
						</div>
						<div style="margin-top: 10px; font-size: 12px; color: var(--text-dim); line-height: 1.5;">
							基于 Slack 官方 Socket Mode 出站 WebSocket，零公网 IP、免反向代理、免开放入站端口。支持在频道（@机器人）或私聊双向对话，自动分配独立上下文。支持 <code>/help</code>、<code>/clear</code>、<code>/status</code> 等斜杠指令。
						</div>
					</div>

					<!-- Send Message Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 12px;">📤 快捷向 Slack 频道发送消息</div>
						<div style="display: flex; flex-direction: column; gap: 10px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">目标 Channel ID (如 C12345678):</label>
								<input type="text" class="slack-send-channelid" placeholder="如：C12345678 (留空使用默认频道)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">消息文本 (支持 Markdown / mrkdwn):</label>
								<textarea class="slack-send-text" rows="3" placeholder="输入要发送的消息内容..." style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); resize: vertical; font-family: inherit;"></textarea>
							</div>
							<div style="display: flex; justify-content: flex-end; gap: 8px;">
								<button class="slack-btn-send" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">🚀 发送消息</button>
							</div>
						</div>
					</div>
				</div>

				<!-- Settings Modal -->
				<div class="slack-modal-settings" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
					<div style="width: 520px; max-width: 90vw; max-height: 85vh; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
						<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<span style="font-weight: 600;">💬 Slack 机器人凭证配置</span>
							<button class="slack-modal-close" style="background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 16px;">✕</button>
						</div>
						<div style="padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">Bot User OAuth Token (xoxb-..., 加密存储):</label>
								<input type="password" class="slack-cfg-bot-token" placeholder="xoxb-... (OAuth & Permissions 中获取)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">App-Level Token (xapp-..., Socket Mode 必需, 加密存储):</label>
								<input type="password" class="slack-cfg-app-token" placeholder="xapp-... (Basic Information → App-Level Tokens 中生成)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								<div style="margin-top: 4px; font-size: 11px; color: var(--text-dim);">需包含 connections:write 权限用于建立 Socket Mode 长连接</div>
							</div>

							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">默认发送 Channel ID (可选):</label>
								<input type="text" class="slack-cfg-default-channel" placeholder="如：C12345678" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;">🤖 机器人双工与白名单控制</div>
								<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
									<input type="checkbox" id="slack-cfg-bot-enabled" class="slack-cfg-bot-enabled" style="cursor: pointer;" />
									<label for="slack-cfg-bot-enabled" style="font-size: 12px; cursor: pointer; user-select: none;">启用 Slack Socket Mode 机器人双向对话服务</label>
								</div>
								<div style="margin-bottom: 8px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">允许的用户白名单 (Slack User ID，逗号分隔，留空不限制):</label>
									<input type="text" class="slack-cfg-allowed-users" placeholder="U123456, U789012 (留空允许所有用户)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div>
									<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
										<label style="color: var(--text-dim);">📂 项目根目录 (Workspace Cwd，留空跟随当前项目，支持聊天发 /cwd 切换):</label>
									</div>
									<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
										<input type="text" class="slack-cfg-workspace" placeholder="如：E:/my-project (留空跟随当前项目)" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
										<select class="slack-cfg-ws-select" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
											<option value="">快速点选已有项目...</option>
										</select>
										<button type="button" class="slack-cfg-ws-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">📂 浏览...</button>
										<button type="button" class="slack-cfg-use-cwd" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">设为当前项目</button>
									</div>
								</div>
								<div style="margin-top: 10px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">✨ AI 模型与思考强度 (留空跟随全局默认):</label>
									<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
										<input type="text" class="slack-cfg-model" placeholder="留空 = 跟随全局默认模型（支持手输或点选）" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
										<button type="button" class="slack-cfg-model-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">✨ 选择模型...</button>
										<select class="slack-cfg-thinking" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
											<option value="">思考强度：跟随全局</option>
											<option value="off">思考：关闭 (off)</option>
											<option value="low">思考：低 (low)</option>
											<option value="medium">思考：中 (medium)</option>
											<option value="high">思考：高 (high)</option>
											<option value="max">思考：最大 (max)</option>
										</select>
									</div>
								</div>
							</div>
						</div>
						<div style="padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<button class="slack-btn-test-cfg" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">🔌 测试连接</button>
							<div style="display: flex; gap: 8px;">
								<button class="slack-modal-cancel" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">取消</button>
								<button class="slack-btn-save-cfg" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">💾 保存配置</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		`;

		const q = (sel) => el.querySelector(sel);
		const statusBadge = q(".slack-status-badge");
		const metricState = q(".slack-metric-state");
		const metricUsername = q(".slack-metric-username");
		const metricRecv = q(".slack-metric-recv");
		const metricSent = q(".slack-metric-sent");
		const modal = q(".slack-modal-settings");

		const cfgBotToken = q(".slack-cfg-bot-token");
		const cfgAppToken = q(".slack-cfg-app-token");
		const cfgDefaultChannel = q(".slack-cfg-default-channel");
		const cfgBotEnabled = q(".slack-cfg-bot-enabled");
		const cfgAllowedUsers = q(".slack-cfg-allowed-users");
		const cfgWorkspace = q(".slack-cfg-workspace");
		const cfgWsSelect = q(".slack-cfg-ws-select");
		const cfgWsBrowse = q(".slack-cfg-ws-browse");
		const cfgModel = q(".slack-cfg-model");
		const cfgModelBrowse = q(".slack-cfg-model-browse");
		const cfgThinking = q(".slack-cfg-thinking");

		let currentState = {};

		async function refresh() {
			const res = await sendHost("get_state");
			if (!res) return;
			currentState = res;

			const b = res.botStatus || {};
			if (b.state === "connected") {
				statusBadge.textContent = "🟢 在线";
				statusBadge.style.color = "var(--green, #22c55e)";
				metricState.textContent = "🟢 已连接 (在线)";
				metricState.style.color = "var(--green, #22c55e)";
			} else if (b.state === "connecting") {
				statusBadge.textContent = "🟡 连接中";
				statusBadge.style.color = "var(--amber, #eab308)";
				metricState.textContent = "🟡 正在连接...";
				metricState.style.color = "var(--amber, #eab308)";
			} else if (b.state === "error") {
				statusBadge.textContent = "🔴 错误";
				statusBadge.style.color = "var(--red, #ef4444)";
				metricState.textContent = "🔴 连接出错";
				metricState.style.color = "var(--red, #ef4444)";
			} else {
				statusBadge.textContent = "⚪ 未启动";
				statusBadge.style.color = "var(--text-dim)";
				metricState.textContent = "⚪ 未启动";
				metricState.style.color = "var(--text-dim)";
			}

			metricUsername.textContent = b.botUsername ? `@${b.botUsername}` : "--";
			metricRecv.textContent = `${b.messagesReceived || 0} 条`;
			metricSent.textContent = `${b.messagesReplied || 0} 条`;
		}

		q(".slack-btn-config").addEventListener("click", () => {
			const cfg = currentState.config || {};
			cfgBotToken.value = "";
			cfgBotToken.placeholder = cfg.hasBotToken ? "●●●●●● (已加密保存，留空保持)" : "填入 xoxb-...";
			cfgAppToken.value = "";
			cfgAppToken.placeholder = cfg.hasAppToken ? "●●●●●● (已加密保存，留空保持)" : "填入 xapp-...";
			cfgDefaultChannel.value = cfg.defaultChannelId || "";
			cfgBotEnabled.checked = Boolean(cfg.botEnabled);
			cfgAllowedUsers.value = Array.isArray(cfg.allowedUsers) ? cfg.allowedUsers.join(", ") : "";
			cfgWorkspace.value = cfg.workspace || "";
			cfgModel.value = cfg.model || "";
			cfgThinking.value = cfg.thinkingLevel || "";

			try {
				const hostProjects = globalThis.window?.__piWebUiHost?.listProjects?.() ?? [];
				cfgWsSelect.innerHTML = '<option value="">快速点选已有项目...</option>';
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

		q(".slack-cfg-use-cwd")?.addEventListener("click", () => {
			if (currentState.hostCwd) cfgWorkspace.value = currentState.hostCwd;
		});
		cfgWsSelect?.addEventListener("change", () => {
			if (cfgWsSelect.value) cfgWorkspace.value = cfgWsSelect.value;
		});
		cfgWsBrowse?.addEventListener("click", async () => {
			const host = globalThis.window?.__piWebUiHost;
			if (typeof host?.pickDirectory !== "function") return;
			const res = await host.pickDirectory({
				title: "选择 Slack 机器人执行项目根目录",
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
		q(".slack-modal-close").addEventListener("click", () => (modal.style.display = "none"));
		q(".slack-modal-cancel").addEventListener("click", () => (modal.style.display = "none"));

		q(".slack-btn-test-cfg").addEventListener("click", async () => {
			const btn = q(".slack-btn-test-cfg");
			btn.disabled = true;
			btn.textContent = "测试中...";
			const testCfg = {
				botToken: cfgBotToken.value.trim(),
				appToken: cfgAppToken.value.trim(),
			};
			const res = await sendHost("test_config", { config: testCfg });
			btn.disabled = false;
			btn.textContent = "🔌 测试连接";
			alert?.(res?.message || (res?.success ? "连接测试通过！" : "测试失败"));
		});

		q(".slack-btn-save-cfg").addEventListener("click", async () => {
			const btn = q(".slack-btn-save-cfg");
			btn.disabled = true;
			btn.textContent = "保存中...";

			const newCfg = {
				botToken: cfgBotToken.value.trim(),
				appToken: cfgAppToken.value.trim(),
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
			btn.textContent = "💾 保存配置";

			if (res?.success) {
				modal.style.display = "none";
				refresh();
			} else {
				alert?.(`保存失败: ${res?.message || "未知错误"}`);
			}
		});

		q(".slack-btn-toggle-bot").addEventListener("click", async () => {
			const isRunning = currentState.botStatus?.state === "connected";
			const action = isRunning ? "stop_bot" : "start_bot";
			await sendHost(action);
			refresh();
		});

		q(".slack-btn-send").addEventListener("click", async () => {
			const channelInput = q(".slack-send-channelid");
			const textInput = q(".slack-send-text");
			const text = textInput.value.trim();
			if (!text) {
				alert?.("请输入要发送的消息文本");
				return;
			}

			const btn = q(".slack-btn-send");
			btn.disabled = true;
			btn.textContent = "发送中...";
			try {
				const res = await sendHost("send_message", {
					channelId: channelInput.value.trim(),
					text,
				});
				if (res?.success) {
					alert?.("✅ Slack 消息发送成功！");
					textInput.value = "";
				} else {
					alert?.(`发送失败: ${res?.message || "未知错误"}`);
				}
			} finally {
				btn.disabled = false;
				btn.textContent = "🚀 发送消息";
			}
		});

		await refresh();
	},
};
