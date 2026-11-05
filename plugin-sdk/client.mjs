/** Browser-only plugin SDK. Vendor this file with client-utils.mjs. */

/**
 * SDK 版本（单源：与 plugin-sdk/package.json 的 version 保持一致，
 * tests/unit/plugin-sdk-mock.test.ts 锁定）。脚手架拷贝 sdk/client.mjs 时连版本号
 * 一起带走；已装插件用 `pi-web-ui plugin upgrade-sdk` 刷新拷贝。
 */
export const SDK_VERSION = "0.3.0";

/** 视图入口：mount(el, ctx) 必填，cleanup/其他字段可选；同样做一次形状校验。 */
export function defineView(view) {
	if (!view || typeof view !== "object") throw new Error("[sdk] defineView 需要一个对象");
	if (typeof view.mount !== "function") throw new Error("[sdk] 视图缺 mount(el, ctx) 方法");
	if (view.cleanup !== undefined && typeof view.cleanup !== "function") {
		throw new Error("[sdk] cleanup 必须是函数");
	}
	return view;
}

/** fenced-code 渲染器入口：{ renderers: { lang: (code, ctx) => HTMLElement | null } }。 */
export function defineRenderer(renderers) {
	if (!renderers || typeof renderers !== "object") throw new Error("[sdk] defineRenderer 需要 { lang: fn } 对象");
	for (const [lang, fn] of Object.entries(renderers)) {
		if (typeof fn !== "function") throw new Error(`[sdk] renderer "${lang}" 不是函数`);
	}
	return { renderers };
}

/**
 * onUiAction 分发：一份表代替一串 if（key 是完整 action 名）。
 *   import { actionHandler, onUiAction } from "./sdk/index.mjs";
 *   onUiAction("my-plugin:tone", actionHandler({ "my-plugin:tone": (value) => {...} }));
 */
export function actionHandler(map) {
	if (!map || typeof map !== "object") throw new Error("[sdk] actionHandler 需要 { action: fn } 对象");
	return (itemId, value) => {
		const fn = map[itemId];
		if (typeof fn === "function") return fn(value);
	};
}

/**
 * 浏览器侧动作注册（client/entry.mjs 用）：包一层 window.__piWebUiHost.onUiAction。
 *  select 切选项时 handler 收到 (itemId, value)；宿主桥还没装好时返回空操作。
 */
export function onUiAction(action, handler) {
	try {
		const bridge = globalThis.window?.__piWebUiHost;
		if (bridge && typeof bridge.onUiAction === "function") return bridge.onUiAction(action, handler);
	} catch {
		/* 非浏览器/桥未就绪 */
	}
	return () => {};
}

/**
 * host.log 分级日志（精简说明）：
 *   host.log("warn", "磁盘只剩", 123, "MB");  // 首参是级别
 *   host.log("直接写内容", { a: 1 });               // 首参不是级别 → 按 info
 * 级别：debug | info（缺省）| warn | error；error 同时走 console.error。
 * 全部进宿主内存环形缓冲（每插件最近 200 条，单条截断 500 字符，不落盘），
 * 用户在设置面板“界面插件”页点该插件的“日志”按需查看（级别过滤 + 清空）。
 */
/** 读设置（host.getSettings 薄封装：缺 key 回 fallback，不抛错）。 */
export function getSetting(host, key, fallback) {
	try {
		const v = host?.getSettings?.()?.[key];
		return v === undefined ? fallback : v;
	} catch {
		return fallback;
	}
}

/** 下拉条目构造器（value 必填，label 缺省回落 value）。 */
export function selectOptions(list) {
	return (Array.isArray(list) ? list : [])
		.map((x) => (typeof x === "string" ? { value: x, label: x } : x))
		.filter((x) => x && typeof x.value === "string" && x.value)
		.slice(0, 32);
}

export * from "./client-utils.mjs";
