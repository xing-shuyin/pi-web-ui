/**
 * 面板浮层视图（`panel.html`）：一块面板一个视图，由宿主摆成盖在页面之上的一块矩形
 * （`desktop/browser-host.ts` 的 `panel` 动作）。页面与 Agent 分栏在它周围照常可见——
 * 所以这里不铺遮罩、不隐藏内容区，只负责画面板、把面板自己要多大报回去、收起时让宿主销毁视图。
 */
import { applySettings, call, reportError, type Settings } from "./common.js";
import { BROWSER_PANELS, type BrowserState } from "../contracts.js";
import { setPanelState, showPanel, usePanelLayer } from "./panels.js";
import { t } from "./i18n.js";

document.body.classList.add("pb-panel-layer");
usePanelLayer();

const requested = new URLSearchParams(location.search).get("panel");
const panel = BROWSER_PANELS.find((name) => name === requested);

if (!panel) {
	document.body.textContent = t("error");
} else {
	void (async () => {
		// 面板要读当前标签页与外观设置（历史/下载/书签都依赖它们），先各取一份
		const [state, settings] = await Promise.all([call<BrowserState>("state"), call<Settings>("settings.get")]);
		applySettings(settings);
		setPanelState(state);
		await showPanel(panel);
	})().catch((error: Error) => {
		// 起不来也要留一行字：宿主会在兜底耗时后把这块视图亮出来
		document.body.textContent = error.message;
		reportError(error);
	});
}
