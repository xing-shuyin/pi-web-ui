import {
	addressUrl,
	agentModeIcon,
	applySettings,
	arrowTopRightIcon,
	backIcon,
	bookmarksIcon,
	bridgeReady,
	browserModeIcon,
	button,
	call,
	clockIcon,
	closeIcon,
	createSvg,
	downloadIcon,
	element,
	enableCrxDropTarget,
	extensionIcon,
	forwardIcon,
	gearIcon,
	globeIcon,
	iconButton,
	input,
	keelBrandIcon,
	keyIcon,
	listenPanelEvents,
	listenState,
	markdownIcon,
	notify,
	plusIcon,
	reloadIcon,
	reportError,
	searchIcon,
	spinnerIcon,
	splitModeIcon,
	starIcon,
	svgPath,
	svgRect,
	translateIcon,
	type Settings,
} from "./common.js";
import { t } from "./i18n.js";
import { addCurrentBookmark, closeShellPanel, showShellPanel } from "./panels.js";
import type { BrowserMode, BrowserState } from "../contracts.js";
import { BROWSER_EXTENSION_PARTITION } from "../contracts.js";

document.body.classList.add("pb-shell");
enableCrxDropTarget();
let state: BrowserState | undefined;
let settings: Settings = {};
let searchOpen = false;

async function browserAction(
	action: "navigate" | "back" | "forward" | "reload" | "tabs.activate" | "tabs.create",
	args?: Record<string, unknown>,
): Promise<void> {
	await closeShellPanel();
	if (searchOpen) await hideSearch();
	if (state?.mode === "agent") await call("mode", { mode: "browser" });
	await call(action, args);
}

const app = document.querySelector<HTMLElement>("#app")!;
const chrome = element("header", "pb-chrome pb-chrome-flush-left");
const titlebar = element("div", "pb-chrome-row pb-tab-row");

const tabs = element("div", "pb-tabs");
tabs.setAttribute("role", "tablist");
tabs.setAttribute("aria-label", t("browser"));
const create = iconButton(plusIcon(12), `${t("newTab")} (Ctrl+T)`, () => browserAction("tabs.create"));
create.classList.add("pb-new-tab-btn");

const dragArea = element("div", "pb-drag-area");

// Agent 未就绪时（默认就是 Agent 启动）覆盖窗口，避免空白等待；失败时给出切换浏览器的出口
const boot = element("div", "pb-boot");
const bootIcon = element("div", "pb-boot-icon pb-spinning");
bootIcon.append(spinnerIcon(18));
const bootText = element("p", "pb-boot-text", t("bootingAgent"));
const bootError = element("p", "pb-boot-error", "");
const bootAction = button(t("switchToBrowser"), () => call("mode", { mode: "browser" }).then(() => {}, reportError));
bootAction.classList.add("pb-boot-action");
/**
 * “本机还没有内核”时的修复出口（纯壳包首次启动）：安装内核 / 安装 Node / 重试。
 * 三个动作全走已有的内核通道（`kernel.upgrade` = npm i -g + 重启，`kernel.installNode` = winget/brew），
 * 不另开一套：同一件事只能有一个实现（`docs/architecture-kernel.md` §纯壳包）。
 */
const bootRepair = element("div", "pb-boot-actions");
bootRepair.hidden = true;
let bootBusy = false;
async function runRepair(action: "kernel.upgrade" | "kernel.installNode" | "kernel.restart"): Promise<void> {
	if (bootBusy) return;
	bootBusy = true;
	bootError.textContent = t("kernelMissingBusy");
	try {
		const result = await call<{ ok: boolean; message: string }>(action);
		if (!result?.ok) bootError.textContent = String(result?.message ?? t("agentUnavailable"));
		// 成功时主进程会自己重启内核并推送新 state（`listenState`），这里不用再刷新。
	} catch (error) {
		bootError.textContent = error instanceof Error ? error.message : String(error);
	} finally {
		bootBusy = false;
	}
}
const installKernelBtn = button(t("kernelMissingInstall"), () => void runRepair("kernel.upgrade"));
const installNodeBtn = button(t("kernelMissingInstallNode"), () => void runRepair("kernel.installNode"));
const retryBtn = button(t("kernelMissingRetry"), () => void runRepair("kernel.restart"));
/**
 * 退出出口：Agent 模式下壳的 chrome 整条隐藏，窗口按钮由内核界面的标题栏提供；
 * 内核界面起不来时那些按钮就一个都不存在了，所以失败态必须自带一个能关窗的按钮。
 */
