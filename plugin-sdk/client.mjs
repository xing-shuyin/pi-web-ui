export const SDK_VERSION = "0.3.0";

export function defineView(view) {
	if (!view || typeof view !== "object") throw new Error("[sdk] defineView 需要一个对象");
	if (typeof view.mount !== "function") throw new Error("[sdk] 视图缺 mount(el, ctx) 方法");
	if (view.cleanup !== undefined && typeof view.cleanup !== "function") {
		throw new Error("[sdk] cleanup 必须是函数");
	}
	return view;
}

export function defineRenderer(renderers) {
	if (!renderers || typeof renderers !== "object") throw new Error("[sdk] defineRenderer 需要 { lang: fn } 对象");
	for (const [lang, fn] of Object.entries(renderers)) {
		if (typeof fn !== "function") throw new Error(`[sdk] renderer "${lang}" 不是函数`);
	}
	return { renderers };
}

export function actionHandler(map) {
	if (!map || typeof map !== "object") throw new Error("[sdk] actionHandler 需要 { action: fn } 对象");
	return (itemId, value) => {
		const fn = map[itemId];
		if (typeof fn === "function") return fn(value);
	};
}

export function onUiAction(action, handler) {
	try {
		const bridge = globalThis.window?.__piWebUiHost;
		if (bridge && typeof bridge.onUiAction === "function") return bridge.onUiAction(action, handler);
	} catch {}
	return () => {};
}

export function getSetting(host, key, fallback) {
	try {
		const v = host?.getSettings?.()?.[key];
		return v === undefined ? fallback : v;
	} catch {
		return fallback;
	}
}

export function selectOptions(list) {
	return (Array.isArray(list) ? list : [])
		.map((x) => (typeof x === "string" ? { value: x, label: x } : x))
		.filter((x) => x && typeof x.value === "string" && x.value)
		.slice(0, 32);
}

export * from "./client-utils.mjs";
