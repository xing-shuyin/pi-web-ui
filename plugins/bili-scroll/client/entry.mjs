import qrcode from "./vendor/qrcode.js";
import { esc } from "@pi-web-ui/plugin-sdk/client";

export default {
	async mount(el, ctx) {
		let ridSeq = 0;
		const pendingReplies = new Map();

		if (typeof ctx.onData === "function") {
			ctx.onData((payload) => {
				const rid = payload && payload.__rid;
				if (rid) {
					const waiter = pendingReplies.get(rid);
					if (waiter) {
						pendingReplies.delete(rid);
						clearTimeout(waiter.timer);
						waiter.resolve(payload);
						return;
					}
				}
				if (payload?.type === "bili:action" && payload?.action) {
					appendActionTerminal(payload.action);
				}
			});
		}

		const sendMsg = (type, payload = {}) => {
			if (typeof ctx.send === "function") {
				const rid = `bili-${Date.now()}-${++ridSeq}`;
				return new Promise((resolve) => {
					const timer = setTimeout(() => {
						pendingReplies.delete(rid);
						resolve({ ok: false, error: "请求宿主服务超时 (30s)" });
					}, 30000);
					pendingReplies.set(rid, { resolve, timer });
					try {
						ctx.send({ ...payload, type, __rid: rid });
					} catch (err) {
						pendingReplies.delete(rid);
						clearTimeout(timer);
						resolve({ ok: false, error: String(err?.message || err) });
					}
				});
			}

			const apiBase = ctx.apiBase || "/plugins-api/bili-scroll";
			const endpoint = type.replace(/^bili:/, "").replace(/-/g, "/");
			return fetch(`${apiBase}/${endpoint}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			})
				.then((r) => r.json())
				.catch((err) => ({ ok: false, error: String(err?.message || err) }));
		};

		const httpGet = (endpoint, params = {}) => {
			const apiBase = ctx.apiBase || "/plugins-api/bili-scroll";
			const q = new URLSearchParams(params).toString();
			const url = `${apiBase}/${endpoint}${q ? `?${q}` : ""}`;
			return fetch(url, { headers: { Accept: "application/json" } })
				.then((r) => r.json())
				.catch((err) => ({ ok: false, error: String(err?.message || err) }));
		};

		const httpPost = (endpoint, body = {}) => {
			const apiBase = ctx.apiBase || "/plugins-api/bili-scroll";
			return fetch(`${apiBase}/${endpoint}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			})
				.then((r) => r.json())
				.catch((err) => ({ ok: false, error: String(err?.message || err) }));
		};

		el.innerHTML = `
			<div class="bili-root" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); font-size: 13px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
				<style>
					/* Inbox styles share the host theme. */
					.bili-inbox { min-width: 0; max-width: 100%; display: flex; flex-direction: column; gap: 10px; }
					.bili-inbox button, .bili-inbox textarea { padding: 7px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; }
					.bili-inbox button { cursor: pointer; }
					.bili-inbox button:disabled { opacity: .5; cursor: default; }
					.bili-inbox .bili-dm-send { background: var(--accent); color: var(--accent-contrast, #fff); }
					.bili-inbox-list { display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow: auto; overscroll-behavior: contain; }
					.bili-inbox-list button { text-align: left; }
					.bili-inbox-list button[aria-pressed="true"] { border-color: var(--accent); }
					.bili-inbox-list button, .bili-dm-message, .bili-dm-selected { min-width: 0; max-width: 100%; overflow-wrap: anywhere; word-break: break-word; white-space: pre-wrap; }
					.bili-dm-message { padding: 8px; border: 1px solid var(--border); border-radius: 6px; }
					.bili-dm-compose { width: 100%; box-sizing: border-box; resize: vertical; }
					/* bili-scroll 开关按钮及交互增强 */
					.bili-switch-wrap {
						position: relative;
						display: inline-flex;
						align-items: center;
						width: 44px;
						height: 24px;
						cursor: pointer;
						user-select: none;
						flex-shrink: 0;
					}
					.bili-cfg-dm-watch {
						position: absolute;
						opacity: 0;
						width: 0;
						height: 0;
						margin: 0;
					}
					.bili-toggle-slider {
						position: absolute;
						top: 0;
						left: 0;
						right: 0;
						bottom: 0;
						background-color: color-mix(in srgb, var(--border, #444) 75%, var(--bg, #111));
						border: 1.5px solid var(--border, #666);
						border-radius: 24px;
						transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
						box-sizing: border-box;
					}
					.bili-toggle-slider::before {
						content: "";
						position: absolute;
						height: 16px;
						width: 16px;
						left: 2px;
						top: 2.5px;
						background-color: #ffffff;
						border-radius: 50%;
						transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.2s ease;
						box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
					}
					.bili-cfg-dm-watch:checked + .bili-toggle-slider {
						background-color: var(--accent);
						border-color: var(--accent);
					}
					.bili-cfg-dm-watch:checked + .bili-toggle-slider::before {
						transform: translateX(20px);
						background-color: var(--accent-contrast, #ffffff);
					}
					.bili-switch-wrap:hover .bili-toggle-slider {
						border-color: color-mix(in srgb, var(--accent) 60%, var(--border, #888));
					}
					.bili-cfg-dm-watch:focus-visible + .bili-toggle-slider {
						outline: 2px solid var(--accent);
						outline-offset: 2px;
					}
					/* 复选框增强 */
					.bili-root input[type="checkbox"]:not(.bili-cfg-dm-watch) {
						width: 16px;
						height: 16px;
						accent-color: var(--accent);
						cursor: pointer;
						margin: 0;
					}
				</style>
				<!-- 顶部 Header -->
				<div style="padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--bg-elev); flex: none;">
					<div style="display: flex; align-items: center; gap: 8px;">
						<span style="font-size: 20px;">📺</span>
						<div>
							<div style="display: flex; align-items: center; gap: 6px;">
								<span style="font-weight: 600; font-size: 14px;">刷B站 2.0</span>
								<span class="bili-badge-ver" style="font-size: 10px; padding: 1px 6px; border-radius: 10px; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);">v2.0.1</span>
								<span class="bili-status-badge" style="font-size: 11px; padding: 1px 6px; border-radius: 4px; background: color-mix(in srgb, var(--green, #22c55e) 15%, transparent); color: var(--green, #22c55e);">就绪</span>
							</div>
							<div style="font-size: 11px; color: var(--text-dim); margin-top: 1px;">当前登录账号自主漫游 · 字幕 / 音频 / 抽样画面理解 · 随时查看私信</div>
						</div>
					</div>
					<div style="display: flex; gap: 6px;">
						<button class="bili-btn-refresh" style="padding: 5px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">🔄 刷新数据</button>
					</div>
				</div>

				<!-- 顶层四页签导航条 -->
				<div style="padding: 0 16px; border-bottom: 1px solid var(--border); background: var(--bg-elev); display: flex; gap: 4px; flex: none;">
					<button class="bili-nav-tab" data-tab="daily" style="padding: 9px 16px; border: none; background: transparent; color: var(--text); font-weight: 600; font-size: 13px; cursor: pointer; border-bottom: 2px solid var(--accent); transition: all .15s;">📌 日常</button>
					<button class="bili-nav-tab" data-tab="taste" style="padding: 9px 16px; border: none; background: transparent; color: var(--text-dim); font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; transition: all .15s;">🎨 偏好</button>
					<button class="bili-nav-tab" data-tab="social" style="padding: 9px 16px; border: none; background: transparent; color: var(--text-dim); font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; transition: all .15s;">💬 互动</button>
					<button class="bili-nav-tab" data-tab="adv" style="padding: 9px 16px; border: none; background: transparent; color: var(--text-dim); font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; transition: all .15s;">🛠️ 高级</button>
				</div>

				<!-- 主滚屏区域 -->
				<div class="bili-scrollable" style="flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px;">
					<!-- 提示条 / Feedback -->
					<div class="bili-feedback-bar" style="display: none; padding: 8px 12px; border-radius: 6px; font-size: 12px; line-height: 1.4;"></div>

					<!-- ═══════════ TAB 1: 日常 (Daily) ═══════════ -->
					<div class="bili-tab-page bili-page-daily" style="display: flex; flex-direction: column; gap: 16px;">
						<!-- 状态与快捷操作卡片 -->
						<div style="border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--bg-elev);">
							<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
								<div>
									<div style="font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px;">
										<span>⚡ AI 自动巡检</span>
										<span class="bili-pill-peak" style="font-size: 11px; padding: 1px 6px; border-radius: 4px; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent);">峰谷自动巡检: 开</span>
									</div>
									<div style="font-size: 12px; color: var(--text-dim); margin-top: 3px;">
										中午 (12:00–14:00) ｜ 夜间 (00:30–08:30) 自动跑 · 挑中额度上限达标即停
									</div>
								</div>
								<div style="display: flex; gap: 8px; flex-wrap: wrap;">
									<button class="bili-btn-chat-mode" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">💬 在对话中漫游</button>
									<button class="bili-btn-fav-today" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">⭐ 收藏今天挑中的</button>
									<button class="bili-btn-run-duty" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 600; font-size: 12px; display: flex; align-items: center; gap: 5px;">
										<span>🧭</span><span>开始 AI 漫游 B 站</span>
									</button>
								</div>
							</div>

							<!-- 指标栅格 -->
							<div style="grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); display: grid; gap: 10px; margin-top: 14px;">
								<div style="border: 1px solid var(--border); padding: 10px 12px; border-radius: 6px; background: var(--bg);">
									<div style="color: var(--text-dim); font-size: 11px;">今日已挑中 / 上限</div>
									<div class="bili-stat-quota" style="font-size: 17px; font-weight: 700; margin-top: 3px; color: var(--accent);">0 / 5 条</div>
								</div>
								<div style="border: 1px solid var(--border); padding: 10px 12px; border-radius: 6px; background: var(--bg);">
									<div style="color: var(--text-dim); font-size: 11px;">今日已跑轮次</div>
									<div class="bili-stat-rounds" style="font-size: 17px; font-weight: 700; margin-top: 3px;">0 轮</div>
								</div>
								<div style="border: 1px solid var(--border); padding: 10px 12px; border-radius: 6px; background: var(--bg);">
									<div style="color: var(--text-dim); font-size: 11px;">投递模式</div>
									<div class="bili-stat-dm-mode" style="font-size: 13px; font-weight: 600; margin-top: 6px; color: var(--green, #22c55e);">私信投递 (默认)</div>
								</div>
								<div style="border: 1px solid var(--border); padding: 10px 12px; border-radius: 6px; background: var(--bg);">
									<div style="color: var(--text-dim); font-size: 11px;">单条独立笔记</div>
									<div class="bili-stat-notes-count" style="font-size: 17px; font-weight: 700; margin-top: 3px;">0 篇</div>
								</div>
							</div>
						</div>

						<!-- 「它刷过的视频」卡片墙 -->
						<div style="border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--bg-elev);">
							<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
								<div>
									<div style="font-weight: 600; font-size: 14px;">🎞️ 它刷过的视频 (卡片墙)</div>
									<div style="font-size: 11px; color: var(--text-dim); margin-top: 2px;">封面走宿主代理不暴露用户 IP · 点击标题在 B站 打开 · 支持单篇笔记沉淀</div>
								</div>
								<!-- 筛选 Chips -->
								<div class="bili-watched-filters" style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center;">
									<button class="bili-chip-state" data-state="" style="padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); background: var(--accent); color: var(--accent-contrast, #fff); font-size: 11px; cursor: pointer;">全部</button>
									<button class="bili-chip-state" data-state="picked" style="padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 11px; cursor: pointer;">🌟 挑中的</button>
									<button class="bili-chip-state" data-state="skipped" style="padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 11px; cursor: pointer;">⏭️ 跳过的</button>
									<button class="bili-chip-state" data-state="commented" style="padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 11px; cursor: pointer;">💬 已投递/评论</button>
									<span style="color: var(--border);">|</span>
									<button class="bili-chip-tier" data-tier="" style="padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 11px; cursor: pointer;">全档位</button>
									<button class="bili-chip-tier" data-tier="值得看" style="padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 11px; cursor: pointer;">值得看</button>
									<button class="bili-chip-tier" data-tier="可以看" style="padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 11px; cursor: pointer;">可以看</button>
								</div>
							</div>

							<!-- 视频网格卡片容器 -->
							<div class="bili-cards-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; margin-top: 12px;">
								<div style="grid-column: 1 / -1; padding: 24px; text-align: center; color: var(--text-dim);">正在加载视频卡片...</div>
							</div>

							<!-- 卡片分页控制器 -->
							<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); font-size: 12px;">
								<span class="bili-page-info" style="color: var(--text-dim);">第 0 - 0 条，共 0 条</span>
								<div style="display: flex; gap: 8px;">
									<button class="bili-btn-prev-page" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 11px;">上一页</button>
									<button class="bili-btn-next-page" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 11px;">下一页</button>
								</div>
							</div>
						</div>

						<!-- AI 实时动作视窗 (Live Action Terminal) -->
						<div style="border: 1px solid var(--border); border-radius: 8px; background: #0c0d0e; color: #d4d4d4; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 3px 10px rgba(0,0,0,0.12);">
							<div style="padding: 8px 14px; background: #16181b; border-bottom: 1px solid #282a2e; display: flex; align-items: center; justify-content: space-between;">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span class="bili-pulse-dot" style="display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #52c41a;"></span>
									<span style="font-weight: 600; font-size: 12px; color: #fff;">AI 实时动作视窗 (Live Action Terminal)</span>
									<span class="bili-action-status-pill" style="font-size: 10px; padding: 1px 5px; border-radius: 3px; background: #26292e; color: #a0a0a0;">待命</span>
								</div>
								<div style="display: flex; gap: 6px;">
									<button class="bili-btn-clear-terminal" style="padding: 2px 7px; border-radius: 3px; border: 1px solid #3c3f44; background: #222428; color: #aaa; cursor: pointer; font-size: 11px;">清屏</button>
								</div>
							</div>
							<div class="bili-action-terminal-body" style="height: 180px; overflow-y: auto; padding: 10px 14px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;">
<span style="color: #666;">[待命] 点击「现在跑一轮」或开启峰谷巡检后，这里将实时输出每一项动作（检索、字幕提取、语义排雷、评级、私信与记账）...</span>
							</div>
						</div>

						<!-- 报告查看区 (折叠式) -->
						<div style="border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--bg-elev);">
							<div style="display: flex; justify-content: space-between; align-items: center;">
								<div style="font-weight: 600; font-size: 14px;">📋 精选速报 (Markdown 日报)</div>
								<div style="display: flex; gap: 8px;">
									<select class="bili-report-select" style="padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;"></select>
									<button class="bili-btn-copy-report" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">📋 复制 Markdown</button>
								</div>
							</div>
							<div class="bili-report-content" style="margin-top: 10px; max-height: 280px; overflow-y: auto; padding: 12px; border-radius: 6px; background: var(--bg); border: 1px solid var(--border); font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; font-family: monospace;">暂无今日日报，点击「现在跑一轮」后在此生成。</div>
						</div>
					</div>

					<!-- ═══════════ TAB 2: 偏好 (Taste) ═══════════ -->
					<div class="bili-tab-page bili-page-taste" style="display: none; flex-direction: column; gap: 14px;">
						<!-- 模型、思考强度与工作区目录 -->
						<div style="border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--bg-elev);">
							<div style="font-weight: 600; font-size: 14px;">🤖 模型、思考强度与工作目录</div>
							<div style="font-size: 12px; color: var(--text-dim); margin-top: 2px;">
								使用当前登录账号自主浏览，结合字幕、音频转写与抽样视觉帧理解视频内容。抽样画面和可获得的音频 / 字幕可能仅覆盖部分视频；结论应注明依据与覆盖范围。可指定笔记工作目录。
							</div>
							<div style="margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">指定研读模型 (provider/model)</div>
									<div style="display: flex; gap: 6px;">
										<select class="bili-cfg-model" style="flex: 1; min-width: 0; padding: 7px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;">
											<option value="">跟随当前会话模型</option>
										</select>
										<button type="button" class="bili-btn-pick-model" style="flex: none; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px; white-space: nowrap;">🎯 选择模型</button>
									</div>
								</div>
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">思考强度 (Reasoning Effort)</div>
									<select class="bili-cfg-reasoning-effort" style="width: 100%; padding: 7px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;">
										<option value="medium">中等深度 (medium - 认真通读梳理逻辑)</option>
										<option value="high">深度推演 (high - 高强度严苛排查水分)</option>
										<option value="low">轻度敏捷 (low - 快速提炼干货点)</option>
										<option value="off">关闭思考 (off - 快速结论)</option>
									</select>
								</div>
								<div style="grid-column: 1 / -1; display: flex; flex-direction: column; gap: 8px;">
									<label>视觉模型（可选，provider/model）
										<input class="bili-cfg-vision-model" type="text" placeholder="留空使用配置的研读模型" style="width: 100%; box-sizing: border-box; padding: 7px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px;" />
									</label>
									<label style="display: flex; align-items: center; gap: 8px;"><input type="checkbox" class="bili-cfg-transcribe" checked />启用音频转写（默认开，需本地转写依赖）</label>
									<div style="font-size: 12px; color: var(--text-dim);">视觉模型需支持图片输入；研读模型未指定时跟随当前会话模型。无法获取某种内容时应明确说明，避免把部分理解当作完整观看。</div>
								</div>
								<div style="grid-column: 1 / -1;">
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">指定工作区目录 (Workspace 绝对路径)</div>
									<div style="display: flex; gap: 6px;">
										<input type="text" class="bili-cfg-workspace" placeholder="例如 D:\\ObsidianVault，单条笔记会自动镜像写入该目录下的 bili-notes/" style="flex: 1; min-width: 0; box-sizing: border-box; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;" />
										<button type="button" class="bili-btn-pick-workspace" style="flex: none; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px; white-space: nowrap;">📂 选择目录</button>
									</div>
								</div>
							</div>
						</div>

						<div style="border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--bg-elev);">
							<div style="font-weight: 600; font-size: 14px;">🎭 它按什么说话（人设提示词）</div>
							<div style="font-size: 12px; color: var(--text-dim); margin-top: 2px;">想让它像谁就写在这儿，留空按中性工程师风格说话。老用户可一键从工作区导入 AGENTS.md。</div>
							<div style="margin-top: 8px; display: flex; flex-direction: column; gap: 8px;">
								<textarea class="bili-cfg-persona" rows="4" placeholder="例如：你是一个毒舌但专业的架构师，对标题党毫不留情，只看重真正的代码和工程实操..." style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; line-height: 1.5; font-family: inherit;"></textarea>
								<div style="display: flex; gap: 8px;">
									<button class="bili-btn-import-agents" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 11px;">📥 从工作区 AGENTS.md 导入</button>
								</div>
							</div>
						</div>

						<div style="border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--bg-elev);">
							<div style="font-weight: 600; font-size: 14px;">🔍 关注与排除关键词</div>
							<div style="font-size: 12px; color: var(--text-dim); margin-top: 2px;">关注词按行或半角逗号分隔；排除词命中的视频将直接跳过不予精选。</div>
							<div style="margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">关注关键词 (一行一个或逗号分隔)</div>
									<textarea class="bili-cfg-keywords" rows="4" style="width: 100%; box-sizing: border-box; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; font-family: monospace;"></textarea>
								</div>
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">排除关键词 (黑名单)</div>
									<textarea class="bili-cfg-exclude" rows="4" style="width: 100%; box-sizing: border-box; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; font-family: monospace;"></textarea>
								</div>
							</div>
						</div>

						<div style="border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--bg-elev);">
							<div style="font-weight: 600; font-size: 14px;">⭐ 自动收藏与日报精细度</div>
							<div style="margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">自动收藏到哪个收藏夹</div>
									<div style="display: flex; gap: 6px;">
										<select class="bili-cfg-fav-folder" style="flex: 1; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;">
											<option value="0">不自动收藏</option>
										</select>
										<button class="bili-btn-reload-favs" style="padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 11px;">🔄 刷新</button>
									</div>
								</div>
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">日报写多细 (Report Level)</div>
									<select class="bili-cfg-report-level" style="width: 100%; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;">
										<option value="full">完整详尽 (full - 标题/UP/为什么值得/要点)</option>
										<option value="brief">薄版 (brief - 每条一两行)</option>
										<option value="off">不写报告 (off - 仅私信/评论投递)</option>
									</select>
								</div>
							</div>
						</div>

						<div>
							<button class="bili-btn-save-taste" style="padding: 8px 24px; border-radius: 6px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); font-weight: 600; cursor: pointer; font-size: 13px;">💾 保存偏好设置</button>
						</div>
					</div>

					<!-- ═══════════ TAB 3: 互动 (Social) ═══════════ -->
					<div class="bili-tab-page bili-page-social" style="display: none; flex-direction: column; gap: 14px;">
						<div style="border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--bg-elev);">
							<div style="font-weight: 600; font-size: 14px;">📬 精选速报投递方式</div>
							<div style="font-size: 12px; color: var(--text-dim); margin-top: 2px;">
								使用当前登录账号浏览和互动。速报私信仅在配置可选接收者后投递；收件箱读取和自动回复无需填写接收者 UID 或昵称。
							</div>
							<div style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;">
								<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
									<input type="radio" name="bili_dm_mode" value="only" checked />
									<span><strong>只私信 (only)</strong> —— 推荐！完全不发公开评论，安静不打扰</span>
								</label>
								<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
									<input type="radio" name="bili_dm_mode" value="both" />
									<span><strong>私信 + 公开评论 (both)</strong> —— 两边都发</span>
								</label>
								<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
									<input type="radio" name="bili_dm_mode" value="off" />
									<span><strong>只发公开评论 (off)</strong> —— 不发私信</span>
								</label>
							</div>
						</div>

						<div style="border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--bg-elev);">
							<div style="font-weight: 600; font-size: 14px;">👤 速报接收者（可选，不影响收件箱）</div>
							<div style="margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">速报接收者 UID（可选）</div>
									<input type="number" class="bili-cfg-dm-uid" placeholder="可留空；无需设置主人 UID" style="width: 100%; box-sizing: border-box; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;" />
								</div>
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">速报接收者昵称 / 评论 @（可选）</div>
									<input type="text" class="bili-cfg-mention-name" placeholder="例如：张三" style="width: 100%; box-sizing: border-box; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;" />
								</div>
							</div>
						</div>

						<div style="border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--bg-elev);">
							<div style="display: flex; justify-content: space-between; align-items: center;">
								<div>
									<div style="font-weight: 600; font-size: 14px;">🔄 当前账号私信监听</div>
									<div style="font-size: 12px; color: var(--text-dim); margin-top: 2px;">
										监听当前登录账号的新私信，不按主人 UID 筛选。关闭监听也可随时手动查看收件箱和历史记录。
									</div>
								</div>
								<label class="bili-switch-wrap" title="监听当前登录账号的新私信">
									<input type="checkbox" class="bili-cfg-dm-watch" checked />
									<span class="bili-toggle-slider"></span>
								</label>
							</div>
							<div style="margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
								<div>
									<label style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;"><input type="checkbox" class="bili-cfg-dm-auto-reply" checked />自动回复新私信（默认开）</label>
									<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 8px;">监听开启时，仅收到新私信才调用模型并消耗模型 tokens；自动回复不使用工具。读取列表和历史不调用模型。</div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">监听间隔 (分钟)</div>
									<input type="number" class="bili-cfg-dm-minutes" value="1" min="1" max="60" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;" />
								</div>
								<div>
									<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">每日回复上限 (防刷)</div>
									<input type="number" class="bili-cfg-dm-reply-limit" value="20" min="0" max="100" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px;" />
								</div>
							</div>
						</div>

						<div style="border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--bg-elev);">
							<div style="font-weight: 600; font-size: 14px;">💬 公开评论与楼中楼互动</div>
							<div style="margin-top: 10px; display: flex; flex-direction: column; gap: 10px;">
								<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
									<input type="checkbox" class="bili-cfg-auto-comment" />
									<span>允许自动发表公开评论并 @ 昵称（安全闸，默认关）</span>
								</label>
								<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
									<input type="checkbox" class="bili-cfg-reply-comments" />
									<span>允许回复评论楼中楼（仅回复直接回复到它下面的提问与轻互动）</span>
								</label>
							</div>
						</div>

						<div class="bili-inbox" style="border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--bg-elev);">
							<div style="font-weight: 600; font-size: 14px;">📥 当前登录账号收件箱</div>
							<div style="color: var(--text-dim);">无需主人 UID。点击刷新即可查看全部私信会话，再选择会话读取历史。</div>
							<button class="bili-dm-refresh" type="button">刷新私信会话</button>
							<div class="bili-dm-status" role="status" aria-live="polite">尚未加载收件箱</div>
							<div class="bili-inbox-list bili-dm-sessions" aria-label="私信会话"></div>
							<button class="bili-dm-more-sessions" type="button" hidden>加载更多会话</button>
							<div class="bili-dm-selected">当前未选择会话</div>
							<button class="bili-dm-refresh-messages" type="button" disabled>刷新当前会话历史</button>
							<div class="bili-inbox-list bili-dm-messages" aria-label="私信历史"></div>
							<button class="bili-dm-more-messages" type="button" hidden>加载更早消息</button>
							<label>手动回复（发送前请核对上方 UID）<textarea class="bili-dm-compose" rows="3" disabled placeholder="输入要发送的文字"></textarea></label>
							<button class="bili-dm-send" type="button" disabled>发送到所选 UID</button>
						</div>
						<div>
							<button class="bili-btn-save-social" style="padding: 8px 24px; border-radius: 6px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); font-weight: 600; cursor: pointer; font-size: 13px;">💾 保存互动设置</button>
						</div>
					</div>

					<!-- ═══════════ TAB 4: 高级 (Advanced) ═══════════ -->
					<div class="bili-tab-page bili-page-adv" style="display: none; flex-direction: column; gap: 14px;">
						<!-- 账号绑定与凭证卡片 -->
						<div class="bili-card-user" style="border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--bg-elev);">
							<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
								<div class="bili-user-info" style="display: flex; align-items: center; gap: 12px;">
									<div class="bili-avatar" style="width: 44px; height: 44px; border-radius: 50%; background: var(--border); display: flex; align-items: center; justify-content: center; font-size: 20px; overflow: hidden; flex: none;">
										👤
									</div>
									<div>
										<div class="bili-uname" style="font-weight: 600; font-size: 14px;">未登录 B 站</div>
										<div class="bili-udesc" style="font-size: 12px; color: var(--text-dim); margin-top: 2px;">扫码登录后凭证保存在本地 bili_credential.json，解锁私信投递与原文字幕。</div>
									</div>
								</div>
								<div class="bili-user-actions" style="display: flex; gap: 8px;">
									<button class="bili-btn-login" style="padding: 6px 14px; border-radius: 4px; border: none; background: #fb7299; color: #fff; cursor: pointer; font-size: 12px; font-weight: 500;">📱 扫码登录</button>
									<button class="bili-btn-logout" style="display: none; padding: 5px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">退出登录</button>
								</div>
							</div>

							<!-- 扫码出码视窗 -->
							<div class="bili-qr-section" style="display: none; margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--border); text-align: center;">
								<div style="font-size: 13px; font-weight: 600; margin-bottom: 8px;">请使用 哔哩哔哩 手机客户端扫码登录（确认时请勾选记住我/长期）</div>
								<div class="bili-qr-container" style="display: inline-flex; align-items: center; justify-content: center; min-width: 180px; min-height: 180px; padding: 10px; background: #fff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.12);">
									<div class="bili-qr-svg-slot" style="display: flex; align-items: center; justify-content: center;"></div>
								</div>
								<div class="bili-qr-status" style="font-size: 12px; color: var(--text-dim); margin-top: 8px;">等待扫码中...</div>
								<div style="margin-top: 8px;">
									<button class="bili-btn-cancel-login" style="padding: 4px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 11px;">取消扫码</button>
								</div>
							</div>
						</div>

						<!-- 环境与依赖安装 -->
						<div style="border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--bg-elev);">
							<div style="font-weight: 600; font-size: 14px;">🐍 环境与扩展依赖</div>
							<div style="font-size: 12px; color: var(--text-dim); margin-top: 2px;">
								插件支持内置纯 JS API 无依赖运行；如需使用本地 Whisper 深度转写无字幕视频，可在此一键安装环境。
							</div>
							<div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
								<button class="bili-btn-install" style="padding: 6px 14px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">📦 装主依赖 (venv)</button>
								<button class="bili-btn-install-asr" style="padding: 6px 14px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">🎙️ 装本地转写依赖 (Whisper+yt-dlp)</button>
							</div>
							<div class="bili-install-tail" style="margin-top: 10px; padding: 8px 10px; border-radius: 6px; background: #0c0d0e; color: #a0a0a0; font-family: monospace; font-size: 11px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; display: none;"></div>
						</div>

						<!-- 工具箱与自检 -->
						<div style="border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--bg-elev);">
							<div style="font-weight: 600; font-size: 14px;">🧰 工具箱与自检诊断</div>
							<div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
								<button class="bili-btn-check-up" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">🧪 测一下</button>
								<button class="bili-btn-diagnose" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">📋 复制诊断信息</button>
								<button class="bili-btn-selfcheck" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">🩺 环境自检</button>
								<button class="bili-btn-verify" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">🔍 复核公开评论</button>
								<button class="bili-btn-open-out" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">📂 打开日报目录 (out)</button>
								<button class="bili-btn-open-home" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">🏠 打开家目录</button>
							</div>
							<div class="bili-diag-result" style="margin-top: 10px; display: none; padding: 10px; border-radius: 6px; background: var(--bg); border: 1px solid var(--border); font-size: 12px; line-height: 1.5; white-space: pre-wrap; font-family: monospace;"></div>
						</div>
					</div>
				</div>
			</div>
		`;

		const navTabs = el.querySelectorAll(".bili-nav-tab");
		const tabPages = {
			daily: el.querySelector(".bili-page-daily"),
			taste: el.querySelector(".bili-page-taste"),
			social: el.querySelector(".bili-page-social"),
			adv: el.querySelector(".bili-page-adv"),
		};
		const feedbackBar = el.querySelector(".bili-feedback-bar");
		const btnRefresh = el.querySelector(".bili-btn-refresh");

		const statQuota = el.querySelector(".bili-stat-quota");
		const statRounds = el.querySelector(".bili-stat-rounds");
		const statDmMode = el.querySelector(".bili-stat-dm-mode");
		const statNotesCount = el.querySelector(".bili-stat-notes-count");
		const btnRunDuty = el.querySelector(".bili-btn-run-duty");
		const btnChatMode = el.querySelector(".bili-btn-chat-mode");
		const btnFavToday = el.querySelector(".bili-btn-fav-today");
		const cardsGrid = el.querySelector(".bili-cards-grid");
		const pageInfo = el.querySelector(".bili-page-info");
		const btnPrevPage = el.querySelector(".bili-btn-prev-page");
		const btnNextPage = el.querySelector(".bili-btn-next-page");
		const terminalBody = el.querySelector(".bili-action-terminal-body");
		const btnClearTerminal = el.querySelector(".bili-btn-clear-terminal");
		const reportSelect = el.querySelector(".bili-report-select");
		const reportContent = el.querySelector(".bili-report-content");
		const btnCopyReport = el.querySelector(".bili-btn-copy-report");

		const cfgModel = el.querySelector(".bili-cfg-model");
		const btnPickModel = el.querySelector(".bili-btn-pick-model");
		const cfgReasoningEffort = el.querySelector(".bili-cfg-reasoning-effort");
		const cfgVisionModel = el.querySelector(".bili-cfg-vision-model");
		const cfgTranscribe = el.querySelector(".bili-cfg-transcribe");
		const cfgWorkspace = el.querySelector(".bili-cfg-workspace");
		const btnPickWorkspace = el.querySelector(".bili-btn-pick-workspace");
		const cfgPersona = el.querySelector(".bili-cfg-persona");
		const btnImportAgents = el.querySelector(".bili-btn-import-agents");
		const cfgKeywords = el.querySelector(".bili-cfg-keywords");
		const cfgExclude = el.querySelector(".bili-cfg-exclude");
		const cfgFavFolder = el.querySelector(".bili-cfg-fav-folder");
		const btnReloadFavs = el.querySelector(".bili-btn-reload-favs");
		const cfgReportLevel = el.querySelector(".bili-cfg-report-level");
		const btnSaveTaste = el.querySelector(".bili-btn-save-taste");

		const dmRadios = el.querySelectorAll('input[name="bili_dm_mode"]');
		const cfgDmUid = el.querySelector(".bili-cfg-dm-uid");
		const cfgMentionName = el.querySelector(".bili-cfg-mention-name");
		const cfgDmWatch = el.querySelector(".bili-cfg-dm-watch");
		const cfgDmAutoReply = el.querySelector(".bili-cfg-dm-auto-reply");
		const cfgDmMinutes = el.querySelector(".bili-cfg-dm-minutes");
		const cfgDmReplyLimit = el.querySelector(".bili-cfg-dm-reply-limit");
		const cfgAutoComment = el.querySelector(".bili-cfg-auto-comment");
		const cfgReplyComments = el.querySelector(".bili-cfg-reply-comments");
		const btnSaveSocial = el.querySelector(".bili-btn-save-social");

		const dmSessions = el.querySelector(".bili-dm-sessions");
		const dmMessages = el.querySelector(".bili-dm-messages");
		const dmStatus = el.querySelector(".bili-dm-status");
		const dmSelected = el.querySelector(".bili-dm-selected");
		const dmCompose = el.querySelector(".bili-dm-compose");
		const dmSend = el.querySelector(".bili-dm-send");
		const dmRefresh = el.querySelector(".bili-dm-refresh");
		const dmRefreshMessages = el.querySelector(".bili-dm-refresh-messages");
		const dmMoreSessions = el.querySelector(".bili-dm-more-sessions");
		const dmMoreMessages = el.querySelector(".bili-dm-more-messages");
		let selectedUid = "";
		let sessions = [];
		let messages = [];
		let sessionsCursor;
		let messagesCursor;
		let sessionsBusy = false;
		let messagesBusy = false;
		let sending = false;
		let messageGeneration = 0;
		const drafts = new Map();

		function renderSessions() {
			dmSessions.innerHTML = sessions
				.map(
					(s) =>
						`<button type="button" data-uid="${esc(String(s.uid))}" aria-pressed="${String(s.uid) === selectedUid}">UID: ${esc(String(s.uid))} · 未读: ${esc(String(s.unread ?? 0))} · 时间戳: ${esc(String(s.lastTs ?? ""))}\n${esc(String(s.preview ?? ""))}</button>`,
				)
				.join("");
		}

		function renderMessages() {
			dmMessages.innerHTML =
				messages
					.map(
						(m) =>
							`<div class="bili-dm-message">${m.fromMe ? "我" : `UID: ${esc(selectedUid)}`} · 时间戳: ${esc(String(m.ts ?? ""))} · 类型: ${esc(String(m.kind ?? ""))}\n${esc(String(m.text ?? ""))}${m.bvid ? `\n视频: ${esc(String(m.bvid))}` : ""}</div>`,
					)
					.join("") || "暂无消息";
		}

		async function loadSessions(more = false) {
			if (sessionsBusy) return;
			sessionsBusy = true;
			dmRefresh.disabled = dmMoreSessions.disabled = true;
			dmStatus.textContent = "正在读取私信会话…";
			try {
				const res = await sendMsg("bili:dm-sessions", { size: 20, ...(more ? { cursor: sessionsCursor } : {}) });
				if (!res?.ok || !Array.isArray(res.sessions)) throw new Error(res?.error || "私信会话响应无效");
				sessions = [...new Map([...(more ? sessions : []), ...res.sessions].map((s) => [String(s.uid), s])).values()];
				sessionsCursor = res.nextCursor;
				dmMoreSessions.hidden = !(res.hasMore && res.nextCursor != null);
				renderSessions();
				dmStatus.textContent = sessions.length ? `已加载 ${sessions.length} 个会话` : "暂无私信会话";
			} catch (err) {
				dmStatus.textContent = `读取失败: ${err.message}`;
			} finally {
				sessionsBusy = false;
				dmRefresh.disabled = dmMoreSessions.disabled = false;
			}
		}

		async function loadMessages(more = false) {
			if (!selectedUid || messagesBusy) return;
			const uid = selectedUid;
			const generation = ++messageGeneration;
			messagesBusy = true;
			dmRefreshMessages.disabled = dmMoreMessages.disabled = true;
			dmStatus.textContent = `正在读取 UID ${uid} 的历史…`;
			try {
				const res = await sendMsg("bili:dm-messages", { uid, size: 30, ...(more ? { cursor: messagesCursor } : {}) });
				if (generation !== messageGeneration) return;
				if (!res?.ok || !Array.isArray(res.messages)) throw new Error(res?.error || "私信历史响应无效");
				messages = [
					...new Map([...(more ? messages : []), ...res.messages].map((m) => [String(m.key), m])).values(),
				].sort((a, b) => Number(a.ts) - Number(b.ts));
				messagesCursor = res.nextCursor;
				dmMoreMessages.hidden = !(res.hasMore && res.nextCursor != null);
				renderMessages();
				dmStatus.textContent = `UID ${uid}: 已加载 ${messages.length} 条消息`;
			} catch (err) {
				if (generation === messageGeneration) dmStatus.textContent = `读取失败: ${err.message}`;
			} finally {
				if (generation === messageGeneration) {
					messagesBusy = false;
					dmRefreshMessages.disabled = dmMoreMessages.disabled = false;
				}
			}
		}

		dmRefresh.addEventListener("click", () => loadSessions());
		dmMoreSessions.addEventListener("click", () => loadSessions(true));
		dmRefreshMessages.addEventListener("click", () => loadMessages());
		dmMoreMessages.addEventListener("click", () => loadMessages(true));
		dmSessions.addEventListener("click", (event) => {
			const button = event.target.closest("button[data-uid]");
			if (!button || sending) return;
			if (selectedUid) drafts.set(selectedUid, dmCompose.value);
			selectedUid = button.dataset.uid;
			++messageGeneration;
			messagesBusy = false;
			messages = [];
			messagesCursor = undefined;
			dmMessages.textContent = "";
			dmMoreMessages.hidden = true;
			dmSelected.textContent = `当前所选 UID: ${selectedUid}`;
			dmSend.textContent = `发送到 UID ${selectedUid}`;
			dmCompose.disabled = dmSend.disabled = false;
			dmCompose.value = drafts.get(selectedUid) || "";
			renderSessions();
			loadMessages();
		});
		dmSend.addEventListener("click", async () => {
			const uid = selectedUid;
			const text = dmCompose.value.trim();
			if (!uid || !text || sending) return;
			sending = true;
			dmSend.disabled = dmCompose.disabled = true;
			dmStatus.textContent = `正在发送到 UID ${uid}…`;
			try {
				const res = await sendMsg("bili:dm-send", { uid, text });
				if (!res?.ok) throw new Error(res?.error || "发送失败");
				dmCompose.value = "";
				drafts.delete(uid);
				dmStatus.textContent = `已发送到 UID ${uid}，可刷新历史查看`;
			} catch (err) {
				dmStatus.textContent = `UID ${uid}: ${err.message}。未确认成功，请先刷新历史核对，再决定是否重发。`;
			} finally {
				sending = false;
				dmSend.disabled = dmCompose.disabled = false;
			}
		});

		const avatar = el.querySelector(".bili-avatar");
		const uname = el.querySelector(".bili-uname");
		const udesc = el.querySelector(".bili-udesc");
		const btnLogin = el.querySelector(".bili-btn-login");
		const btnLogout = el.querySelector(".bili-btn-logout");
		const qrSection = el.querySelector(".bili-qr-section");
		const qrSvgSlot = el.querySelector(".bili-qr-svg-slot");
		const qrStatus = el.querySelector(".bili-qr-status");
		const btnCancelLogin = el.querySelector(".bili-btn-cancel-login");
		const btnInstall = el.querySelector(".bili-btn-install");
		const btnInstallAsr = el.querySelector(".bili-btn-install-asr");
		const installTail = el.querySelector(".bili-install-tail");
		const btnCheckUp = el.querySelector(".bili-btn-check-up");
		const btnDiagnose = el.querySelector(".bili-btn-diagnose");
		const btnSelfcheck = el.querySelector(".bili-btn-selfcheck");
		const btnVerify = el.querySelector(".bili-btn-verify");
		const btnOpenOut = el.querySelector(".bili-btn-open-out");
		const btnOpenHome = el.querySelector(".bili-btn-open-home");
		const diagResult = el.querySelector(".bili-diag-result");

		let currentStatus = null;
		let currentWatchedState = "";
		let currentWatchedTier = "";
		let currentOffset = 0;
		const PAGE_SIZE = 24;
		let pollTimer = null;

		const notify = (msg, tone = "info") => {
			feedbackBar.style.display = "block";
			feedbackBar.textContent = msg;
			if (tone === "good") {
				feedbackBar.style.background = "color-mix(in srgb, var(--green, #22c55e) 15%, transparent)";
				feedbackBar.style.color = "var(--green, #22c55e)";
				feedbackBar.style.border = "1px solid color-mix(in srgb, var(--green, #22c55e) 30%, transparent)";
			} else if (tone === "warn") {
				feedbackBar.style.background = "color-mix(in srgb, var(--amber, #f59e0b) 15%, transparent)";
				feedbackBar.style.color = "var(--amber, #f59e0b)";
				feedbackBar.style.border = "1px solid color-mix(in srgb, var(--amber, #f59e0b) 30%, transparent)";
			} else {
				feedbackBar.style.background = "color-mix(in srgb, var(--accent) 15%, transparent)";
				feedbackBar.style.color = "var(--accent)";
				feedbackBar.style.border = "1px solid color-mix(in srgb, var(--accent) 30%, transparent)";
			}
			setTimeout(() => {
				feedbackBar.style.display = "none";
			}, 4000);
		};

		navTabs.forEach((tabBtn) => {
			tabBtn.addEventListener("click", () => {
				const target = tabBtn.dataset.tab;
				navTabs.forEach((b) => {
					b.style.fontWeight = "normal";
					b.style.color = "var(--text-dim)";
					b.style.borderBottomColor = "transparent";
				});
				tabBtn.style.fontWeight = "600";
				tabBtn.style.color = "var(--text)";
				tabBtn.style.borderBottomColor = "var(--accent)";

				Object.keys(tabPages).forEach((k) => {
					tabPages[k].style.display = k === target ? "flex" : "none";
				});
			});
		});

		function appendActionTerminal(act) {
			const time = act.time || new Date().toLocaleTimeString();
			const line = document.createElement("div");
			line.style.marginBottom = "3px";

			let color = "#d4d4d4";
			if (act.status === "finished" || act.status === "success" || act.step === "picked") {
				color = "#52c41a";
			} else if (act.step === "skip_badword" || act.step === "no_subtitle") {
				color = "#faad14";
			} else if (act.step?.includes("err") || act.step === "error") {
				color = "#ff4d4f";
			}

			line.innerHTML = `<span style="color: #666;">[${esc(String(time))}]</span> <span style="color: ${color};">${esc(act.message || "")}</span>`;
			terminalBody.appendChild(line);
			terminalBody.scrollTop = terminalBody.scrollHeight;
		}

		btnClearTerminal.addEventListener("click", () => {
			terminalBody.innerHTML = '<span style="color: #666;">[终端已清空]</span>';
		});

		async function refreshStatus() {
			const res = await httpGet("status");
			if (!res || !res.ok) return;
			currentStatus = res;

			const quota = res.config?.perDay || 5;
			statQuota.textContent = `${res.pickedToday || 0} / ${quota} 条`;
			statRounds.textContent = `${res.ranToday || 0} 轮`;
			statNotesCount.textContent = `${res.notesCount || 0} 篇`;

			const dmMode = res.config?.dmMode || "only";
			statDmMode.textContent =
				dmMode === "only" ? "只发私信 (默认)" : dmMode === "both" ? "私信 + 评论" : "只发公开评论";

			populateModelOptions(res.config?.model || "");
			if (!cfgVisionModel.dataset.dirty) cfgVisionModel.value = res.config?.visionModel || "";
			if (!cfgTranscribe.dataset.dirty) cfgTranscribe.checked = res.config?.transcribe !== false;
			if (cfgReasoningEffort) cfgReasoningEffort.value = res.config?.reasoningEffort || "medium";
			if (cfgWorkspace && !cfgWorkspace.value) cfgWorkspace.value = res.config?.workspace || "";
			if (cfgPersona && !cfgPersona.value) cfgPersona.value = res.config?.personaPrompt || "";
			if (cfgKeywords && !cfgKeywords.value) cfgKeywords.value = res.config?.keywords || "";
			if (cfgExclude && !cfgExclude.value) cfgExclude.value = res.config?.excludeKeywords || "";
			if (cfgReportLevel) cfgReportLevel.value = res.config?.reportLevel || "full";

			dmRadios.forEach((r) => {
				r.checked = r.value === dmMode;
			});
			if (cfgDmUid && !cfgDmUid.value) cfgDmUid.value = res.config?.dmUid || "";
			if (cfgMentionName && !cfgMentionName.value) cfgMentionName.value = res.config?.mentionName || "";
			if (cfgDmWatch && !cfgDmWatch.dataset.dirty) cfgDmWatch.checked = res.config?.dmWatch !== false;
			if (!cfgDmAutoReply.dataset.dirty) cfgDmAutoReply.checked = res.config?.dmAutoReply !== false;
			if (cfgDmMinutes) cfgDmMinutes.value = res.config?.dmWatchMinutes || 1;
			if (cfgDmReplyLimit) cfgDmReplyLimit.value = res.config?.dmReplyPerDay || 20;
			if (cfgAutoComment) cfgAutoComment.checked = Boolean(res.config?.autoComment);
			if (cfgReplyComments) cfgReplyComments.checked = Boolean(res.config?.replyToComments);

			if (res.user?.loggedIn) {
				avatar.innerHTML = res.user.face
					? `<img src="${esc(res.user.face)}" style="width: 100%; height: 100%; object-fit: cover;" />`
					: "👤";
				uname.innerHTML = `${esc(res.user.uname)} <span style="font-size: 11px; padding: 1px 5px; border-radius: 4px; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent);">Lv.${res.user.level || 0}</span>`;
				udesc.textContent = `UID: ${res.user.mid} ｜ 硬币: ${res.user.money || 0} ｜ 会员: ${res.user.vipType ? "年度大会员" : "普通会员"}`;
				btnLogin.style.display = "none";
				btnLogout.style.display = "inline-block";
			} else {
				avatar.innerHTML = "👤";
				uname.textContent = "未登录 B 站";
				udesc.textContent = "扫码登录后凭证保存在本地 bili_credential.json，解锁私信投递与原文字幕。";
				btnLogin.style.display = "inline-block";
				btnLogout.style.display = "none";
			}

			if (res.reports && res.reports.length > 0) {
				reportSelect.innerHTML = res.reports
					.map((r) => `<option value="${esc(r.date)}">${esc(r.title)}</option>`)
					.join("");
				loadReport(res.reports[0].date);
			}

			if (res.installTail) {
				installTail.style.display = "block";
				installTail.textContent = res.installTail;
			}
		}

		async function loadReport(day) {
			const res = await httpGet("report", { day });
			if (res && res.exists) {
				reportContent.textContent = res.text;
			} else {
				reportContent.textContent = "暂无该日精选日报。";
			}
		}

		reportSelect.addEventListener("change", () => {
			loadReport(reportSelect.value);
		});

		btnCopyReport.addEventListener("click", () => {
			if (reportContent.textContent) {
				navigator.clipboard.writeText(reportContent.textContent);
				notify("已复制 Markdown 日报到剪贴板", "good");
			}
		});

		async function loadWatchedCards() {
			const params = {
				offset: currentOffset,
				limit: PAGE_SIZE,
			};
			if (currentWatchedState) params.state = currentWatchedState;
			if (currentWatchedTier) params.tier = currentWatchedTier;

			const res = await httpGet("watched", params);
			if (!res || !res.ok) {
				cardsGrid.innerHTML = `<div style="grid-column: 1 / -1; padding: 20px; text-align: center; color: var(--text-dim);">加载失败: ${esc(res?.error || "未知异常")}</div>`;
				return;
			}

			const rows = res.rows || [];
			const total = res.total || 0;
			pageInfo.textContent = `第 ${total === 0 ? 0 : currentOffset + 1} - ${currentOffset + rows.length} 条，共 ${total} 条`;
			btnPrevPage.disabled = currentOffset === 0;
			btnNextPage.disabled = currentOffset + rows.length >= total;

			if (rows.length === 0) {
				cardsGrid.innerHTML = `<div style="grid-column: 1 / -1; padding: 30px; text-align: center; color: var(--text-dim);">暂无符合筛选条件的视频记录</div>`;
				return;
			}

			cardsGrid.innerHTML = rows
				.map((item) => {
					const coverUrl = `/plugins-api/bili-scroll/cover?bv=${item.bvid}`;
					const tierBadge =
						item.tier === "值得看"
							? `<span style="font-size: 10px; padding: 1px 6px; border-radius: 4px; background: color-mix(in srgb, var(--green, #22c55e) 15%, transparent); color: var(--green, #22c55e); font-weight: 600;">值得看</span>`
							: item.tier === "可以看"
								? `<span style="font-size: 10px; padding: 1px 6px; border-radius: 4px; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent);">可以看</span>`
								: item.tier === "不值当"
									? `<span style="font-size: 10px; padding: 1px 6px; border-radius: 4px; background: color-mix(in srgb, var(--amber, #f59e0b) 15%, transparent); color: var(--amber, #f59e0b);">不值当</span>`
									: "";
					const noteBadge = item.note
						? `<button class="bili-btn-view-note" data-bv="${esc(item.bvid)}" data-day="${esc(item.day)}" style="font-size: 10px; padding: 1px 6px; border-radius: 4px; background: var(--bg-elev); border: 1px solid var(--border); color: var(--text); cursor: pointer;">📝 查看笔记</button>`
						: "";

					return `
					<div class="bili-card-item" style="border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--bg); display: flex; flex-direction: column; transition: transform .12s, box-shadow .12s;">
						<div style="position: relative; width: 100%; aspect-ratio: 16/9; background: #000; overflow: hidden;">
							<img src="${coverUrl}" loading="lazy" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.style.display='none'" />
							<div style="position: absolute; bottom: 4px; right: 6px; font-size: 10px; background: rgba(0,0,0,0.7); color: #fff; padding: 1px 4px; border-radius: 3px;">${esc(item.bvid)}</div>
						</div>
						<div style="padding: 10px; display: flex; flex-direction: column; gap: 6px; flex: 1;">
							<div style="font-weight: 600; font-size: 13px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word;">
								<a href="${esc(item.url)}" target="_blank" style="color: inherit; text-decoration: none;">${esc(item.title || item.bvid)}</a>
							</div>
							<div style="font-size: 11px; color: var(--text-dim); display: flex; justify-content: space-between; align-items: center;">
								<span>UP: ${esc(item.up || "未知")}</span>
								<span>${esc(item.day)}</span>
							</div>
							<div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">
								${tierBadge}
								${noteBadge}
								<span style="font-size: 10px; color: var(--text-dim);">${esc(item.status)}</span>
							</div>
							${
								item.why
									? `<div style="font-size: 11px; color: var(--text-dim); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-top: 2px;">💡 ${esc(item.why)}</div>`
									: ""
							}
						</div>
					</div>
				`;
				})
				.join("");

			cardsGrid.querySelectorAll(".bili-btn-view-note").forEach((btn) => {
				btn.addEventListener("click", async (e) => {
					e.stopPropagation();
					const bv = btn.dataset.bv;
					const day = btn.dataset.day;
					const res = await httpGet("note", { bvid: bv, day });
					if (res && res.ok && res.text) {
						reportContent.textContent = res.text;
						notify(`已在下方日报视窗载入 ${bv} 的单条笔记`, "good");
						reportContent.scrollIntoView({ behavior: "smooth", block: "nearest" });
					} else {
						notify("未找到该视频的单条笔记", "warn");
					}
				});
			});
		}

		el.querySelectorAll(".bili-chip-state").forEach((btn) => {
			btn.addEventListener("click", () => {
				el.querySelectorAll(".bili-chip-state").forEach((b) => {
					b.style.background = "var(--bg)";
					b.style.color = "var(--text)";
				});
				btn.style.background = "var(--accent)";
				btn.style.color = "var(--accent-contrast, #fff)";
				currentWatchedState = btn.dataset.state;
				currentOffset = 0;
				loadWatchedCards();
			});
		});

		el.querySelectorAll(".bili-chip-tier").forEach((btn) => {
			btn.addEventListener("click", () => {
				el.querySelectorAll(".bili-chip-tier").forEach((b) => {
					b.style.background = "var(--bg)";
					b.style.color = "var(--text)";
				});
				btn.style.background = "var(--accent)";
				btn.style.color = "var(--accent-contrast, #fff)";
				currentWatchedTier = btn.dataset.tier;
				currentOffset = 0;
				loadWatchedCards();
			});
		});

		btnPrevPage.addEventListener("click", () => {
			if (currentOffset >= PAGE_SIZE) {
				currentOffset -= PAGE_SIZE;
				loadWatchedCards();
			}
		});

		btnNextPage.addEventListener("click", () => {
			currentOffset += PAGE_SIZE;
			loadWatchedCards();
		});

		async function reloadFavFolders() {
			const res = await httpGet("fav-folders");
			if (res && res.ok) {
				const cur = cfgFavFolder.value;
				cfgFavFolder.innerHTML =
					`<option value="0">不自动收藏</option>` +
					(res.folders || [])
						.map((f) => `<option value="${f.id}">${esc(f.title)} (${f.count || 0}个内容)</option>`)
						.join("");
				if (cur) cfgFavFolder.value = cur;
			}
		}
		btnReloadFavs.addEventListener("click", () => {
			reloadFavFolders();
			notify("已更新收藏夹列表", "good");
		});

		function populateModelOptions(selectedModel = "") {
			const hostModels = window.__piWebUiHost?.models?.list?.() || [];
			cfgModel.innerHTML = '<option value="">跟随当前会话模型</option>';
			let hasSelected = !selectedModel;
			for (const m of hostModels) {
				const fullId = m.provider ? `${m.provider}/${m.id}` : m.id;
				const opt = document.createElement("option");
				opt.value = fullId;
				opt.textContent = `${m.name || m.id} (${m.provider || "default"})`;
				if (selectedModel && (fullId === selectedModel || m.id === selectedModel)) {
					opt.selected = true;
					hasSelected = true;
				}
				cfgModel.appendChild(opt);
			}
			if (selectedModel && !hasSelected) {
				const opt = document.createElement("option");
				opt.value = selectedModel;
				opt.textContent = `${selectedModel} (当前指定)`;
				opt.selected = true;
				cfgModel.appendChild(opt);
			}
		}

		btnPickModel.addEventListener("click", async () => {
			if (typeof window.__piWebUiHost?.pickModel === "function") {
				const cur = cfgModel.value || window.__piWebUiHost.getCurrentModelId?.() || "";
				const res = await window.__piWebUiHost.pickModel({ currentModelId: cur });
				if (res && res.ok && res.modelId) {
					populateModelOptions(res.modelId);
					cfgModel.value = res.modelId;
					notify(`已选定模型: ${res.name || res.modelId}`, "good");
				}
			} else {
				notify("请直接在下拉列表中选择模型", "info");
			}
		});

		btnPickWorkspace.addEventListener("click", async () => {
			if (typeof window.__piWebUiHost?.pickDirectory === "function") {
				const cur = cfgWorkspace.value.trim();
				const res = await window.__piWebUiHost.pickDirectory({ initialPath: cur || undefined });
				if (res && res.ok && res.path) {
					cfgWorkspace.value = res.path;
					notify(`已选定工作区: ${res.path}`, "good");
				}
			} else {
				notify("请在输入框中填入本地目录绝对路径", "info");
			}
		});

		for (const input of [cfgVisionModel, cfgTranscribe, cfgDmWatch, cfgDmAutoReply]) {
			input.addEventListener("input", () => {
				input.dataset.dirty = "true";
			});
		}

		btnSaveTaste.addEventListener("click", async () => {
			const patch = {
				model: cfgModel.value.trim(),
				visionModel: cfgVisionModel.value.trim(),
				transcribe: cfgTranscribe.checked,
				reasoningEffort: cfgReasoningEffort.value,
				workspace: cfgWorkspace.value.trim(),
				personaPrompt: cfgPersona.value.trim(),
				keywords: cfgKeywords.value.trim(),
				excludeKeywords: cfgExclude.value.trim(),
				favFolderId: Number(cfgFavFolder.value) || 0,
				reportLevel: cfgReportLevel.value,
			};
			const res = await httpPost("config", patch);
			if (res && res.ok) {
				notify("偏好设置保存成功！", "good");
			} else {
				notify(`保存失败: ${res?.error || "未知异常"}`, "warn");
			}
		});

		btnImportAgents.addEventListener("click", () => {
			if (currentStatus?.personaFromWs) {
				cfgPersona.value = currentStatus.personaFromWs;
				notify("已成功导入当前工作区 AGENTS.md", "good");
			} else {
				notify("工作区中未找到 AGENTS.md", "warn");
			}
		});

		btnSaveSocial.addEventListener("click", async () => {
			let dmMode = "only";
			dmRadios.forEach((r) => {
				if (r.checked) dmMode = r.value;
			});
			const patch = {
				dmMode,
				dmUid: Number(cfgDmUid.value) || 0,
				mentionName: cfgMentionName.value.trim(),
				dmWatch: cfgDmWatch.checked,
				dmAutoReply: cfgDmAutoReply.checked,
				dmWatchMinutes: Math.max(1, Number(cfgDmMinutes.value) || 1),
				dmReplyPerDay: Number(cfgDmReplyLimit.value) || 20,
				autoComment: cfgAutoComment.checked,
				replyToComments: cfgReplyComments.checked,
			};
			const res = await httpPost("config", patch);
			if (res && res.ok) {
				notify("互动设置保存成功！", "good");
				refreshStatus();
			} else {
				notify(`保存失败: ${res?.error || "未知异常"}`, "warn");
			}
		});

		btnLogin.addEventListener("click", async () => {
			qrSection.style.display = "block";
			qrStatus.textContent = "正在向 B站 请求登录二维码...";
			qrSvgSlot.innerHTML = "";

			const res = await httpPost("login/start");
			if (!res || !res.ok) {
				qrStatus.textContent = `出码失败: ${res?.error || "网络异常"}`;
				return;
			}

			qrStatus.textContent = "等待手机 B站 客户端扫码...";
			try {
				const qrSvg = qrcode(res.url, { width: 170, height: 170 });
				qrSvgSlot.innerHTML = qrSvg;
			} catch {
				qrSvgSlot.textContent = "二维码生成失败";
			}

			if (pollTimer) clearInterval(pollTimer);
			pollTimer = setInterval(async () => {
				const pollRes = await httpPost("login/poll", { key: res.key });
				if (pollRes.state === "scanned") {
					qrStatus.textContent = "已扫描，请在手机上点击确认登录...";
				} else if (pollRes.state === "ok") {
					clearInterval(pollTimer);
					qrSection.style.display = "none";
					notify("🎉 登录成功！凭证已安全保存到 bili_credential.json", "good");
					refreshStatus();
				} else if (pollRes.state === "expired") {
					clearInterval(pollTimer);
					qrStatus.textContent = "二维码已过期，请重新点击扫码登录。";
				}
			}, 2500);
		});

		btnCancelLogin.addEventListener("click", () => {
			if (pollTimer) clearInterval(pollTimer);
			qrSection.style.display = "none";
		});

		btnLogout.addEventListener("click", async () => {
			await httpPost("login/logout");
			notify("已退出登录并清除凭证", "info");
			refreshStatus();
		});

		btnRunDuty.addEventListener("click", async () => {
			notify("🚀 AI 巡检已启动，正向动作视窗汇报每一步...", "info");
			const r = await httpPost("duty/run");
			if (r && r.started) {
				appendActionTerminal({ step: "start", message: "🚀 巡检流程已在后台执行..." });
			}
		});

		btnChatMode.addEventListener("click", () => {
			const prompt =
				"帮我开启一次 B 站 AI 漫游（AI Roaming）：围绕我的关注关键词搜寻最新视频，调用 bili_subtitle 通读原文字幕深度排雷；遇到真正的干货视频时，调用 bili_related 顺藤摸瓜继续漫游探索；将今日精选沉淀到日报并私信发给我。";
			if (typeof ctx.insertPrompt === "function") {
				ctx.insertPrompt(prompt);
				notify("已填入主聊天输入框，回车即可让智能体自主漫游！", "good");
			} else {
				navigator.clipboard.writeText(prompt);
				notify("已复制漫游指令到剪贴板", "good");
			}
		});

		btnFavToday.addEventListener("click", async () => {
			const res = await httpPost("fav-today");
			if (res && res.ok) {
				notify(`成功将 ${res.added}/${res.total} 条视频收藏到目标收藏夹！`, "good");
			} else {
				notify(`收藏失败: ${res?.error || "未知异常"}`, "warn");
			}
		});

		let installPollingTimer = null;
		function startInstallTailPolling() {
			if (installPollingTimer) clearInterval(installPollingTimer);
			installTail.style.display = "block";
			installPollingTimer = setInterval(async () => {
				const res = await httpGet("status");
				if (res && res.installTail) {
					installTail.textContent = res.installTail;
					installTail.scrollTop = installTail.scrollHeight;
				}
				if (res && !res.installing && !res.asrInstalling) {
					clearInterval(installPollingTimer);
					installPollingTimer = null;
					refreshStatus();
				}
			}, 1500);
		}

		btnInstall.addEventListener("click", async () => {
			notify("正在安装主依赖环境，请观察下方实时日志...", "info");
			startInstallTailPolling();
			const r = await httpPost("install");
			if (r && r.started) {
				notify(r.hint || "正在后台安装主依赖...", "info");
			}
		});

		btnInstallAsr.addEventListener("click", async () => {
			notify("正在安装本地 Whisper 转写依赖，模型走国内镜像...", "info");
			startInstallTailPolling();
			const r = await httpPost("install-asr");
			if (r && r.started) {
				notify(r.hint || "正在后台安装转写依赖...", "info");
			}
		});

		btnCheckUp.addEventListener("click", async () => {
			notify("正在真机测试 B站 接口连通性...", "info");
			diagResult.style.display = "block";
			diagResult.textContent = "正在测试登录凭证与搜索...";
			const res = await httpGet("status");
			diagResult.textContent = res.loggedIn ? "✅ 凭证有效，B站通信正常！" : "❌ 凭证无效或未登录";
		});

		btnDiagnose.addEventListener("click", async () => {
			const res = await httpGet("diagnose");
			if (res && res.text) {
				navigator.clipboard.writeText(res.text);
				diagResult.style.display = "block";
				diagResult.textContent = res.text;
				notify("诊断信息已复制到剪贴板！", "good");
			}
		});

		btnSelfcheck.addEventListener("click", async () => {
			const res = await httpGet("selfcheck");
			diagResult.style.display = "block";
			if (res && res.items) {
				const lines = res.items.map(
					(i) => `${i.ok ? "✅" : "❌"} ${i.name}：${i.detail} ${i.fix ? `(修复建议: ${i.fix})` : ""}`,
				);
				diagResult.textContent = lines.join("\n");
			}
		});

		btnVerify.addEventListener("click", async () => {
			notify("正在复核发出的公开评论可见性...", "info");
			diagResult.style.display = "block";
			diagResult.textContent = "正在向 B站 接口核对评论列表...";
			const res = await httpPost("verify");
			if (res && res.text) {
				diagResult.textContent = res.text;
				notify("复核完成！结果已显示在下方", "good");
			}
		});

		btnOpenOut.addEventListener("click", () => httpPost("open", { what: "out" }));
		btnOpenHome.addEventListener("click", () => httpPost("open", { what: "home" }));

		btnRefresh.addEventListener("click", () => {
			refreshStatus();
			loadWatchedCards();
			reloadFavFolders();
			notify("数据已刷新", "info");
		});

		refreshStatus();
		loadWatchedCards();
		reloadFavFolders();
	},
};