const exitBtn = button(t("bootExit"), () => window.piDesktop?.window.close());
installKernelBtn.classList.add("pb-boot-action");
installNodeBtn.classList.add("pb-boot-action");
retryBtn.classList.add("pb-boot-action");
exitBtn.classList.add("pb-boot-action");
bootRepair.append(installNodeBtn, installKernelBtn, retryBtn);
boot.append(bootIcon, bootText, bootError, bootRepair, bootAction, exitBtn);
app.append(boot);

function renderBoot(next: BrowserState, left: number): void {
	const missing = next.kernelMissing;
	const repair = next.kernelRepair;
	// 失败/需要修的时候覆盖层不能收：`agentReady` 只说明文档加载完了，
	// 内核回一张 503 诊断页它也照样为真（实机白屏就是这么来的）。
	const broken = Boolean(next.agentError || repair);
	const waiting = next.mode !== "browser" && (!next.agentReady || broken);
	boot.classList.toggle("pb-hidden", !waiting);
	if (!waiting) return;
	boot.style.left = "0px";
	boot.style.width = next.mode === "split" ? `${Math.max(0, left)}px` : "100%";
	boot.classList.toggle("pb-boot-failed", broken || Boolean(missing));
	// 失败/缺东西时没有人在干活，转圈只会让人以为“它在做事”（实机就是这个观感）。
	bootIcon.style.display = broken || missing ? "none" : "";
	bootText.textContent = repair
		? t("kernelRepairTitle")
		: missing
			? t("kernelMissingTitle")
			: next.agentError
				? t("agentUnavailable")
				: t("bootingAgent");
	// 有内核但装包不完整 = 给“修复内核 / 重试 / 退出”；还没有内核 = 再加“安装 Node”；
	// 其它失败 = 只给“重试 + 去浏览器 + 退出”。
	bootRepair.hidden = !missing && !repair;
	if (missing) {
		installNodeBtn.hidden = missing.nodeOk;
		installKernelBtn.hidden = !missing.nodeOk;
	}
	if (repair) {
		installNodeBtn.hidden = true;
		installKernelBtn.hidden = false;
	}
	exitBtn.hidden = !broken && !missing;
	if (!bootBusy) bootError.textContent = repair?.message ?? (next.agentError && !missing ? next.agentError : "");
}

const modeBtn = iconButton(splitModeIcon(13), "模式切换 (Ctrl+Alt+M)", async () => {
	await closeShellPanel();
	if (searchOpen) await hideSearch();
	const nextMode: BrowserMode = state?.mode === "browser" ? "split" : state?.mode === "split" ? "agent" : "browser";
	await call("mode", { mode: nextMode });
});
modeBtn.classList.add("pb-tool-btn");

const searchBtn = iconButton(searchIcon(13), "搜索或输入网址 (Ctrl+L)", () => {
	if (searchOpen) void hideSearch();
	else void openSearch();
});
searchBtn.classList.add("pb-tool-btn");

// 扩展入口：点开就是扩展面板（点行开扩展页面 / 行尾菜单启停、重载、移除），徽标只报「已启用」数量
const extensionsBtn = iconButton(extensionIcon(13), t("extensions"), () => showShellPanel("extensions"));
extensionsBtn.classList.add("pb-tool-btn");
const extensionsCount = element("span", "pb-tool-btn-count");
extensionsCount.hidden = true;
extensionsBtn.append(extensionsCount);

async function refreshExtensionsCount(): Promise<void> {
	try {
		const entries = await call<{ enabled: boolean }[]>("extensions.list");
		const enabled = entries.filter((entry) => entry.enabled).length;
		extensionsCount.textContent = String(enabled);
		extensionsCount.hidden = enabled === 0;
	} catch {
		// 面板自己能报错，工具栏上的计数静默降级
		extensionsCount.hidden = true;
	}
}

// TOTP 验证器：当前站点有绑定的条目时，图标上带一个小圆点（不看面板也知道「这里有」）
const totpBtn = iconButton(keyIcon(13), t("vault"), () => showShellPanel("vault", "totp"));
totpBtn.classList.add("pb-tool-btn");
const totpDot = element("span", "pb-tool-btn-dot");
totpDot.hidden = true;
totpBtn.append(totpDot);

