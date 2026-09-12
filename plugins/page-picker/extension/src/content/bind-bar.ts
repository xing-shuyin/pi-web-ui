/// <reference path="../chrome.d.ts" />
/// <reference lib="dom" />
/**
 * 「绑定服务」浮条（content script，**只注入到 pi-web-ui 页面本身**）。
 *
 * 它解决的是远程/局域网部署的第一公里：地址可能是 `http://39.99.235.208:8787`、
 * 端口也不固定，而用户此刻就站在那个页面上 —— 与其让他去选项页手打地址，不如在页面上
 * 问一句「要不要把它设成拾取服务地址」。注入时机由 background 决定（探测出本页是
 * pi-web-ui 才注入），所以这里不再判断「是不是 pi-web-ui」，只算「要问什么」。
 *
 * 与拾取器的区别：只提供信息，不改页面数据。挂在 Shadow DOM 里（`:host { all: initial }`），
 * 页面 CSS 进不来、我们的样式出不去。
 *
 * 这里用 **open** shadow root（拾取器是 closed）：浮条的按钮必须能被自动化点到
 * （`tests/page-picker-test.mjs` 真的点「设为服务地址」走一遍完整链路），而它不含任何敏感
 * 数据 —— 文案就是用户自己看得见的那两行。
 */

import { bindView, type BindResult, type BindView } from "../shared/bind.js";
import { DEFAULT_SERVER_URL } from "../shared/settings.js";

const FLAG = "__piWebUiBindBar";
const HOST_ID = "pi-page-picker-bind-host";

interface BarRuntime {
	destroy: () => void;
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.card {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 10;
  width: min(620px, 92vw); padding: 14px 16px; border-radius: 10px; pointer-events: auto;
  background: rgba(17,24,39,.97); color: #e5e7eb; font-size: 13px; line-height: 1.55;
  box-shadow: 0 10px 34px rgba(0,0,0,.45);
}
.t { font-weight: 600; color: #93c5fd; margin-bottom: 4px; }
.d { color: #cbd5e1; word-break: break-all; }
.s { margin-top: 8px; }
.s.ok { color: #4ade80; }
.s.err { color: #f87171; }
.s.warn { color: #fbbf24; }
.row { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.grow { flex: 1 1 auto; }
button {
  padding: 6px 11px; border-radius: 6px; border: 1px solid #374151; background: #1f2937;
  color: #e5e7eb; font-size: 12px; cursor: pointer;
}
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
button:hover { filter: brightness(1.15); }
button:disabled { opacity: .6; cursor: default; }
.hidden { display: none !important; }
`;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "class") node.className = v;
		else if (k === "text") node.textContent = v;
		else node.setAttribute(k, v);
	}
	return node;
}

function createBar(): BarRuntime & { render: (view: BindView) => void } {
	const host = el("div", { id: HOST_ID });
	host.style.cssText = "position:fixed;inset:auto 0 0 0;z-index:2147483647;pointer-events:none;";
	const shadow = host.attachShadow({ mode: "open" });

	const title = el("div", { class: "t" });
	const detail = el("div", { class: "d" });
	const status = el("div", { class: "s hidden" });
	const bindBtn = el("button", { class: "primary", text: "设为服务地址" });
	const pickBtn = el("button", { text: "在本页拾取元素" });
	const authBtn = el("button", { class: "hidden", text: "打开设置页授权" });
	const closeBtn = el("button", { text: "关闭" });
	const card = el("div", { class: "card" });
	const foot = el("div", { class: "row" });
	foot.append(pickBtn, authBtn, el("span", { class: "grow" }), closeBtn, bindBtn);
	card.append(title, detail, status, foot);
	shadow.append(el("style", { text: CSS }), card);
	(document.body ?? document.documentElement).append(host);

	let destroyed = false;
	const destroy = (): void => {
		if (destroyed) return;
		destroyed = true;
		window.removeEventListener("keydown", onKeyDown, true);
		host.remove();
		const w = window as unknown as Record<string, unknown>;
		if (w[FLAG] === runtime) delete w[FLAG];
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape") destroy();
	};

	const say = (text: string, kind: "ok" | "err" | "warn" | "info"): void => {
		status.textContent = text;
		status.className = `s ${kind === "info" ? "" : kind}`.trim();
	};

	const render = (view: BindView): void => {
		title.textContent = view.title;
		detail.textContent = view.detail;
		// 已经是这个地址了：没有可绑的东西，只留「在本页拾取」（开发 pi-web-ui 自己时用得上）
		bindBtn.classList.toggle("hidden", view.same);
		bindBtn.textContent = view.same ? "" : (view.bindLabel ?? "设为服务地址");
		if (view.same) say(`已绑定 ${view.base}`, "ok");
	};
	const onBind = async (): Promise<void> => {
		bindBtn.disabled = true;
		bindBtn.textContent = "正在绑定…";
		let res: BindResult | undefined;
		try {
			res = (await chrome.runtime.sendMessage({ type: "page-picker:bind", url: location.href })) as
				BindResult | undefined;
		} catch {
			/* 通道断了也按失败处理，下面统一提示 */
		}
		if (!res) {
			say("绑定失败：background 没响应，刷新页面后再试", "err");
			bindBtn.disabled = false;
			bindBtn.textContent = "设为服务地址";
			return;
		}
		say(res.message, res.ok ? "ok" : res.needAuth ? "warn" : "err");
		if (res.ok) {
			bindBtn.disabled = false;
			bindBtn.textContent = "已绑定";
			bindBtn.classList.add("hidden");
			window.setTimeout(destroy, 2600);
			return;
		}
		// 没授权：页面上点的按钮给不了浏览器要的手势 → 去扩展自己的页面点一次
		if (res.needAuth) authBtn.classList.remove("hidden");
		bindBtn.disabled = false;
		bindBtn.textContent = "重试绑定";
	};

	bindBtn.addEventListener("click", () => void onBind());
	authBtn.addEventListener("click", () => {
		void chrome.runtime.sendMessage({ type: "page-picker:open-options", url: location.href });
	});
	pickBtn.addEventListener("click", () => {
		void chrome.runtime.sendMessage({ type: "page-picker:pick-anyway" });
		destroy(); // 拾取器由 background 注入，浮条自己收掉，两套 UI 不叠
	});
	closeBtn.addEventListener("click", destroy);
	window.addEventListener("keydown", onKeyDown, true);

	const runtime: BarRuntime & { render: (view: BindView) => void } = { destroy, render };

	return runtime;
}

/**
 * 入口：重复注入（再点一次图标）只把浮条换成新的，不会叠出第二条。
 * 设置从 background 取（`serverUrl` 不是秘密，storage 只有它那边能读）—— 取不到就
 * 按默认地址算，反正只是决定「当前地址」那一行显示什么。
 */
const w = window as unknown as Record<string, unknown>;
(w[FLAG] as BarRuntime | undefined)?.destroy(); // 再点一次图标：换新的，不叠第二条
const runtime = createBar();
w[FLAG] = runtime;

void (async () => {
	let bound = "";
	try {
		const res = (await chrome.runtime.sendMessage({ type: "page-picker:settings" })) as
			{ serverUrl?: string } | undefined;
		bound = res?.serverUrl ?? "";
	} catch {
		/* 拿不到设置也能问 —— bindView 会用默认地址兜底 */
	}
	runtime.render(bindView(location.href, bound || DEFAULT_SERVER_URL));
})();
