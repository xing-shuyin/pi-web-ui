import { esc as escapeHtml } from "@pi-web-ui/plugin-sdk/client";

function activate(ctx) {
	ctx.ui?.registerView?.({
		id: "feishu",
		label: "飞书",
		icon: "🐦",
		render(container) {
			renderFeishuWorkbench(container, ctx);
		},
	});
}

activate.mount = function mount(el, ctx) {
	renderFeishuWorkbench(el, ctx);
	return () => {
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
	container.innerHTML = `
		<div class="feishu-root" style="display: flex; flex-direction: column; height: 100%; width: 100%; background: var(--bg); color: var(--text); font-size: 13px; overflow: hidden; box-sizing: border-box;">
			<!-- Topbar -->
			<div class="feishu-topbar" style="display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--bg-elev); flex-shrink: 0; gap: 12px; flex-wrap: wrap;">
				<div style="display: flex; align-items: center; gap: 10px;">
					<span style="font-size: 18px;">🐦</span>
					<span style="font-weight: 600; font-size: 14px;">飞书工作台</span>
					<span class="feishu-status-badge" style="font-size: 11px; padding: 2px 8px; border-radius: 12px; background: var(--bg-elev2); color: var(--text-dim); border: 1px solid var(--border);">检测中...</span>
				</div>
				<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
					<input type="text" class="feishu-search-input" placeholder="搜索消息或发送人..." style="padding: 5px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; width: 180px; outline: none;" />
					<button class="feishu-btn feishu-btn-search" style="padding: 5px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;">搜索</button>
					<button class="feishu-btn feishu-btn-compose" style="padding: 5px 12px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-size: 12px; font-weight: 500;">✏ 发消息 / 卡片</button>
					<button class="feishu-btn feishu-btn-refresh" style="padding: 5px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;" title="同步与轮询">⟳ 刷新</button>
					<button class="feishu-btn feishu-btn-settings" style="padding: 5px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;" title="配置凭证与机器人">⚙ 配置</button>
				</div>
			</div>

			<!-- Main 3-Column Body -->
			<div class="feishu-body" style="display: flex; flex: 1; min-height: 0; width: 100%;">
				<!-- Left Column: Chats & Channels -->
				<div class="feishu-col-chats" style="width: 220px; border-right: 1px solid var(--border); background: var(--bg-elev); display: flex; flex-direction: column; flex-shrink: 0;">
					<div style="padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 11px; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; display: flex; justify-content: space-between; align-items: center;">
						<span>会话与通道</span>
						<button class="feishu-btn-add-chat" style="padding: 2px 6px; font-size: 11px; border-radius: 3px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;" title="添加自定义会话或接收人">+</button>
					</div>
					<div class="feishu-chats-list" style="flex: 1; overflow-y: auto; padding: 6px;">
						<div style="padding: 12px; text-align: center; color: var(--text-dim);">加载会话中...</div>
					</div>
				</div>

				<!-- Middle Column: Messages Stream -->
				<div class="feishu-col-messages" style="width: 320px; border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; background: var(--bg);">
					<div class="feishu-msgs-header" style="padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
						<span class="feishu-current-chat-title">消息列表</span>
						<span class="feishu-msgs-count" style="font-size: 11px; color: var(--text-dim);">0 条</span>
					</div>
					<div class="feishu-messages-list" style="flex: 1; overflow-y: auto; padding: 6px;">
						<div style="padding: 20px; text-align: center; color: var(--text-dim);">请选择左侧会话查看消息</div>
					</div>
				</div>

				<!-- Right Column: Message Reader & Actions -->
				<div class="feishu-col-reader" style="flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--bg); overflow-y: auto;">
					<div class="feishu-reader-placeholder" style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-dim); padding: 40px; text-align: center;">
						<span style="font-size: 32px; margin-bottom: 12px;">🐦</span>
						<div style="font-weight: 500; font-size: 15px; margin-bottom: 6px;">飞书消息阅读与互动面板</div>
						<div style="font-size: 12px; max-width: 380px; line-height: 1.6;">
							选择左侧消息以查看详情、回复会话、引用到 AI 对话、进行智能翻译或发送表情互动。
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
								<div>发送人: <b class="feishu-reader-sender" style="color: var(--text);"></b></div>
								<div>时间: <span class="feishu-reader-date"></span></div>
								<div>ID: <code class="feishu-reader-msgid" style="font-size: 11px; background: var(--bg-elev2); padding: 1px 4px; border-radius: 3px; cursor: pointer;" title="点击复制消息 ID"></code></div>
							</div>
							<!-- Actions Toolbar -->
							<div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
								<button class="feishu-btn feishu-btn-reply" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;">↩ 回复</button>
								<button class="feishu-btn feishu-btn-reply-thread" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;">🧵 话题回复</button>
								<button class="feishu-btn feishu-btn-quote" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;" title="引用到 AI 输入框">💬 引用到对话</button>
								<div style="display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border); border-radius: 4px; padding: 2px 6px; background: var(--bg-elev2);">
									<button class="feishu-btn feishu-btn-translate" style="background: none; border: none; color: var(--text); cursor: pointer; font-size: 12px; padding: 0;">🌐 翻译</button>
									<select class="feishu-translate-model" style="background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 3px; font-size: 11px; padding: 1px 4px; outline: none;">
										<option value="">跟随后台默认</option>
									</select>
								</div>
								<!-- Reaction bar -->
								<div class="feishu-reaction-bar" style="display: inline-flex; gap: 2px; align-items: center; border: 1px solid var(--border); border-radius: 4px; padding: 2px 4px; background: var(--bg-elev2);">
									<button class="feishu-react-btn" data-emoji="THUMBSUP" style="border: none; background: none; cursor: pointer; font-size: 14px;" title="点赞">👍</button>
									<button class="feishu-react-btn" data-emoji="OK" style="border: none; background: none; cursor: pointer; font-size: 14px;" title="好的">👌</button>
									<button class="feishu-react-btn" data-emoji="HEART" style="border: none; background: none; cursor: pointer; font-size: 14px;" title="爱心">❤️</button>
									<button class="feishu-react-btn" data-emoji="APPLAUSE" style="border: none; background: none; cursor: pointer; font-size: 14px;" title="鼓掌">👏</button>
									<button class="feishu-react-btn" data-emoji="DONE" style="border: none; background: none; cursor: pointer; font-size: 14px;" title="完成">✅</button>
									<button class="feishu-react-btn" data-emoji="FIRE" style="border: none; background: none; cursor: pointer; font-size: 14px;" title="火焰">🔥</button>
								</div>
								<button class="feishu-btn feishu-btn-recall" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--red, #f87171); background: transparent; color: var(--red, #f87171); cursor: pointer; font-size: 12px; margin-left: auto;" title="撤回机器人发送的消息">🗑 撤回</button>
							</div>
						</div>

						<!-- Translation Banner (Conditional) -->
						<div class="feishu-translation-banner" style="display: none; padding: 12px 16px; background: var(--bg-elev2); border-bottom: 1px solid var(--border);">
							<div style="font-size: 11px; font-weight: 600; color: var(--accent); margin-bottom: 4px; display: flex; justify-content: space-between;">
								<span>译文结果</span>
								<button class="feishu-btn-hide-trans" style="border: none; background: none; color: var(--text-dim); cursor: pointer; font-size: 11px;">隐藏</button>
							</div>
							<div class="feishu-translation-text" style="font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;"></div>
						</div>

						<!-- Message Body -->
						<div class="feishu-reader-body" style="flex: 1; padding: 20px; overflow-y: auto; line-height: 1.6; font-size: 13px; white-space: pre-wrap; word-break: break-word;"></div>

						<!-- Raw JSON Inspector (collapsible) -->
						<details class="feishu-raw-details" style="padding: 10px 16px; border-top: 1px solid var(--border); font-size: 11px; color: var(--text-dim); background: var(--bg-elev);">
							<summary style="cursor: pointer; user-select: none;">查看原始消息数据 (JSON)</summary>
							<pre class="feishu-raw-pre" style="margin-top: 8px; padding: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; overflow-x: auto; font-family: var(--mono, monospace); font-size: 11px; max-height: 200px;"></pre>
						</details>
					</div>
				</div>
			</div>

			<!-- Compose / Reply Modal -->
			<div class="feishu-compose-modal" style="display: none; position: absolute; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; align-items: center; justify-content: center;">
				<div style="width: 520px; max-width: 90%; max-height: 90%; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
					<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 14px; display: flex; justify-content: space-between; align-items: center;">
						<span class="feishu-compose-title">✏ 发送飞书消息 / 卡片</span>
						<button class="feishu-compose-close" style="border: none; background: none; color: var(--text-dim); cursor: pointer; font-size: 16px;">×</button>
					</div>
					<div style="padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; font-size: 12px;">
						<div>
							<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">发送目标 (Receive ID / Webhook):</label>
							<input type="text" class="feishu-input-target" placeholder="oc_xxx (群聊) / ou_xxx (用户) / __webhook__" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
						</div>
						<div style="display: flex; gap: 12px;">
							<div style="flex: 1;">
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">消息类型:</label>
								<select class="feishu-select-msgtype" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
									<option value="text">纯文本 (text)</option>
									<option value="post">富文本带标题 (post)</option>
									<option value="interactive">交互卡片 (interactive)</option>
								</select>
							</div>
							<div class="feishu-wrap-template" style="flex: 1; display: none;">
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">卡片配色主题:</label>
								<select class="feishu-select-template" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
									<option value="blue">蓝色 (blue)</option>
									<option value="wathet">浅蓝 (wathet)</option>
									<option value="turquoise">青色 (turquoise)</option>
									<option value="green">绿色 (green)</option>
									<option value="yellow">黄色 (yellow)</option>
									<option value="orange">橙色 (orange)</option>
									<option value="red">红色 (red)</option>
									<option value="violet">紫罗兰 (violet)</option>
									<option value="purple">紫色 (purple)</option>
									<option value="grey">中性灰 (grey)</option>
								</select>
							</div>
						</div>
						<div class="feishu-wrap-title" style="display: none;">
							<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">标题 (可选):</label>
							<input type="text" class="feishu-input-title" placeholder="输入卡片或富文本标题..." style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
						</div>
						<div>
							<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">正文内容 (卡片支持 Markdown 格式):</label>
							<textarea class="feishu-input-content" rows="6" placeholder="输入消息内容..." style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); resize: vertical; font-family: inherit; font-size: 12px;"></textarea>
						</div>
					</div>
					<div style="padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px;">
						<button class="feishu-compose-cancel" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">取消</button>
						<button class="feishu-compose-submit" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">发送</button>
					</div>
				</div>
			</div>

			<!-- Settings Modal -->
			<div class="feishu-settings-modal" style="display: none; position: absolute; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; align-items: center; justify-content: center;">
				<div style="width: 540px; max-width: 90%; max-height: 90%; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
					<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 14px; display: flex; justify-content: space-between; align-items: center;">
						<span>⚙ 飞书开放平台与机器人配置</span>
						<button class="feishu-settings-close" style="border: none; background: none; color: var(--text-dim); cursor: pointer; font-size: 16px;">×</button>
					</div>
					<div style="padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; font-size: 12px;">
						<div>
							<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">接入模式 / 平台预设:</label>
							<select class="feishu-cfg-preset" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
								<option value="feishu">飞书 (国内版 open.feishu.cn)</option>
								<option value="lark">Lark (国际版 open.larksuite.com)</option>
								<option value="webhook">仅自定义机器人 Webhook (单向推送)</option>
								<option value="custom">自定义 / 私有化网关</option>
							</select>
							<div class="feishu-cfg-hint" style="margin-top: 4px; font-size: 11px; color: var(--text-dim); line-height: 1.4;"></div>
						</div>
						<div class="feishu-cfg-wrap-baseurl" style="display: none;">
							<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">Open API 根地址:</label>
							<input type="text" class="feishu-cfg-baseurl" placeholder="https://open.feishu.cn" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
						</div>
						<div class="feishu-cfg-app-section" style="border-top: 1px solid var(--border); padding-top: 12px;">
							<div style="font-weight: 600; margin-bottom: 8px;">企业自建应用凭证 (支持双向会话与消息收发)</div>
							<div style="display: flex; gap: 10px; margin-bottom: 8px;">
								<div style="flex: 1;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">App ID (cli_xxx):</label>
									<input type="text" class="feishu-cfg-appid" placeholder="cli_a1b2c3d4e5" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div style="flex: 1;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">App Secret (加密存储):</label>
									<input type="password" class="feishu-cfg-appsecret" placeholder="留空保持不变" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>
							<div style="display: flex; gap: 10px;">
								<div style="flex: 1;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">默认会话 ID (可选):</label>
									<input type="text" class="feishu-cfg-default-chat" placeholder="oc_xxx (留空自动取第一群)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div style="flex: 1;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">新消息轮询间隔 (秒):</label>
									<input type="number" class="feishu-cfg-pollsec" placeholder="60" min="15" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>
						</div>
						<div class="feishu-cfg-bot-section" style="border-top: 1px solid var(--border); padding-top: 12px;">
							<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
								<div style="font-weight: 600;">🤖 飞书机器人 (Bot) 双工对话服务</div>
								<span class="feishu-bot-status-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">未启动</span>
							</div>
							<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
								<input type="checkbox" id="feishu-cfg-bot-enabled" class="feishu-cfg-bot-enabled" style="cursor: pointer;" />
								<label for="feishu-cfg-bot-enabled" style="font-size: 12px; cursor: pointer; user-select: none;">启用飞书机器人对话 (用户在群里 @机器人 或私聊自动驱动 AI 会话并回复)</label>
							</div>
							<div style="display: flex; gap: 10px; margin-bottom: 8px;">
								<div style="flex: 1;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">群聊响应模式:</label>
									<select class="feishu-cfg-group-mode" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
										<option value="mention">仅在群内 @机器人 时回复 (推荐)</option>
										<option value="none">群聊不回复 (仅私聊对话)</option>
										<option value="all">群聊全部消息均回复</option>
									</select>
								</div>
								<div style="flex: 1;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">安全白名单 (Open ID，逗号分隔，留空不限制):</label>
									<input type="text" class="feishu-cfg-allowed-senders" placeholder="ou_xxx, ou_yyy (留空允许所有用户)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>
							<div style="margin-bottom: 8px;">
								<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
									<label style="color: var(--text-dim);">📂 项目根目录 (Workspace Cwd，留空跟随宿主当前项目，支持在聊天发 /cwd 切换):</label>
								</div>
								<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
									<input type="text" class="feishu-cfg-workspace" placeholder="如：E:/my-project (留空跟随当前项目)" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
									<select class="feishu-cfg-ws-select" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
										<option value="">快速点选已有项目...</option>
									</select>
									<button type="button" class="feishu-cfg-ws-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">📂 浏览...</button>
									<button type="button" class="feishu-cfg-use-cwd" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">设为当前项目</button>
								</div>
							</div>
							<div style="margin-bottom: 8px;">
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">✨ AI 模型与思考强度 (留空跟随全局默认):</label>
								<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
									<input type="text" class="feishu-cfg-model" placeholder="留空 = 跟随全局默认模型（支持手输或点选）" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
									<button type="button" class="feishu-cfg-model-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">✨ 选择模型...</button>
									<select class="feishu-cfg-thinking" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
										<option value="">思考强度：跟随全局</option>
										<option value="off">思考：关闭 (off)</option>
										<option value="low">思考：低 (low)</option>
										<option value="medium">思考：中 (medium)</option>
										<option value="high">思考：高 (high)</option>
										<option value="max">思考：最大 (max)</option>
									</select>
								</div>
							</div>
							<div class="feishu-bot-metrics" style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">已接收: 0 条 · 已回复: 0 条</div>
						</div>
						<div class="feishu-cfg-webhook-section" style="border-top: 1px solid var(--border); padding-top: 12px;">
							<div style="font-weight: 600; margin-bottom: 8px;">自定义群机器人 Webhook (单向卡片与文本推送)</div>
							<div style="margin-bottom: 8px;">
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">Webhook 地址:</label>
								<input type="text" class="feishu-cfg-webhook-url" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxxx" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">签名校验密钥 (可选, 加密存储):</label>
								<input type="password" class="feishu-cfg-webhook-secret" placeholder="留空保持不变" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
						</div>
					</div>
					<div style="padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev2);">
						<button class="feishu-settings-test" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">🔌 测试连接</button>
						<div style="display: flex; gap: 8px;">
							<button class="feishu-settings-cancel" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">取消</button>
							<button class="feishu-settings-save" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">💾 保存配置</button>
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
					resolve({ success: false, message: "宿主回包超时" });
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
			statusBadge.textContent = "未配置";
			statusBadge.style.color = "var(--text-dim)";
			statusBadge.style.borderColor = "var(--border)";
		} else if (status.status === "webhook") {
			statusBadge.textContent = "Webhook 模式";
			statusBadge.style.color = "var(--accent)";
			statusBadge.style.borderColor = "var(--accent)";
		} else if (status.status === "ok") {
			statusBadge.textContent = status.unread > 0 ? `${status.unread} 条未读` : "已连接";
			statusBadge.style.color = status.unread > 0 ? "var(--accent)" : "var(--green, #4ade80)";
			statusBadge.style.borderColor = status.unread > 0 ? "var(--accent)" : "var(--green, #4ade80)";
		} else {
			statusBadge.textContent = "异常";
			statusBadge.style.color = "var(--red, #f87171)";
			statusBadge.style.borderColor = "var(--red, #f87171)";
		}
	}

	function renderChats() {
		if (!chatsListEl) return;
		if (!state.chats.length) {
			chatsListEl.innerHTML = `<div style="padding: 16px; text-align: center; color: var(--text-dim); font-size: 12px;">暂无会话。请配置 App 凭证或点击右上角 '+' 手动添加目标。</div>`;
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
						${c.isCustom ? `<button class="feishu-remove-custom-btn" data-id="${escapeHtml(c.id)}" style="border: none; background: none; color: var(--text-dim); cursor: pointer; font-size: 11px;" title="移除快捷会话">×</button>` : ""}
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
				if (window.confirm?.(`确认移除快捷会话 ${id} 吗？`)) {
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
			messagesListEl.innerHTML = `<div style="padding: 24px 12px; text-align: center; color: var(--text-dim); font-size: 12px;">当前会话暂无消息</div>`;
			msgsCountEl.textContent = "0 条";
			return;
		}

		msgsCountEl.textContent = `${state.messages.length} 条`;
		messagesListEl.innerHTML = state.messages
			.map((m) => {
				const isSelected = state.activeMessage && state.activeMessage.id === m.id;
				const unreadBadge = !m.seen
					? `<span style="width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex-shrink: 0;"></span>`
					: "";

				let typeBadge = "";
				if (m.msgType === "post")
					typeBadge = `<span style="font-size: 10px; padding: 1px 4px; border-radius: 3px; background: var(--bg-elev2); color: var(--text-dim);">富文本</span>`;
				else if (m.msgType === "interactive")
					typeBadge = `<span style="font-size: 10px; padding: 1px 4px; border-radius: 3px; background: var(--accent); color: var(--accent-contrast, #fff);">卡片</span>`;
				else if (m.msgType === "image")
					typeBadge = `<span style="font-size: 10px; padding: 1px 4px; border-radius: 3px; background: var(--bg-elev2); color: var(--text-dim);">图片</span>`;
				else if (m.msgType === "file")
					typeBadge = `<span style="font-size: 10px; padding: 1px 4px; border-radius: 3px; background: var(--bg-elev2); color: var(--text-dim);">文件</span>`;

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
		messagesListEl.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-dim);">正在同步消息...</div>`;
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

		readerSubject.textContent = msg.subject || "无标题消息";
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
		statusBadge.textContent = "同步中...";
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
		messagesListEl.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-dim);">搜索中...</div>`;
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
			readerMsgId.textContent = "✓ 已复制";
			setTimeout(() => {
				readerMsgId.textContent = id;
			}, 1200);
		}
	});

	q(".feishu-btn-quote").addEventListener("click", () => {
		if (!state.activeMessage) return;
		const m = state.activeMessage;
		const quoteText = `> 【飞书消息】${m.senderName} (${formatDate(m.date)})\n> ${m.text.replace(/\n/g, "\n> ")}\n\n`;

		if (typeof window.__piWebUiHost?.compose === "function") {
			window.__piWebUiHost.compose({ text: quoteText });
			window.__piWebUiHost.setView?.("chat");
		} else if (window.__piWebUiHost?.injectDraft) {
			window.__piWebUiHost.injectDraft({
				text: quoteText,
				items: [{ label: `飞书: ${m.subject || m.id.slice(-6)}`, text: quoteText, key: m.id }],
			});
			if (window.__piWebUiHost.setView) window.__piWebUiHost.setView("chat");
			else if (ctx.ui?.setView) ctx.ui.setView("chat");
		} else if (navigator.clipboard) {
			navigator.clipboard.writeText(quoteText);
			alert?.("已复制引用内容到剪贴板！");
		}
	});

	q(".feishu-btn-translate").addEventListener("click", async () => {
		if (!state.activeMessage) return;
		transBanner.style.display = "block";
		transText.textContent = "正在翻译中...";
		const model = transModelSelect.value || undefined;
		const res = await sendHost("translate_message", {
			text: state.activeMessage.text,
			targetLang: "zh-CN",
			model,
		});
		if (res?.translation) {
			transText.textContent = res.translation;
		} else {
			transText.textContent = "翻译失败，请检查网络或重试。";
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
		if (window.confirm?.("确认撤回这条飞书消息吗？（需由机器人或当前凭证发送的消息方可撤回）")) {
			const res = await sendHost("recall_message", { messageId: state.activeMessage.id });
			if (res?.success) {
				alert?.("消息已成功撤回！");
				refreshAll();
			} else {
				alert?.(`撤回失败: ${res?.message || "未知错误"}`);
			}
		}
	});

	q(".feishu-btn-compose").addEventListener("click", () => {
		composeMode = { type: "new", replyId: "", replyInThread: false };
		composeTitle.textContent = "✏ 发送飞书消息 / 卡片";
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
		composeTitle.textContent = `↩ 回复消息 (${state.activeMessage.senderName})`;
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
		composeTitle.textContent = `🧵 话题回复 (${state.activeMessage.senderName})`;
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
			alert?.("请输入正文内容！");
			return;
		}

		const msgType = selectMsgType.value;
		const title = inputTitle.value.trim();
		const cardTemplate = selectTemplate.value;
		const target = inputTarget.value.trim();

		const submitBtn = q(".feishu-compose-submit");
		submitBtn.disabled = true;
		submitBtn.textContent = "发送中...";

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
		submitBtn.textContent = "发送";

		if (res?.success) {
			composeModal.style.display = "none";
			refreshAll();
		} else {
			alert?.(`发送失败: ${res?.message || "未知错误"}`);
		}
	});

	q(".feishu-btn-add-chat").addEventListener("click", async () => {
		const id = window.prompt?.("请输入飞书会话 ID (oc_xxx / ou_xxx / 邮箱地址):");
		if (!id?.trim()) return;
		const name = window.prompt?.("请输入自定义会话备注名称:", id.trim()) || id.trim();
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
		cfgAppSecret.placeholder = cfg.hasAppSecret ? "●●●●●● (已加密保存，留空保持)" : "填入 App Secret";
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

		const bStat = state.botStatus || {};
		if (bStat.state === "connected") {
			botStatusBadge.textContent = "🟢 在线";
			botStatusBadge.style.color = "var(--green, #22c55e)";
		} else if (bStat.state === "connecting") {
			botStatusBadge.textContent = "🟡 连接中";
			botStatusBadge.style.color = "var(--amber, #eab308)";
		} else if (bStat.state === "error") {
			botStatusBadge.textContent = "🔴 错误";
			botStatusBadge.style.color = "var(--red, #ef4444)";
		} else {
			botStatusBadge.textContent = "⚪ 未启动";
			botStatusBadge.style.color = "var(--text-dim)";
		}
		botMetrics.textContent = `已接收: ${bStat.messagesReceived || 0} 条 · 已回复: ${bStat.messagesReplied || 0} 条`;

		cfgWebhookUrl.value = cfg.webhookUrl || "";
		cfgWebhookSecret.value = "";
		cfgWebhookSecret.placeholder = cfg.hasWebhookSecret
			? "●●●●●● (已加密保存，留空保持)"
			: "填入 Webhook 签名密钥 (可选)";

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
			title: "选择飞书机器人执行项目根目录",
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
		testBtn.textContent = "测试中...";
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
		testBtn.textContent = "🔌 测试连接";

		const messages = res?.results?.messages || [];
		alert?.(messages.join("\n") || (res?.success ? "连接测试通过！" : "测试未通过"));
	});

	q(".feishu-settings-save").addEventListener("click", async () => {
		const saveBtn = q(".feishu-settings-save");
		saveBtn.disabled = true;
		saveBtn.textContent = "保存中...";

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
		saveBtn.textContent = "💾 保存配置";

		if (res?.success) {
			settingsModal.style.display = "none";
			refreshAll();
		} else {
			alert?.(`保存失败: ${res?.message || "未知错误"}`);
		}
	});

	refreshAll();
}