async function refreshTotpMatch(): Promise<void> {
	try {
		const active = state?.tabs.find((tab) => tab.id === state?.activeTabId)?.url;
		if (!active) {
			totpDot.hidden = true;
			return;
		}
		let origin = "";
		try {
			origin = new URL(active).origin;
		} catch {
			totpDot.hidden = true;
			return;
		}
		const entries = await call<{ origin: string }[]>("totp.list");
		totpDot.hidden = !entries.some((entry) => entry.origin && entry.origin === origin);
	} catch {
		// 保管库锁定（系统加密不可用）或宿主未就绪：不亮圆点
		totpDot.hidden = true;
	}
}

const MIN_SPLIT_RATIO = 0.2;
const MAX_SPLIT_RATIO = 0.8;
const SNAP_THRESHOLD_PX = 60;

const controls = element("div", "pb-window-controls");

const minBtn = element("button", "pb-win-btn pb-win-min");
minBtn.type = "button";
minBtn.title = t("minimize") || "最小化";
minBtn.setAttribute("aria-label", t("minimize") || "最小化");
// 10 单位画布按 13px 显示（见 .pb-chrome-row 的 --pb-ctl-icon），描边按比例调到 ~1.1px
minBtn.append(createSvg(13, 13, "0 0 10 10", [svgPath("M1 5.5h8", "0.85")]));
minBtn.addEventListener("click", () => window.piDesktop?.window.minimize());

const maxBtn = element("button", "pb-win-btn pb-win-max");
maxBtn.type = "button";
function updateMaxBtn(maximized: boolean): void {
	maxBtn.replaceChildren(
		maximized
			? createSvg(13, 13, "0 0 10 10", [
					svgPath("M3 3V1.5C3 1.22 3.22 1 3.5 1H9.5C9.78 1 10 1.22 10 1.5V7.5C10 7.78 9.78 8 9.5 8H8", "0.85", "butt"),
					svgRect(1, 3, 7, 7, 0.5, "0.85"),
				])
			: createSvg(13, 13, "0 0 10 10", [svgRect(1, 1, 8, 8, 0.5, "0.85")]),
	);
	const tip = maximized ? t("restore") || "向下还原" : t("maximize") || "最大化";
	maxBtn.title = tip;
	maxBtn.setAttribute("aria-label", tip);
}
updateMaxBtn(false);
void window.piDesktop?.window
	.isMaximized()
	.then(updateMaxBtn)
	.catch(() => {});
window.piDesktop?.window.onMaximizedChange?.(updateMaxBtn);
maxBtn.addEventListener("click", () => window.piDesktop?.window.toggleMaximize());

const closeBtn = element("button", "pb-win-btn pb-win-close");
closeBtn.type = "button";
closeBtn.title = t("closeWindow") || "关闭";
closeBtn.setAttribute("aria-label", t("closeWindow") || "关闭");
closeBtn.append(createSvg(13, 13, "0 0 10 10", [svgPath("M1.5 1.5l7 7M8.5 1.5l-7 7", "0.85", "round")]));
closeBtn.addEventListener("click", () => window.piDesktop?.window.close());

if (window.piDesktop?.platform === "darwin") {
	document.body.classList.add("pb-mac");
	controls.style.display = "none";
	window.piDesktop.window.onFullScreenChange?.((isFullScreen: boolean) => {
		document.body.classList.toggle("pb-fullscreen", isFullScreen);
	});
}

controls.append(minBtn, maxBtn, closeBtn);

// 扩展动作：Electron 不渲染 chrome.action 的图标/badge，electron-chrome-extensions 的
// <browser-action-list> 把它们变成工具栏上真实的按钮（点击就是 Chrome 的 popup / onClicked）。
// 必须用 JS 建：库在 preload 里定义自定义元素，HTML 里的静态标签会在升级前就被解析。
const actionList = document.createElement("browser-action-list");
actionList.className = "pb-action-list";
actionList.setAttribute("partition", BROWSER_EXTENSION_PARTITION);
actionList.setAttribute("alignment", "bottom left");

const items = element("div", "pb-tool-items");
items.append(actionList);

// 第一行只放「窗框」：标签页、新建、模式、搜索、扩展动作图标、窗口按钮
titlebar.append(tabs, create, dragArea, modeBtn, searchBtn, items, controls);

