export default {
	async mount(el, ctx) {
		const sendHost = async (type, payload = {}) => {
			return await ctx.send({ type, ...payload });
		};

		el.innerHTML = `
			<div class="dingtalk-root" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); font-size: 13px;">
				<!-- Topbar Header -->
				<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--bg-elev);">
					<div style="display: flex; align-items: center; gap: 8px;">
						<span style="font-size: 18px;">📌</span>
						<span style="font-weight: 600; font-size: 14px;">钉钉 (DingTalk) 工作台与机器人</span>
						<span class="dingtalk-status-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">检测中...</span>
					</div>
					<div style="display: flex; gap: 8px;">
						<button class="dingtalk-btn-config" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">⚙️ 配置凭证</button>
					</div>
				</div>

				<!-- Main Container -->
				<div style="flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px;">
					<!-- Bot Status Overview Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
							<div style="font-weight: 600; font-size: 14px;">🤖 钉钉机器人 (Bot) 双工状态</div>
							<div class="dingtalk-bot-toggle-wrap">
								<button class="dingtalk-btn-toggle-bot" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">切换机器人服务</button>
							</div>
						</div>
						<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">双工状态</div>
								<div class="dingtalk-metric-state" style="font-size: 14px; font-weight: 600;">⚪ 未启动</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">已接收消息</div>
								<div class="dingtalk-metric-recv" style="font-size: 14px; font-weight: 600;">0 条</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">已回复消息</div>
								<div class="dingtalk-metric-sent" style="font-size: 14px; font-weight: 600;">0 条</div>
							</div>
						</div>
						<div style="margin-top: 10px; font-size: 12px; color: var(--text-dim); line-height: 1.5;">
							支持群聊 @机器人 或单聊触发，自动接入 pi-web-ui 独立对话会话。支持 <code>/help</code>、<code>/clear</code>、<code>/status</code> 等斜杠快捷指令，超长 Markdown 自动结构化分块，代码块完整闭合。
						</div>
					</div>

					<!-- Webhook Quick Push Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 12px;">📣 群机器人自定义 Webhook 快捷推送</div>
						<div style="display: flex; flex-direction: column; gap: 10px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">卡片标题:</label>
								<input type="text" class="dingtalk-push-title" placeholder="通知标题 (如：构建完成通报)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">Markdown 正文内容:</label>
								<textarea class="dingtalk-push-text" rows="4" placeholder="支持标准 Markdown 语法，如：### 项目构建完成\n- 状态：成功\n- 分支：main" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); resize: vertical; font-family: inherit;"></textarea>
							</div>
							<div style="display: flex; justify-content: flex-end; gap: 8px;">
								<button class="dingtalk-btn-push" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">🚀 一键发送到钉钉群</button>
							</div>
						</div>
					</div>
				</div>

				<!-- Settings Modal -->
				<div class="dingtalk-modal-settings" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
					<div style="width: 520px; max-width: 90vw; max-height: 85vh; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
						<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<span style="font-weight: 600;">📌 钉钉集成参数配置</span>
							<button class="dingtalk-modal-close" style="background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 16px;">✕</button>
						</div>
						<div style="padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;">
							<div>
								<div style="font-weight: 600; margin-bottom: 8px;">企业自建应用 / 机器人 API (支持双工对话与长连接)</div>
								<div style="display: flex; gap: 10px; margin-bottom: 8px;">
									<div style="flex: 1;">
										<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">AppKey (ClientId):</label>
										<input type="text" class="dingtalk-cfg-appkey" placeholder="dingxxxxxxxx" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
									</div>
									<div style="flex: 1;">
										<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">AppSecret (加密保存):</label>
										<input type="password" class="dingtalk-cfg-appsecret" placeholder="留空保持不变" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
									</div>
								</div>
								<div>
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">RobotCode (机器人标识，可选):</label>
									<input type="text" class="dingtalk-cfg-robotcode" placeholder="可选，默认为 AppKey" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;">🤖 机器人双工与安全访问准入</div>
								<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
									<input type="checkbox" id="dingtalk-cfg-bot-enabled" class="dingtalk-cfg-bot-enabled" style="cursor: pointer;" />
									<label for="dingtalk-cfg-bot-enabled" style="font-size: 12px; cursor: pointer; user-select: none;">启用钉钉机器人双向会话对话服务</label>
								</div>
								<div style="margin-bottom: 8px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">安全白名单 (Staff ID，逗号分隔，留空不限制):</label>
									<input type="text" class="dingtalk-cfg-allowed-senders" placeholder="staff123, staff456 (留空允许所有用户)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div>
									<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
										<label style="color: var(--text-dim);">📂 项目根目录 (Workspace Cwd，留空跟随当前项目，支持聊天发 /cwd 切换):</label>
									</div>
									<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
										<input type="text" class="dingtalk-cfg-workspace" placeholder="如：E:/my-project (留空跟随当前项目)" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
										<select class="dingtalk-cfg-ws-select" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
											<option value="">快速点选已有项目...</option>
										</select>
										<button type="button" class="dingtalk-cfg-ws-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">📂 浏览...</button>
										<button type="button" class="dingtalk-cfg-use-cwd" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">设为当前项目</button>
									</div>
								</div>
								<div style="margin-top: 10px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">✨ AI 模型与思考强度 (留空跟随全局默认):</label>
									<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
										<input type="text" class="dingtalk-cfg-model" placeholder="留空 = 跟随全局默认模型（支持手输或点选）" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
										<button type="button" class="dingtalk-cfg-model-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">✨ 选择模型...</button>
										<select class="dingtalk-cfg-thinking" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
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

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;">群机器人自定义 Webhook (单向卡片推送)</div>
								<div style="margin-bottom: 8px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">Webhook 地址:</label>
									<input type="text" class="dingtalk-cfg-webhook-url" placeholder="https://oapi.dingtalk.com/robot/send?access_token=xxxx" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div>
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">签名加签密钥 (SEC... 开头，加密保存):</label>
									<input type="password" class="dingtalk-cfg-webhook-secret" placeholder="留空保持不变" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>
						</div>
						<div style="padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<button class="dingtalk-btn-test-cfg" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">🔌 测试连接</button>
							<div style="display: flex; gap: 8px;">
								<button class="dingtalk-modal-cancel" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">取消</button>
								<button class="dingtalk-btn-save-cfg" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">💾 保存配置</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		`;

		const q = (sel) => el.querySelector(sel);
		const statusBadge = q(".dingtalk-status-badge");
		const metricState = q(".dingtalk-metric-state");
		const metricRecv = q(".dingtalk-metric-recv");
		const metricSent = q(".dingtalk-metric-sent");
		const modal = q(".dingtalk-modal-settings");

		const cfgAppKey = q(".dingtalk-cfg-appkey");
		const cfgAppSecret = q(".dingtalk-cfg-appsecret");
		const cfgRobotCode = q(".dingtalk-cfg-robotcode");
		const cfgBotEnabled = q(".dingtalk-cfg-bot-enabled");
		const cfgAllowedSenders = q(".dingtalk-cfg-allowed-senders");
		const cfgWorkspace = q(".dingtalk-cfg-workspace");
		const cfgWsSelect = q(".dingtalk-cfg-ws-select");
		const cfgWsBrowse = q(".dingtalk-cfg-ws-browse");
		const cfgModel = q(".dingtalk-cfg-model");
		const cfgModelBrowse = q(".dingtalk-cfg-model-browse");
		const cfgThinking = q(".dingtalk-cfg-thinking");
		const cfgWebhookUrl = q(".dingtalk-cfg-webhook-url");
		const cfgWebhookSecret = q(".dingtalk-cfg-webhook-secret");

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

			metricRecv.textContent = `${b.messagesReceived || 0} 条`;
			metricSent.textContent = `${b.messagesReplied || 0} 条`;
		}

		q(".dingtalk-btn-config").addEventListener("click", () => {
			const cfg = currentState.config || {};
			cfgAppKey.value = cfg.appKey || "";
			cfgAppSecret.value = "";
			cfgAppSecret.placeholder = cfg.hasAppSecret ? "●●●●●● (已加密保存，留空保持)" : "填入 AppSecret";
			cfgRobotCode.value = cfg.robotCode || "";
			cfgBotEnabled.checked = Boolean(cfg.botEnabled);
			cfgAllowedSenders.value = Array.isArray(cfg.allowedSenders) ? cfg.allowedSenders.join(", ") : "";
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

			cfgWebhookUrl.value = cfg.webhookUrl || "";
			cfgWebhookSecret.value = "";
			cfgWebhookSecret.placeholder = cfg.hasWebhookSecret
				? "●●●●●● (已加密保存，留空保持)"
				: "填入 Webhook 签名密钥 (可选)";

			modal.style.display = "flex";
		});

		q(".dingtalk-cfg-use-cwd")?.addEventListener("click", () => {
			if (currentState.hostCwd) cfgWorkspace.value = currentState.hostCwd;
		});
		cfgWsSelect?.addEventListener("change", () => {
			if (cfgWsSelect.value) cfgWorkspace.value = cfgWsSelect.value;
		});
		cfgWsBrowse?.addEventListener("click", async () => {
			const host = globalThis.window?.__piWebUiHost;
			if (typeof host?.pickDirectory !== "function") return;
			const res = await host.pickDirectory({
				title: "选择钉钉机器人执行项目根目录",
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
		q(".dingtalk-modal-close").addEventListener("click", () => (modal.style.display = "none"));
		q(".dingtalk-modal-cancel").addEventListener("click", () => (modal.style.display = "none"));

		q(".dingtalk-btn-test-cfg").addEventListener("click", async () => {
			const btn = q(".dingtalk-btn-test-cfg");
			btn.disabled = true;
			btn.textContent = "测试中...";
			const testCfg = {
				appKey: cfgAppKey.value.trim(),
				appSecret: cfgAppSecret.value.trim(),
				webhookUrl: cfgWebhookUrl.value.trim(),
				webhookSecret: cfgWebhookSecret.value.trim(),
			};
			const res = await sendHost("test_config", { config: testCfg });
			btn.disabled = false;
			btn.textContent = "🔌 测试连接";

			const messages = res?.results?.messages || [];
			alert?.(messages.join("\n") || (res?.success ? "测试通过！" : "测试未通过"));
		});

		q(".dingtalk-btn-save-cfg").addEventListener("click", async () => {
			const btn = q(".dingtalk-btn-save-cfg");
			btn.disabled = true;
			btn.textContent = "保存中...";

			const newCfg = {
				appKey: cfgAppKey.value.trim(),
				appSecret: cfgAppSecret.value.trim(),
				robotCode: cfgRobotCode.value.trim(),
				botEnabled: Boolean(cfgBotEnabled.checked),
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
			btn.disabled = false;
			btn.textContent = "💾 保存配置";

			if (res?.success) {
				modal.style.display = "none";
				refresh();
			} else {
				alert?.(`保存失败: ${res?.message || "未知错误"}`);
			}
		});

		q(".dingtalk-btn-toggle-bot").addEventListener("click", async () => {
			const isRunning = currentState.botStatus?.state === "connected";
			const action = isRunning ? "stop_bot" : "start_bot";
			await sendHost(action);
			refresh();
		});

		q(".dingtalk-btn-push").addEventListener("click", async () => {
			const titleInput = q(".dingtalk-push-title");
			const textInput = q(".dingtalk-push-text");
			const text = textInput.value.trim();
			if (!text) {
				alert?.("请输入 Markdown 正文内容");
				return;
			}

			const btn = q(".dingtalk-btn-push");
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
					alert?.("✅ 钉钉消息推送成功！");
					textInput.value = "";
				} else {
					alert?.(`发送失败: ${res?.message || "未知错误"}`);
				}
			} finally {
				btn.disabled = false;
				btn.textContent = "🚀 一键发送到钉钉群";
			}
		});

		await refresh();
	},
};
