export default {
	async mount(el, ctx) {
		const sendHost = async (type, payload = {}) => {
			return await ctx.send({ type, ...payload });
		};

		el.innerHTML = `
			<div class="wecom-root" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); font-size: 13px;">
				<!-- Topbar Header -->
				<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--bg-elev);">
					<div style="display: flex; align-items: center; gap: 8px;">
						<span style="font-size: 18px;">💼</span>
						<span style="font-weight: 600; font-size: 14px;">企业微信 (WeCom) 工作台与机器人</span>
						<span class="wecom-status-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">检测中...</span>
					</div>
					<div style="display: flex; gap: 8px;">
						<button class="wecom-btn-config" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">⚙️ 配置凭证</button>
					</div>
				</div>

				<!-- Main Container -->
				<div style="flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px;">
					<!-- Bot Status Overview Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
							<div style="font-weight: 600; font-size: 14px;">🤖 企业微信机器人 (Bot) 状态</div>
							<div class="wecom-bot-toggle-wrap">
								<button class="wecom-btn-toggle-bot" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">切换机器人服务</button>
							</div>
						</div>
						<div style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); display: grid; gap: 12px;">
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">回调桥接状态</div>
								<div class="wecom-metric-state" style="font-size: 14px; font-weight: 600;">⚪ 未启动</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">已接收消息</div>
								<div class="wecom-metric-recv" style="font-size: 14px; font-weight: 600;">0 条</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">已回复消息</div>
								<div class="wecom-metric-sent" style="font-size: 14px; font-weight: 600;">0 条</div>
							</div>
						</div>
						<div style="margin-top: 10px; font-size: 12px; color: var(--text-dim); line-height: 1.5;">
							支持群机器人 Webhook 与企业内部自建应用消息。对话回复自动按企微格式结构化分块，支持 <code>/help</code>、<code>/clear</code>、<code>/status</code> 等斜杠快捷指令。
						</div>
					</div>

					<!-- Webhook Push Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 12px;">📣 群机器人 Webhook 快捷卡片推送</div>
						<div style="display: flex; flex-direction: column; gap: 10px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">卡片标题:</label>
								<input type="text" class="wecom-push-title" placeholder="如：系统发布通知 / 告警通报" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">Markdown 正文内容:</label>
								<textarea class="wecom-push-text" rows="4" placeholder="支持企微 Markdown 格式，例如：\n> **构建状态**：成功\n> **提交信息**：修复已知问题" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); resize: vertical; font-family: inherit;"></textarea>
							</div>
							<div style="display: flex; justify-content: flex-end; gap: 8px;">
								<button class="wecom-btn-push" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">🚀 一键推送到企业微信群</button>
							</div>
						</div>
					</div>
				</div>

				<!-- Settings Modal -->
				<div class="wecom-modal-settings" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
					<div style="width: 520px; max-width: 90vw; max-height: 85vh; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
						<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<span style="font-weight: 600;">💼 企业微信参数配置</span>
							<button class="wecom-modal-close" style="background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 16px;">✕</button>
						</div>
						<div style="padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;">
							<div>
								<div style="font-weight: 600; margin-bottom: 8px;">群机器人 Webhook (快速接入群消息推送)</div>
								<div>
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">Webhook Key (或完整地址中的 key 参数, 加密保存):</label>
									<input type="password" class="wecom-cfg-webhook-key" placeholder="693a91f6-7xxx-4xxx-xxxx-xxxxxxxxxxxx" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;">企业自建应用 API (可选，发送应用消息与单聊)</div>
								<div style="display: flex; gap: 10px; margin-bottom: 8px;">
									<div style="flex: 1;">
										<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">CorpID (企业 ID):</label>
										<input type="text" class="wecom-cfg-corpid" placeholder="wwxxxxxxxxxxxxxxxx" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
									</div>
									<div style="flex: 1;">
										<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">CorpSecret (应用凭证密钥):</label>
										<input type="password" class="wecom-cfg-corpsecret" placeholder="留空保持不变" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
									</div>
								</div>
								<div>
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">AgentId (应用 AgentId):</label>
									<input type="text" class="wecom-cfg-agentid" placeholder="1000002" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;">🤖 回调桥接与白名单控制</div>
								<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
									<input type="checkbox" id="wecom-cfg-bot-enabled" class="wecom-cfg-bot-enabled" style="cursor: pointer;" />
									<label for="wecom-cfg-bot-enabled" style="font-size: 12px; cursor: pointer; user-select: none;">启用内部会话桥接（需另接可信回调适配器）</label>
								</div>
								<div style="margin-bottom: 8px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">安全白名单 (用户账号/UserId，逗号分隔，留空不限制):</label>
									<input type="text" class="wecom-cfg-allowed-users" placeholder="zhangsan, lisi (留空允许所有用户)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div>
									<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
										<label style="color: var(--text-dim);">📂 项目根目录 (Workspace Cwd，留空跟随当前项目，支持聊天发 /cwd 切换):</label>
									</div>
									<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
										<input type="text" class="wecom-cfg-workspace" placeholder="如：E:/my-project (留空跟随当前项目)" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
										<select class="wecom-cfg-ws-select" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
											<option value="">快速点选已有项目...</option>
										</select>
										<button type="button" class="wecom-cfg-ws-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">📂 浏览...</button>
										<button type="button" class="wecom-cfg-use-cwd" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">设为当前项目</button>
									</div>
								</div>
								<div style="margin-top: 10px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">✨ AI 模型与思考强度 (留空跟随全局默认):</label>
									<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
										<input type="text" class="wecom-cfg-model" placeholder="留空 = 跟随全局默认模型（支持手输或点选）" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
										<button type="button" class="wecom-cfg-model-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">✨ 选择模型...</button>
										<select class="wecom-cfg-thinking" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
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
							<button class="wecom-btn-test-cfg" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">🔌 测试连接</button>
							<div style="display: flex; gap: 8px;">
								<button class="wecom-modal-cancel" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">取消</button>
								<button class="wecom-btn-save-cfg" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">💾 保存配置</button>
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
				statusBadge.textContent = "🟡 桥接已启用";
				statusBadge.style.color = "var(--amber, #eab308)";
				metricState.textContent = "🟡 需外部回调接入（Webhook 仅发送）";
				metricState.style.color = "var(--amber, #eab308)";
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

			metricRecv.textContent = `${b.messagesReceived || 0} 条`;
			metricSent.textContent = `${b.messagesReplied || 0} 条`;
		}

		q(".wecom-btn-config").addEventListener("click", () => {
			const cfg = currentState.config || {};
			cfgWebhookKey.value = "";
			cfgWebhookKey.placeholder = cfg.hasWebhookKey ? "●●●●●● (已加密保存，留空保持)" : "填入 Webhook Key";
			cfgCorpId.value = cfg.corpId || "";
			cfgCorpSecret.value = "";
			cfgCorpSecret.placeholder = cfg.hasCorpSecret ? "●●●●●● (已加密保存，留空保持)" : "填入 CorpSecret";
			cfgAgentId.value = cfg.agentId || "";
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
				title: "选择企业微信机器人执行项目根目录",
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
			btn.textContent = "测试中...";
			const testCfg = {
				webhookKey: cfgWebhookKey.value.trim(),
				corpId: cfgCorpId.value.trim(),
				corpSecret: cfgCorpSecret.value.trim(),
			};
			const res = await sendHost("test_config", { config: testCfg });
			btn.disabled = false;
			btn.textContent = "🔌 测试连接";

			const messages = res?.results?.messages || [];
			alert?.(messages.join("\n") || (res?.success ? "连接测试通过！" : "测试未通过"));
		});

		q(".wecom-btn-save-cfg").addEventListener("click", async () => {
			const btn = q(".wecom-btn-save-cfg");
			btn.disabled = true;
			btn.textContent = "保存中...";

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
			btn.textContent = "💾 保存配置";

			if (res?.success) {
				modal.style.display = "none";
				refresh();
			} else {
				alert?.(`保存失败: ${res?.message || "未知错误"}`);
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
				alert?.("请输入 Markdown 正文内容");
				return;
			}

			const btn = q(".wecom-btn-push");
			btn.disabled = true;
			btn.textContent = "发送中...";
			try {
				const res = await sendHost("send_webhook", {
					payload: {
						msgType: "markdown",
						title: titleInput.value.trim() || "通知",
						text,
					},
				});
				if (res?.success) {
					alert?.("✅ 企业微信消息推送成功！");
					textInput.value = "";
				} else {
					alert?.(`发送失败: ${res?.message || "未知错误"}`);
				}
			} finally {
				btn.disabled = false;
				btn.textContent = "🚀 一键推送到企业微信群";
			}
		});

		await refresh();
	},
};