/**
 * 第二行：一条位置固定的工具栏（后退/前进/刷新 · 收藏/书签/下载/历史/翻译/复制Markdown · 验证器/扩展/设置）。
 * 这些动作以前挂在页面右下角的悬浮圆钮上（已下线）：它跟着站点漂、会被站点层级压住、换个站就换位置，
 * 用户经常找不到。现在全部钉在标签页下沿这一行里，位置永远不变。
 */
const toolRow = element("div", "pb-chrome-row pb-tool-row");
const navGroup = element("div", "pb-tool-group");
const pageGroup = element("div", "pb-tool-group");
const toolGroup = element("div", "pb-tool-group pb-tool-group-end");

const backBtn = iconButton(backIcon(14), `${t("back")} (Alt+←)`, () => browserAction("back"));
const forwardBtn = iconButton(forwardIcon(14), `${t("forward")} (Alt+→)`, () => browserAction("forward"));
const reloadBtn = iconButton(reloadIcon(14), `${t("reload")} (Ctrl+R)`, () => browserAction("reload"));
const starBtn = iconButton(starIcon(14), `${t("addBookmark")} (Ctrl+D)`, () => addCurrentBookmark());
const bookmarksBtn = iconButton(bookmarksIcon(14), t("bookmarks"), () => showShellPanel("bookmarks"));
const downloadsBtn = iconButton(downloadIcon(14), t("downloads"), () => showShellPanel("downloads"));
const downloadsCount = element("span", "pb-tool-btn-count");
downloadsCount.hidden = true;
downloadsBtn.append(downloadsCount);
const historyBtn = iconButton(clockIcon(14), t("history"), () => showShellPanel("history"));
// 翻译 / 复制 Markdown 是页面级能力（得在站点自己的文档里跑），交给宿主在活动标签页上执行
const translateBtn = iconButton(translateIcon(14), t("translatePage"), () => runPageCommand("page.translate"));
const markdownBtn = iconButton(markdownIcon(14), t("copyMarkdown"), () => runPageCommand("page.markdown"));
const settingsBtn = iconButton(gearIcon(14), t("settings"), () => showShellPanel("settings"));

for (const btn of [
	backBtn,
	forwardBtn,
	reloadBtn,
	starBtn,
	bookmarksBtn,
	downloadsBtn,
	historyBtn,
	translateBtn,
	markdownBtn,
	settingsBtn,
])
	btn.classList.add("pb-tool-btn");

navGroup.append(backBtn, forwardBtn, reloadBtn);
pageGroup.append(starBtn, bookmarksBtn, downloadsBtn, historyBtn, translateBtn, markdownBtn);
toolGroup.append(totpBtn, extensionsBtn, settingsBtn);
toolRow.append(navGroup, pageGroup, toolGroup);

/** 页面级动作：宿主把结果消息回给外壳，用 toast 报一句，不做假成功。 */
async function runPageCommand(action: "page.translate" | "page.markdown"): Promise<void> {
	try {
		const message = await call<string>(action);
		if (message) notify(message);
		if (action === "page.translate") watchPageTranslation(message);
	} catch (error) {
		reportError(error);
	}
}

/**
 * 整页翻译是页面里跑的异步活（几十段、几十秒），点完按钮后轮询页面状态：
 * 翻译中不刷屏，完成/失败才再报一句——悬浮球下线后，这是唯一能“看见它到底成没成”的地方。
 */
let translatePollTimer: ReturnType<typeof setInterval> | undefined;
function watchPageTranslation(started: string): void {
	// 刚点的是「显示原文」或页面不支持：没有活要等
	if (!started || started.includes("原文") || started.includes("不支持") || started.includes("进行中")) return;
	if (translatePollTimer !== undefined) clearInterval(translatePollTimer);
	const startedAt = Date.now();
	translatePollTimer = setInterval(() => {
		void (async () => {
			const timedOut = Date.now() - startedAt > 120_000;
			const state = await call<{ pageState?: string; done?: number; failed?: number } | null>(
				"page.translateState",
			).catch(() => null);
			if (!timedOut && (!state || state.pageState === "translating")) return;
			if (translatePollTimer !== undefined) clearInterval(translatePollTimer);
			translatePollTimer = undefined;
			if (timedOut) return;
			if (state?.pageState === "translated")
				notify(
					state.failed ? `${t("translateDone")} · ${t("translateFailedParts")}: ${state.failed}` : t("translateDone"),
				);
			else notify(t("translateFailed"), true);
		})();
	}, 1000);
}

