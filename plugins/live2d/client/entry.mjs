import { detectLang, makeT } from "./i18n.mjs";
import { getClientBase } from "./models.mjs";
import { Live2DWidget } from "./widget.mjs";

const RUNTIME_KEY = "__piLive2dRuntime";

const previous = globalThis[RUNTIME_KEY];
if (previous?.destroy) {
	try {
		previous.destroy();
	} catch (err) {
		console.warn("[live2d] 清理旧实例失败:", err);
	}
}

const clientBase = getClientBase(import.meta.url);
const currentLang = detectLang();
const t = makeT(currentLang);

const widget = new Live2DWidget({
	clientBase,
	t,
});
void widget.start();

function onPluginData(e) {
	const detail = e.detail;
	if (detail?.pluginId !== "live2d") return;
	const payload = detail.payload;
	if (!payload) return;

	if (payload.type === "live2d:action") {
		const { action } = payload;
		if (action === "expression") {
			widget.stage?.playExpression(payload.name);
			if (payload.text) widget.showBubble(payload.text, payload.duration || 4000);
		} else if (action === "thought") {
			if (payload.expression) widget.stage?.playExpression(payload.expression);
			widget.showThought(payload.text, payload.duration || 5000);
		} else if (action === "bubble" || action === "message") {
			if (payload.expression) widget.stage?.playExpression(payload.expression);
			widget.showBubble(payload.text, payload.duration || 4000, { isThought: Boolean(payload.thought) });
		} else if (action === "mode") {
			if (payload.mode === "mouse" || payload.mode === "idle") {
				widget.config.mode = payload.mode;
				widget.stage?.setMode(payload.mode);
			}
		} else if (action === "model_switch") {
			if (payload.model) widget.switchModel(payload.model);
		} else if (action === "play_audio") {
			if (payload.url) void widget.playAudio(payload.url, payload.name, payload.volume);
		} else if (action === "stop_audio") {
			widget.stopAudio();
		} else if (action === "blink") {
			widget.triggerBlink(payload.blinkType || "both");
		}
	} else if (payload.type === "live2d:agent-event") {
		const { status } = payload;
		if (status === "thinking" || status === "running") {
			widget.onAgentThinking();
		} else if (status === "done") {
			widget.onAgentDone();
		} else if (status === "error") {
			widget.onAgentError();
		}
	} else if (payload.type === "live2d:custom-models-updated") {
		if (Array.isArray(payload.models)) {
			for (const m of payload.models) {
				if (!widget.models.some((x) => x.key === m.key)) {
					widget.models.push(m);
				}
			}
		}
	} else if (payload.type === "live2d:settings-updated") {
		const s = payload.settings;
		if (!s) return;
		if (s.enabled !== undefined) {
			if (s.enabled && !widget.visible) widget.show();
			else if (!s.enabled && widget.visible) widget.hide();
		}
		if (s.clickThrough !== undefined) {
			widget.toggleClickThrough(Boolean(s.clickThrough));
		}
		if (s.defaultModel && s.defaultModel !== widget.activeModel?.key) {
			widget.switchModel(s.defaultModel);
		}
		if (s.mode && s.mode !== widget.config.mode) {
			widget.config.mode = s.mode;
			widget.stage?.setMode(s.mode);
		}
		if (typeof s.scale === "number" && s.scale !== widget.config.scale) {
			widget.setScale(s.scale);
		}
		if (s.soundEnabled !== undefined) {
			widget.config.soundEnabled = Boolean(s.soundEnabled);
		}
		if (s.reactToAgent !== undefined) {
			widget.config.reactToAgent = Boolean(s.reactToAgent);
		}
		if (s.autoBlink !== undefined) {
			widget.config.autoBlink = Boolean(s.autoBlink);
			widget.stage?.setAutoBlink(widget.config.autoBlink);
		}
		if (s.voiceOnly !== undefined) {
			widget.config.voiceOnly = Boolean(s.voiceOnly);
			widget.stage?.setVoiceOnly(widget.config.voiceOnly);
		}
		if (typeof s.lipSyncSensitivity === "number") {
			widget.config.lipSyncSensitivity = s.lipSyncSensitivity;
			widget.stage?.setLipSyncSensitivity(s.lipSyncSensitivity);
		}
	}
}

window.addEventListener("pi-web-ui:plugin-data", onPluginData);

function handleToggleOrUnlock() {
	if (widget.config.clickThrough) {
		widget.toggleClickThrough(false);
		if (!widget.visible) widget.show();
	} else {
		widget.toggle();
	}
}

const unbinds = [];
const hostBridge = window.__piWebUiHost;
if (typeof hostBridge?.onUiAction === "function") {
	unbinds.push(hostBridge.onUiAction("live2d:toggle", handleToggleOrUnlock));
	unbinds.push(hostBridge.onUiAction("toggle", handleToggleOrUnlock));
}

const onKeyDown = (e) => {
	if (e.altKey && (e.key === "l" || e.key === "L")) {
		e.preventDefault();
		handleToggleOrUnlock();
	}
};
window.addEventListener("keydown", onKeyDown);

const runtime = {
	widget,
	toggle: handleToggleOrUnlock,
	destroy() {
		window.removeEventListener("pi-web-ui:plugin-data", onPluginData);
		window.removeEventListener("keydown", onKeyDown);
		for (const u of unbinds) {
			try {
				u();
			} catch {}
		}
		widget.destroy();
	},
};

globalThis[RUNTIME_KEY] = runtime;

export default runtime;
