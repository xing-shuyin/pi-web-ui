const ACTION_SET_WORKSPACE = "qq:set-workspace";

let panelSendSink = null;
let pendingWorkspace = null;

function requestSetWorkspace(path) {
	const clean = String(path ?? "").trim();
	if (!clean) return;
	if (panelSendSink) {
		panelSendSink({ type: "set_workspace", workspace: clean });
		return;
	}
	pendingWorkspace = clean;
}

function onSetWorkspaceAction(_itemId, _value, target) {
	const path = target?.id !== undefined && target?.id !== null ? String(target.id).trim() : "";
	if (!path) return;
	requestSetWorkspace(path);
}

function whenBridge(fn, tries = 40) {
	const bridge = globalThis.window?.__piWebUiHost;
	if (bridge && typeof bridge === "object") {
		fn(bridge);
		return;
	}
	if (tries <= 0) return;
	setTimeout(() => whenBridge(fn, tries - 1), 250);
}

whenBridge((bridge) => {
	try {
		bridge.onUiAction?.(ACTION_SET_WORKSPACE, onSetWorkspaceAction);
	} catch {}
});

export default {
	async mount(el, ctx) {
		let ridSeq = 0;
		const pendingReplies = new Map();
		let offData = null;

		el.innerHTML = `
			<div class="qq-root" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); font-size: 13px;">
				<!-- Topbar Header -->
				<div class="qq-topbar" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; border-bottom: 1px solid var(--border); background: var(--bg-elev); flex-shrink: 0; flex-wrap: wrap; gap: 10px;">
					<div style="display: flex; align-items: center; gap: 10px;">
						<span style="font-size: 20px;">🐧</span>
						<span style="font-weight: 600; font-size: 15px;">QQ 机器人工作台</span>
						<span class="qq-status-badge" style="font-size: 11px; padding: 2px 8px; border-radius: 12px; background: var(--bg-elev2); color: var(--text-dim); border: 1px solid var(--border);">检测中...</span>
					</div>
					<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
						<button class="qq-btn-refresh" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;">⟳ 刷新状态</button>
						<button class="qq-btn-toggle-bot" style="padding: 6px 14px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px; font-weight: 500;">⚡ 启停服务</button>
						<button class="qq-btn-config" style="padding: 6px 14px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;">⚙️ 凭证与高级设置</button>
					</div>
				</div>

				<!-- Main Dashboard Body -->
				<div class="qq-body" style="flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; max-width: 900px; margin: 0 auto; width: 100%; box-sizing: border-box;">
					
					<!-- Workspace Cwd Section -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
							<span>📂</span><span>项目根目录（执行工作空间）</span>
						</div>
						<div class="qq-ws-status" style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px; word-break: break-all;">读取中…</div>
						<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
							<input type="text" class="qq-ws-input" placeholder="留空 = 跟随当前网页项目根目录" style="flex: 2; min-width: 220px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							<select class="qq-ws-select" style="min-width: 150px; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
								<option value="">快速点选已有项目…</option>
							</select>
							<button class="qq-ws-browse" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">📂 浏览目录…</button>
							<button class="qq-ws-save" style="padding: 6px 14px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">设为根目录</button>
							<button class="qq-ws-use-cwd" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">设为当前项目</button>
							<button class="qq-ws-clear" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">清空固定</button>
						</div>
					</div>

					<!-- Model & Thinking Level Section -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
							<span>🤖</span><span>AI 模型与双向同步模式</span>
						</div>
						<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px;">
							<input type="text" class="qq-model-input" placeholder="留空 = 跟随全局默认模型（支持手输或点选）" style="flex: 2; min-width: 200px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							<button class="qq-model-browse" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">✨ 选择模型…</button>
							<select class="qq-thinking-select" style="min-width: 140px; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
								<option value="">思考强度：跟随全局</option>
								<option value="off">思考：关闭 (off)</option>
								<option value="low">思考：低 (low)</option>
								<option value="medium">思考：中 (medium)</option>
								<option value="high">思考：高 (high)</option>
								<option value="max">思考：最大 (max)</option>
							</select>
							<button class="qq-model-save" style="padding: 6px 14px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">保存配置</button>
							<button class="qq-model-clear" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">恢复默认</button>
						</div>
						<div style="background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px;">
							<label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; font-weight: 500;">
								<input type="checkbox" class="qq-bind-active-check" style="cursor: pointer;" />
								<span>⚠️ 强行注入电脑端当前打开的会话（遥控器模式，默认关闭）</span>
							</label>
							<div style="font-size: 12px; color: var(--text-dim); margin-top: 4px; line-height: 1.5; padding-left: 22px;">
								建议保持关闭：每个 QQ 用户/群自动拥有独立的专属会话，绝不干扰电脑端正在进行的日常写代码对话。在下方点击「👁️ 打开此对话」即可随时在电脑端点开专属会话并接管！
							</div>
						</div>
					</div>

					<!-- Recent QQ Chats Section (Direct View on PC) -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between;">
							<div style="display: flex; align-items: center; gap: 6px;">
								<span>💬</span><span>最近 QQ 互动对话（电脑端直接点开查看）</span>
							</div>
							<span style="font-size: 11px; color: var(--text-dim); font-weight: normal;">双向消息流转</span>
						</div>
						<div class="qq-recent-list" style="display: flex; flex-direction: column; gap: 8px;">
							<div style="color: var(--text-dim); font-size: 12px; padding: 12px; text-align: center; border: 1px dashed var(--border); border-radius: 4px;">
								暂无 QQ 互动记录。在 QQ 中 @机器人 发送消息，这里即可实时查看并一键跳转到主界面！
							</div>
						</div>
					</div>

					<!-- Status & Health Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 12px;">📊 机器人连接与运行概况</div>
						<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
							<div style="padding: 10px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">连接状态</div>
								<div class="qq-metric-state" style="font-size: 14px; font-weight: 600;">检测中...</div>
							</div>
							<div style="padding: 10px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">机器人账号</div>
								<div class="qq-metric-username" style="font-size: 14px; font-weight: 600;">--</div>
							</div>
							<div style="padding: 10px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">已接收消息</div>
								<div class="qq-metric-recv" style="font-size: 14px; font-weight: 600;">0 条</div>
							</div>
							<div style="padding: 10px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">已回复消息</div>
								<div class="qq-metric-sent" style="font-size: 14px; font-weight: 600;">0 条</div>
							</div>
						</div>
						<div style="margin-top: 12px; font-size: 12px; color: var(--text-dim); line-height: 1.6; border-top: 1px dashed var(--border); padding-top: 10px;">
							💬 <strong>快捷指令指南</strong>：在 QQ 频道或群聊中发送 <code>/</code> 或 <code>/help</code> 可查看编号操作菜单。支持发送 <code>1/cwd [路径]</code> 切换项目、<code>2/new [提示]</code> 清空或开新任务、<code>3/status</code> 查看状态、<code>4/model [ID]</code> 切模型、<code>5/thinking [档位]</code> 调思考、<code>6/plan [on/off]</code> 计划模式、<code>7/compact</code> 压缩会话、<code>8/stop</code> 中止任务。
						</div>
					</div>

					<!-- Send Message Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 12px;">📤 快捷向 QQ 频道子频道发送测试消息</div>
						<div style="display: flex; flex-direction: column; gap: 10px;">
							<div>
								<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
									<label style="color: var(--text-dim);">目标子频道 Channel ID:</label>
									<button class="qq-btn-fetch-channels" style="font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">🔍 自动读取我的子频道</button>
								</div>
								<select class="qq-channels-dropdown" style="display: none; width: 100%; box-sizing: border-box; margin-bottom: 6px; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--accent); background: var(--bg-elev); color: var(--text);"></select>
								<input type="text" class="qq-send-channelid" placeholder="如：12345678 (注意：是具体的文字子频道ID，不是大频道号)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">消息文本内容:</label>
								<textarea class="qq-send-text" rows="2" placeholder="输入要发送的消息内容..." style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); resize: vertical; font-family: inherit;"></textarea>
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">媒体（可选：本地文件路径或 http(s) URL）:</label>
								<input type="text" class="qq-send-media" placeholder="如 C:\\pic\\a.png 或 https://…/a.png" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								<div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">子频道（Channel ID）只支持公网 URL（官方限制）；发本地文件请填下面的单聊/群聊 openid。</div>
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">单聊 / 群聊 openid（可选，填了就发它而不是频道）:</label>
								<div style="display: flex; gap: 8px;">
									<select class="qq-send-openid-type" style="padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
										<option value="user">单聊 user_openid</option>
										<option value="group">群聊 group_openid</option>
									</select>
									<input type="text" class="qq-send-openid" placeholder="留空 = 发到上方子频道" style="flex: 1; min-width: 0; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>
							<div style="display: flex; justify-content: flex-end; gap: 8px;">
								<button class="qq-btn-send" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">🚀 发送消息</button>
							</div>
						</div>
					</div>
				</div>

				<!-- Settings Modal -->
				<div class="qq-modal-settings" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
					<div style="width: 540px; max-width: 90vw; max-height: 85vh; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
						<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<span style="font-weight: 600;">🐧 QQ 机器人凭证与高级设置</span>
							<button class="qq-modal-close" style="background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 16px;">✕</button>
						</div>
						<div style="padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">AppID (来自 QQ 开放平台):</label>
								<input type="text" class="qq-cfg-appid" placeholder="如：102030405" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">AppSecret / ClientSecret (机器人密钥, 加密存储):</label>
								<input type="password" class="qq-cfg-clientsecret" placeholder="填入 AppSecret (机器人密钥)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div style="display: flex; align-items: center; gap: 8px;">
								<input type="checkbox" id="qq-cfg-sandbox" class="qq-cfg-sandbox" style="cursor: pointer;" />
								<label for="qq-cfg-sandbox" style="font-size: 12px; cursor: pointer; user-select: none;">使用沙箱测试环境 (sandbox.api.sgroup.qq.com)</label>
							</div>

							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">默认发送子频道 Channel ID (可选，非 AppSecret，不使用可留空):</label>
								<input type="text" class="qq-cfg-default-channel" placeholder="如：12345678 (不用频道请留空)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 6px;">📢 频道通知广播</div>
								<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 8px;">借助私人频道接收 AI 状态推送，无需时刻守在电脑前。</div>
								<div style="margin-bottom: 8px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">广播通知子频道 ID (留空默认使用上方默认子频道):</label>
									<input type="text" class="qq-cfg-broadcast-channel" placeholder="留空使用上方默认子频道" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div style="display: flex; flex-direction: column; gap: 6px;">
									<div style="display: flex; align-items: center; gap: 8px;">
										<input type="checkbox" id="qq-cfg-notify-question" class="qq-cfg-notify-question" style="cursor: pointer;" />
										<label for="qq-cfg-notify-question" style="font-size: 12px; cursor: pointer; user-select: none;">AI 提问待确认时发送频道通知 (ask_user_question)</label>
									</div>
									<div style="display: flex; align-items: center; gap: 8px;">
										<input type="checkbox" id="qq-cfg-notify-runend" class="qq-cfg-notify-runend" style="cursor: pointer;" />
										<label for="qq-cfg-notify-runend" style="font-size: 12px; cursor: pointer; user-select: none;">AI 任务执行完成时发送频道通知 (run_end 摘要)</label>
									</div>
								</div>
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;">🔊 自动回复语音</div>
								<label style="display: block; margin-bottom: 8px;">回复方式
									<select class="qq-cfg-reply-mode" style="width: 100%; padding: 6px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px;">
										<option value="text">文字回复</option><option value="voice">语音回复</option><option value="both">语音和文字</option>
									</select>
								</label>
								<label style="display: block; margin-bottom: 8px;">TTS 引擎
									<select class="qq-cfg-voice-engine" style="width: 100%; padding: 6px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px;"></select>
								</label>
								<label style="display: block; margin-bottom: 8px;">音色
									<select class="qq-cfg-voice-speaker" style="width: 100%; padding: 6px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px;"></select>
								</label>
								<label style="display: block; margin-bottom: 8px;">语速
									<input type="number" class="qq-cfg-voice-rate" min="0.5" max="2" step="0.1" value="1" style="width: 100%; box-sizing: border-box; padding: 6px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px;" />
								</label>
								<div class="qq-voice-error" role="alert" style="font-size: 12px; color: var(--text-dim); overflow-wrap: anywhere;"></div>
								<div style="font-size: 12px; color: var(--text-dim);">单聊和群聊支持语音，频道使用文字。长回复朗读开头并附完整文字；语音失败自动发送文字。安装并启用 TTS 插件后，可选择豆包等引擎及其音色。</div>
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;">🤖 机器人双工与白名单控制</div>
								<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
									<input type="checkbox" id="qq-cfg-bot-enabled" class="qq-cfg-bot-enabled" style="cursor: pointer;" />
									<label for="qq-cfg-bot-enabled" style="font-size: 12px; cursor: pointer; user-select: none;">启用 QQ 机器人双向会话对话服务 (WebSocket 出站长连接)</label>
								</div>
								<div style="margin-bottom: 8px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">允许的用户白名单 (用户 ID / OpenID，逗号分隔，留空不限制):</label>
									<input type="text" class="qq-cfg-allowed-users" placeholder="123456, 789012 (留空允许所有用户)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div style="display: flex; gap: 10px; align-items: center;">
									<div style="flex: 1;">
										<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">执行超时提醒 (秒):</label>
										<input type="number" class="qq-cfg-timeout" min="15" max="600" placeholder="90" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
									</div>
								</div>
							</div>
						</div>
						<div style="padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<button class="qq-btn-test-cfg" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">🔌 测试连接</button>
							<div style="display: flex; gap: 8px;">
								<button class="qq-modal-cancel" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">取消</button>
								<button class="qq-btn-save-cfg" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">💾 保存配置</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		`;

		const q = (sel) => el.querySelector(sel);
		const statusBadge = q(".qq-status-badge");
		const metricState = q(".qq-metric-state");
		const metricUsername = q(".qq-metric-username");
		const metricRecv = q(".qq-metric-recv");
		const metricSent = q(".qq-metric-sent");
		const modal = q(".qq-modal-settings");

		const wsStatusEl = q(".qq-ws-status");
		const wsInputEl = q(".qq-ws-input");
		const wsSelectEl = q(".qq-ws-select");
		const wsBrowseBtn = q(".qq-ws-browse");
		const wsSaveBtn = q(".qq-ws-save");
		const wsUseCwdBtn = q(".qq-ws-use-cwd");
		const wsClearBtn = q(".qq-ws-clear");

		const modelInputEl = q(".qq-model-input");
		const modelBrowseBtn = q(".qq-model-browse");
		const thinkingSelectEl = q(".qq-thinking-select");
		const bindActiveCheckEl = q(".qq-bind-active-check");
		const modelSaveBtn = q(".qq-model-save");
		const modelClearBtn = q(".qq-model-clear");

		const cfgAppId = q(".qq-cfg-appid");
		const cfgClientSecret = q(".qq-cfg-clientsecret");
		const cfgSandbox = q(".qq-cfg-sandbox");
		const cfgDefaultChannel = q(".qq-cfg-default-channel");
		const cfgBroadcastChannel = q(".qq-cfg-broadcast-channel");
		const cfgNotifyQuestion = q(".qq-cfg-notify-question");
		const cfgInboundMedia = q(".qq-cfg-inbound-media");
		const cfgNotifyRunEnd = q(".qq-cfg-notify-runend");
		const cfgBotEnabled = q(".qq-cfg-bot-enabled");
		const cfgAllowedUsers = q(".qq-cfg-allowed-users");
		const cfgTimeout = q(".qq-cfg-timeout");
		const cfgReplyMode = q(".qq-cfg-reply-mode");
		const cfgVoiceEngine = q(".qq-cfg-voice-engine");
		const cfgVoiceSpeaker = q(".qq-cfg-voice-speaker");
		const cfgVoiceRate = q(".qq-cfg-voice-rate");
		const voiceError = q(".qq-voice-error");

		let currentState = {};
		let currentWorkspace = "";
		let currentHostCwd = "";

		panelSendSink = (payload) => ctx.send(payload);
		if (pendingWorkspace) {
			const next = pendingWorkspace;
			pendingWorkspace = null;
			ctx.send({ type: "set_workspace", workspace: next });
		}

		function updateStatusView(b = {}) {
			if (b.state === "connected") {
				statusBadge.textContent = "🟢 在线";
				statusBadge.style.color = "var(--green, #22c55e)";
				metricState.textContent = b.lastError ? `🔴 投递失败: ${b.lastError}` : "🟢 已连接 (在线)";
				metricState.style.color = b.lastError ? "var(--red, #ef4444)" : "var(--green, #22c55e)";
			} else if (b.state === "connecting") {
				statusBadge.textContent = "🟡 连接中";
				statusBadge.style.color = "var(--amber, #eab308)";
				metricState.textContent = "🟡 正在连接...";
				metricState.style.color = "var(--amber, #eab308)";
			} else if (b.state === "error") {
				statusBadge.textContent = "🔴 错误";
				statusBadge.style.color = "var(--red, #ef4444)";
				metricState.textContent = b.lastError ? `🔴 出错: ${b.lastError}` : "🔴 连接出错";
				metricState.style.color = "var(--red, #ef4444)";
			} else {
				statusBadge.textContent = "⚪ 未启动";
				statusBadge.style.color = "var(--text-dim)";
				metricState.textContent = "⚪ 未启动";
				metricState.style.color = "var(--text-dim)";
			}

			metricUsername.textContent = b.botUsername ? `${b.botUsername}` : "--";
			metricRecv.textContent = `${b.messagesReceived || 0} 条`;
			metricSent.textContent = `${b.messagesReplied || 0} 条`;
		}

		function renderWorkspace(s = {}) {
			const cfg = s.config || {};
			const ws = String(cfg.workspace ?? "").trim();
			const hostCwd = String(s.hostCwd ?? "").trim();
			currentWorkspace = ws;
			currentHostCwd = hostCwd;

			if (document.activeElement !== wsInputEl) {
				wsInputEl.value = ws;
			}

			if (ws) {
				wsStatusEl.innerHTML = `当前已固定根目录：<code style="background:var(--bg-elev2);padding:2px 6px;border-radius:4px;">${ws}</code>`;
			} else if (hostCwd) {
				wsStatusEl.innerHTML = `跟随网页当前项目：<code style="background:var(--bg-elev2);padding:2px 6px;border-radius:4px;">${hostCwd}</code> (留空默认)`;
			} else {
				wsStatusEl.textContent = "跟随宿主启动工作目录 (默认)";
			}

			if (wsSelectEl) {
				const options = [{ label: "选择最近项目…", value: "" }];
				if (hostCwd) {
					const name =
						hostCwd
							.replace(/[\\/]+$/, "")
							.split(/[\\/]/)
							.pop() || hostCwd;
					options.push({ label: `当前网页项目：${name} (${hostCwd})`, value: hostCwd });
				}
				if (ws && ws !== hostCwd) {
					const name =
						ws
							.replace(/[\\/]+$/, "")
							.split(/[\\/]/)
							.pop() || ws;
					options.push({ label: `已固定根目录：${name} (${ws})`, value: ws });
				}
				try {
					const hostProjects = globalThis.window?.__piWebUiHost?.listProjects?.() ?? [];
					for (const p of hostProjects) {
						if (p && !options.some((o) => o.value === p)) {
							const name =
								p
									.replace(/[\\/]+$/, "")
									.split(/[\\/]/)
									.pop() || p;
							options.push({ label: `${name} (${p})`, value: p });
						}
					}
				} catch {}

				wsSelectEl.innerHTML = "";
				for (const opt of options) {
					const o = document.createElement("option");
					o.value = opt.value;
					o.textContent = opt.label;
					wsSelectEl.appendChild(o);
				}
			}
		}

		function renderModelAndThinking(s = {}) {
			const cfg = s.config || {};
			if (document.activeElement !== modelInputEl) {
				modelInputEl.value = cfg.model || "";
			}
			thinkingSelectEl.value = cfg.thinkingLevel || "";
			bindActiveCheckEl.checked = Boolean(cfg.bindActive);
		}

		function renderRecentChats(chats = []) {
			const listEl = q(".qq-recent-list");
			if (!listEl) return;
			if (!Array.isArray(chats) || chats.length === 0) {
				listEl.innerHTML =
					'<div style="color: var(--text-dim); font-size: 12px; padding: 12px; text-align: center; border: 1px dashed var(--border); border-radius: 4px;">暂无 QQ 互动记录。在 QQ 中 @机器人 发送消息，这里即可实时查看并一键跳转到主界面！</div>';
				return;
			}

			listEl.innerHTML = "";
			for (const item of chats) {
				const row = document.createElement("div");
				row.style.cssText =
					"display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-radius: 6px; background: var(--bg); border: 1px solid var(--border); gap: 12px; flex-wrap: wrap;";

				const infoCol = document.createElement("div");
				infoCol.style.cssText = "flex: 1; min-width: 200px;";

				const metaRow = document.createElement("div");
				metaRow.style.cssText =
					"display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-dim); margin-bottom: 4px;";
				const timeStr = item.updatedAt ? new Date(item.updatedAt).toLocaleTimeString() : "";
				metaRow.innerHTML = `<span>👤 QQ用户: <strong>${item.authorId}</strong></span>${timeStr ? `<span>• ${timeStr}</span>` : ""}<span>• 会话: <code>${item.conversationId}</code></span>`;

				const textDiv = document.createElement("div");
				textDiv.style.cssText =
					"font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 550px;";
				const promptPreview = item.lastUserText ? `<strong>问：</strong>${item.lastUserText}` : "";
				const replyPreview = item.lastAssistantText
					? ` <span style="color:var(--text-dim);"><strong>答：</strong>${item.lastAssistantText}</span>`
					: "";
				textDiv.innerHTML = promptPreview + replyPreview || "(暂无消息文本)";

				infoCol.appendChild(metaRow);
				infoCol.appendChild(textDiv);

				const btn = document.createElement("button");
				btn.style.cssText =
					"padding: 6px 14px; border-radius: 4px; border: 1px solid var(--border); background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-size: 12px; font-weight: 500; flex-shrink: 0;";
				btn.textContent = "👁️ 打开此对话";
				btn.title = "在电脑端直接打开该会话，查看流式记录并直接回复接管";

				btn.addEventListener("click", async () => {
					const bridge = globalThis.window?.__piWebUiHost;
					btn.disabled = true;
					btn.textContent = "打开中...";
					try {
						if (bridge?.sessions?.open) {
							await bridge.sessions.open(item.openId || item.conversationId);
						}
						bridge?.setView?.("chat");
					} finally {
						btn.disabled = false;
						btn.textContent = "👁️ 打开此对话";
					}
				});

				row.appendChild(infoCol);
				row.appendChild(btn);
				listEl.appendChild(row);
			}
		}

		if (typeof ctx.onData === "function") {
			offData = ctx.onData((payload) => {
				const rid = payload && payload.__rid;
				if (rid && pendingReplies.has(rid)) {
					const waiter = pendingReplies.get(rid);
					pendingReplies.delete(rid);
					clearTimeout(waiter.timer);
					waiter.resolve(payload);
					return;
				}
				if (payload?.type === "bot_status" && payload.status) {
					updateStatusView(payload.status);
				}
				if (payload?.type === "recent_chats" && Array.isArray(payload.recentChats)) {
					renderRecentChats(payload.recentChats);
				}
			});
		}

		function sendHost(type, payload = {}) {
			if (typeof ctx.send === "function") {
				const rid = `qq-${++ridSeq}-${Date.now()}`;
				return new Promise((resolve) => {
					const timer = setTimeout(() => {
						pendingReplies.delete(rid);
						resolve({ success: false, message: "宿主通信超时" });
					}, 30000);
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
			return Promise.resolve({ success: false, message: "宿主通信未就绪" });
		}

		async function refresh() {
			const res = await sendHost("get_state");
			if (!res || res.type !== "state") return;
			currentState = {
				...res,
				config: {
					...(currentState.config || {}),
					...(res.config || {}),
				},
			};
			updateStatusView(res.botStatus || {});
			renderWorkspace(res);
			renderModelAndThinking(res);
			renderRecentChats(res.recentChats || []);
		}

		q(".qq-btn-refresh").addEventListener("click", () => refresh());

		wsSelectEl?.addEventListener("change", () => {
			const val = wsSelectEl.value;
			if (val) {
				wsInputEl.value = val;
			}
		});

		wsBrowseBtn?.addEventListener("click", async () => {
			const host = globalThis.window?.__piWebUiHost;
			if (typeof host?.pickDirectory !== "function") return;
			const res = await host.pickDirectory({
				title: "选择 QQ 机器人执行项目根目录",
				initialPath: wsInputEl.value.trim() || currentWorkspace || currentHostCwd,
			});
			if (res?.ok && res.path) {
				wsInputEl.value = res.path;
				const r = await sendHost("set_workspace", { workspace: res.path });
				if (r?.success) await refresh();
			}
		});

		wsSaveBtn?.addEventListener("click", async () => {
			const val = wsInputEl.value.trim();
			const r = await sendHost("set_workspace", { workspace: val });
			if (r?.success) {
				alert?.("✅ 已将项目根目录设为：" + (val || "(跟随全局)"));
				await refresh();
			} else {
				alert?.("⚠️ 切换失败: " + (r?.message || "未知错误"));
			}
		});

		wsUseCwdBtn?.addEventListener("click", async () => {
			if (currentHostCwd) {
				wsInputEl.value = currentHostCwd;
				const r = await sendHost("set_workspace", { workspace: currentHostCwd });
				if (r?.success) await refresh();
			}
		});

		wsClearBtn?.addEventListener("click", async () => {
			wsInputEl.value = "";
			const r = await sendHost("set_workspace", { workspace: "" });
			if (r?.success) {
				alert?.("已清空固定根目录，恢复跟随全局");
				await refresh();
			}
		});

		modelBrowseBtn?.addEventListener("click", async () => {
			const host = globalThis.window?.__piWebUiHost;
			if (typeof host?.pickModel !== "function") return;
			const res = await host.pickModel({
				currentModelId: modelInputEl?.value?.trim() || undefined,
			});
			if (res?.ok && res.modelId) {
				modelInputEl.value = res.modelId;
			}
		});

		modelSaveBtn?.addEventListener("click", async () => {
			const m = modelInputEl.value.trim();
			const th = thinkingSelectEl.value.trim();
			const bindActive = Boolean(bindActiveCheckEl.checked);
			const cfg = {
				...(currentState.config || {}),
				model: m,
				thinkingLevel: th,
				bindActive,
			};
			const r = await sendHost("save_config", { config: cfg });
			if (r?.success) {
				alert?.("✅ AI 模型与思考强度配置已保存！");
				await refresh();
			} else {
				alert?.("保存失败: " + (r?.message || "未知错误"));
			}
		});

		modelClearBtn?.addEventListener("click", async () => {
			modelInputEl.value = "";
			thinkingSelectEl.value = "";
			const cfg = {
				...(currentState.config || {}),
				model: "",
				thinkingLevel: "",
			};
			const r = await sendHost("save_config", { config: cfg });
			if (r?.success) {
				alert?.("已恢复跟随全局默认模型与思考强度");
				await refresh();
			}
		});

		bindActiveCheckEl?.addEventListener("change", async () => {
			const cfg = {
				...(currentState.config || {}),
				bindActive: Boolean(bindActiveCheckEl.checked),
			};
			await sendHost("save_config", { config: cfg });
		});

		let voiceRequest = 0;
		async function loadVoices(selected = "") {
			const request = ++voiceRequest;
			const engine = cfgVoiceEngine.value;
			cfgVoiceSpeaker.replaceChildren(new Option("默认音色", ""));
			if (selected) cfgVoiceSpeaker.add(new Option(selected, selected));
			cfgVoiceSpeaker.value = selected;
			voiceError.textContent = currentState.botStatus?.lastVoiceError
				? `上次语音回复已回退为文字：${currentState.botStatus.lastVoiceError}`
				: "";
			try {
				const result = await sendHost("get_voice_options", { engine });
				if (request !== voiceRequest || engine !== cfgVoiceEngine.value) return;
				if (result?.type !== "voice_options") throw new Error(result?.message || "无法加载音色");
				cfgVoiceSpeaker.replaceChildren(new Option("默认音色", ""));
				for (const voice of result.voices || []) cfgVoiceSpeaker.add(new Option(voice.label, voice.id));
				if (selected && !(result.voices || []).some((voice) => voice.id === selected))
					cfgVoiceSpeaker.add(new Option(selected, selected));
				cfgVoiceSpeaker.value = selected;
			} catch (error) {
				if (request === voiceRequest) voiceError.textContent = error.message;
			}
		}
		function updateVoiceRate() {
			cfgVoiceRate.disabled =
				currentState.ttsEngines?.find((engine) => engine.id === cfgVoiceEngine.value)?.supportsRate === false;
			if (cfgVoiceRate.disabled) cfgVoiceRate.value = "1";
		}
		cfgVoiceEngine.addEventListener("change", () => {
			updateVoiceRate();
			void loadVoices();
		});
		q(".qq-btn-config").addEventListener("click", () => {
			const cfg = currentState.config || {};
			cfgAppId.value = cfg.appId || "";
			cfgClientSecret.value = "";
			cfgClientSecret.placeholder = cfg.hasClientSecret
				? "●●●●●● (已加密保存，留空保持不变)"
				: "填入 AppSecret (机器人密钥)";
			cfgSandbox.checked = Boolean(cfg.useSandbox);
			cfgDefaultChannel.value = cfg.defaultChannelId || "";
			cfgBroadcastChannel.value = cfg.broadcastChannelId || "";
			cfgNotifyQuestion.checked = cfg.notifyOnQuestion !== false;
			if (cfgInboundMedia) cfgInboundMedia.checked = cfg.inboundMedia !== false;
			cfgNotifyRunEnd.checked = Boolean(cfg.notifyOnRunEnd);
			cfgBotEnabled.checked = Boolean(cfg.botEnabled);
			cfgAllowedUsers.value = Array.isArray(cfg.allowedUsers) ? cfg.allowedUsers.join(", ") : "";
			cfgTimeout.value = cfg.replyTimeoutSec || 90;
			cfgReplyMode.value = cfg.replyMode || "text";
			cfgVoiceRate.value = cfg.voiceRate || 1;
			const engines = currentState.ttsEngines?.length
				? currentState.ttsEngines
				: [{ id: "builtin", label: "系统语音" }];
			cfgVoiceEngine.replaceChildren(...engines.map((engine) => new Option(engine.label, engine.id)));
			if (cfg.voiceEngine && !engines.some((engine) => engine.id === cfg.voiceEngine))
				cfgVoiceEngine.add(new Option(`${cfg.voiceEngine}（未加载）`, cfg.voiceEngine));
			cfgVoiceEngine.value = cfg.voiceEngine || "builtin";
			updateVoiceRate();
			void loadVoices(cfg.voiceSpeaker || "");

			modal.style.display = "flex";
		});

		q(".qq-modal-close").addEventListener("click", () => (modal.style.display = "none"));
		q(".qq-modal-cancel").addEventListener("click", () => (modal.style.display = "none"));

		q(".qq-btn-test-cfg").addEventListener("click", async () => {
			const appId = cfgAppId.value.trim();
			const clientSecret = cfgClientSecret.value.trim();
			const hasSavedSecret = Boolean(currentState.config?.hasClientSecret);

			if (!appId) {
				alert?.("请先填写 AppID");
				return;
			}
			if (!clientSecret && !hasSavedSecret) {
				alert?.("请先填写 AppSecret / ClientSecret (机器人密钥)");
				return;
			}

			const btn = q(".qq-btn-test-cfg");
			btn.disabled = true;
			btn.textContent = "测试中...";
			try {
				const testCfg = {
					appId,
					clientSecret,
					useSandbox: Boolean(cfgSandbox.checked),
				};
				const res = await sendHost("test_config", { config: testCfg });
				if (res?.success) {
					alert?.(res.message || "连接测试通过！");
				} else {
					alert?.(res?.message ? `测试失败: ${res.message}` : "测试失败: 未收到有效响应");
				}
			} finally {
				btn.disabled = false;
				btn.textContent = "🔌 测试连接";
			}
		});

		q(".qq-btn-save-cfg").addEventListener("click", async () => {
			const appId = cfgAppId.value.trim();
			const clientSecret = cfgClientSecret.value.trim();
			const hasSavedSecret = Boolean(currentState.config?.hasClientSecret);

			if (cfgBotEnabled.checked && (!appId || (!clientSecret && !hasSavedSecret))) {
				alert?.("启用机器人对话服务需要先配置 AppID 和 AppSecret");
				return;
			}

			const btn = q(".qq-btn-save-cfg");
			btn.disabled = true;
			btn.textContent = "保存中...";

			try {
				const newCfg = {
					...(currentState.config || {}),
					appId,
					clientSecret,
					useSandbox: Boolean(cfgSandbox.checked),
					defaultChannelId: cfgDefaultChannel.value.trim(),
					broadcastChannelId: cfgBroadcastChannel.value.trim(),
					notifyOnQuestion: Boolean(cfgNotifyQuestion.checked),
					notifyOnRunEnd: Boolean(cfgNotifyRunEnd.checked),
					inboundMedia: cfgInboundMedia
						? Boolean(cfgInboundMedia.checked)
						: currentState.config?.inboundMedia !== false,
					replyMode: cfgReplyMode.value,
					voiceEngine: cfgVoiceEngine.value,
					voiceSpeaker: cfgVoiceSpeaker.value,
					voiceRate: Math.max(0.5, Math.min(2, Number(cfgVoiceRate.value) || 1)),
					botEnabled: Boolean(cfgBotEnabled.checked),
					allowedUsers: cfgAllowedUsers.value
						.split(/[,，\s]+/)
						.map((s) => s.trim())
						.filter(Boolean),
					replyTimeoutSec: Number(cfgTimeout.value) || 90,
				};

				const res = await sendHost("save_config", { config: newCfg });
				if (res?.success) {
					currentState.config = {
						...(currentState.config || {}),
						...newCfg,
					};
					modal.style.display = "none";
					await refresh();
				} else {
					alert?.(`保存失败: ${res?.message || "未知错误"}`);
				}
			} finally {
				btn.disabled = false;
				btn.textContent = "💾 保存配置";
			}
		});

		q(".qq-btn-toggle-bot").addEventListener("click", async () => {
			const isRunning = currentState.botStatus?.state === "connected";
			const action = isRunning ? "stop_bot" : "start_bot";
			await sendHost(action);
			await refresh();
		});

		const fetchChannelsBtn = q(".qq-btn-fetch-channels");
		const channelsDropdown = q(".qq-channels-dropdown");
		const channelInput = q(".qq-send-channelid");

		fetchChannelsBtn?.addEventListener("click", async () => {
			fetchChannelsBtn.disabled = true;
			fetchChannelsBtn.textContent = "读取中...";
			try {
				const res = await sendHost("list_channels");
				if (!res?.success) {
					alert?.(res?.message ? `读取失败: ${res.message}` : "读取失败: 请确认机器人是否已加入频道并在线");
					return;
				}
				const guilds = Array.isArray(res.guilds) ? res.guilds : [];
				if (guilds.length === 0) {
					alert?.("未找到机器人加入的频道。请先在 QQ 开放平台将机器人邀请进您的频道！");
					return;
				}
				channelsDropdown.innerHTML = '<option value="">-- 点击选择下方读取到的子频道 --</option>';
				let count = 0;
				for (const g of guilds) {
					for (const c of g.channels || []) {
						count++;
						const opt = document.createElement("option");
						opt.value = c.id;
						opt.textContent = `【${g.guildName}】#${c.name} (ID: ${c.id})`;
						channelsDropdown.appendChild(opt);
					}
				}
				if (count > 0) {
					channelsDropdown.style.display = "block";
					channelsDropdown.addEventListener("change", () => {
						if (channelsDropdown.value) {
							channelInput.value = channelsDropdown.value;
						}
					});
					alert?.(`成功读取到 ${count} 个子频道！已在下方列出，请直接在下拉框中选择。`);
				} else {
					alert?.("已找到频道，但未获取到子频道列表。请检查机器人是否有子频道访问权限。");
				}
			} finally {
				fetchChannelsBtn.disabled = false;
				fetchChannelsBtn.textContent = "🔍 自动读取我的子频道";
			}
		});

		q(".qq-btn-send").addEventListener("click", async () => {
			const channelInput = q(".qq-send-channelid");
			const textInput = q(".qq-send-text");
			const mediaInput = q(".qq-send-media");
			const openidInput = q(".qq-send-openid");
			const openidTypeSel = q(".qq-send-openid-type");
			const text = textInput.value.trim();
			const media = mediaInput?.value?.trim?.() || "";
			const openid = openidInput?.value?.trim?.() || "";
			if (!text && !media) {
				alert?.("请输入消息文本或媒体路径");
				return;
			}

			const btn = q(".qq-btn-send");
			btn.disabled = true;
			btn.textContent = media ? "上传中..." : "发送中...";
			try {
				const res = await sendHost("send_message", {
					channelId: channelInput.value.trim(),
					text,
					media,
					openid,
					openidType: openidTypeSel?.value === "group" ? "group" : "user",
				});
				if (res?.success) {
					alert?.(media ? "✅ QQ 媒体发送成功！" : "✅ QQ 消息发送成功！");
					textInput.value = "";
					if (mediaInput) mediaInput.value = "";
				} else {
					alert?.(`发送失败: ${res?.message || "未知错误"}`);
				}
			} finally {
				btn.disabled = false;
				btn.textContent = "🚀 发送消息";
			}
		});

		await refresh();

		return () => {
			panelSendSink = null;
			if (typeof offData === "function") offData();
			for (const [, waiter] of pendingReplies) {
				clearTimeout(waiter.timer);
			}
			pendingReplies.clear();
		};
	},
};