/** 工具栏下载计数：只有真在下的任务才亮徽标（下完不亮，翻面板看列表）。 */
let downloadPollTimer: ReturnType<typeof setTimeout> | undefined;
let downloadsCheckedAt = 0;
async function refreshDownloadsCount(force = false): Promise<void> {
	// 状态推送很密（每次加载进度都来一发），徽标不需要那个新鲜度：两秒内只问一次
	const now = Date.now();
	if (!force && now - downloadsCheckedAt < 2000) return;
	downloadsCheckedAt = now;
	try {
		const entries = await call<{ state: string }[]>("downloads.list");
		const active = entries.filter((entry) => entry.state === "progressing").length;
		downloadsCount.textContent = String(active);
		downloadsCount.hidden = active === 0;
		if (active > 0 && downloadPollTimer === undefined) {
			downloadPollTimer = setTimeout(() => {
				downloadPollTimer = undefined;
				void refreshDownloadsCount(true);
			}, 1500);
		}
	} catch {
		// 面板自己能报错，工具栏上的计数静默降级
		downloadsCount.hidden = true;
	}
}

// 中间可拖拽分栏线 (Direct Draggable Split Divider)
const divider = element("div", "pb-split-divider");
const dividerLine = element("div", "pb-split-divider-line");
const dividerBadge = element("div", "pb-split-divider-badge");
divider.append(dividerLine, dividerBadge);
app.append(divider);

let isDraggingDivider = false;
let ratioFrame = 0;

divider.addEventListener("pointerdown", (event) => {
	if (event.button !== 0) return;
	event.preventDefault();
	isDraggingDivider = true;
	divider.setPointerCapture(event.pointerId);
	divider.classList.add("pb-dragging");
	document.body.classList.add("pb-is-resizing");
});

divider.addEventListener("pointermove", (event) => {
	if (!isDraggingDivider) return;
	const width = window.innerWidth;
	if (width <= 0) return;
	const x = event.clientX;
	const r = x / width;

	if (r > 0.92 || x > width - SNAP_THRESHOLD_PX) {
		divider.classList.add("pb-snap-agent");
		divider.classList.remove("pb-snap-browser");
		dividerBadge.textContent = "释放隐藏浏览器";
		const left = Math.floor(width * MAX_SPLIT_RATIO);
		chrome.style.left = `${left}px`;
		chrome.style.width = `${Math.max(0, width - left)}px`;
		divider.style.left = `${left - 3}px`;
	} else if (r < 0.08 || x < SNAP_THRESHOLD_PX) {
		divider.classList.add("pb-snap-browser");
		divider.classList.remove("pb-snap-agent");
		dividerBadge.textContent = "释放隐藏智能体";
		const left = Math.floor(width * MIN_SPLIT_RATIO);
		chrome.style.left = `${left}px`;
		chrome.style.width = `${Math.max(0, width - left)}px`;
		divider.style.left = `${left - 3}px`;
	} else {
		divider.classList.remove("pb-snap-agent", "pb-snap-browser");
		const clamped = Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, r));
		const left = Math.floor(width * clamped);
		const right = Math.max(0, width - left);
		chrome.style.left = `${left}px`;
		chrome.style.width = `${right}px`;
		divider.style.left = `${left - 3}px`;
		dividerBadge.textContent = `${Math.round(clamped * 100)}% | ${Math.round((1 - clamped) * 100)}%`;
		cancelAnimationFrame(ratioFrame);
		ratioFrame = requestAnimationFrame(() => {
			void call("splitRatio", { ratio: clamped }).catch(reportError);
		});
	}
});

function finishDividerDrag(event: PointerEvent): void {
	if (!isDraggingDivider) return;
	isDraggingDivider = false;
	divider.classList.remove("pb-dragging", "pb-snap-agent", "pb-snap-browser");
	document.body.classList.remove("pb-is-resizing");
	try {
		divider.releasePointerCapture(event.pointerId);
	} catch {}

	const width = window.innerWidth;
	if (width <= 0) return;
	const x = event.clientX;
	const r = x / width;

	if (r > 0.92 || x > width - SNAP_THRESHOLD_PX) {
		void call("mode", { mode: "agent" }).catch(reportError);
	} else if (r < 0.08 || x < SNAP_THRESHOLD_PX) {
		void call("mode", { mode: "browser" }).catch(reportError);
	} else {
		const clamped = Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, r));
		void call("splitRatio", { ratio: clamped }).catch(reportError);
	}
}

divider.addEventListener("pointerup", finishDividerDrag);
divider.addEventListener("pointercancel", finishDividerDrag);

