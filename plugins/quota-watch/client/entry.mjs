import { hostApi } from "@pi-web-ui/plugin-sdk/client";
import { createQuotaCard } from "./card.mjs";
import { createSummaryStore } from "./store.mjs";
import { ensureStyles } from "./styles.mjs";

const KEY = "__piQuotaWatch";
const FOOTER_KEY = "quota-watch";
const PLUGIN_ID = "quota-watch";
/** 闲着 60 秒一次；浮层开着（store.hold()）自动降到 15 秒。 */
const IDLE_POLL_MS = 60_000;
const ACTIVE_POLL_MS = 15_000;

const api = hostApi();
const API = resolveApiBase(import.meta.url);
/** 唯一数据源：底栏与浮层订阅同一份快照（旧实现各拉一次，才会「点了刷新底栏不动」）。 */
const store = createSummaryStore({ apiBase: API, idleMs: IDLE_POLL_MS, activeMs: ACTIVE_POLL_MS });
/** 稳定的 render 引用：宿主按引用比较，每次轮询新建会让开着的卡片重挂。 */
const renderCard = createQuotaCard({ apiBase: API, store });

// 宿主重载 bundle 时把上一份彻底清掉（含底栏槽与轮询）
globalThis[KEY]?.destroyAll?.();

let disposed = false;
/** 上一次推给宿主的文本：一样就别重复推，省掉宿主的无谓重渲染。 */
let lastPushed = "";

function resolveApiBase(importMetaUrl) {
	const base = String(importMetaUrl);
	const idx = base.indexOf("/plugins/");
	const root = idx >= 0 ? base.slice(0, idx) : base.replace(/\/[^/]*$/, "");
	return `${root}/plugins-api/${PLUGIN_ID}`;
}

/**
 * 把一份快照的底栏部分交给宿主的内置槽（斜杠接在「当前对话费用」后面）。
 *
 * `content.render` 是**内容**而不是外壳：点它弹的跟随浮层由宿主负责
 * （定位 / 翻转 / 跟随 / 点外关闭 / 层级 / 主题），插件只往容器里画那几行。
 * 文本为空 = 当前模型没有对应的额度来源，此时清掉槽（底栏与浮层一起消失）。
 * @param {any} data
 */
function pushFooter(data) {
	if (disposed) return;
	const footer = data?.footer;
	if (!footer?.text) {
		if (lastPushed !== "") {
			lastPushed = "";
			api?.setFooterStatus?.(FOOTER_KEY, null);
		}
		return;
	}
	const text = String(footer.text);
	const tip = String(footer.tip ?? footer.text);
	const key = `${text}\u0000${tip}`;
	if (key === lastPushed) return;
	lastPushed = key;
	api?.setFooterStatus?.(FOOTER_KEY, {
		text,
		tip,
		pluginId: PLUGIN_ID,
		content: { render: renderCard },
	});
}

const unsubscribe = store.subscribe(pushFooter);

function startPolling() {
	if (disposed) return;
	store.start();
	window.addEventListener("focus", onFocus);
	document.addEventListener("visibilitychange", onVisibility);
}

function onFocus() {
	// 回来第一件事：拿最新的一份（命中缓存就秒回，过期才出网）
	void store.refresh(false).catch(() => {});
}

function onVisibility() {
	if (document.visibilityState === "visible") onFocus();
}

function destroyAll() {
	if (disposed) return;
	disposed = true;
	unsubscribe();
	store.stop();
	lastPushed = "";
	window.removeEventListener("focus", onFocus);
	document.removeEventListener("visibilitychange", onVisibility);
	api?.setFooterStatus?.(FOOTER_KEY, null);
}

globalThis[KEY] = { destroyAll };

ensureStyles();
startPolling();

export default {
	dispose() {
		destroyAll();
	},
};
