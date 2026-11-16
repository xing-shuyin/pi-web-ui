import { esc } from "@pi-web-ui/plugin-sdk/client";
import { makeT } from "./i18n.mjs";

/** 面板文案：语言解析 / 回退 / 插值都在 SDK 里，这里只按当前界面语言取词。 */
const t = makeT();

/** 指令词表本身是数据（/help、1/cwd…），只有方括号里的参数提示随界面语言变化。 */
const cmdCode = (token) => `<code>${esc(token)}</code>`;
/** 路径展示沿用原生 code 标签样式（数据由宿主/配置提供）。 */
const codeTag = (text) => `<code style="background:var(--bg-elev2);padding:2px 6px;border-radius:4px;">${text}</code>`;
function quickCmdGuide() {
	return t("quickCmdBody", {
		slash: cmdCode("/"),
		help: cmdCode("/help"),
		cwd: cmdCode(t("cmdCwd")),
		new: cmdCode(t("cmdNew")),
		status: cmdCode(t("cmdStatus")),
		model: cmdCode(t("cmdModel")),
		thinking: cmdCode(t("cmdThinking")),
		plan: cmdCode(t("cmdPlan")),
		compact: cmdCode(t("cmdCompact")),
		stop: cmdCode(t("cmdStop")),
	});
}

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
						<span style="font-weight: 600; font-size: 15px;">${esc(t("workbenchTitle"))}</span>
						<span class="qq-status-badge" style="font-size: 11px; padding: 2px 8px; border-radius: 12px; background: var(--bg-elev2); color: var(--text-dim); border: 1px solid var(--border);">${esc(t("checking"))}</span>
					</div>
					<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
						<button class="qq-btn-refresh" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;">${esc(t("refreshStatus"))}</button>
						<button class="qq-btn-toggle-bot" style="padding: 6px 14px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px; font-weight: 500;">${esc(t("toggleBot"))}</button>
						<button class="qq-btn-config" style="padding: 6px 14px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;">${esc(t("openConfig"))}</button>
					</div>
				</div>

				<!-- Main Dashboard Body -->
				<div class="qq-body" style="flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; max-width: 900px; margin: 0 auto; width: 100%; box-sizing: border-box;">
					
					<!-- Workspace Cwd Section -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
							<span>📂</span><span>${esc(t("wsTitle"))}</span>
						</div>
						<div class="qq-ws-status" style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px; word-break: break-all;">${esc(t("loading"))}</div>
						<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
							<input type="text" class="qq-ws-input" placeholder="${esc(t("wsPlaceholder"))}" style="flex: 2; min-width: 220px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							<select class="qq-ws-select" style="min-width: 150px; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
								<option value="">${esc(t("wsSelectPlaceholder"))}</option>
							</select>
							<button class="qq-ws-browse" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">${esc(t("wsBrowse"))}</button>
							<button class="qq-ws-save" style="padding: 6px 14px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">${esc(t("wsSetRoot"))}</button>
							<button class="qq-ws-use-cwd" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">${esc(t("wsUseCwd"))}</button>
							<button class="qq-ws-clear" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">${esc(t("wsClear"))}</button>
						</div>
					</div>

					<!-- Model & Thinking Level Section -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
							<span>🤖</span><span>${esc(t("modelTitle"))}</span>
						</div>
						<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px;">
							<input type="text" class="qq-model-input" placeholder="${esc(t("modelPlaceholder"))}" style="flex: 2; min-width: 200px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							<button class="qq-model-browse" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">${esc(t("modelBrowse"))}</button>
							<select class="qq-thinking-select" style="min-width: 140px; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
								<option value="">${esc(t("thinkingDefault"))}</option>
								<option value="off">${esc(t("thinkingOff"))}</option>
								<option value="low">${esc(t("thinkingLow"))}</option>
								<option value="medium">${esc(t("thinkingMedium"))}</option>
								<option value="high">${esc(t("thinkingHigh"))}</option>
								<option value="max">${esc(t("thinkingMax"))}</option>
							</select>
							<button class="qq-model-save" style="padding: 6px 14px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">${esc(t("saveConfig"))}</button>
							<button class="qq-model-clear" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">${esc(t("modelClear"))}</button>
						</div>
						<div style="background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px;">
							<label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; font-weight: 500;">
								<input type="checkbox" class="qq-bind-active-check" style="cursor: pointer;" />
								<span>${esc(t("bindActiveLabel"))}</span>
							</label>
							<div style="font-size: 12px; color: var(--text-dim); margin-top: 4px; line-height: 1.5; padding-left: 22px;">
								${esc(t("bindActiveHint"))}
							</div>
						</div>
					</div>

					<!-- Recent QQ Chats Section (Direct View on PC) -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between;">
							<div style="display: flex; align-items: center; gap: 6px;">
								<span>💬</span><span>${esc(t("recentTitle"))}</span>
							</div>
							<span style="font-size: 11px; color: var(--text-dim); font-weight: normal;">${esc(t("recentSubtitle"))}</span>
						</div>
						<div class="qq-recent-list" style="display: flex; flex-direction: column; gap: 8px;">
							<div style="color: var(--text-dim); font-size: 12px; padding: 12px; text-align: center; border: 1px dashed var(--border); border-radius: 4px;">
								${esc(t("recentEmpty"))}
							</div>
						</div>
					</div>

					<!-- Status & Health Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 12px;">${esc(t("healthTitle"))}</div>
						<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
							<div style="padding: 10px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">${esc(t("connState"))}</div>
								<div class="qq-metric-state" style="font-size: 14px; font-weight: 600;">${esc(t("checking"))}</div>
							</div>
							<div style="padding: 10px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">${esc(t("botAccount"))}</div>
								<div class="qq-metric-username" style="font-size: 14px; font-weight: 600;">--</div>
							</div>
							<div style="padding: 10px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">${esc(t("recvCount"))}</div>
								<div class="qq-metric-recv" style="font-size: 14px; font-weight: 600;">${esc(t("countMessages", { count: 0 }))}</div>
							</div>
							<div style="padding: 10px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">${esc(t("sentCount"))}</div>
								<div class="qq-metric-sent" style="font-size: 14px; font-weight: 600;">${esc(t("countMessages", { count: 0 }))}</div>
							</div>
						</div>
						<div style="margin-top: 12px; font-size: 12px; color: var(--text-dim); line-height: 1.6; border-top: 1px dashed var(--border); padding-top: 10px;">
							💬 <strong>${esc(t("quickCmdTitle"))}</strong>${quickCmdGuide()}
						</div>
					</div>

					<!-- Send Message Card -->
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 12px;">${esc(t("sendTitle"))}</div>
						<div style="display: flex; flex-direction: column; gap: 10px;">
							<div>
								<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
									<label style="color: var(--text-dim);">${esc(t("targetChannel"))}</label>
									<button class="qq-btn-fetch-channels" style="font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">${esc(t("fetchChannels"))}</button>
								</div>
								<select class="qq-channels-dropdown" style="display: none; width: 100%; box-sizing: border-box; margin-bottom: 6px; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--accent); background: var(--bg-elev); color: var(--text);"></select>
								<input type="text" class="qq-send-channelid" placeholder="${esc(t("channelPlaceholder"))}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${esc(t("messageText"))}</label>
								<textarea class="qq-send-text" rows="2" placeholder="${esc(t("messagePlaceholder"))}" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); resize: vertical; font-family: inherit;"></textarea>
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${esc(t("mediaLabel"))}</label>
								<input type="text" class="qq-send-media" placeholder="${esc(t("mediaPlaceholder"))}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								<div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">${esc(t("mediaHint"))}</div>
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${esc(t("openidLabel"))}</label>
								<div style="display: flex; gap: 8px;">
									<select class="qq-send-openid-type" style="padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
										<option value="user">${esc(t("openidTypeUser"))}</option>
										<option value="group">${esc(t("openidTypeGroup"))}</option>
									</select>
									<input type="text" class="qq-send-openid" placeholder="${esc(t("openidPlaceholder"))}" style="flex: 1; min-width: 0; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
							</div>
							<div style="display: flex; justify-content: flex-end; gap: 8px;">
								<button class="qq-btn-send" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">${esc(t("sendMessage"))}</button>
							</div>
						</div>
					</div>
				</div>

				<!-- Settings Modal -->
				<div class="qq-modal-settings" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
					<div style="width: 540px; max-width: 90vw; max-height: 85vh; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
						<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<span style="font-weight: 600;">${esc(t("modalTitle"))}</span>
							<button class="qq-modal-close" style="background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 16px;">✕</button>
						</div>
						<div style="padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${esc(t("appIdLabel"))}</label>
								<input type="text" class="qq-cfg-appid" placeholder="${esc(t("appIdPlaceholder"))}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${esc(t("secretLabel"))}</label>
								<input type="password" class="qq-cfg-clientsecret" placeholder="${esc(t("secretPlaceholder"))}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div style="display: flex; align-items: center; gap: 8px;">
								<input type="checkbox" id="qq-cfg-sandbox" class="qq-cfg-sandbox" style="cursor: pointer;" />
								<label for="qq-cfg-sandbox" style="font-size: 12px; cursor: pointer; user-select: none;">${esc(t("sandboxLabel"))}</label>
							</div>

							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${esc(t("defaultChannelLabel"))}</label>
								<input type="text" class="qq-cfg-default-channel" placeholder="${esc(t("defaultChannelPlaceholder"))}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 6px;">${esc(t("broadcastSection"))}</div>
								<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 8px;">${esc(t("broadcastDesc"))}</div>
								<div style="margin-bottom: 8px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${esc(t("broadcastChannelLabel"))}</label>
									<input type="text" class="qq-cfg-broadcast-channel" placeholder="${esc(t("broadcastChannelPlaceholder"))}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div style="display: flex; flex-direction: column; gap: 6px;">
									<div style="display: flex; align-items: center; gap: 8px;">
										<input type="checkbox" id="qq-cfg-notify-question" class="qq-cfg-notify-question" style="cursor: pointer;" />
										<label for="qq-cfg-notify-question" style="font-size: 12px; cursor: pointer; user-select: none;">${esc(t("notifyQuestionLabel"))}</label>
									</div>
									<div style="display: flex; align-items: center; gap: 8px;">
										<input type="checkbox" id="qq-cfg-notify-runend" class="qq-cfg-notify-runend" style="cursor: pointer;" />
										<label for="qq-cfg-notify-runend" style="font-size: 12px; cursor: pointer; user-select: none;">${esc(t("notifyRunEndLabel"))}</label>
									</div>
								</div>
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;">${esc(t("voiceSection"))}</div>
								<label style="display: block; margin-bottom: 8px;">${esc(t("replyModeLabel"))}
									<select class="qq-cfg-reply-mode" style="width: 100%; padding: 6px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px;">
										<option value="text">${esc(t("replyModeText"))}</option><option value="voice">${esc(t("replyModeVoice"))}</option><option value="both">${esc(t("replyModeBoth"))}</option>
									</select>
								</label>
								<label style="display: block; margin-bottom: 8px;">${esc(t("voiceEngineLabel"))}
									<select class="qq-cfg-voice-engine" style="width: 100%; padding: 6px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px;"></select>
								</label>
								<label style="display: block; margin-bottom: 8px;">${esc(t("voiceSpeakerLabel"))}
									<select class="qq-cfg-voice-speaker" style="width: 100%; padding: 6px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px;"></select>
								</label>
								<label style="display: block; margin-bottom: 8px;">${esc(t("voiceRateLabel"))}
									<input type="number" class="qq-cfg-voice-rate" min="0.5" max="2" step="0.1" value="1" style="width: 100%; box-sizing: border-box; padding: 6px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px;" />
								</label>
								<div class="qq-voice-error" role="alert" style="font-size: 12px; color: var(--text-dim); overflow-wrap: anywhere;"></div>
								<div style="font-size: 12px; color: var(--text-dim);">${esc(t("voiceHint"))}</div>
							</div>

							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;">${esc(t("botSection"))}</div>
								<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
									<input type="checkbox" id="qq-cfg-bot-enabled" class="qq-cfg-bot-enabled" style="cursor: pointer;" />
									<label for="qq-cfg-bot-enabled" style="font-size: 12px; cursor: pointer; user-select: none;">${esc(t("botEnabledLabel"))}</label>
								</div>
								<div style="margin-bottom: 8px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${esc(t("allowedUsersLabel"))}</label>
									<input type="text" class="qq-cfg-allowed-users" placeholder="${esc(t("allowedUsersPlaceholder"))}" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div style="display: flex; gap: 10px; align-items: center;">
									<div style="flex: 1;">
										<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">${esc(t("timeoutLabel"))}</label>
										<input type="number" class="qq-cfg-timeout" min="15" max="600" placeholder="90" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
									</div>
								</div>
							</div>
						</div>
						<div style="padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<button class="qq-btn-test-cfg" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">${esc(t("testConnection"))}</button>
							<div style="display: flex; gap: 8px;">
								<button class="qq-modal-cancel" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">${esc(t("cancel"))}</button>
								<button class="qq-btn-save-cfg" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">${esc(t("saveConfigBtn"))}</button>
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
				statusBadge.textContent = t("statusOnline");
				statusBadge.style.color = "var(--green, #22c55e)";
				metricState.textContent = b.lastError
					? t("metricDeliveryFailed", { error: b.lastError })
					: t("metricConnected");
				metricState.style.color = b.lastError ? "var(--red, #ef4444)" : "var(--green, #22c55e)";
			} else if (b.state === "connecting") {
				statusBadge.textContent = t("statusConnecting");
				statusBadge.style.color = "var(--amber, #eab308)";
				metricState.textContent = t("metricConnecting");
				metricState.style.color = "var(--amber, #eab308)";
			} else if (b.state === "error") {
				statusBadge.textContent = t("statusError");
				statusBadge.style.color = "var(--red, #ef4444)";
				metricState.textContent = b.lastError ? t("metricErrored", { error: b.lastError }) : t("metricConnError");
				metricState.style.color = "var(--red, #ef4444)";
			} else {
				statusBadge.textContent = t("notRunning");
				statusBadge.style.color = "var(--text-dim)";
				metricState.textContent = t("notRunning");
				metricState.style.color = "var(--text-dim)";
			}

			metricUsername.textContent = b.botUsername ? `${b.botUsername}` : "--";
			metricRecv.textContent = t("countMessages", { count: b.messagesReceived || 0 });
			metricSent.textContent = t("countMessages", { count: b.messagesReplied || 0 });
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
				wsStatusEl.innerHTML = t("wsFixed", { path: codeTag(ws) });
			} else if (hostCwd) {
				wsStatusEl.innerHTML = t("wsFollowing", { path: codeTag(hostCwd) });
			} else {
				wsStatusEl.textContent = t("wsFollowHost");
			}

			if (wsSelectEl) {
				const options = [{ label: t("wsSelectOption"), value: "" }];
				if (hostCwd) {
					const name =
						hostCwd
							.replace(/[\\/]+$/, "")
							.split(/[\\/]/)
							.pop() || hostCwd;
					options.push({ label: t("wsCurrentOption", { name, path: hostCwd }), value: hostCwd });
				}
				if (ws && ws !== hostCwd) {
					const name =
						ws
							.replace(/[\\/]+$/, "")
							.split(/[\\/]/)
							.pop() || ws;
					options.push({ label: t("wsPinnedOption", { name, path: ws }), value: ws });
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
				listEl.innerHTML = `<div style="color: var(--text-dim); font-size: 12px; padding: 12px; text-align: center; border: 1px dashed var(--border); border-radius: 4px;">${esc(t("recentEmpty"))}</div>`;
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
				metaRow.innerHTML = `<span>👤 ${esc(t("chatUser"))}<strong>${item.authorId}</strong></span>${timeStr ? `<span>• ${timeStr}</span>` : ""}<span>• ${esc(t("chatSession"))}<code>${item.conversationId}</code></span>`;

				const textDiv = document.createElement("div");
				textDiv.style.cssText =
					"font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 550px;";
				const promptPreview = item.lastUserText ? `<strong>${esc(t("askPrefix"))}</strong>${item.lastUserText}` : "";
				const replyPreview = item.lastAssistantText
					? ` <span style="color:var(--text-dim);"><strong>${esc(t("replyPrefix"))}</strong>${item.lastAssistantText}</span>`
					: "";
				textDiv.innerHTML = promptPreview + replyPreview || esc(t("noMessageText"));

				infoCol.appendChild(metaRow);
				infoCol.appendChild(textDiv);

				const btn = document.createElement("button");
				btn.style.cssText =
					"padding: 6px 14px; border-radius: 4px; border: 1px solid var(--border); background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-size: 12px; font-weight: 500; flex-shrink: 0;";
				btn.textContent = t("openChat");
				btn.title = t("openChatTitle");

				btn.addEventListener("click", async () => {
					const bridge = globalThis.window?.__piWebUiHost;
					btn.disabled = true;
					btn.textContent = t("opening");
					try {
						if (bridge?.sessions?.open) {
							await bridge.sessions.open(item.openId || item.conversationId);
						}
						bridge?.setView?.("chat");
					} finally {
						btn.disabled = false;
						btn.textContent = t("openChat");
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
						resolve({ success: false, message: t("hostTimeout") });
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
			return Promise.resolve({ success: false, message: t("hostNotReady") });
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
				title: t("pickDirTitle"),
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
				alert?.(t("workspaceSet", { path: val || t("followGlobal") }));
				await refresh();
			} else {
				alert?.(t("switchFailed", { error: r?.message || t("unknownError") }));
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
				alert?.(t("workspaceCleared"));
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
				alert?.(t("modelSaved"));
				await refresh();
			} else {
				alert?.(t("saveFailed", { error: r?.message || t("unknownError") }));
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
				alert?.(t("modelReset"));
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
			cfgVoiceSpeaker.replaceChildren(new Option(t("defaultVoice"), ""));
			if (selected) cfgVoiceSpeaker.add(new Option(selected, selected));
			cfgVoiceSpeaker.value = selected;
			voiceError.textContent = currentState.botStatus?.lastVoiceError
				? t("voiceFallbackNotice", { error: currentState.botStatus.lastVoiceError })
				: "";
			try {
				const result = await sendHost("get_voice_options", { engine });
				if (request !== voiceRequest || engine !== cfgVoiceEngine.value) return;
				if (result?.type !== "voice_options") throw new Error(result?.message || t("voiceLoadFailed"));
				cfgVoiceSpeaker.replaceChildren(new Option(t("defaultVoice"), ""));
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
			cfgClientSecret.placeholder = cfg.hasClientSecret ? t("secretSavedPlaceholder") : t("secretPlaceholder");
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
				: [{ id: "builtin", label: t("builtinVoice") }];
			cfgVoiceEngine.replaceChildren(...engines.map((engine) => new Option(engine.label, engine.id)));
			if (cfg.voiceEngine && !engines.some((engine) => engine.id === cfg.voiceEngine))
				cfgVoiceEngine.add(new Option(t("voiceNotLoaded", { engine: cfg.voiceEngine }), cfg.voiceEngine));
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
				alert?.(t("needAppId"));
				return;
			}
			if (!clientSecret && !hasSavedSecret) {
				alert?.(t("needSecret"));
				return;
			}

			const btn = q(".qq-btn-test-cfg");
			btn.disabled = true;
			btn.textContent = t("testing");
			try {
				const testCfg = {
					appId,
					clientSecret,
					useSandbox: Boolean(cfgSandbox.checked),
				};
				const res = await sendHost("test_config", { config: testCfg });
				if (res?.success) {
					alert?.(res.message || t("testPassed"));
				} else {
					alert?.(res?.message ? t("testFailed", { error: res.message }) : t("testNoResponse"));
				}
			} finally {
				btn.disabled = false;
				btn.textContent = t("testConnection");
			}
		});

		q(".qq-btn-save-cfg").addEventListener("click", async () => {
			const appId = cfgAppId.value.trim();
			const clientSecret = cfgClientSecret.value.trim();
			const hasSavedSecret = Boolean(currentState.config?.hasClientSecret);

			if (cfgBotEnabled.checked && (!appId || (!clientSecret && !hasSavedSecret))) {
				alert?.(t("enableNeedsCreds"));
				return;
			}

			const btn = q(".qq-btn-save-cfg");
			btn.disabled = true;
			btn.textContent = t("savingConfig");

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
					alert?.(t("saveFailed", { error: res?.message || t("unknownError") }));
				}
			} finally {
				btn.disabled = false;
				btn.textContent = t("saveConfigBtn");
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
			fetchChannelsBtn.textContent = t("fetching");
			try {
				const res = await sendHost("list_channels");
				if (!res?.success) {
					alert?.(res?.message ? t("fetchFailed", { error: res.message }) : t("fetchFailedHint"));
					return;
				}
				const guilds = Array.isArray(res.guilds) ? res.guilds : [];
				if (guilds.length === 0) {
					alert?.(t("fetchNoGuilds"));
					return;
				}
				channelsDropdown.innerHTML = `<option value="">${esc(t("channelPickHint"))}</option>`;
				let count = 0;
				for (const g of guilds) {
					for (const c of g.channels || []) {
						count++;
						const opt = document.createElement("option");
						opt.value = c.id;
						opt.textContent = t("channelOption", { guild: g.guildName, channel: c.name, id: c.id });
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
					alert?.(t("fetchOk", { count }));
				} else {
					alert?.(t("fetchNoSubs"));
				}
			} finally {
				fetchChannelsBtn.disabled = false;
				fetchChannelsBtn.textContent = t("fetchChannels");
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
				alert?.(t("emptyMessage"));
				return;
			}

			const btn = q(".qq-btn-send");
			btn.disabled = true;
			btn.textContent = media ? t("uploading") : t("sending");
			try {
				const res = await sendHost("send_message", {
					channelId: channelInput.value.trim(),
					text,
					media,
					openid,
					openidType: openidTypeSel?.value === "group" ? "group" : "user",
				});
				if (res?.success) {
					alert?.(media ? t("sendOkMedia") : t("sendOkText"));
					textInput.value = "";
					if (mediaInput) mediaInput.value = "";
				} else {
					alert?.(t("sendFailed", { error: res?.message || t("unknownError") }));
				}
			} finally {
				btn.disabled = false;
				btn.textContent = t("sendMessage");
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