const progressBarWrap = element("div", "pb-progress-bar-wrap");
const progressBar = element("div", "pb-progress-bar");
progressBarWrap.append(progressBar);

chrome.append(titlebar, toolRow, progressBarWrap);
app.append(chrome);

// 极简搜索浮层 (参照 E:\ai-browser\src\search.html)
const searchOverlay = element("div", "pb-search-overlay");
const searchCard = element("div", "pb-search-card");
const searchForm = element("form", "pb-search-form");
const searchIconEl = element("span", "pb-search-icon");
searchIconEl.append(searchIcon(16));
const searchInput = input("", "text");
searchInput.classList.add("pb-search-input");
searchInput.placeholder = t("addressHint") || "输入网址或搜索关键词…";
searchInput.autocomplete = "off";
searchInput.spellcheck = false;
const searchSubmit = iconButton(arrowTopRightIcon(12), t("search"), () => {});
searchSubmit.type = "submit";
searchSubmit.classList.add("pb-search-submit");
const searchEsc = element("span", "pb-search-esc", "ESC");
searchForm.append(searchIconEl, searchInput, searchSubmit, searchEsc);

const searchActions = element("div", "pb-search-actions");
const aiAction = button(
	[agentModeIcon(13), element("span", "", t("agent") || "AI 智能体")],
	async () => {
		await hideSearch();
		await call("mode", { mode: "split" });
	},
	"pb-action-chip",
);
const newTabAction = button(
	[plusIcon(11), element("span", "", t("newTab") || "新建标签")],
	async () => {
		await hideSearch();
		await browserAction("tabs.create");
	},
	"pb-action-chip",
);
searchActions.append(aiAction, newTabAction);

searchCard.append(searchForm, searchActions);
searchOverlay.append(searchCard);
document.body.append(searchOverlay);

async function openSearch(): Promise<void> {
	if (searchOpen) return;
	await closeShellPanel();
	searchOpen = true;
	await call("overlay", { open: true });
	searchOverlay.classList.add("pb-open");
	const currentTab = state?.tabs.find((tab) => tab.id === state?.activeTabId);
	searchInput.value = !currentTab || currentTab.internal ? "" : currentTab.url;
	setTimeout(() => {
		searchInput.focus();
		searchInput.select();
	}, 60);
}

async function hideSearch(): Promise<void> {
	if (!searchOpen) return;
	searchOpen = false;
	searchOverlay.classList.remove("pb-open");
	await call("overlay", { open: false });
}

searchForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const val = searchInput.value.trim();
	if (!val) {
		void hideSearch();
		return;
	}
	void (async () => {
		await hideSearch();
		const url = addressUrl(val, settings.searchEngine);
		await browserAction("navigate", { url });
	})().catch(reportError);
});

searchEsc.addEventListener("click", () => void hideSearch());
searchOverlay.addEventListener("click", (event) => {
	if (event.target === searchOverlay) void hideSearch();
});
searchInput.addEventListener("keydown", (event) => {
	if (event.key === "Escape") {
		event.preventDefault();
		void hideSearch();
	}
});

function updateProgress(next: BrowserState): void {
	const tab = next.tabs.find((tab) => tab.id === next.activeTabId);
	if (tab?.loading) {
		progressBar.style.width = "75%";
		progressBar.style.opacity = "1";
	} else {
		progressBar.style.width = "100%";
		setTimeout(() => {
			const current = state?.tabs.find((t) => t.id === state?.activeTabId);
			if (!current?.loading) {
				progressBar.style.opacity = "0";
				setTimeout(() => {
					progressBar.style.width = "0%";
				}, 250);
			}
		}, 180);
	}
}

function render(next: BrowserState): void {
	const previous = state;
	state = next;
	void refreshTotpMatch();
	tabs.replaceChildren();
	for (const tab of next.tabs) {
		const row = element("div", `pb-tab${tab.id === next.activeTabId ? " pb-active" : ""}`);
		const activate = button("", () => browserAction("tabs.activate", { id: tab.id }), "pb-tab-activate");
		activate.setAttribute("role", "tab");
		activate.setAttribute("aria-selected", String(tab.id === next.activeTabId));
		activate.title = tab.url;
		const mark = element("span", tab.loading ? "pb-tab-mark pb-spinning" : "pb-tab-mark");
		if (tab.loading) {
			mark.append(spinnerIcon(12));
		} else if (tab.favicon) {
			// 站点图标：http(s) 或 data:image，两类都在 shell 的 img-src 白名单里
			const icon = element("img", "pb-tab-favicon");
			icon.src = tab.favicon;
			icon.alt = "";
			icon.decoding = "async";
			icon.addEventListener("error", () => {
				// 站点图标 404 / 被拦：退回地球图标，别留一个空白框
				icon.replaceWith(globeIcon(12));
			});
			mark.append(icon);
		} else if (tab.internal) {
			mark.append(keelBrandIcon(12));
		} else {
			mark.append(globeIcon(12));
		}
		activate.append(mark, element("span", "pb-tab-title", tab.title || t("newTab")));
		const close = iconButton(closeIcon(8), `${t("closeTab")}: ${tab.title || t("newTab")}`, () =>
			call("tabs.close", { id: tab.id }),
		);
		close.classList.add("pb-tab-close");
		row.addEventListener("auxclick", (event) => {
			if (event.button === 1) {
				event.preventDefault();
				void call("tabs.close", { id: tab.id }).catch(reportError);
			}
		});
		// 整块高亮区域都可点：激活按钮之外的左右留白（关闭键旁边那几像素）也算点标签
		row.addEventListener("click", (event) => {
			const target = event.target as Element | null;
			if (target?.closest(".pb-tab-close, .pb-tab-activate")) return;
			void browserAction("tabs.activate", { id: tab.id });
		});
		// 右键：原生菜单（引用到输入框 / 复制链接 / 重新加载 / 关闭…），菜单位置就放在鼠标那一点
		row.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			void call<string>("tabs.menu", { id: tab.id, x: event.clientX, y: event.clientY })
				.then((message) => {
					if (message) notify(message);
				})
				.catch(reportError);
		});
		row.append(activate, close);
		tabs.append(row);
	}
	if (previous?.activeTabId !== next.activeTabId || previous?.tabs.length !== next.tabs.length)
		tabs.querySelector(".pb-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });

	const modeConfig: Record<BrowserMode, { icon: () => SVGSVGElement; title: string }> = {
		browser: { icon: () => browserModeIcon(15), title: "当前：浏览器模式 (点击切换为分栏协作)" },
		split: { icon: () => splitModeIcon(15), title: "当前：分栏协作模式 (点击切换为智能体模式)" },
		agent: { icon: () => agentModeIcon(15), title: "当前：智能体模式 (点击切换为浏览器模式)" },
	};
	const cfg = modeConfig[next.mode] || modeConfig.browser;
	modeBtn.replaceChildren(cfg.icon());
	modeBtn.title = `${cfg.title} (Ctrl+Alt+M)`;

	// 后退/前进不可用时置灰：依旧可点（点了就是无操作），但看得出“到头了”
	const activeTab = next.tabs.find((tab) => tab.id === next.activeTabId);
	backBtn.disabled = !activeTab?.canGoBack;
	forwardBtn.disabled = !activeTab?.canGoForward;

	updateProgress(next);
	void refreshDownloadsCount();
	updateChromePosition(next);
}

function updateChromePosition(next: BrowserState): void {
	const split = Number.isFinite(next.splitRatio)
		? Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, next.splitRatio))
		: 0.5;
	const left = next.mode === "split" ? Math.floor(window.innerWidth * split) : 0;
	chrome.classList.toggle("pb-chrome-flush-left", next.mode !== "split");
	if (next.mode === "split") {
		const right = Math.max(0, window.innerWidth - left);
		chrome.style.display = "";
		chrome.style.left = `${left}px`;
		chrome.style.width = `${right}px`;
		chrome.style.borderLeft = "";

		divider.style.display = "flex";
		divider.style.left = `${left - 3}px`;
	} else {
		// Agent 模式下壳的 chrome 整条让位给内核界面（窗口按钮由它自己的标题栏提供）。
		// 但内核界面起不来时它一个按钮都拿不出来，用户连关窗/最小化都做不到（实机：白页只能强杀），
		// 所以失败态必须把壳自己的 chrome 放回来。
		const agentBroken = Boolean(next.agentError || next.kernelRepair || next.kernelMissing);
		chrome.style.display = next.mode === "browser" || agentBroken ? "" : "none";
		chrome.style.left = "0px";
		chrome.style.width = "100%";
		chrome.style.borderLeft = "";
		divider.style.display = "none";
	}
	nudgeDragRegion();
	renderBoot(next, left);
}

/**
 * 分栏模式用内联 left/width 挪 .pb-chrome：位置一动，原生拖拽区的几何就得重算。
 * Electron 只在下一帧提交拖拽区信息时才重算，挪完位置不动它就可能留着旧矩形 ——
 * 旧矩形是浏览器模式下的整条窗宽，正好压在移位后的标签上，表现就是「标签点不动」。
 * 改一次 drag/no-drag 是成本最低的强制重算（拖拽区现在只有 .pb-drag-area 一块）。
 * 只在几何真的变了才抖：状态推送很密，每帧都抖会让空白条忽强忽不拖。
 */
let dragNudgeFrame = 0;
let lastChromeKey = "";
function nudgeDragRegion(): void {
	const key = `${chrome.style.display}|${chrome.style.left}|${chrome.style.width}`;
	if (key === lastChromeKey) return;
	lastChromeKey = key;
	cancelAnimationFrame(dragNudgeFrame);
	dragArea.style.setProperty("-webkit-app-region", "no-drag");
	dragNudgeFrame = requestAnimationFrame(() => {
		dragNudgeFrame = requestAnimationFrame(() => {
			dragArea.style.removeProperty("-webkit-app-region");
		});
	});
}

window.addEventListener("resize", () => {
	if (state) updateChromePosition(state);
});

listenState(render);

void bridgeReady()
	.then((bridge) => {
		const dispose = bridge.onOpenOptions?.(() => {
			void showShellPanel("settings").catch(reportError);
		});
		if (dispose) window.addEventListener("pagehide", dispose, { once: true });
		const focusDispose = bridge.onFocusAddress?.(() => {
			void openSearch().catch(reportError);
		});
		if (focusDispose) window.addEventListener("pagehide", focusDispose, { once: true });
	})
	.catch(reportError);

async function loadSettings(): Promise<void> {
	settings = await call<Settings>("settings.get");
	applySettings(settings);
}

window.addEventListener("pb-settings-changed", () => {
	void loadSettings().catch(reportError);
});
window.addEventListener("pb-extensions-changed", () => void refreshExtensionsCount());
window.addEventListener("pb-vault-changed", () => void refreshTotpMatch());
// 面板开在自己的视图里，那里的改动只能由宿主转发过来
listenPanelEvents((name) => {
	if (name === "pb-settings-changed") void loadSettings().catch(reportError);
	if (name === "pb-extensions-changed") void refreshExtensionsCount();
	if (name === "pb-vault-changed") void refreshTotpMatch();
});
window.addEventListener("focus", () => {
	void loadSettings().catch(reportError);
});

window.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && searchOpen) {
		event.preventDefault();
		void hideSearch();
		return;
	}
	if (event.altKey && (event.key === "ArrowLeft" || event.key === "Left")) {
		event.preventDefault();
		void browserAction("back").catch(reportError);
		return;
	}
	if (event.altKey && (event.key === "ArrowRight" || event.key === "Right")) {
		event.preventDefault();
		void browserAction("forward").catch(reportError);
		return;
	}
	if (event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "m") {
		event.preventDefault();
		const nextMode: BrowserMode = state?.mode === "browser" ? "split" : state?.mode === "split" ? "agent" : "browser";
		void call("mode", { mode: nextMode }).catch(reportError);
		return;
	}
	// F12 / Ctrl+Shift+I：焦点在外壳（地址栏、面板）时也开当前标签页的开发者工具
	if (event.key === "F12" || ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "i")) {
		event.preventDefault();
		void call("devtools.toggle", { id: state?.activeTabId }).catch(reportError);
		return;
	}
	if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
	const key = event.key.toLowerCase();
	if (key === "l" || key === "k") {
		event.preventDefault();
		if (searchOpen) void hideSearch();
		else void openSearch();
	}
	if (key === "t") {
		event.preventDefault();
		void browserAction("tabs.create").catch(reportError);
	}
	if (key === "w" && state?.activeTabId) {
		event.preventDefault();
		void call("tabs.close", { id: state.activeTabId }).catch(reportError);
	}
	if (key === "r") {
		event.preventDefault();
		void browserAction("reload").catch(reportError);
	}
	if (key === "d") {
		event.preventDefault();
		void addCurrentBookmark().catch(reportError);
	}
});

void Promise.all([call<BrowserState>("state").then(render), loadSettings(), refreshExtensionsCount()]).catch(
	reportError,
);
